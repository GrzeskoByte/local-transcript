//! Phonon-2 (FermionResearch/Phonon-2, a five-value quantised Parakeet TDT
//! 0.6B v3, ~164 MB) through the Phonon CLI (`pip install fermion-research`,
//! command `phonon`). Runs on CPU (Linux x86-64/Arm, Windows x64, Intel Macs)
//! and MLX on Apple silicon; the app never installs Python packages itself.
//!
//! It sits *next to* the main backend (bundled whisper.cpp / voxtype): the
//! model `phonon-2` shows up in the catalog whenever the CLI is found, and a
//! request for it is routed here whatever the main backend is.
//!
//! Privacy: the CLI's code and native libraries were checked for telemetry
//! (none). It goes online only through `huggingface_hub` to fetch the model,
//! which happens only in [`download`] (the Download button). Transcription
//! runs with `HF_HUB_OFFLINE=1`, so it can never reach the network.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use std::process::Child;

use crate::models::{self, NativeModel};
use crate::native_asr::NativeSegment;

/// Model name the app uses (also the CLI's alias for the repo).
pub const MODEL: &str = "phonon-2";
const REPO_DIR: &str = "FermionResearch__Phonon-2";
const HUB_DIR: &str = "models--FermionResearch--Phonon-2";
/// `_catalog.SPEECH_PROFILES["five-value"]["unpack_dir"]` in fermion-research.
const UNPACK_DIR: &str = "model_phonon2_c4c_int6";
/// Download size of the archive (`config.json` → `artifact.download_bytes`).
pub const DOWNLOAD_BYTES: u64 = 163_515_201;
pub const INSTALL_HINT: &str = "Install the Phonon CLI: pipx install fermion-research \
     (or pip install fermion-research; Python 3.10+). On Apple silicon also: \
     pip install mlx mlx-audio mlx-lm soundfile scipy zstandard.";

pub fn is_phonon_model(name: Option<&str>) -> bool {
    matches!(name, Some(n) if n.eq_ignore_ascii_case(MODEL))
}

/// `$PHONON_CLI_PATH`, else `phonon` on PATH (+ `~/.local/bin`, Homebrew dirs).
pub fn discover() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("PHONON_CLI_PATH") {
        let pb = PathBuf::from(raw);
        if pb.is_file() {
            return Some(pb);
        }
    }
    models::which("phonon")
}

/// Same rule as `fermion.cli._cache_dir` / `_cache_override`.
fn fermion_cache_root() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("FERMION_CACHE_DIR") {
        return Some(PathBuf::from(d));
    }
    models::home_dir().map(|h| h.join(".cache").join("fermion"))
}

/// `fetch.profile_dir(repo, unpack_dir)`: where the unpacked model lives.
pub fn model_dir() -> Option<PathBuf> {
    fermion_cache_root().map(|r| r.join("speech").join(REPO_DIR).join(UNPACK_DIR))
}

/// `fetch.is_model_dir`: both files, so a half-unpacked tree is not "ready".
fn is_model_dir(dir: &Path) -> bool {
    dir.join("config.json").is_file() && dir.join("packed_manifest.json").is_file()
}

pub fn installed() -> bool {
    model_dir().map(|d| is_model_dir(&d)).unwrap_or(false)
}

/// The catalog entry. Listed even without the CLI so the model is
/// discoverable; it is then not downloadable and says how to get the CLI.
pub fn catalog_model(cli: Option<&Path>) -> NativeModel {
    let installed = cli.is_some() && installed();
    let mut detail = format!("~{} MB · English · Parakeet TDT, Phonon CLI", DOWNLOAD_BYTES / 1_000_000);
    if cli.is_none() {
        detail.push_str(" · requires the Phonon CLI (pip install fermion-research)");
    }
    NativeModel {
        name: MODEL.to_string(),
        engine: "phonon".to_string(),
        installed,
        downloadable: cli.is_some(),
        path: if installed { model_dir().map(|d| d.to_string_lossy().to_string()) } else { None },
        size_bytes: Some(DOWNLOAD_BYTES),
        accuracy: 6,
        recommended: false,
        detail,
    }
}

/// Environment for every Phonon child: no Hugging Face telemetry, no
/// progress bars on the pipe, no deprecation chatter.
fn quiet_env(cmd: &mut std::process::Command) {
    cmd.env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        .env("DO_NOT_TRACK", "1")
        .env("FERMION_QUIET_DEPRECATIONS", "1");
}

/// `phonon transcribe --download-only`: fetch, verify (pinned SHA-256) and
/// unpack the model. Only ever called from the Download button.
pub fn download(cli: &Path) -> Result<(), String> {
    if installed() {
        return Ok(());
    }
    let mut cmd = crate::proc::command(cli);
    cmd.args(["transcribe", "--download-only"]);
    quiet_env(&mut cmd);
    let out = cmd.output().map_err(|e| format!("Could not run the Phonon CLI: {e}"))?;
    if out.status.success() && installed() {
        return Ok(());
    }
    Err(format!("Phonon model download failed: {}", last_lines(&out.stderr, &out.stdout)))
}

/// Hugging Face hub cache the CLI downloads into (`cli._download_cache_root`).
fn hub_cache_root() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("FERMION_CACHE_DIR") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("HF_HUB_CACHE") {
        return Some(PathBuf::from(d));
    }
    if let Some(d) = std::env::var_os("HF_HOME") {
        return Some(PathBuf::from(d).join("hub"));
    }
    models::home_dir().map(|h| h.join(".cache").join("huggingface").join("hub"))
}

/// (received, total, done) for the progress bar: the growing `*.incomplete`
/// blob in the hub cache. Best effort — 0 received keeps the bar indeterminate.
pub fn download_progress() -> (u64, u64, bool) {
    if installed() {
        return (DOWNLOAD_BYTES, DOWNLOAD_BYTES, true);
    }
    let blobs = match hub_cache_root() {
        Some(r) => r.join(HUB_DIR).join("blobs"),
        None => return (0, DOWNLOAD_BYTES, false),
    };
    let received = std::fs::read_dir(&blobs)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.metadata().ok())
                .map(|m| m.len())
                .filter(|n| *n <= DOWNLOAD_BYTES)
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    (received, DOWNLOAD_BYTES, false)
}

/// `phonon transcribe <wav> --json`, offline. Returns timestamped segments.
pub fn transcribe(
    slot: &Arc<Mutex<Option<Child>>>,
    cli: &Path,
    wav: &Path,
) -> Result<Vec<NativeSegment>, String> {
    if !installed() {
        return Err("The Phonon-2 model is not downloaded yet. Download it in Settings → Models.".to_string());
    }
    let mut cmd = crate::proc::command(cli);
    cmd.arg("transcribe").arg(wav).arg("--json");
    quiet_env(&mut cmd);
    // The model is on disk: never let the CLI go online while transcribing.
    cmd.env("HF_HUB_OFFLINE", "1");
    let out = crate::native_asr::run_command(slot, cmd, "phonon")?;
    if !out.success {
        return Err(format!("Phonon failed: {}", last_lines(out.stderr.as_bytes(), out.stdout.as_bytes())));
    }
    parse_json(&out.stdout)
}

/// The JSON object is the last non-empty stdout line (notes go to stderr).
pub fn parse_json(stdout: &str) -> Result<Vec<NativeSegment>, String> {
    let line = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| l.starts_with('{'))
        .ok_or_else(|| "Phonon printed no transcript".to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("Could not read Phonon's output: {e}"))?;
    let secs = |v: &serde_json::Value, k: &str| v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0) * 1000.0;
    let mut segments: Vec<NativeSegment> = value
        .get("segments")
        .and_then(|s| s.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = item.get("text")?.as_str()?.trim().to_string();
                    (!text.is_empty()).then(|| NativeSegment {
                        start_ms: secs(item, "start"),
                        end_ms: secs(item, "end"),
                        text,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    if segments.is_empty() {
        let text = value.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        if !text.is_empty() {
            let end = value.get("duration_seconds").and_then(|d| d.as_f64()).unwrap_or(0.0) * 1000.0;
            segments.push(NativeSegment { start_ms: 0.0, end_ms: end, text });
        }
    }
    Ok(segments)
}

fn last_lines(stderr: &[u8], stdout: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let text = if err.trim().is_empty() { String::from_utf8_lossy(stdout) } else { err };
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(3)..].join(" ");
    if tail.is_empty() { "no output".to_string() } else { tail }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_segments_in_seconds() {
        let out = "noise\n{\"text\": \"Hello there. General.\", \"segments\": [{\"id\": 0, \"start\": 0.32, \"end\": 1.5, \"text\": \"Hello there.\"}, {\"id\": 1, \"start\": 2.0, \"end\": 2.75, \"text\": \" General. \"}], \"duration_seconds\": 3.0}\n";
        let segs = parse_json(out).unwrap();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].start_ms, 320.0);
        assert_eq!(segs[0].end_ms, 1500.0);
        assert_eq!(segs[1].text, "General.");
    }

    #[test]
    fn falls_back_to_text() {
        let segs = parse_json("{\"text\": \"Only text\", \"duration_seconds\": 2.5}").unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].end_ms, 2500.0);
    }

    #[test]
    fn empty_transcript_is_no_segments() {
        assert!(parse_json("{\"text\": \"\", \"segments\": []}").unwrap().is_empty());
        assert!(parse_json("").is_err());
    }

    #[test]
    fn model_name_matches_case_insensitively() {
        assert!(is_phonon_model(Some("phonon-2")));
        assert!(is_phonon_model(Some("Phonon-2")));
        assert!(!is_phonon_model(Some("parakeet-tdt-0.6b-v3")));
        assert!(!is_phonon_model(None));
    }

    #[test]
    fn model_dir_follows_the_cli_layout() {
        let dir = model_dir().unwrap();
        assert!(dir.ends_with("speech/FermionResearch__Phonon-2/model_phonon2_c4c_int6"));
    }
}
