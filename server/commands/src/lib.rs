//! Per-user command handlers for the server edition (`docs/SERVER.md` → `POST /api/invoke/:cmd`).
//!
//! The HTTP layer (`lt-server`) codes against the public items of this file
//! (`UserCtx`, `Engine`, `dispatch`, `capabilities`, `usage_bytes`, `export_user`,
//! `delete_user_data`); the handlers live in the modules below. Same command
//! names, argument names and result shapes as the Tauri commands in
//! `src-tauri/src`, but every path is resolved from `UserCtx.user_dir`.
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use serde::Serialize;
use serde_json::Value;

mod asr;
mod calendar;
mod db;
mod diarize;
mod jobs;
mod live;
mod models;
#[path = "../../../src-tauri/src/proc.rs"]
mod proc;
mod queue;
mod recordings;
mod settings;
mod util;

use util::Args;

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
    pub calendar_allowed_hosts: Vec<String>,
    /// Encrypts per-user settings at rest.
    pub secret_key: [u8; 32],
}

/// Shared state across users: model dir, ASR queue, live slots, download progress.
pub struct Engine {
    pub config: EngineConfig,
    me: Weak<Engine>,
    pub(crate) asr: asr::AsrState,
    pub(crate) live: live::LiveState,
    pub(crate) diarize: diarize::DiarizeState,
    recording_writes: Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>,
}

impl Engine {
    pub fn new(config: EngineConfig) -> Arc<Self> {
        // Scratch files of a previous run (a crash mid-transcription).
        let _ = std::fs::remove_dir_all(config.data_dir.join("tmp"));
        Arc::new_cyclic(|me| Self {
            config,
            me: me.clone(),
            asr: asr::AsrState::new(),
            live: live::LiveState::new(),
            diarize: diarize::DiarizeState::default(),
            recording_writes: Mutex::default(),
        })
    }

    fn recording_write_lock(&self, dir: &Path) -> Arc<Mutex<()>> {
        let mut locks = util::lock(&self.recording_writes);
        locks.retain(|_, lock| lock.strong_count() != 0);
        let lock = locks.entry(dir.to_owned()).or_default();
        if let Some(current) = lock.upgrade() {
            return current;
        }
        let current = Arc::new(Mutex::new(()));
        *lock = Arc::downgrade(&current);
        current
    }

    /// An owning handle, for work that moves to a blocking thread.
    pub(crate) fn arc(&self) -> Arc<Engine> {
        self.me.upgrade().expect("an Engine only exists inside the Arc made by Engine::new")
    }
}

pub enum Body {
    Json(Value),
    /// Raw-body commands (`invokeDesktopRaw`): bytes + lower-cased `x-*` headers.
    Raw { bytes: Vec<u8>, headers: HashMap<String, String> },
}

pub enum Reply {
    Json(Value),
    Recording(Vec<PathBuf>),
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

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        CommandError::Failed(message)
    }
}

type Outcome = Result<Reply, CommandError>;

/// Commands every signed-in user may call.
const MEMBER_COMMANDS: &[&str] = &[
    "native_settings_load",
    "native_settings_set",
    "native_recording_write",
    "native_recording_write_meta",
    "native_recording_read_meta",
    "native_recording_list",
    "native_recording_read",
    "native_recording_delete",
    "native_asr_status",
    "native_asr_models",
    "native_asr_transcribe",
    "native_asr_cancel",
    "native_asr_download_progress",
    "native_live_transcribe",
    "native_live_cancel",
    "native_diarize_status",
    "native_diarize_run",
    "native_diarize_progress",
    "native_diarize_cancel",
    "native_calendar_test",
    "native_calendar_create",
    "native_calendar_fetch",
    "native_calendar_probe",
    "server_db_get",
    "server_db_get_all",
    "server_db_get_by_index",
    "server_db_put",
    "server_db_delete",
    "server_db_put_if_exists",
    "server_db_patch",
    "server_db_put_if_unchanged",
    "server_db_commit_transcript",
    "server_db_set_segment_speakers",
    "server_db_delete_meeting",
];

/// Commands only admins may call (shared server resources).
const ADMIN_COMMANDS: &[&str] = &["native_asr_download_model", "native_asr_enable_gpu"];

/// Run one command for `ctx`.
pub async fn dispatch(engine: &Engine, ctx: &UserCtx, cmd: &str, body: Body) -> Outcome {
    if ADMIN_COMMANDS.contains(&cmd) && !ctx.is_admin {
        return Err(CommandError::Forbidden(format!("{cmd} is only available to admins.")));
    }
    if !MEMBER_COMMANDS.contains(&cmd) && !ADMIN_COMMANDS.contains(&cmd) {
        return Err(CommandError::NotFound(format!("{cmd} is not available in the server edition")));
    }
    let engine = engine.arc();
    let ctx = ctx.clone();
    let user = ctx.user_id.clone();
    let dir = ctx.user_dir.clone();

    // The one raw-body command.
    if cmd == "native_diarize_run" {
        let Body::Raw { bytes, headers } = body else {
            return Err("Expected the audio as the request body.".to_string().into());
        };
        let speakers: i32 = headers
            .get("x-num-speakers")
            .and_then(|v| v.parse().ok())
            .filter(|n: &i32| *n > 0 && *n <= 20)
            .unwrap_or(-1);
        let text = blocking(move || diarize::run_blocking(&engine, &user, &bytes, speakers)).await?;
        return json(text);
    }

    let mut args = match body {
        Body::Json(v) => Args::from_value(v)?,
        Body::Raw { .. } => return Err("This command takes JSON arguments.".to_string().into()),
    };

    match cmd {
        // --- settings ---------------------------------------------------------
        "native_settings_load" => {
            let key = engine.config.secret_key;
            json(blocking(move || Ok(settings::load(&dir, &key))).await?)
        }
        "native_settings_set" => {
            let (name, value): (String, Value) = (args.get("key")?, args.raw("value")?);
            let key = engine.config.secret_key;
            blocking(move || settings::set(&dir, &key, &name, value)).await?;
            json(())
        }

        // --- recordings ---------------------------------------------------------
        "native_recording_write" => {
            let request: recordings::WriteChunkRequest = args.get("request")?;
            blocking(move || {
                let lock = engine.recording_write_lock(&dir);
                let _guard = util::lock(&lock);
                recordings::write_chunk(&dir, &request, ctx.quota_bytes)
            }).await?;
            json(())
        }
        "native_recording_write_meta" => {
            let (id, meta): (String, String) = (args.get("meetingId")?, args.get("meta")?);
            blocking(move || {
                let lock = engine.recording_write_lock(&dir);
                let _guard = util::lock(&lock);
                recordings::write_meta(&dir, &id, &meta)
            }).await?;
            json(())
        }
        "native_recording_read_meta" => {
            let id: String = args.get("meetingId")?;
            json(blocking(move || recordings::read_meta(&dir, &id)).await?)
        }
        "native_recording_list" => {
            let id: String = args.get("meetingId")?;
            json(blocking(move || recordings::list(&dir, &id)).await?)
        }
        "native_recording_read" => {
            let id: String = args.get("meetingId")?;
            let track: String = args.opt("track")?.unwrap_or_default();
            Ok(Reply::Recording(blocking(move || recordings::track_paths(&dir, &id, &track)).await?))
        }
        "native_recording_delete" => {
            let id: String = args.get("meetingId")?;
            blocking(move || recordings::delete(&dir, &id)).await?;
            json(())
        }

        // --- ASR ----------------------------------------------------------------
        "native_asr_status" => json(blocking(move || Ok(asr::status(&engine))).await?),
        "native_asr_models" => json(blocking(move || Ok(asr::models_list(&engine))).await?),
        "native_asr_download_progress" => {
            let name: String = args.get("name")?;
            json(asr::download_progress(&engine, &name)?)
        }
        "native_asr_download_model" => {
            let name: String = args.get("name")?;
            blocking(move || asr::download_model(&engine, &name)).await?;
            json(())
        }
        "native_asr_enable_gpu" => Err(CommandError::Failed(
            "GPU acceleration is configured by whoever runs this server (use a GPU-enabled whisper.cpp build).".into(),
        )),
        "native_asr_transcribe" => {
            let request: asr::TranscribeRequest = args.take("request")?;
            json(asr::transcribe(&engine, &user, request).await?)
        }
        "native_asr_cancel" => {
            asr::cancel(&engine, &user);
            json(())
        }

        // --- live ---------------------------------------------------------------
        "native_live_transcribe" => {
            let request: live::LiveTranscribeRequest = args.take("request")?;
            json(live::transcribe(&engine, &user, request).await?)
        }
        "native_live_cancel" => {
            live::cancel(&engine, &user);
            json(())
        }

        // --- diarization ----------------------------------------------------------
        "native_diarize_status" => json(diarize::status(&engine)),
        "native_diarize_progress" => json(diarize::progress(&engine, &user)),
        "native_diarize_cancel" => {
            diarize::cancel(&engine, &user);
            json(())
        }

        // --- calendar -------------------------------------------------------------
        "native_calendar_test" => {
            let request: calendar::CalendarTestRequest = args.get("request")?;
            json(blocking(move || calendar::test(&request, &engine.config.calendar_allowed_hosts)).await?)
        }
        "native_calendar_create" | "native_calendar_fetch" => {
            let request: calendar::CalendarCreateRequest = args.get("request")?;
            json(blocking(move || calendar::send(&request, &engine.config.calendar_allowed_hosts)).await?)
        }
        "native_calendar_probe" => {
            let request: calendar::ProbeRequest = args.get("request")?;
            json(blocking(move || calendar::probe(&request, &engine.config.calendar_allowed_hosts)).await?)
        }

        // --- meeting database -------------------------------------------------------
        _ => {
            let Some(sub) = cmd.strip_prefix("server_db_") else {
                return Err(CommandError::NotFound(format!("{cmd} is not available in the server edition")));
            };
            let sub = sub.to_string();
            Ok(Reply::Json(blocking(move || db::handle(&dir, &sub, &args)).await?))
        }
    }
}

/// Run blocking work off the async runtime.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, CommandError> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result.map_err(CommandError::Failed),
        Err(e) => Err(CommandError::Failed(format!("Background task failed: {e}"))),
    }
}

fn json<T: Serialize>(value: T) -> Outcome {
    serde_json::to_value(value)
        .map(Reply::Json)
        .map_err(|e| CommandError::Failed(format!("Could not encode the result: {e}")))
}

/// Commands this user may call (shown in `/api/me`).
pub fn capabilities(is_admin: bool) -> Vec<&'static str> {
    let mut all: Vec<&'static str> = MEMBER_COMMANDS.to_vec();
    if is_admin {
        all.extend_from_slice(ADMIN_COMMANDS);
    }
    all
}

/// Bytes used under `user_dir` (quota + admin list).
pub fn usage_bytes(user_dir: &Path) -> u64 {
    util::dir_size(user_dir)
}

/// Zip of the user's data: meetings/segments/kv as JSON, decrypted settings, recordings.
pub async fn export_user(engine: &Engine, ctx: &UserCtx) -> Result<std::fs::File, String> {
    let dir = ctx.user_dir.clone();
    let key = engine.config.secret_key;
    tokio::task::spawn_blocking(move || export_blocking(&dir, &key))
        .await
        .map_err(|e| format!("Export task failed: {e}"))?
}

fn export_blocking(dir: &Path, key: &[u8; 32]) -> Result<std::fs::File, String> {
    use std::io::Seek;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    let zip_err = |e: zip::result::ZipError| format!("Could not build the export: {e}");
    let io_err = |e: std::io::Error| format!("Could not build the export: {e}");
    // The OS removes the scratch file when its last handle closes, including on disconnect.
    let mut zip = ZipWriter::new(tempfile::tempfile_in(dir).map_err(io_err)?);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);

    {
        let mut conn = db::db_path(dir).is_file().then(|| db::open(dir)).transpose()?;
        let snapshot = conn.as_mut().map(|conn| conn.transaction()).transpose()
            .map_err(|e| format!("Database error: {e}"))?;
        for store in ["meetings", "segments", "kv"] {
            zip.start_file(format!("{store}.json"), deflated).map_err(zip_err)?;
            db::export_table(snapshot.as_deref(), store, &mut zip)?;
        }
    }
    zip.start_file("settings.json", deflated).map_err(zip_err)?;
    serde_json::to_writer_pretty(&mut zip, &settings::load(dir, key))
        .map_err(|e| format!("Could not encode the export: {e}"))?;

    // Audio chunks are already compressed (Opus): store them as they are.
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored).large_file(true);
    for top in ["recordings", "files"] {
        let mut stack = vec![dir.join(top)];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else { continue };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|e| e.file_name());
            for entry in entries {
                let path = entry.path();
                let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
                if meta.is_dir() {
                    stack.push(path);
                } else if meta.is_file() && path.extension().map(|e| e != "part").unwrap_or(true) {
                    let rel = path.strip_prefix(dir).map_err(|_| "Invalid path".to_string())?;
                    let name = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
                    zip.start_file(name, stored).map_err(zip_err)?;
                    let mut file = std::fs::File::open(&path).map_err(io_err)?;
                    std::io::copy(&mut file, &mut zip).map_err(io_err)?;
                }
            }
        }
    }
    let mut file = zip.finish().map_err(zip_err)?;
    file.rewind().map_err(io_err)?;
    Ok(file)
}

/// Cancel the user's jobs and remove `user_dir` entirely.
pub async fn delete_user_data(engine: &Engine, ctx: &UserCtx) -> Result<(), String> {
    asr::cancel(engine, &ctx.user_id);
    live::cancel(engine, &ctx.user_id);
    engine.diarize.forget(&ctx.user_id);
    let dir = ctx.user_dir.clone();
    tokio::task::spawn_blocking(move || match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete the user's data: {e}")),
    })
    .await
    .map_err(|e| format!("Delete task failed: {e}"))?
}

#[cfg(test)]
mod tests;
