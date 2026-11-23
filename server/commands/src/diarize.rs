//! Speaker detection, per user: runs the bundled sherpa-onnx diarizer.
// Ported from src-tauri/src/diarize.rs: progress and cancel are per user (the
// desktop module keeps one global run), the runtime folder is `EngineConfig.diarize_dir`,
// the temp WAV has a unique name, and at most `MAX_RUNS` run at once server-wide.
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

use crate::util::{lock, unique_path};
use crate::Engine;

const BIN: &str = "sherpa-onnx-offline-speaker-diarization";
const SEGMENTATION: &str = "segmentation.onnx";
const EMBEDDING: &str = "embedding.onnx";
/// Clustering threshold for TitaNet-small embeddings (higher = fewer speakers).
const THRESHOLD: f32 = 0.8;
pub const MAX_RUNS: usize = 2;

#[derive(Default)]
struct UserRun {
    running: AtomicBool,
    child: Mutex<Option<Child>>,
    /// 0..10000 (percent × 100) of the last run.
    progress: AtomicU32,
}

#[derive(Default)]
pub struct DiarizeState {
    users: Mutex<HashMap<String, Arc<UserRun>>>,
    active: AtomicUsize,
}

impl DiarizeState {
    fn user(&self, user: &str) -> Arc<UserRun> {
        lock(&self.users).entry(user.to_string()).or_default().clone()
    }

    /// Forget a user's state (account deleted) after cancelling their run.
    pub fn forget(&self, user: &str) {
        if let Some(run) = lock(&self.users).remove(user) {
            kill(&run);
        }
    }
}

fn kill(run: &UserRun) {
    if let Some(mut child) = lock(&run.child).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarizeStatus {
    pub available: bool,
    pub dir: Option<String>,
}

fn is_complete(dir: &Path) -> bool {
    dir.join(BIN).is_file() && dir.join(SEGMENTATION).is_file() && dir.join(EMBEDDING).is_file()
}

fn runtime_dir(engine: &Engine) -> Option<PathBuf> {
    engine.config.diarize_dir.clone().filter(|d| is_complete(d))
}

pub fn status(engine: &Engine) -> DiarizeStatus {
    let dir = runtime_dir(engine);
    DiarizeStatus { available: dir.is_some(), dir: dir.map(|d| d.to_string_lossy().to_string()) }
}

/// 0..100 of the user's run.
pub fn progress(engine: &Engine, user: &str) -> f32 {
    engine.diarize.user(user).progress.load(Ordering::Relaxed) as f32 / 100.0
}

pub fn cancel(engine: &Engine, user: &str) {
    kill(&engine.diarize.user(user));
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

/// Body: 16 kHz mono WAV; `speakers` = a known count (≤ 0 = detect). Blocking.
pub fn run_blocking(engine: &Engine, user: &str, wav: &[u8], speakers: i32) -> Result<String, String> {
    let dir = runtime_dir(engine).ok_or("Speaker detection is not installed on this server.")?;
    if wav.len() < 44 || &wav[..4] != b"RIFF" {
        return Err("The audio is not a WAV file.".into());
    }
    let run = engine.diarize.user(user);
    if run.running.swap(true, Ordering::SeqCst) {
        return Err("Speaker detection is already running.".into());
    }
    if engine.diarize.active.fetch_add(1, Ordering::SeqCst) >= MAX_RUNS {
        engine.diarize.active.fetch_sub(1, Ordering::SeqCst);
        run.running.store(false, Ordering::SeqCst);
        return Err("Speaker detection is busy on this server. Try again in a minute.".into());
    }
    run.progress.store(0, Ordering::Relaxed);
    let tmp_dir = engine.tmp_dir();
    let result = run_cli(&dir, &tmp_dir, &run, wav, speakers);
    run.progress.store(10_000, Ordering::Relaxed);
    engine.diarize.active.fetch_sub(1, Ordering::SeqCst);
    run.running.store(false, Ordering::SeqCst);
    result
}

fn run_cli(dir: &Path, tmp_dir: &Path, run: &Arc<UserRun>, wav: &[u8], speakers: i32) -> Result<String, String> {
    std::fs::create_dir_all(tmp_dir).map_err(|e| format!("Could not create the scratch folder: {e}"))?;
    let tmp = unique_path(tmp_dir, "diarize").with_extension("wav");
    std::fs::write(&tmp, wav).map_err(|e| format!("Could not write the audio: {e}"))?;
    let result = (|| {
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
        let mut child = cmd.spawn().map_err(|_| "Could not start speaker detection.".to_string())?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *lock(&run.child) = Some(child);
        // Progress lines may come on either stream; keep stdout for the turns.
        let err_run = run.clone();
        let err_reader = std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(s) = stderr {
                for line in BufReader::new(s).lines().map_while(Result::ok) {
                    if let Some(p) = parse_progress(&line) {
                        err_run.progress.store((p * 100.0) as u32, Ordering::Relaxed);
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
                    run.progress.store((p * 100.0) as u32, Ordering::Relaxed);
                } else {
                    out.push_str(&line);
                    out.push('\n');
                }
            }
        }
        let status = lock(&run.child).take().map(|mut c| c.wait());
        let err_text = err_reader.join().unwrap_or_default();
        match status {
            Some(Ok(s)) if s.success() => Ok(turns_only(&out)),
            Some(Ok(_)) | None => {
                let tail: String = err_text.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
                Err(if tail.is_empty() { "Speaker detection stopped.".into() } else { format!("Speaker detection failed: {tail}") })
            }
            Some(Err(e)) => Err(format!("Speaker detection failed: {e}")),
        }
    })();
    let _ = std::fs::remove_file(&tmp);
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
}
