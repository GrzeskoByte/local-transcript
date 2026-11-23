//! Live transcription while recording.
// Ported from src-tauri/src/live_asr.rs: the regular whisper.cpp path on its own
// child slot per user (so `native_asr_cancel` never kills it), not queued behind
// whole-file jobs, at most `MAX_LIVE` at once server-wide.
use std::sync::Arc;

use serde::Deserialize;

use crate::asr::{self, NativeSegment, TranscribeRequest};
use crate::jobs::{CancelOnDrop, JobRegistry};
use crate::models;
use crate::Engine;

pub const MAX_LIVE: usize = 2;
const BUSY: &str = "Live transcription is busy on this server";

pub struct LiveState {
    pub jobs: Arc<JobRegistry>,
}

impl LiveState {
    pub fn new() -> Self {
        Self { jobs: JobRegistry::new() }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscribeRequest {
    /// A 16 kHz mono WAV (or bare f32 PCM), base64 encoded.
    pub samples_base64: String,
    #[serde(default)]
    pub sample_rate: u32,
    /// Native model name, e.g. `"base"`.
    pub model: String,
    #[serde(default)]
    pub language: Option<String>,
}

pub async fn transcribe(engine: &Engine, user: &str, request: LiveTranscribeRequest) -> Result<Vec<NativeSegment>, String> {
    if !models::valid_model_name(&request.model) {
        return Err(format!("Invalid model name: {}", request.model));
    }
    let backend = engine.backend().ok_or_else(|| "No transcription backend available".to_string())?;
    let guard = engine.live.jobs.try_register(user, MAX_LIVE, 1).ok_or_else(|| BUSY.to_string())?;
    let _abort = CancelOnDrop(guard.ctl.clone());
    let (models_dir, tmp_dir) = (engine.models_dir(), engine.tmp_dir());
    let request = TranscribeRequest {
        samples_base64: request.samples_base64,
        sample_rate: request.sample_rate,
        model: Some(request.model),
        engine: None,
        language: request.language,
    };
    tokio::task::spawn_blocking(move || {
        let guard = guard;
        let Some(prepared) = asr::prepare(&models_dir, &tmp_dir, &request)? else { return Ok(Vec::new()) };
        asr::run_whisper(&backend, &prepared, &guard.ctl)
    })
    .await
    .map_err(|e| format!("Live transcription task failed: {e}"))?
}

pub fn cancel(engine: &Engine, user: &str) {
    engine.live.jobs.cancel_user(user);
}
