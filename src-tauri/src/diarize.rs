//! Speaker detection ("who said what"), fully local: runs the bundled
//! sherpa-onnx `sherpa-onnx-offline-speaker-diarization` CLI with the
//! pyannote segmentation model and a NeMo TitaNet speaker-embedding model
//! (fetched into `src-tauri/diarize/` by `scripts/fetch-diarizer.sh` and
//! shipped as a resource). No network, no telemetry.
//!
//! The webview sends 16 kHz mono WAV as the raw request body and gets the
//! CLI's "start -- end speaker_NN" lines back (parsed in `src/domain/speakers.ts`).
//! Commands: `native_diarize_status`, `native_diarize_run`,
//! `native_diarize_progress`, `native_diarize_cancel`.

use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Manager};

const BIN: &str = if cfg!(windows) {
    "sherpa-onnx-offline-speaker-diarization.exe"
} else {
    "sherpa-onnx-offline-speaker-diarization"
};
const SEGMENTATION: &str = "segmentation.onnx";
const EMBEDDING: &str = "embedding.onnx";
/// Clustering threshold for TitaNet-small embeddings (higher = fewer speakers);
/// 0.8 split the sherpa-onnx four-speaker sample correctly.
const THRESHOLD: f32 = 0.8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizeStatus {
    pub available: bool,
    pub dir: Option<String>,
}

/// Folder holding the CLI, its onnxruntime library and both models.
fn runtime_dir(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("LT_DIARIZE_DIR") {
        candidates.push(PathBuf::from(dir));
    }
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("diarize"));
    }
    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        candidates.push(exe_dir.join("diarize"));
        // `npm run tauri:dev`: src-tauri/target/debug → src-tauri/diarize
        candidates.push(exe_dir.join("../../diarize"));
    }
    candidates.into_iter().find(|d| is_complete(d))
}

fn is_complete(dir: &Path) -> bool {
    dir.join(BIN).is_file() && dir.join(SEGMENTATION).is_file() && dir.join(EMBEDDING).is_file()
}

struct Run {
    child: Arc<Mutex<Option<Child>>>,
}

fn running() -> &'static Mutex<Option<Run>> {
    static R: OnceLock<Mutex<Option<Run>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

fn progress() -> &'static AtomicU32 {
    static P: AtomicU32 = AtomicU32::new(0);
    &P
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// "progress 42.67%" → 42.67
fn parse_progress(line: &str) -> Option<f32> {
    line.trim().strip_prefix("progress ")?.trim_end_matches('%').trim().parse().ok()
}

/// Only the "start -- end speaker_NN" lines of the CLI's output.
fn turns_only(stdout: &str) -> String {
    stdout
        .lines()
        .filter(|l| {
            let parts: Vec<&str> = l.split_whitespace().collect();
            parts.len() == 4 && parts[1] == "--" && parts[3].starts_with("speaker_")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[tauri::command]
pub fn native_diarize_status(app: AppHandle) -> DiarizeStatus {
    let dir = runtime_dir(&app);
    DiarizeStatus { available: dir.is_some(), dir: dir.map(|d| d.to_string_lossy().to_string()) }
}

/// 0..100 of the run in flight.
#[tauri::command]
pub fn native_diarize_progress() -> f32 {
    progress().load(Ordering::Relaxed) as f32 / 100.0
}

#[tauri::command]
pub fn native_diarize_cancel() {
    if let Some(run) = lock(running()).as_ref() {
        if let Some(child) = lock(&run.child).as_mut() {
            let _ = child.kill();
        }
    }
}

/// Body: 16 kHz mono WAV. Header `x-num-speakers`: a known count (0 = detect).
#[tauri::command]
pub async fn native_diarize_run(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let tauri::ipc::InvokeBody::Raw(wav) = request.body() else {
        return Err("Expected the audio as the request body.".into());
    };
    let speakers: i32 = request
        .headers()
        .get("x-num-speakers")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .filter(|n: &i32| *n > 0 && *n <= 20)
        .unwrap_or(-1);
    let dir = runtime_dir(&app).ok_or("Speaker detection is not installed in this build.")?;
    let wav = wav.clone();
    crate::recordings::off_main(move || run_blocking(&dir, &wav, speakers)).await
}

fn run_blocking(dir: &Path, wav: &[u8], speakers: i32) -> Result<String, String> {
    if wav.len() < 44 || &wav[..4] != b"RIFF" {
        return Err("The audio is not a WAV file.".into());
    }
    let child_slot = {
        let mut r = lock(running());
        if r.is_some() {
            return Err("Speaker detection is already running.".into());
        }
        let slot = Arc::new(Mutex::new(None));
        *r = Some(Run { child: slot.clone() });
        slot
    };
    progress().store(0, Ordering::Relaxed);
    let result = (|| {
        let tmp = std::env::temp_dir().join(format!("lt-diarize-{}.wav", std::process::id()));
        std::fs::write(&tmp, wav).map_err(|e| format!("Could not write the audio: {e}"))?;
        let threads = std::thread::available_parallelism().map(|n| n.get().min(4)).unwrap_or(2);
        let mut cmd = crate::proc::command(dir.join(BIN));
        cmd.arg(format!("--segmentation.pyannote-model={}", dir.join(SEGMENTATION).display()))
            .arg(format!("--embedding.model={}", dir.join(EMBEDDING).display()))
            .arg(format!("--segmentation.num-threads={threads}"))
            .arg(format!("--embedding.num-threads={threads}"))
            .arg(format!("--clustering.num-clusters={speakers}"))
            .arg(format!("--clustering.cluster-threshold={THRESHOLD}"))
            .arg(&tmp)
            .current_dir(dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Windows/macOS look for onnxruntime next to the binary; Linux via RPATH $ORIGIN.
        if cfg!(target_os = "macos") {
            cmd.env("DYLD_LIBRARY_PATH", dir);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start speaker detection: {e}"))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *lock(&child_slot) = Some(child);
        // Progress lines may come on either stream; keep stdout for the turns.
        let err_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(s) = stderr {
                for line in BufReader::new(s).lines().map_while(Result::ok) {
                    if let Some(p) = parse_progress(&line) {
                        progress().store((p * 100.0) as u32, Ordering::Relaxed);
                    } else {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
            }
            text
        });
        let mut out = String::new();
        if let Some(s) = stdout {
            for line in BufReader::new(s).lines().map_while(Result::ok) {
                if let Some(p) = parse_progress(&line) {
                    progress().store((p * 100.0) as u32, Ordering::Relaxed);
                } else {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        let status = lock(&child_slot).take().map(|mut c| c.wait());
        let err_text = err_reader.join().unwrap_or_default();
        let _ = std::fs::remove_file(&tmp);
        match status {
            Some(Ok(s)) if s.success() => Ok(turns_only(&out)),
            Some(Ok(_)) | None => {
                let tail: String = err_text.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
                Err(if tail.is_empty() { "Speaker detection stopped.".into() } else { format!("Speaker detection failed: {tail}") })
            }
            Some(Err(e)) => Err(format!("Speaker detection failed: {e}")),
        }
    })();
    *lock(running()) = None;
    progress().store(10_000, Ordering::Relaxed);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_progress_lines() {
        assert_eq!(parse_progress("progress 42.67%"), Some(42.67));
        assert_eq!(parse_progress("0.638 -- 6.848 speaker_00"), None);
    }

    #[test]
    fn keeps_only_turn_lines() {
        let out = "Started\n0.638 -- 6.848 speaker_00\nDuration : 56.861 s\n7.017 -- 10.679 speaker_01\n";
        assert_eq!(turns_only(out), "0.638 -- 6.848 speaker_00\n7.017 -- 10.679 speaker_01");
    }

    #[test]
    fn a_folder_without_models_is_not_a_runtime() {
        assert!(!is_complete(&std::env::temp_dir().join("lt-no-such-diarizer")));
    }

    /// Real run: `LT_DIARIZE_DIR=… LT_DIARIZE_WAV=… cargo test --lib -- --ignored diarizes`
    #[test]
    #[ignore]
    fn diarizes_a_real_recording() {
        let dir = PathBuf::from(std::env::var("LT_DIARIZE_DIR").expect("LT_DIARIZE_DIR"));
        let wav = std::fs::read(std::env::var("LT_DIARIZE_WAV").expect("LT_DIARIZE_WAV")).unwrap();
        let out = run_blocking(&dir, &wav, -1).unwrap();
        eprintln!("{out}");
        assert!(out.lines().count() > 1);
    }
}
