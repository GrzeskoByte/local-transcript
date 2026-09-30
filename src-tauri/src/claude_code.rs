//! Claude Code sidecar: summarize meeting transcripts with the user's own
//! Claude Code login via headless `claude -p`.
//!
//! The frontend selects this through the `claude` LLM preset
//! (`src/integrations/llm.ts`). No API key is needed here — authentication
//! and billing are the user's Claude Code setup. Each run is saved as a named
//! Claude Code session (run from the home directory) and its id is returned,
//! so the user can continue with `claude --resume <id>`.

use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::opencode::{first_line, quick_output, strip_ansi};

/// Headless summarization can take a while on long transcripts.
const MAX_SUMMARIZE_SECS: u64 = 15 * 60;

/// `--model` aliases the CLI resolves to the latest model of each family.
const MODEL_ALIASES: [&str; 4] = ["opus", "sonnet", "haiku", "fable"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeStatus {
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSummarizeRequest {
    /// Alias (`opus`, `sonnet`, …) or a full model name.
    pub model: String,
    pub system: String,
    /// Instruction; the transcript is piped on stdin.
    pub message: String,
    pub transcript: String,
    /// Session display name (shown by `claude --resume`).
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSummarizeResult {
    pub text: String,
    pub session_id: Option<String>,
}

fn discover_claude() -> Option<PathBuf> {
    if let Some(raw) = std::env::var_os("CLAUDE_BIN") {
        let pb = PathBuf::from(raw);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(pb) = crate::models::which("claude") {
        return Some(pb);
    }
    // Launchers get a minimal PATH: try the native installer and mise shims.
    let home = crate::models::home_dir()?;
    [
        home.join(".claude").join("local").join("claude"),
        home.join(".local").join("share").join("mise").join("shims").join("claude"),
    ]
    .into_iter()
    .find(|pb| pb.is_file())
}

fn unavailable() -> ClaudeStatus {
    ClaudeStatus { available: false, binary_path: None, version: None, models: Vec::new() }
}

#[tauri::command]
pub async fn native_claude_status() -> ClaudeStatus {
    let Some(bin) = discover_claude() else { return unavailable() };
    tauri::async_runtime::spawn_blocking(move || ClaudeStatus {
        available: true,
        binary_path: Some(bin.to_string_lossy().to_string()),
        version: quick_output(&bin, &["--version"]).and_then(|t| first_line(&t)),
        models: MODEL_ALIASES.iter().map(|m| m.to_string()).collect(),
    })
    .await
    .unwrap_or_else(|_| unavailable())
}

/// Parse `--output-format json`: `{ result, session_id, is_error }`.
fn parse_result(stdout: &str) -> Result<ClaudeSummarizeResult, String> {
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .map_err(|_| "Claude Code returned an unexpected reply".to_string())?;
    let text = value.get("result").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if value.get("is_error").and_then(|v| v.as_bool()).unwrap_or(false) {
        let snippet: String = text.chars().take(300).collect();
        return Err(format!(
            "Claude Code failed{}",
            if snippet.is_empty() { ".".to_string() } else { format!(": {snippet}") }
        ));
    }
    if text.is_empty() {
        return Err("Claude Code returned an empty reply".to_string());
    }
    let session_id = value.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(ClaudeSummarizeResult { text, session_id })
}

fn summarize_blocking(
    bin: PathBuf,
    request: ClaudeSummarizeRequest,
) -> Result<ClaudeSummarizeResult, String> {
    let model = request.model.trim();
    if model.is_empty() {
        return Err("Claude Code settings incomplete: model".to_string());
    }
    let mut cmd = crate::proc::command(&bin);
    cmd.args([
        "-p",
        request.message.as_str(),
        "--model",
        model,
        "--output-format",
        "json",
        // Summarize only: no tools, no MCP servers.
        "--tools",
        "",
        "--strict-mcp-config",
        "--system-prompt",
        request.system.as_str(),
        "-n",
        request.title.as_str(),
    ])
    // Launched from a Claude Code terminal (dev), the CLI would refuse to nest.
    .env_remove("CLAUDECODE")
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    // Sessions are grouped by directory: home keeps them in one findable place.
    if let Some(home) = crate::models::home_dir() {
        cmd.current_dir(home);
    }
    let mut child = cmd.spawn().map_err(|e| format!("Failed to start Claude Code: {e}"))?;

    // Transcripts can exceed argv limits: pipe them on stdin.
    let stdin_handle = child.stdin.take().map(|mut pipe| {
        let transcript = request.transcript.clone();
        std::thread::spawn(move || {
            let _ = pipe.write_all(transcript.as_bytes());
        })
    });
    let read_pipe = |pipe: Option<Box<dyn Read + Send>>| {
        pipe.map(|mut p| {
            std::thread::spawn(move || {
                let mut buf = String::new();
                let _ = p.read_to_string(&mut buf);
                buf
            })
        })
    };
    let stdout_handle = read_pipe(child.stdout.take().map(|p| Box::new(p) as Box<dyn Read + Send>));
    let stderr_handle = read_pipe(child.stderr.take().map(|p| Box::new(p) as Box<dyn Read + Send>));

    let deadline = Instant::now() + Duration::from_secs(MAX_SUMMARIZE_SECS);
    let status = loop {
        if let Some(exit) = child.try_wait().map_err(|e| format!("Claude Code wait failed: {e}"))? {
            break exit;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            return Err("Claude Code summarization timed out".to_string());
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    if let Some(h) = stdin_handle {
        let _ = h.join();
    }
    let stdout = stdout_handle.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = stderr_handle.and_then(|h| h.join().ok()).unwrap_or_default();

    // A failed run still prints its JSON result (with is_error) on stdout.
    let parsed = parse_result(&stdout);
    let reported = matches!(&parsed, Err(e) if e.starts_with("Claude Code failed"));
    if status.success() || parsed.is_ok() || reported {
        return parsed;
    }
    let detail = strip_ansi(&stderr).trim().to_string();
    let snippet: String = detail.chars().take(300).collect();
    Err(format!(
        "Claude Code run failed{}",
        if snippet.is_empty() { ".".to_string() } else { format!(": {snippet}") }
    ))
}

#[tauri::command]
pub async fn native_claude_summarize(
    request: ClaudeSummarizeRequest,
) -> Result<ClaudeSummarizeResult, String> {
    let bin = discover_claude().ok_or_else(|| {
        "Claude Code CLI not found. Install it from claude.com/claude-code and run `claude` once to log in."
            .to_string()
    })?;
    tauri::async_runtime::spawn_blocking(|| summarize_blocking(bin, request))
        .await
        .map_err(|e| format!("Claude Code task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_success_with_session() {
        let out = r#"{"type":"result","subtype":"success","is_error":false,"result":" # Summary\nok ","session_id":"abc"}"#;
        let r = parse_result(out).expect("ok");
        assert_eq!(r.text, "# Summary\nok");
        assert_eq!(r.session_id.as_deref(), Some("abc"));
    }

    #[test]
    fn reports_errors_and_empty_replies() {
        let err = parse_result(r#"{"is_error":true,"result":"Not logged in"}"#).unwrap_err();
        assert!(err.contains("Not logged in"), "{err}");
        assert!(parse_result(r#"{"is_error":false,"result":""}"#).unwrap_err().contains("empty"));
        assert!(parse_result("garbage").is_err());
    }

    /// Runs the real CLI (needs `claude` logged in): `cargo test -- --ignored claude`.
    #[test]
    #[ignore]
    fn real_cli_smoke() {
        let bin = discover_claude().expect("claude on PATH");
        let r = summarize_blocking(
            bin,
            ClaudeSummarizeRequest {
                model: "haiku".into(),
                system: "Reply in Markdown with '# Summary' and '# Key points' sections.".into(),
                message: "Summarize the meeting. Its transcript is attached below.".into(),
                transcript: "Alice: the launch moves to Friday. Bob: I'll update the docs.".into(),
                title: "Meeting summary: smoke test".into(),
            },
        )
        .expect("summary");
        assert!(r.text.contains("Friday"), "{}", r.text);
        assert!(r.session_id.is_some());
    }
}
