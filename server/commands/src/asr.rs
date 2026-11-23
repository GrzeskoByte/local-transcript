//! Native ASR commands: whisper.cpp CLI, shared models, per-user jobs, fair queue.
// Ported from src-tauri/src/native_asr.rs. Differences: models live in the shared
// `<data_dir>/models`; the one-child-at-a-time rule is a server-wide *fair* queue
// (round-robin across users); every job belongs to a user and `cancel` only
// reaches the caller's; models are addressed by plain name (no filesystem paths).
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::jobs::{JobCtl, JobRegistry};
use crate::models::{self, Backend, NativeAsrStatus, NativeModel};
use crate::queue::FairQueue;
use crate::util::{lock, unique_path};
use crate::Engine;

const TARGET_SAMPLE_RATE: u32 = 16_000;
const MAX_TRANSCRIBE_SECS: u64 = 30 * 60;
const DEFAULT_MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

pub struct AsrState {
    pub queue: Arc<FairQueue>,
    pub jobs: Arc<JobRegistry>,
    backend: Mutex<Option<Backend>>,
    downloading: Mutex<HashSet<String>>,
    sizes: Mutex<HashMap<String, u64>>,
}

impl AsrState {
    pub fn new() -> Self {
        Self {
            queue: FairQueue::new(1),
            jobs: JobRegistry::new(),
            backend: Mutex::new(None),
            downloading: Mutex::new(HashSet::new()),
            sizes: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    /// A 16 kHz mono WAV (or bare little-endian f32 PCM), base64 encoded.
    pub samples_base64: String,
    #[serde(default)]
    pub sample_rate: u32,
    /// Native model name, e.g. `"large-v3-turbo"`.
    #[serde(default)]
    pub model: Option<String>,
    /// Desktop/voxtype only; accepted and ignored here.
    #[serde(default)]
    #[allow(dead_code)]
    pub engine: Option<String>,
    /// `"auto"` | `"en"` | ...
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NativeSegment {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

impl Engine {
    pub fn models_dir(&self) -> PathBuf {
        self.config.data_dir.join("models")
    }

    pub(crate) fn tmp_dir(&self) -> PathBuf {
        self.config.data_dir.join("tmp")
    }

    /// The CLI (found once, then remembered).
    pub(crate) fn backend(&self) -> Option<Backend> {
        let mut cached = lock(&self.asr.backend);
        if cached.is_none() {
            *cached = models::discover_backend(self.config.whisper_cli.as_deref());
        }
        cached.clone()
    }
}

// ---------------------------------------------------------------------------
// Status / models / download
// ---------------------------------------------------------------------------

pub fn status(engine: &Engine) -> NativeAsrStatus {
    let dir = engine.models_dir();
    let models_list = models::collect_models(&dir);
    let model_dir = dir.is_dir().then(|| dir.to_string_lossy().to_string());
    match engine.backend() {
        Some(b) => NativeAsrStatus {
            available: true,
            backend: "whisper-cli".to_string(),
            binary_path: Some(b.path.to_string_lossy().to_string()),
            version: b.version,
            engines: Vec::new(),
            acceleration: None,
            gpu: models::GpuInfo::default(),
            model_dir,
            models: models_list,
            install_hint: None,
            bundled: false,
            recommended_model: Some(models::WHISPER_CLI_FIRST_MODEL.to_string()),
        },
        None => NativeAsrStatus {
            available: false,
            backend: "none".to_string(),
            binary_path: None,
            version: None,
            engines: Vec::new(),
            acceleration: None,
            gpu: models::GpuInfo::default(),
            model_dir,
            models: models_list,
            install_hint: Some(models::install_hint()),
            bundled: false,
            recommended_model: None,
        },
    }
}

pub fn models_list(engine: &Engine) -> Vec<NativeModel> {
    models::collect_models(&engine.models_dir())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub received: u64,
    /// 0 when the size is not known (progress is then indeterminate).
    pub total: u64,
    pub done: bool,
}

/// Poll a model download (global: models are shared by every user).
pub fn download_progress(engine: &Engine, name: &str) -> Result<DownloadProgress, String> {
    if !models::valid_model_name(name) {
        return Err("Invalid model name".to_string());
    }
    let dir = engine.models_dir();
    let total = lock(&engine.asr.sizes).get(name).copied().unwrap_or(0);
    let done_path = dir.join(models::ggml_filename(name));
    if done_path.is_file() {
        let size = done_path.metadata().map(|m| m.len()).unwrap_or(0);
        return Ok(DownloadProgress { received: size, total: total.max(size), done: true });
    }
    let part = dir.join(format!("{}.part", models::ggml_filename(name)));
    let received = part.metadata().map(|m| m.len()).unwrap_or(0);
    Ok(DownloadProgress { received, total, done: false })
}

/// `LT_MODEL_BASE_URL` (a mirror / air-gapped file server) overrides Hugging Face.
fn model_download_url(base: Option<&str>, name: &str) -> String {
    let base = base.unwrap_or(DEFAULT_MODEL_BASE_URL);
    format!("{}/{}", base.trim_end_matches('/'), models::ggml_filename(name))
}

/// Final Content-Length after redirects (Hugging Face → CDN), via `curl -I`.
fn remote_size(url: &str) -> Option<u64> {
    let out = crate::proc::command("curl").args(["-sIL", "--max-time", "20", url]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.trim().eq_ignore_ascii_case("content-length").then(|| v.trim().parse::<u64>().ok())?
        })
        .next_back()
        .filter(|n| *n > 0)
}

/// Admin only (checked by the dispatcher). Blocking: runs curl for minutes.
pub fn download_model(engine: &Engine, name: &str) -> Result<(), String> {
    if !models::valid_model_name(name) {
        return Err(format!("Refusing to download suspicious model name: {name}"));
    }
    let dir = engine.models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the model folder: {e}"))?;
    let dest = dir.join(models::ggml_filename(name));
    if dest.is_file() {
        return Ok(());
    }
    if !lock(&engine.asr.downloading).insert(name.to_string()) {
        return Err(format!("{name} is already being downloaded."));
    }
    let result = download_to(engine, name, &dir, &dest);
    lock(&engine.asr.downloading).remove(name);
    result
}

fn download_to(engine: &Engine, name: &str, dir: &Path, dest: &Path) -> Result<(), String> {
    let tmp = dir.join(format!("{}.part", models::ggml_filename(name)));
    let url = model_download_url(std::env::var("LT_MODEL_BASE_URL").ok().as_deref(), name);
    let expected = remote_size(&url);
    if let Some(size) = expected {
        lock(&engine.asr.sizes).insert(name.to_string(), size);
    }
    let _ = std::fs::remove_file(&tmp);
    let out = crate::proc::command("curl")
        .args(["-fSL", "--retry", "3", "--speed-limit", "1000", "--speed-time", "120", "-o"])
        .arg(&tmp)
        .arg(&url)
        .output()
        .map_err(|e| format!("Model download failed (could not run `curl`: {e})"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "Model download failed ({}). Check the server's internet access.",
            if detail.is_empty() { "curl reported an error" } else { &detail }
        ));
    }
    // Never accept a truncated or wrong-sized model file.
    let got = tmp.metadata().map(|m| m.len()).unwrap_or(0);
    if let Some(size) = expected {
        if got != size {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("Model download was incomplete ({got} of {size} bytes). Check the connection and retry."));
        }
    }
    std::fs::rename(&tmp, dest).map_err(|e| format!("Could not save the model file: {e}"))
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/// A decoded request ready for the CLI; its files are removed on drop.
pub struct Prepared {
    wav: PathBuf,
    base: PathBuf,
    model_path: PathBuf,
    language: Option<String>,
}

impl Drop for Prepared {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);
        let (Some(parent), Some(name)) = (self.base.parent(), self.base.file_name().and_then(|s| s.to_str())) else {
            return;
        };
        let prefix = format!("{name}.");
        if let Ok(entries) = std::fs::read_dir(parent) {
            for entry in entries.flatten() {
                if entry.file_name().to_str().is_some_and(|n| n.starts_with(&prefix)) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}

/// Decode the audio, resolve the model, write the 16 kHz WAV. `None` = nothing to transcribe.
pub fn prepare(models_dir: &Path, tmp_dir: &Path, request: &TranscribeRequest) -> Result<Option<Prepared>, String> {
    if let Some(model) = request.model.as_deref().filter(|m| !m.is_empty()) {
        if !models::valid_model_name(model) {
            return Err(format!("Invalid model name: {model}"));
        }
    }
    let raw = base64::engine::general_purpose::STANDARD
        .decode(request.samples_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 audio: {e}"))?;
    if raw.is_empty() {
        return Ok(None);
    }
    let (samples, source_rate) = decode_audio(&raw, request.sample_rate)?;
    if samples.is_empty() {
        return Ok(None);
    }
    let resampled = if source_rate != TARGET_SAMPLE_RATE && source_rate != 0 {
        resample_linear(&samples, source_rate, TARGET_SAMPLE_RATE)
    } else {
        samples
    };
    let model_path = resolve_model(models_dir, request.model.as_deref())?;
    std::fs::create_dir_all(tmp_dir).map_err(|e| format!("Could not create the scratch folder: {e}"))?;
    let base = unique_path(tmp_dir, "asr");
    let wav = PathBuf::from(format!("{}.wav", base.to_string_lossy()));
    let prepared = Prepared { wav, base, model_path, language: request.language.clone() };
    write_wav(&prepared.wav, &resampled)?;
    Ok(Some(prepared))
}

/// Queue fairly, then run the CLI. The job belongs to `user`.
pub async fn transcribe(engine: &Engine, user: &str, request: TranscribeRequest) -> Result<Vec<NativeSegment>, String> {
    let backend = engine.backend().ok_or_else(|| "No transcription backend available".to_string())?;
    let guard = engine.asr.jobs.register(user);
    let (models_dir, tmp_dir) = (engine.models_dir(), engine.tmp_dir());
    let prepared = tokio::task::spawn_blocking(move || prepare(&models_dir, &tmp_dir, &request))
        .await
        .map_err(|e| format!("Transcription task failed: {e}"))??;
    let Some(prepared) = prepared else { return Ok(Vec::new()) };

    // Waiting in line (cancelling the user's jobs ends the wait).
    let permit = engine
        .asr
        .queue
        .enter(user)
        .wait()
        .await
        .map_err(|_| "Transcription cancelled".to_string())?;
    if guard.ctl.is_cancelled() {
        return Err("Transcription cancelled".to_string());
    }
    let ctl = guard.ctl.clone();
    let _abort = crate::jobs::CancelOnDrop(ctl.clone());
    tokio::task::spawn_blocking(move || {
        let _slot = permit; // released when the CLI is done
        let _guard = guard;
        run_whisper(&backend, &prepared, &ctl)
    })
    .await
    .map_err(|e| format!("Transcription task failed: {e}"))?
}

/// Cancel the caller's queued and running transcriptions.
pub fn cancel(engine: &Engine, user: &str) {
    engine.asr.queue.cancel_user(user);
    engine.asr.jobs.cancel_user(user);
}

pub fn run_whisper(backend: &Backend, p: &Prepared, ctl: &JobCtl) -> Result<Vec<NativeSegment>, String> {
    let base_str = p.base.to_string_lossy().to_string();
    let mut args: Vec<String> = vec![
        "-m".into(),
        p.model_path.to_string_lossy().to_string(),
        "-f".into(),
        p.wav.to_string_lossy().to_string(),
        "-oj".into(),
        "-of".into(),
        base_str.clone(),
        "-nt".into(),
        "--no-prints".into(),
    ];
    if let Some(lang) = p.language.as_deref() {
        if !lang.is_empty() && lang != "auto" {
            args.push("-l".into());
            args.push(lang.to_string());
        }
    }
    run_child(ctl, &backend.path, &args)?;
    let json_path = format!("{base_str}.json");
    let text = std::fs::read_to_string(&json_path)
        .map_err(|_| "whisper.cpp did not produce transcript output.".to_string())?;
    parse_whisper_json(&text)
}

/// Model file for a plain model name (or the best installed one when none is given).
fn resolve_model(dir: &Path, model: Option<&str>) -> Result<PathBuf, String> {
    let candidates: Vec<String> = match model.filter(|m| !m.is_empty()) {
        Some(m) => vec![format!("ggml-{m}.bin"), format!("{m}.bin")],
        None => {
            let mut all: Vec<String> = std::fs::read_dir(dir)
                .map(|rd| {
                    rd.flatten()
                        .filter_map(|e| e.file_name().into_string().ok())
                        .filter(|n| n.starts_with("ggml-") && n.ends_with(".bin"))
                        .collect()
                })
                .unwrap_or_default();
            all.sort();
            if let Some(i) = all.iter().position(|n| n == "ggml-base.en.bin") {
                let base = all.remove(i);
                all.insert(0, base);
            }
            all
        }
    };
    candidates
        .iter()
        .map(|name| dir.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| format!("Whisper model '{}' is not installed on this server.", model.unwrap_or("<default>")))
}

fn parse_whisper_json(text: &str) -> Result<Vec<NativeSegment>, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("Failed to parse whisper.cpp output: {e}"))?;
    let items = value
        .get("transcription")
        .and_then(|v| v.as_array())
        .or_else(|| value.get("segments").and_then(|v| v.as_array()))
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();
    let mut segments = Vec::new();
    for item in items {
        let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let (start_ms, end_ms) = extract_times(&item);
        segments.push(NativeSegment { start_ms, end_ms, text });
    }
    Ok(segments)
}

fn extract_times(item: &serde_json::Value) -> (f64, f64) {
    if let Some(offsets) = item.get("offsets") {
        let from = offsets.get("from").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let to = offsets.get("to").and_then(|v| v.as_f64()).unwrap_or(0.0);
        return (from, to);
    }
    if let Some(ts) = item.get("timestamps") {
        let from = ts.get("from").and_then(|v| v.as_str()).map(parse_timestamp).unwrap_or(0.0);
        let to = ts.get("to").and_then(|v| v.as_str()).map(parse_timestamp).unwrap_or(0.0);
        return (from, to);
    }
    (0.0, 0.0)
}

/// Parse `"HH:MM:SS,mmm"` / `"HH:MM:SS.mmm"` into milliseconds.
fn parse_timestamp(raw: &str) -> f64 {
    let cleaned = raw.trim().replace(',', ".");
    let parts: Vec<&str> = cleaned.split(':').collect();
    let num = |s: &str| s.parse::<f64>().unwrap_or(0.0);
    let (h, m, s) = match parts.len() {
        3 => (num(parts[0]), num(parts[1]), num(parts[2])),
        2 => (0.0, num(parts[0]), num(parts[1])),
        1 => (0.0, 0.0, num(parts[0])),
        _ => (0.0, 0.0, 0.0),
    };
    (h * 3600.0 + m * 60.0 + s) * 1000.0
}

// ---------------------------------------------------------------------------
// Child process runner (killable, with timeout)
// ---------------------------------------------------------------------------

fn run_child(ctl: &JobCtl, program: &Path, args: &[String]) -> Result<(), String> {
    if ctl.is_cancelled() {
        return Err("Transcription cancelled".to_string());
    }
    let mut command = crate::proc::command(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "Could not start the transcription engine.".to_string())?;

    // Drain both pipes so a chatty CLI never blocks on a full pipe.
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        pipe.map(|mut p| {
            thread::spawn(move || {
                let mut buf = Vec::new();
                let _ = p.read_to_end(&mut buf);
            })
        })
    };
    let out_h = drain(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let err_h = drain(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    *lock(&ctl.child) = Some(child);

    let deadline = Instant::now() + Duration::from_secs(MAX_TRANSCRIBE_SECS);
    let outcome = loop {
        {
            let mut guard = lock(&ctl.child);
            match guard.as_mut() {
                Some(proc) => match proc.try_wait() {
                    Ok(Some(exit)) => {
                        *guard = None;
                        break Ok(exit.success());
                    }
                    Ok(None) => {}
                    Err(e) => {
                        *guard = None;
                        break Err(format!("Failed to wait for the transcription engine: {e}"));
                    }
                },
                None => break Err("Transcription cancelled".to_string()),
            }
        }
        if ctl.is_cancelled() {
            ctl.cancel();
            break Err("Transcription cancelled".to_string());
        }
        if Instant::now() >= deadline {
            ctl.cancel();
            break Err("Transcription timed out".to_string());
        }
        thread::sleep(Duration::from_millis(50));
    };
    // Only wait for the pipe readers after a normal exit: a killed child's
    // grandchildren may still hold the pipes open.
    if outcome.is_ok() {
        for h in [out_h, err_h].into_iter().flatten() {
            let _ = h.join();
        }
    }
    // whisper.cpp may exit non-zero yet leave output; the caller decides by the JSON.
    outcome.map(|_| ())
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/// Decode the audio payload: a RIFF/WAVE container, else bare little-endian f32 mono PCM.
fn decode_audio(raw: &[u8], declared_rate: u32) -> Result<(Vec<f32>, u32), String> {
    if raw.len() >= 12 && &raw[0..4] == b"RIFF" && &raw[8..12] == b"WAVE" {
        return parse_wav(raw);
    }
    if raw.len() & 3 != 0 {
        return Err("Audio payload length is not a multiple of 4 bytes".to_string());
    }
    let samples: Vec<f32> = (0..raw.len() / 4)
        .map(|i| f32::from_le_bytes([raw[i * 4], raw[i * 4 + 1], raw[i * 4 + 2], raw[i * 4 + 3]]))
        .collect();
    let rate = if declared_rate == 0 { TARGET_SAMPLE_RATE } else { declared_rate };
    Ok((samples, rate))
}

/// Minimal RIFF/WAVE reader: PCM s16, PCM s32 and IEEE float32, downmixed to mono.
fn parse_wav(raw: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;
    while pos + 8 <= raw.len() {
        let id = &raw[pos..pos + 4];
        let size = u32::from_le_bytes([raw[pos + 4], raw[pos + 5], raw[pos + 6], raw[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = match body_start.checked_add(size) {
            Some(e) if e <= raw.len() => e,
            _ => break,
        };
        let body = &raw[body_start..body_end];
        if id == b"fmt " {
            if body.len() < 16 {
                return Err("Invalid WAV fmt chunk".to_string());
            }
            let format = u16::from_le_bytes([body[0], body[1]]);
            let channels = u16::from_le_bytes([body[2], body[3]]);
            let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
            let bits = u16::from_le_bytes([body[14], body[15]]);
            fmt = Some((format, channels, rate, bits));
        } else if id == b"data" {
            data = Some(body);
        }
        pos = body_end + (size & 1);
    }
    let (format, channels, rate, bits) = fmt.ok_or_else(|| "WAV missing fmt chunk".to_string())?;
    let data = data.ok_or_else(|| "WAV missing data chunk".to_string())?;
    let channels = channels.max(1) as usize;
    let mut samples: Vec<f32> = Vec::new();
    match (format, bits) {
        (1, 16) => {
            for frame in data.chunks_exact(2 * channels) {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    acc += i16::from_le_bytes([frame[c * 2], frame[c * 2 + 1]]) as f32 / 32768.0;
                }
                samples.push(acc / channels as f32);
            }
        }
        (1, 32) => {
            for frame in data.chunks_exact(4 * channels) {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    let b = &frame[c * 4..c * 4 + 4];
                    acc += i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0;
                }
                samples.push(acc / channels as f32);
            }
        }
        (3, 32) => {
            for frame in data.chunks_exact(4 * channels) {
                let mut acc = 0.0f32;
                for c in 0..channels {
                    let b = &frame[c * 4..c * 4 + 4];
                    acc += f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                }
                samples.push(acc / channels as f32);
            }
        }
        _ => return Err(format!("Unsupported WAV format {format} with {bits}-bit samples")),
    }
    Ok((samples, rate))
}

fn resample_linear(samples: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let out_len = ((samples.len() as f64) / ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let i0 = src.floor() as usize;
        let frac = (src - i0 as f64) as f32;
        let s0 = *samples.get(i0).unwrap_or(&0.0);
        let s1 = *samples.get(i0 + 1).unwrap_or(&s0);
        out.push(s0 + (s1 - s0) * frac);
    }
    out
}

fn write_wav(path: &Path, samples: &[f32]) -> Result<(), String> {
    let mut pcm: Vec<u8> = Vec::with_capacity(samples.len() * 2);
    for &sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * 32767.0).round() as i32;
        pcm.extend_from_slice(&(value.clamp(-32768, 32767) as i16).to_le_bytes());
    }
    let data_len = pcm.len() as u32;
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = TARGET_SAMPLE_RATE * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);
    let mut out: Vec<u8> = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(&pcm);
    std::fs::write(path, out).map_err(|e| format!("Failed to write temp WAV: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_whisper_json_offsets_and_timestamps() {
        let text = r#"{"transcription":[
            {"offsets":{"from":0,"to":1500},"text":" Hello "},
            {"timestamps":{"from":"00:00:02,000","to":"00:01:03,500"},"text":"World"},
            {"offsets":{"from":1,"to":2},"text":"  "}]}"#;
        let segs = parse_whisper_json(text).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0], NativeSegment { start_ms: 0.0, end_ms: 1500.0, text: "Hello".into() });
        assert_eq!((segs[1].start_ms, segs[1].end_ms), (2000.0, 63500.0));
    }

    #[test]
    fn wav_round_trips_through_the_decoder() {
        let tmp = std::env::temp_dir().join(format!("lt-wav-{}.wav", std::process::id()));
        write_wav(&tmp, &[0.0, 0.5, -0.5, 1.0]).unwrap();
        let (samples, rate) = decode_audio(&std::fs::read(&tmp).unwrap(), 0).unwrap();
        let _ = std::fs::remove_file(&tmp);
        assert_eq!(rate, 16_000);
        assert_eq!(samples.len(), 4);
        assert!((samples[1] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn download_url_points_at_whisper_cpp_repo() {
        assert_eq!(
            model_download_url(None, "base.en"),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin"
        );
        assert_eq!(model_download_url(Some("file:///m/"), "tiny"), "file:///m/ggml-tiny.bin");
    }
}
