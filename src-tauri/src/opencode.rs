//! OpenCode sidecar: summarize meeting transcripts with the user's own
//! OpenCode setup (models + auth) via headless `opencode run`.
//!
//! The frontend selects this through the `opencode` LLM preset
//! (`src/integrations/llm.ts`). No OpenCode API key is needed here —
//! authentication lives in the user's OpenCode configuration.

use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Headless summarization can take a while on long transcripts.
const MAX_SUMMARIZE_SECS: u64 = 15 * 60;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub server_url: Option<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeSummarizeRequest {
    /// `provider/model` id as listed by `opencode models`.
    pub model: String,
    /// Full instruction (system prompt + meeting context).
    pub message: String,
    /// Transcript markdown, attached to the run via `--file`.
    pub transcript: String,
}

fn discover_opencode() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("OPENCODE_BIN") {
        let pb = PathBuf::from(raw);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(pb) = crate::models::which("opencode") {
        return Some(pb);
    }
    // Default install location of the official install script.
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    {
        let pb = home.join(".opencode").join("bin").join("opencode");
        if pb.is_file() {
            return Some(pb);
        }
    }
    None
}

fn first_line(text: &str) -> Option<String> {
    text.lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty())
        .map(|s| s.to_string())
}

fn quick_output(bin: &PathBuf, args: &[&str]) -> Option<String> {
    // Bounded wait: these are local informational commands, but `service
    // status` can block if the background service is wedged — never hang
    // the Settings "Test connection" button forever.
    let mut child = crate::process::command(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout_pipe = child.stdout.take();
    let handle = stdout_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    let success = loop {
        match child.try_wait() {
            Ok(Some(exit)) => break exit.success(),
            Ok(None) => {}
            Err(_) => break false,
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let out = handle.and_then(|h| h.join().ok()).unwrap_or_default();
    success.then(|| out)
}

fn collect_status(bin: PathBuf) -> OpencodeStatus {
    let path = bin.to_string_lossy().to_string();
    let version = quick_output(&bin, &["--version"]).and_then(|t| first_line(&t));
    let server_url =
        quick_output(&bin, &["service", "status"]).and_then(|t| first_line(&t));
    let models = quick_output(&bin, &["models"])
        .map(|t| {
            t.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    OpencodeStatus {
        available: true,
        binary_path: Some(path),
        version,
        server_url,
        models,
    }
}

#[tauri::command]
pub async fn native_opencode_status() -> OpencodeStatus {
    match discover_opencode() {
        Some(bin) => {
            tauri::async_runtime::spawn_blocking(|| collect_status(bin))
                .await
                .unwrap_or(OpencodeStatus {
                    available: false,
                    binary_path: None,
                    version: None,
                    server_url: None,
                    models: Vec::new(),
                })
        }
        None => OpencodeStatus {
            available: false,
            binary_path: None,
            version: None,
            server_url: None,
            models: Vec::new(),
        },
    }
}

struct TempTranscript {
    path: PathBuf,
}

impl TempTranscript {
    fn create(transcript: &str) -> Result<Self, String> {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "local-transcribe-opencode-{}-{}.md",
            std::process::id(),
            nanos
        ));
        std::fs::write(&path, transcript)
            .map_err(|e| format!("Failed to write transcript temp file: {e}"))?;
        Ok(Self { path })
    }
}

impl Drop for TempTranscript {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
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

fn summarize_blocking(
    bin: PathBuf,
    request: OpencodeSummarizeRequest,
) -> Result<String, String> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err("OpenCode settings incomplete: model".to_string());
    }
    let tmp = TempTranscript::create(&request.transcript)?;
    let file_arg = tmp.path.to_string_lossy().to_string();

    let mut child = crate::process::command(&bin)
        .args([
            "run",
            "--model",
            model,
            "--file",
            file_arg.as_str(),
            "--title",
            "Meeting summary",
            request.message.as_str(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start OpenCode: {e}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = stdout_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });
    let stderr_handle = stderr_pipe.map(|mut pipe| {
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = pipe.read_to_string(&mut buf);
            buf
        })
    });

    let deadline = Instant::now() + Duration::from_secs(MAX_SUMMARIZE_SECS);
    let status = loop {
        match child.try_wait().map_err(|e| format!("OpenCode wait failed: {e}"))? {
            Some(exit) => break exit,
            None => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("OpenCode summarization timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    };

    let stdout = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    // TempTranscript::drop removes the file here.
    drop(tmp);

    if !status.success() {
        let detail = strip_ansi(&stderr).trim().to_string();
        let snippet: String = detail.chars().take(300).collect();
        return Err(format!(
            "OpenCode run failed{}",
            if snippet.is_empty() {
                ".".to_string()
            } else {
                format!(": {snippet}")
            }
        ));
    }
    let text = strip_ansi(&stdout).trim().to_string();
    if text.is_empty() {
        return Err("OpenCode returned an empty reply".to_string());
    }
    Ok(text)
}

#[tauri::command]
pub async fn native_opencode_summarize(request: OpencodeSummarizeRequest) -> Result<String, String> {
    let bin = discover_opencode()
        .ok_or_else(|| "OpenCode CLI not found. Install it from opencode.ai.".to_string())?;
    tauri::async_runtime::spawn_blocking(|| summarize_blocking(bin, request))
        .await
        .map_err(|e| format!("OpenCode task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_sequences() {
        assert_eq!(strip_ansi("\u{1b}[32mok\u{1b}[0m").as_str(), "ok");
        assert_eq!(strip_ansi("plain").as_str(), "plain");
    }

    #[test]
    fn first_line_skips_blanks() {
        assert_eq!(first_line("\n  \nopencode 1.2.3\nmore").as_deref(), Some("opencode 1.2.3"));
        assert_eq!(first_line("   \n"), None);
    }

    #[test]
    fn temp_transcript_roundtrip_and_cleanup() {
        let path;
        {
            let tmp = TempTranscript::create("hello").expect("create");
            path = tmp.path.clone();
            assert_eq!(std::fs::read_to_string(&path).expect("read"), "hello");
        }
        assert!(!path.exists(), "temp file must be removed on drop");
    }
}
