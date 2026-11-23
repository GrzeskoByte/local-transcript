//! Per-user command handlers for the server edition (`docs/SERVER.md` → `POST /api/invoke/:cmd`).
//!
//! INTERFACE STUB — the HTTP layer (`lt-server`) codes against these signatures;
//! the bodies are filled in by the commands work package. Keep the signatures.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::Value;

/// The signed-in user. Built by the HTTP layer from the session; handlers resolve
/// every path from `user_dir` and never from client input.
#[derive(Clone, Debug)]
pub struct UserCtx {
    pub user_id: String,
    /// `/data/users/<uid>` — created by the HTTP layer before the first call.
    pub user_dir: PathBuf,
    pub is_admin: bool,
    /// 0 = unlimited.
    pub quota_bytes: u64,
}

#[derive(Clone, Debug)]
pub struct EngineConfig {
    /// `/data`
    pub data_dir: PathBuf,
    /// whisper-cli; `None` = discover like `src-tauri/src/models.rs`.
    pub whisper_cli: Option<PathBuf>,
    pub diarize_dir: Option<PathBuf>,
    /// Encrypts per-user settings at rest.
    pub secret_key: [u8; 32],
}

/// Shared state across users: model dir, ASR queue, live slots, download progress.
pub struct Engine {
    pub config: EngineConfig,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Arc<Self> {
        Arc::new(Self { config })
    }
}

pub enum Body {
    Json(Value),
    /// Raw-body commands (`invokeDesktopRaw`): bytes + lower-cased `x-*` headers.
    Raw { bytes: Vec<u8>, headers: HashMap<String, String> },
}

pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
}

#[derive(Debug)]
pub enum CommandError {
    /// Unknown or unsupported command → 404.
    NotFound(String),
    /// Admin-only command called by a member → 403.
    Forbidden(String),
    /// The command's `Err(String)` → 400.
    Failed(String),
}

/// Run one command for `ctx`.
pub async fn dispatch(_engine: &Engine, _ctx: &UserCtx, cmd: &str, _body: Body) -> Result<Reply, CommandError> {
    Err(CommandError::NotFound(format!("Unknown command: {cmd}")))
}

/// Commands this user may call (shown in `/api/me`).
pub fn capabilities(_is_admin: bool) -> Vec<&'static str> {
    Vec::new()
}

/// Bytes used under `user_dir` (quota + admin list).
pub fn usage_bytes(_user_dir: &Path) -> u64 {
    0
}

/// Zip of the user's data: meetings.db as JSON, recordings, decrypted settings.
pub async fn export_user(_engine: &Engine, _ctx: &UserCtx) -> Result<Vec<u8>, String> {
    Err("not implemented".into())
}

/// Cancel the user's jobs and remove `user_dir` entirely.
pub async fn delete_user_data(_engine: &Engine, _ctx: &UserCtx) -> Result<(), String> {
    Err("not implemented".into())
}
