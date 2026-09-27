//! Tauri commands for the native, shell-out ASR backend.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::models::{self, Backend, NativeAsrStatus, NativeModel};

const TARGET_SAMPLE_RATE: u32 = 16_000;
const MAX_TRANSCRIBE_SECS: u64 = 30 * 60;

#[derive(Default)]
pub struct AppState {
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeRequest {
    /// Little-endian f32 mono PCM, base64 encoded.
    pub samples_base64: String,
    pub sample_rate: u32,
    /// Native model name, e.g. `"large-v3-turbo"` (not a HF repo id).
    #[serde(default)]
    pub model: Option<String>,
    /// `"whisper"` | `"parakeet"` | ... (voxtype only).
    #[serde(default)]
    pub engine: Option<String>,
    /// `"auto"` | `"en"` | `"english"` | ...
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSegment {
    pub start_ms: f64,
    pub end_ms: f64,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn native_asr_status() -> NativeAsrStatus {
    build_status()
}

fn build_status() -> NativeAsrStatus {
    let backend = models::discover_backend();
    let (engines, models_list) = models::collect_models(backend.as_ref());
    let model_dir = models::first_existing_model_dir();

    match backend {
        Some(b) => NativeAsrStatus {
            available: true,
            acceleration: models::read_acceleration(&b),
            gpu: models::read_gpu(&b),
            backend: b.name,
            binary_path: Some(b.path),
            version: b.version,
            engines,
            model_dir,
            models: models_list,
            install_hint: None,
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
        },
    }
}

#[tauri::command]
pub fn native_asr_models() -> Vec<NativeModel> {
    let backend = models::discover_backend();
    models::collect_models(backend.as_ref()).1
}

/// Enable GPU acceleration through Voxtype. This needs root, so we try polkit
/// (`pkexec`, which shows a graphical password prompt) before passwordless sudo.
#[tauri::command]
pub async fn native_asr_enable_gpu() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(enable_gpu_blocking)
        .await
        .map_err(|e| format!("GPU enable task failed: {e}"))?
}

fn enable_gpu_blocking() -> Result<String, String> {
    let backend = models::discover_backend()
        .ok_or_else(|| "No transcription backend available.".to_string())?;
    if backend.name != "voxtype" {
        return Err(
            "GPU acceleration is managed by Voxtype; a whisper-cli backend was detected instead."
                .to_string(),
        );
    }

    let attempts: [(&str, Vec<&str>); 2] = [
        ("pkexec", vec![backend.path.as_str(), "setup", "gpu", "--enable"]),
        ("sudo", vec!["-n", backend.path.as_str(), "setup", "gpu", "--enable"]),
    ];

    let mut last_err = "GPU acceleration could not be enabled automatically.".to_string();
    for (program, args) in attempts {
        match Command::new(program).args(&args).output() {
            Ok(out) if out.status.success() => {
                let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
                return Ok(if text.is_empty() {
                    "GPU acceleration enabled.".to_string()
                } else {
                    text
                });
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = stderr;
                }
            }
            Err(_) => {
                // Program not installed; try the next option.
            }
        }
    }

    Err(format!(
        "{last_err} Run manually: sudo {} setup gpu --enable",
        backend.path
    ))
}

#[tauri::command]
pub async fn native_asr_download_model(name: String) -> Result<(), String> {
    let backend = models::discover_backend()
        .ok_or_else(|| "No transcription backend available. Install Voxtype to download models.".to_string())?;

    if backend.name != "voxtype" {
        return Err(format!(
            "Model downloads require the Voxtype backend (found: {}). \
             Download whisper.cpp models manually with the whisper.cpp download script.",
            backend.name
        ));
    }

    let output = Command::new(&backend.path)
        .args([
            "setup",
            "--download",
            "--model",
            &name,
            "--quiet",
            "--no-post-install",
        ])
        .output()
        .map_err(|e| format!("Failed to run voxtype: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        Err(format!("voxtype setup --download failed: {detail}"))
    }
}

#[tauri::command]
pub async fn native_asr_transcribe(
    state: State<'_, AppState>,
    request: TranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    let slot = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || transcribe_blocking(&slot, request))
        .await
        .map_err(|e| format!("Transcription task failed: {e}"))?
}

#[tauri::command]
pub fn native_asr_cancel(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "transcription state lock poisoned".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Transcription core
// ---------------------------------------------------------------------------

fn transcribe_blocking(
    slot: &Arc<Mutex<Option<Child>>>,
    request: TranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    let backend = models::discover_backend()
        .ok_or_else(|| "No transcription backend available".to_string())?;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(request.samples_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 audio: {e}"))?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }

    // The desktop bridge ships a complete 16 kHz mono WAV; the documented
    // contract also allows a bare little-endian f32 PCM stream. Accept both.
    let (samples, source_rate) = decode_audio(&raw, request.sample_rate)?;
    if samples.is_empty() {
        return Ok(Vec::new());
    }

    let resampled = if source_rate != TARGET_SAMPLE_RATE && source_rate != 0 {
        resample_linear(&samples, source_rate, TARGET_SAMPLE_RATE)
    } else {
        samples
    };
    let duration_ms = (resampled.len() as f64 / TARGET_SAMPLE_RATE as f64) * 1000.0;

    // Drop guard: removes the temp WAV + any whisper-cli sidecar files.
    let artifacts = TempArtifacts::create();
    write_wav(&artifacts.wav, &resampled)?;

    match backend.name.as_str() {
        "voxtype" => transcribe_voxtype(slot, &backend.path, &artifacts.wav, &request, duration_ms),
        _ => transcribe_whisper_cli(slot, &backend, &artifacts.wav, &artifacts.base, &request),
    }
}

// ---------------------------------------------------------------------------
// whisper-cli backend
// ---------------------------------------------------------------------------

fn transcribe_whisper_cli(
    slot: &Arc<Mutex<Option<Child>>>,
    backend: &Backend,
    wav: &Path,
    base: &Path,
    request: &TranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    let model_path = resolve_whisper_model(request.model.as_deref())?;
    let base_str = base.to_string_lossy().to_string();

    let mut args: Vec<String> = vec![
        "-m".into(),
        model_path,
        "-f".into(),
        wav.to_string_lossy().to_string(),
        "-oj".into(),
        "-of".into(),
        base_str.clone(),
        "-nt".into(),
        "--no-prints".into(),
    ];
    if let Some(lang) = request.language.as_deref() {
        if !lang.is_empty() && lang != "auto" {
            args.push("-l".into());
            args.push(lang.to_string());
        }
    }

    run_child(slot, &backend.path, &args)?;

    let json_path = format!("{base_str}.json");
    let text = std::fs::read_to_string(&json_path).map_err(|e| {
        format!("whisper.cpp did not produce transcript output ({json_path}): {e}")
    })?;
    parse_whisper_json(&text)
}

fn resolve_whisper_model(model: Option<&str>) -> Result<String, String> {
    if let Some(m) = model {
        if m.ends_with(".bin") {
            let p = PathBuf::from(m);
            if p.is_file() {
                return Ok(p.to_string_lossy().to_string());
            }
        }
    }

    let dirs = models::model_dirs();
    let candidates: Vec<String> = match model {
        Some(m) if !m.is_empty() => vec![format!("ggml-{m}.bin"), format!("{m}.bin")],
        _ => {
            let mut all: Vec<String> = Vec::new();
            for dir in &dirs {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        if let Some(name) = entry.file_name().to_str() {
                            if name.starts_with("ggml-") && name.ends_with(".bin") {
                                all.push(name.to_string());
                            }
                        }
                    }
                }
            }
            all.sort();
            all.dedup();
            // Prefer base.en, else first available.
            let mut ordered: Vec<String> = Vec::new();
            if all.iter().any(|n| n == "ggml-base.en.bin") {
                ordered.push("ggml-base.en.bin".to_string());
            }
            ordered.extend(all);
            ordered
        }
    };

    for dir in &dirs {
        for name in &candidates {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Ok(candidate.to_string_lossy().to_string());
            }
        }
    }

    Err(format!(
        "Whisper model '{}' not found in model directories",
        model.unwrap_or("<default>")
    ))
}

fn parse_whisper_json(text: &str) -> Result<Vec<NativeSegment>, String> {
    let value: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("Failed to parse whisper.cpp output: {e}"))?;

    let items = value
        .get("transcription")
        .and_then(|v| v.as_array())
        .or_else(|| value.get("segments").and_then(|v| v.as_array()))
        .or_else(|| value.as_array())
        .cloned()
        .unwrap_or_default();

    let mut segments = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let (start_ms, end_ms) = extract_times(&item);
        segments.push(NativeSegment {
            start_ms,
            end_ms,
            text,
        });
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
        let from = ts
            .get("from")
            .and_then(|v| v.as_str())
            .map(parse_timestamp)
            .unwrap_or(0.0);
        let to = ts
            .get("to")
            .and_then(|v| v.as_str())
            .map(parse_timestamp)
            .unwrap_or(0.0);
        return (from, to);
    }
    (0.0, 0.0)
}

/// Parse `"HH:MM:SS,mmm"` / `"HH:MM:SS.mmm"` into milliseconds.
fn parse_timestamp(raw: &str) -> f64 {
    let cleaned = raw.trim().replace(',', ".");
    let parts: Vec<&str> = cleaned.split(':').collect();
    let (h, m, s) = match parts.len() {
        3 => (
            parts[0].parse::<f64>().unwrap_or(0.0),
            parts[1].parse::<f64>().unwrap_or(0.0),
            parts[2].parse::<f64>().unwrap_or(0.0),
        ),
        2 => (
            0.0,
            parts[0].parse::<f64>().unwrap_or(0.0),
            parts[1].parse::<f64>().unwrap_or(0.0),
        ),
        1 => (0.0, 0.0, parts[0].parse::<f64>().unwrap_or(0.0)),
        _ => (0.0, 0.0, 0.0),
    };
    (h * 3600.0 + m * 60.0 + s) * 1000.0
}

// ---------------------------------------------------------------------------
// voxtype backend
// ---------------------------------------------------------------------------

fn transcribe_voxtype(
    slot: &Arc<Mutex<Option<Child>>>,
    bin: &str,
    wav: &Path,
    request: &TranscribeRequest,
    duration_ms: f64,
) -> Result<Vec<NativeSegment>, String> {
    let mut args: Vec<String> = Vec::new();

    if let Some(model) = request.model.as_deref() {
        if !model.is_empty() && !model.ends_with(".bin") && !model.contains('/') {
            args.push("--model".into());
            args.push(model.to_string());
        }
    }
    if let Some(engine) = request.engine.as_deref() {
        if !engine.is_empty() {
            args.push("--engine".into());
            args.push(engine.to_string());
        }
    }
    if let Some(language) = request.language.as_deref() {
        if !language.is_empty() {
            args.push("--language".into());
            args.push(language.to_string());
        }
    }

    args.push("transcribe".into());
    args.push(wav.to_string_lossy().to_string());

    let output = run_child(slot, bin, &args)?;
    let transcript = extract_voxtype_transcript(&output.stdout);
    if transcript.is_empty() {
        return Ok(Vec::new());
    }

    Ok(vec![NativeSegment {
        start_ms: 0.0,
        end_ms: duration_ms,
        text: transcript,
    }])
}

fn extract_voxtype_transcript(stdout: &str) -> String {
    let cleaned = strip_ansi(stdout);
    let mut last = String::new();
    for raw_line in cleaned.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if line.contains(" INFO ") || line.contains(" WARN ") || line.contains("ERROR ") {
            continue;
        }
        if line.starts_with("whisper_")
            || line.starts_with("Loading audio file")
            || line.starts_with("Audio format")
            || line.starts_with("Processing ")
        {
            continue;
        }
        last = line.to_string();
    }
    last
}

fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(&next) = chars.peek() {
                    chars.next();
                    if ('@'..='~').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

// ---------------------------------------------------------------------------
// Child process runner (killable, with timeout)
// ---------------------------------------------------------------------------

struct ChildOutput {
    #[allow(dead_code)]
    success: bool,
    stdout: String,
}

fn run_child(
    slot: &Arc<Mutex<Option<Child>>>,
    program: &str,
    args: &[String],
) -> Result<ChildOutput, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("Failed to spawn {program}: {e}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = stdout_pipe.map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });
    let stderr_handle = stderr_pipe.map(|mut pipe| {
        thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });

    {
        let mut guard = slot
            .lock()
            .map_err(|_| "transcription state lock poisoned".to_string())?;
        *guard = Some(child);
    }

    let deadline = Instant::now() + Duration::from_secs(MAX_TRANSCRIBE_SECS);
    let mut status = None;

    loop {
        {
            let mut guard = slot
                .lock()
                .map_err(|_| "transcription state lock poisoned".to_string())?;
            match guard.as_mut() {
                Some(proc) => match proc.try_wait() {
                    Ok(Some(exit)) => {
                        status = Some(exit);
                        *guard = None;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        *guard = None;
                        return Err(format!("Failed to wait for {program}: {e}"));
                    }
                },
                None => {
                    return Err("Transcription cancelled".to_string());
                }
            }
        }

        if status.is_some() {
            break;
        }

        if Instant::now() >= deadline {
            if let Ok(mut guard) = slot.lock() {
                if let Some(proc) = guard.as_mut() {
                    let _ = proc.kill();
                }
                *guard = None;
            }
            return Err("Transcription timed out".to_string());
        }

        thread::sleep(Duration::from_millis(100));
    }

    let stdout = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let _stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let success = status.map(|s| s.success()).unwrap_or(false);

    Ok(ChildOutput { success, stdout })
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

struct TempArtifacts {
    wav: PathBuf,
    base: PathBuf,
}

impl TempArtifacts {
    fn create() -> Self {
        let dir = std::env::temp_dir();
        let pid = std::process::id();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let base = dir.join(format!("local-transcribe-{pid}-{nanos}"));
        let wav = PathBuf::from(format!("{}.wav", base.to_string_lossy()));
        Self { wav, base }
    }
}

impl Drop for TempArtifacts {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.wav);

        let prefix = match self.base.file_name().and_then(|s| s.to_str()) {
            Some(name) => format!("{name}."),
            None => return,
        };
        if let Some(parent) = self.base.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    if let Some(name) = entry.file_name().to_str() {
                        if name.starts_with(&prefix) {
                            let _ = std::fs::remove_file(entry.path());
                        }
                    }
                }
            }
        }
    }
}

/// Decode the IPC audio payload. Prefers a RIFF/WAVE container (what the
/// desktop bridge actually sends); otherwise treats the bytes as a bare
/// little-endian f32 mono PCM stream.
fn decode_audio(raw: &[u8], declared_rate: u32) -> Result<(Vec<f32>, u32), String> {
    if raw.len() >= 12 && &raw[0..4] == b"RIFF" && &raw[8..12] == b"WAVE" {
        return parse_wav(raw);
    }
    if raw.len() % 4 != 0 {
        return Err("Audio payload length is not a multiple of 4 bytes".to_string());
    }
    let samples: Vec<f32> = raw
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let rate = if declared_rate == 0 { TARGET_SAMPLE_RATE } else { declared_rate };
    Ok((samples, rate))
}

/// Minimal RIFF/WAVE reader: PCM s16, PCM s32 and IEEE float32, mono or multi
/// channel (downmixed to mono).
fn parse_wav(raw: &[u8]) -> Result<(Vec<f32>, u32), String> {
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= raw.len() {
        let id = &raw[pos..pos + 4];
        let size = u32::from_le_bytes([raw[pos + 4], raw[pos + 5], raw[pos + 6], raw[pos + 7]])
            as usize;
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

        pos = body_end + (size & 1); // chunks are word-aligned
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
        let clamped = sample.clamp(-1.0, 1.0);
        let value = (clamped * 32767.0).round() as i32;
        let value = value.clamp(-32768, 32767) as i16;
        pcm.extend_from_slice(&value.to_le_bytes());
    }

    let data_len = pcm.len() as u32;
    let channels: u16 = 1;
    let bits: u16 = 16;
    let byte_rate = TARGET_SAMPLE_RATE * channels as u32 * (bits as u32 / 8);
    let block_align = channels * (bits / 8);

    let mut out: Vec<u8> = Vec::with_capacity(44 + pcm.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
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
    fn parses_offsets_json() {
        let json = r#"{"transcription":[
            {"offsets":{"from":0,"to":1200},"text":" hello "},
            {"offsets":{"from":1200,"to":2500},"text":""},
            {"offsets":{"from":2500,"to":4000},"text":"world"}
        ]}"#;
        let segments = parse_whisper_json(json).unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "hello");
        assert_eq!(segments[0].end_ms, 1200.0);
        assert_eq!(segments[1].start_ms, 2500.0);
    }

    #[test]
    fn parses_timestamp_json() {
        let json = r#"{"segments":[
            {"timestamps":{"from":"00:00:01,500","to":"00:00:03.000"},"text":"hi"}
        ]}"#;
        let segments = parse_whisper_json(json).unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].start_ms, 1500.0);
        assert_eq!(segments[0].end_ms, 3000.0);
    }

    #[test]
    fn strips_ansi_and_log_lines() {
        let input = "\u{1b}[32m2026-01-01 INFO  loading\u{1b}[0m\nwhisper_init: ok\nHello world\n";
        assert_eq!(extract_voxtype_transcript(input), "Hello world");
    }

    #[test]
    fn resamples_down_to_16k() {
        let input: Vec<f32> = (0..48000).map(|i| i as f32 / 48000.0).collect();
        let out = resample_linear(&input, 48000, 16000);
        assert_eq!(out.len(), 16000);
    }

    #[test]
    fn decodes_wav16_container() {
        let samples: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0];
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + 8).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&32000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&8u32.to_le_bytes());
        for s in &samples {
            wav.extend_from_slice(&((s * 32767.0) as i16).to_le_bytes());
        }
        let (decoded, rate) = decode_audio(&wav, 16000).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(decoded.len(), 4);
        assert!((decoded[3] - 1.0).abs() < 0.01);
    }

    #[test]
    fn decodes_raw_f32_fallback() {
        let mut raw = Vec::new();
        for s in [0.25f32, -0.75] {
            raw.extend_from_slice(&s.to_le_bytes());
        }
        let (decoded, rate) = decode_audio(&raw, 0).unwrap();
        assert_eq!(rate, 16000);
        assert_eq!(decoded, vec![0.25, -0.75]);
    }
}
