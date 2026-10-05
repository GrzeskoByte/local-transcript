//! Live transcription while recording.
//!
//! The webview cuts the recording's audio into short utterances (≤24 s, cut at
//! pauses) and sends each one here as it ends. Two engines:
//!  - `"whistle"`: Cactus Whistle (16.9 MB, CPU, 7 languages) run through the
//!    Cactus `needle` engine binary. Both files are downloaded on request into
//!    `<app_model_dir>/whistle/` from Hugging Face (Apache-2.0).
//!  - `"native"`: the regular whisper.cpp / voxtype backend with an installed
//!    model (the same path as whole-file transcription).
//!
//! Live runs use their own child-process slot, so cancelling a whole-file
//! transcription never kills the live one (and vice versa).

use std::path::PathBuf;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::models;
use crate::native_asr::{
    self, decode_audio, resample_linear, run_child_with_env, write_wav, DownloadProgress,
    NativeSegment, TempArtifacts, TranscribeRequest, TARGET_SAMPLE_RATE,
};

const ENGINE_BASE_URL: &str = "https://huggingface.co/Cactus-Compute/needle3/resolve/main";
const MODEL_URL: &str = "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact";
const MODEL_FILE: &str = "whistle.cact";
/// Whistle reads at most 30 s per pass; the webview sends ≤24 s.
const MAX_WHISTLE_SECS: f64 = 30.0;
/// Languages Whistle can be pinned to (anything else is auto-detected).
const WHISTLE_LANGUAGES: [&str; 7] = ["en", "de", "fr", "es", "it", "nl", "pl"];
/// The engine documents no language flag for its CLI runner: try it once and
/// fall back to auto-detect for good if the runner rejects it.
static LANGUAGE_FLAG_UNSUPPORTED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct LiveState {
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscribeRequest {
    /// A 16 kHz mono WAV (or bare f32 PCM), base64 encoded.
    pub samples_base64: String,
    pub sample_rate: u32,
    /// `"whistle"` | `"native"`.
    pub engine: String,
    /// Native model name for the `"native"` engine.
    #[serde(default)]
    pub model: Option<String>,
    /// `"auto"` | `"en"` | ...
    #[serde(default)]
    pub language: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhistleStatus {
    /// A Whistle engine build exists for this OS/CPU.
    pub supported: bool,
    /// Engine and weights are on disk.
    pub installed: bool,
    pub platform: Option<String>,
    pub dir: Option<String>,
}

/// Folder of the Cactus engine build for this OS/CPU (see the needle3 repo).
fn engine_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        ("macos", "aarch64") => Some("macos-arm64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("windows", "aarch64") => Some("windows-arm64"),
        _ => None,
    }
}

fn engine_file() -> &'static str {
    if cfg!(windows) {
        "needle.exe"
    } else {
        "needle"
    }
}

fn whistle_dir() -> Option<PathBuf> {
    models::app_model_dir().map(|d| d.join("whistle"))
}

/// (engine, weights) paths when both are installed.
fn installed_paths() -> Option<(PathBuf, PathBuf)> {
    let dir = whistle_dir()?;
    let engine = dir.join(engine_file());
    let model = dir.join(MODEL_FILE);
    (engine.is_file() && model.is_file()).then_some((engine, model))
}

#[tauri::command]
pub fn native_whistle_status() -> WhistleStatus {
    WhistleStatus {
        supported: engine_platform().is_some(),
        installed: installed_paths().is_some(),
        platform: engine_platform().map(str::to_string),
        dir: whistle_dir().map(|d| d.to_string_lossy().to_string()),
    }
}

/// Expected total bytes of the download in flight (0 = unknown).
fn download_total() -> &'static Mutex<u64> {
    static TOTAL: std::sync::OnceLock<Mutex<u64>> = std::sync::OnceLock::new();
    TOTAL.get_or_init(|| Mutex::new(0))
}

fn file_len(path: &std::path::Path) -> u64 {
    path.metadata().map(|m| m.len()).unwrap_or(0)
}

#[tauri::command]
pub fn native_whistle_download_progress() -> Result<DownloadProgress, String> {
    let dir = whistle_dir().ok_or_else(|| "No model directory is configured.".to_string())?;
    let done = installed_paths().is_some();
    let received: u64 = [engine_file(), MODEL_FILE]
        .iter()
        .map(|name| file_len(&dir.join(name)) + file_len(&dir.join(format!("{name}.part"))))
        .sum();
    let total = download_total().lock().map(|t| *t).unwrap_or(0);
    Ok(DownloadProgress { received, total: total.max(if done { received } else { 0 }), done })
}

#[tauri::command]
pub async fn native_whistle_download() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(download_blocking)
        .await
        .map_err(|e| format!("Download task failed: {e}"))?
}

fn download_blocking() -> Result<(), String> {
    let platform = engine_platform().ok_or_else(|| {
        "Whistle has no engine build for this computer (Intel Macs are not supported).".to_string()
    })?;
    let dir = whistle_dir().ok_or_else(|| "No model directory is configured.".to_string())?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let files = [
        (format!("{ENGINE_BASE_URL}/{platform}/{}", engine_file()), engine_file()),
        (MODEL_URL.to_string(), MODEL_FILE),
    ];
    let sizes: Vec<Option<u64>> = files.iter().map(|(url, _)| native_asr::remote_size(url)).collect();
    if let Ok(mut total) = download_total().lock() {
        *total = sizes.iter().map(|s| s.unwrap_or(0)).sum();
    }
    for ((url, name), expected) in files.iter().zip(sizes) {
        let dest = dir.join(name);
        if dest.is_file() && expected.map_or(true, |size| file_len(&dest) == size) {
            continue;
        }
        let tmp = dir.join(format!("{name}.part"));
        let _ = std::fs::remove_file(&tmp);
        native_asr::download_with_system_tools(url, &tmp)?;
        let got = file_len(&tmp);
        if let Some(size) = expected {
            if got != size {
                let _ = std::fs::remove_file(&tmp);
                return Err(format!(
                    "Whistle download was incomplete ({got} of {size} bytes). Check your connection and retry."
                ));
            }
        }
        make_executable(&tmp, *name == engine_file())?;
        std::fs::rename(&tmp, &dest).map_err(|e| format!("Could not save {name}: {e}"))?;
    }
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &std::path::Path, executable: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if !executable {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("Could not mark the Whistle engine executable: {e}"))
}

#[cfg(not(unix))]
fn make_executable(_path: &std::path::Path, _executable: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn native_live_transcribe(
    state: State<'_, LiveState>,
    request: LiveTranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    let slot = state.child.clone();
    tauri::async_runtime::spawn_blocking(move || live_blocking(&slot, request))
        .await
        .map_err(|e| format!("Live transcription task failed: {e}"))?
}

#[tauri::command]
pub fn native_live_cancel(state: State<'_, LiveState>) -> Result<(), String> {
    let mut guard = state
        .child
        .lock()
        .map_err(|_| "live transcription state lock poisoned".to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

fn live_blocking(
    slot: &Arc<Mutex<Option<Child>>>,
    request: LiveTranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    match request.engine.as_str() {
        "whistle" => transcribe_whistle(slot, &request),
        "native" => {
            if let Some(model) = request.model.as_deref() {
                if !native_asr::valid_model_name(model) {
                    return Err(format!("Invalid model name: {model}"));
                }
            }
            native_asr::transcribe_blocking(
                slot,
                TranscribeRequest {
                    samples_base64: request.samples_base64,
                    sample_rate: request.sample_rate,
                    model: request.model,
                    engine: None,
                    language: request.language,
                },
            )
        }
        other => Err(format!("Unknown live transcription engine: {other}")),
    }
}

fn transcribe_whistle(
    slot: &Arc<Mutex<Option<Child>>>,
    request: &LiveTranscribeRequest,
) -> Result<Vec<NativeSegment>, String> {
    let (engine, model) = installed_paths()
        .ok_or_else(|| "Whistle is not downloaded yet (Settings → Models → Live transcription).".to_string())?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(request.samples_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 audio: {e}"))?;
    let (samples, rate) = decode_audio(&raw, request.sample_rate)?;
    let mut samples = if rate != TARGET_SAMPLE_RATE && rate != 0 {
        resample_linear(&samples, rate, TARGET_SAMPLE_RATE)
    } else {
        samples
    };
    samples.truncate((MAX_WHISTLE_SECS * TARGET_SAMPLE_RATE as f64) as usize);
    if samples.is_empty() {
        return Ok(Vec::new());
    }
    let duration_ms = samples.len() as f64 / TARGET_SAMPLE_RATE as f64 * 1000.0;

    let artifacts = TempArtifacts::create();
    write_wav(&artifacts.wav, &samples)?;
    let mut args: Vec<String> = vec![
        "--model".into(),
        model.to_string_lossy().to_string(),
        "--audio".into(),
        artifacts.wav.to_string_lossy().to_string(),
    ];
    let language = whistle_language(request.language.as_deref());
    let pinned = language.is_some() && !LANGUAGE_FLAG_UNSUPPORTED.load(Ordering::Relaxed);
    if pinned {
        args.push("--audio-language".into());
        args.push(language.unwrap_or_default().to_string());
    }
    // The engine binary sends nothing over the network; these opt-outs cover
    // the Cactus tooling in case a future runner gains telemetry.
    let envs = [("NEEDLE_TELEMETRY", "0"), ("DO_NOT_TRACK", "1")];
    let engine_path = engine.to_string_lossy().to_string();
    let mut out = run_child_with_env(slot, &engine_path, &args, &envs)?;
    if !out.success && pinned {
        LANGUAGE_FLAG_UNSUPPORTED.store(true, Ordering::Relaxed);
        args.truncate(4);
        out = run_child_with_env(slot, &engine_path, &args, &envs)?;
    }
    if !out.success {
        let detail = native_asr::strip_ansi(&out.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "The Whistle engine failed.".to_string()
        } else {
            format!("The Whistle engine failed: {detail}")
        });
    }
    let text = parse_whistle_output(&out.stdout);
    if text.is_empty() {
        return Ok(Vec::new());
    }
    Ok(vec![NativeSegment { start_ms: 0.0, end_ms: duration_ms, text }])
}

/// A language Whistle can be pinned to, or None to auto-detect.
fn whistle_language(language: Option<&str>) -> Option<&str> {
    language.filter(|l| WHISTLE_LANGUAGES.contains(l))
}

/// The transcript from the runner's stdout: its JSON object (`text`, or
/// `audio_text` when the runner merges speech fields under an `audio_`
/// prefix), else the last plain line.
fn parse_whistle_output(stdout: &str) -> String {
    let cleaned = native_asr::strip_ansi(stdout);
    let json_text = |value: &serde_json::Value| -> Option<String> {
        ["text", "audio_text"]
            .iter()
            .find_map(|k| value.get(*k).and_then(|v| v.as_str()))
            .map(|s| s.trim().to_string())
    };
    if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if start < end {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(&cleaned[start..=end]) {
                if let Some(text) = json_text(&value) {
                    return text;
                }
            }
        }
    }
    for line in cleaned.lines().rev() {
        let line = line.trim();
        if line.starts_with('{') {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(text) = json_text(&value) {
                    return text;
                }
            }
            continue;
        }
        if !line.is_empty() {
            return line.to_string();
        }
    }
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_transcribe_json() {
        let out = r#"{"text":" turn off the kitchen lights ","language":"en","ttft_ms":11.0,"decode_tps":1300.0}"#;
        assert_eq!(parse_whistle_output(out), "turn off the kitchen lights");
    }

    #[test]
    fn parses_audio_prefixed_json_after_log_lines() {
        let out = "loading whistle.cact\n{\"function_calls\":[],\"audio_text\":\"hallo zusammen\",\"audio_language\":\"de\"}\n";
        assert_eq!(parse_whistle_output(out), "hallo zusammen");
    }

    #[test]
    fn silence_gives_empty_text() {
        assert_eq!(parse_whistle_output(r#"{"text":"","language":""}"#), "");
        assert_eq!(parse_whistle_output(""), "");
    }

    #[test]
    fn falls_back_to_last_plain_line() {
        assert_eq!(parse_whistle_output("\u{1b}[2mready\u{1b}[0m\nhello world\n"), "hello world");
    }

    #[test]
    fn pins_only_whistle_languages() {
        assert_eq!(whistle_language(Some("pl")), Some("pl"));
        assert_eq!(whistle_language(Some("auto")), None);
        assert_eq!(whistle_language(Some("ja")), None);
        assert_eq!(whistle_language(None), None);
    }

    #[test]
    fn platform_folder_matches_needle3_layout() {
        if let Some(p) = engine_platform() {
            assert!(["linux-x86_64", "linux-arm64", "macos-arm64", "windows-x86_64", "windows-arm64"].contains(&p));
        }
    }
}
