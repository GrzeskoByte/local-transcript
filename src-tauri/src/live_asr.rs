//! Live transcription while recording.
//!
//! The webview cuts the recording's audio into short utterances (≤10 s, cut at
//! pauses) and sends each one here as it ends. They are transcribed by the
//! regular whisper.cpp / voxtype backend with an installed model — the same
//! fully local path as whole-file transcription; nothing leaves the computer.
//!
//! Live runs use their own child-process slot, so cancelling a whole-file
//! transcription never kills the live one (and vice versa).

use std::process::Child;
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::State;

use crate::native_asr::{self, NativeSegment, TranscribeRequest};

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
    /// Native model name, e.g. `"base"`.
    pub model: String,
    /// `"auto"` | `"en"` | ...
    #[serde(default)]
    pub language: Option<String>,
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
    if !native_asr::valid_model_name(&request.model) {
        return Err(format!("Invalid model name: {}", request.model));
    }
    native_asr::transcribe_blocking(
        slot,
        TranscribeRequest {
            samples_base64: request.samples_base64,
            sample_rate: request.sample_rate,
            model: Some(request.model),
            engine: None,
            language: request.language,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_model_paths_before_spawning() {
        let slot = Arc::new(Mutex::new(None));
        let request = LiveTranscribeRequest {
            samples_base64: String::new(),
            sample_rate: 16000,
            model: "../../etc/passwd".into(),
            language: None,
        };
        assert!(live_blocking(&slot, request).unwrap_err().starts_with("Invalid model name"));
    }
}
