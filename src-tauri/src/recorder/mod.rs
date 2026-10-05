//! Native recording: capture, mix, Opus-encode and store audio in Rust, on
//! every OS. The webview owns no capture or MediaRecorder pipeline, so Stop
//! cannot freeze the window (WebKitGTK tore those down on its main thread for
//! seconds — minutes on long recordings). The webview polls for status,
//! levels, diagnostics and live-transcription audio.
//!
//! Commands: `native_recorder_devices`, `native_recorder_start`,
//! `native_recorder_pause`, `native_recorder_resume`, `native_recorder_poll`,
//! `native_recorder_retry`, `native_recorder_live_take`, `native_recorder_stop`,
//! and `native_audio_decode` (Ogg Opus → PCM for playback/transcription).

mod capture;
mod dsp;
mod engine;
mod ogg;
mod stats;

use capture::{Capture, InputRequest, Role};
use engine::{ChunkStore, Diagnostics, Engine, Input, MIME_TYPE};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// An input this far (3 s, in 48 kHz samples) behind real time has stalled:
/// pad it. Generous: PulseAudio/PipeWire deliver in bursts of up to ~2 s.
const STALL: u64 = 48_000 * 3;
const TICK: Duration = Duration::from_millis(10);
const CAPTURE_STOP_TIMEOUT: Duration = Duration::from_secs(5);
/// Longest wait at Stop for audio still in the sound server.
const DELIVERY_WAIT: Duration = Duration::from_millis(2500);
const ENGINE_STOP_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub meeting_id: String,
    /// 'speaker' (microphone), 'device' (system sound) or 'dual' (both, mixed).
    pub mode: String,
    #[serde(default)]
    pub microphone: Option<String>,
    #[serde(default)]
    pub output: Option<String>,
    /// Path inside the user's meeting folder to append the audio to.
    #[serde(default)]
    pub mirror_path: Option<String>,
    #[serde(default)]
    pub live: bool,
    pub started_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReply {
    pub mime_type: String,
    pub inputs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// 'idle' | 'recording' | 'paused' | 'error'
    pub state: String,
    pub meeting_id: Option<String>,
    pub elapsed_ms: u64,
    pub chunks: u32,
    pub unsaved_chunks: usize,
    pub error: Option<String>,
    /// 'source' (a device is gone) | 'storage' (chunks could not be written)
    pub error_kind: Option<String>,
    pub levels: Vec<f64>,
    pub mirror_ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Diagnostics>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReply {
    pub mime_type: String,
    pub duration_ms: u64,
    pub chunk_count: u32,
    pub unsaved_chunks: usize,
    pub mirror_ok: bool,
    pub diagnostics: Diagnostics,
}

struct Shared {
    engine: Mutex<Engine>,
    paused: AtomicBool,
    stop: AtomicBool,
    /// Timeline position of Stop: audio up to it is kept.
    stop_pos: AtomicU64,
}

struct Session {
    meeting_id: String,
    shared: Arc<Shared>,
    capture: Option<Capture>,
    done: mpsc::Receiver<()>,
}

fn session() -> &'static Mutex<Option<Session>> {
    static SESSION: OnceLock<Mutex<Option<Session>>> = OnceLock::new();
    SESSION.get_or_init(|| Mutex::new(None))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Runs the engine: a frame is mixed as soon as every input delivered its
/// audio; an input that is `STALL` behind real time gets silence there, so
/// the recording keeps growing. Paused stretches are skipped by position, so
/// audio a sound server delivers late still lands where it belongs.
fn run(shared: Arc<Shared>, done: mpsc::Sender<()>) {
    loop {
        std::thread::sleep(TICK);
        let mut engine = lock(&shared.engine);
        if shared.stop.load(Ordering::SeqCst) {
            // Everything up to Stop (or to the pause it was stopped in).
            engine.mix_until(shared.stop_pos.load(Ordering::SeqCst));
            engine.finish();
            break;
        }
        while engine.frame_ready() {
            engine.frame();
        }
        let now = engine.now_pos();
        engine.mix_until(now.saturating_sub(STALL));
        engine.discard_paused();
    }
    let _ = done.send(());
}

fn status_of(meeting_id: &str, shared: &Shared, diagnostics: bool) -> Status {
    let engine = lock(&shared.engine);
    let (error, error_kind) = if let Some(lost) = &engine.source_lost {
        (Some(lost.clone()), Some("source".to_string()))
    } else if engine.store.unsaved() > 0 {
        (engine.store.last_error.clone().or(Some("Audio could not be saved.".into())), Some("storage".to_string()))
    } else {
        (None, None)
    };
    let state = if error.is_some() {
        "error"
    } else if shared.paused.load(Ordering::SeqCst) {
        "paused"
    } else {
        "recording"
    };
    Status {
        state: state.into(),
        meeting_id: Some(meeting_id.to_string()),
        elapsed_ms: engine.elapsed_ms(),
        chunks: engine.store.written(),
        unsaved_chunks: engine.store.unsaved(),
        error,
        error_kind,
        levels: engine.levels(),
        mirror_ok: engine.store.mirror_ok,
        diagnostics: diagnostics.then(|| engine.diagnostics()),
    }
}

fn start_blocking(app_root: std::path::PathBuf, mirror_root: Option<std::path::PathBuf>, req: StartRequest) -> Result<StartReply, String> {
    if lock(session()).is_some() {
        return Err("A recording is already running.".into());
    }
    let roles: Vec<Role> = match req.mode.as_str() {
        "speaker" => vec![Role::Microphone],
        "device" => vec![Role::Device],
        "dual" => vec![Role::Microphone, Role::Device],
        other => return Err(format!("Unknown recording mode: {other}")),
    };
    let dir = crate::recordings::meeting_dir(&app_root, &req.meeting_id)?;
    let mirror = match (&req.mirror_path, mirror_root) {
        (Some(rel), Some(root)) => Some(root.join(crate::storage::safe_relative(rel)?)),
        _ => None,
    };
    let requests = roles
        .iter()
        .map(|&role| InputRequest {
            role,
            device: match role {
                Role::Microphone => req.microphone.clone(),
                Role::Device => req.output.clone(),
            },
        })
        .collect();
    let (capture, opened) = capture::start(requests)?;
    let names: Vec<String> = opened.iter().map(|o| o.settings.label.clone().unwrap_or_default()).collect();
    let inputs = opened.into_iter().map(|o| (Input::new(o.role, o.buffer), o.settings)).collect();
    let serial = (req.started_at as u32) ^ std::process::id();
    let engine = match Engine::new(inputs, ChunkStore::new(dir.clone(), mirror), req.live, serial) {
        Ok(e) => e,
        Err(e) => {
            capture.stop(CAPTURE_STOP_TIMEOUT);
            return Err(e);
        }
    };
    let meta = serde_json::json!({ "mimeType": MIME_TYPE, "startedAt": req.started_at, "native": true });
    if let Err(e) = crate::recordings::write_atomic(&dir.join("meta.json"), meta.to_string().as_bytes()) {
        capture.stop(CAPTURE_STOP_TIMEOUT);
        return Err(e);
    }
    let shared = Arc::new(Shared {
        engine: Mutex::new(engine),
        paused: AtomicBool::new(false),
        stop: AtomicBool::new(false),
        stop_pos: AtomicU64::new(0),
    });
    let (done_tx, done_rx) = mpsc::channel();
    let worker = shared.clone();
    std::thread::Builder::new()
        .name("lt-recorder".into())
        .spawn(move || run(worker, done_tx))
        .map_err(|e| format!("Could not start the recorder: {e}"))?;
    *lock(session()) = Some(Session { meeting_id: req.meeting_id, shared, capture: Some(capture), done: done_rx });
    Ok(StartReply { mime_type: MIME_TYPE.into(), inputs: names })
}

fn stop_blocking() -> Result<StopReply, String> {
    let Some(mut s) = lock(session()).take() else {
        return Err("No recording is running.".into());
    };
    // Audio captured before Stop may still sit in the sound server (PulseAudio
    // delivers record streams in fragments of up to ~2 s): wait for it,
    // bounded. Then release the devices (bounded) and let the engine mix up
    // to the Stop position and write the last chunk.
    let (stop_pos, buffers) = {
        let mut engine = lock(&s.shared.engine);
        let stop_pos = engine.record_end(engine.now_pos());
        engine.stop_at(stop_pos);
        (stop_pos, engine.buffers())
    };
    s.shared.stop_pos.store(stop_pos, Ordering::SeqCst);
    let deadline = Instant::now() + DELIVERY_WAIT;
    while Instant::now() < deadline && buffers.iter().any(|b| !b.delivered_until(stop_pos)) {
        std::thread::sleep(Duration::from_millis(20));
    }
    if let Some(capture) = s.capture.take() {
        capture.stop(CAPTURE_STOP_TIMEOUT);
    }
    s.shared.stop.store(true, Ordering::SeqCst);
    let _ = s.done.recv_timeout(ENGINE_STOP_TIMEOUT);
    let engine = lock(&s.shared.engine);
    Ok(StopReply {
        mime_type: MIME_TYPE.into(),
        duration_ms: engine.elapsed_ms(),
        chunk_count: engine.store.written(),
        unsaved_chunks: engine.store.unsaved(),
        mirror_ok: engine.store.mirror_ok,
        diagnostics: engine.diagnostics(),
    })
}

/// Stop and save a running recording when the app quits.
pub fn shutdown() {
    let _ = stop_blocking();
}

#[tauri::command]
pub async fn native_recorder_devices() -> Result<capture::Devices, String> {
    crate::recordings::off_main(|| Ok(capture::devices())).await
}

#[tauri::command]
pub async fn native_recorder_start(app: AppHandle, request: StartRequest) -> Result<StartReply, String> {
    let root = crate::recordings::root(&app)?;
    let mirror_root = request.mirror_path.as_ref().and_then(|_| crate::storage::storage_root(&app).ok());
    crate::recordings::off_main(move || start_blocking(root, mirror_root, request)).await
}

fn set_paused(paused: bool) {
    let shared = lock(session()).as_ref().map(|s| s.shared.clone());
    if let Some(shared) = shared {
        let mut engine = lock(&shared.engine);
        let now = engine.now_pos();
        if paused {
            engine.pause_at(now);
        } else {
            engine.resume_at(now);
        }
        shared.paused.store(paused, Ordering::SeqCst);
    }
}

#[tauri::command]
pub async fn native_recorder_pause() -> Result<(), String> {
    set_paused(true);
    Ok(())
}

#[tauri::command]
pub async fn native_recorder_resume() -> Result<(), String> {
    set_paused(false);
    Ok(())
}

/// Ask the engine to write held chunks again (after a storage error).
#[tauri::command]
pub async fn native_recorder_retry() -> Result<bool, String> {
    let shared = lock(session()).as_ref().map(|s| s.shared.clone());
    let Some(shared) = shared else { return Ok(true) };
    crate::recordings::off_main(move || Ok(lock(&shared.engine).store.retry())).await
}

#[tauri::command]
pub async fn native_recorder_poll(diagnostics: Option<bool>) -> Result<Status, String> {
    let current = lock(session()).as_ref().map(|s| (s.meeting_id.clone(), s.shared.clone()));
    Ok(match current {
        Some((id, shared)) => status_of(&id, &shared, diagnostics.unwrap_or(false)),
        None => Status { state: "idle".into(), ..Default::default() },
    })
}

/// Audio recorded since the last call, for live transcription: 16 kHz mono
/// 16-bit little-endian PCM (raw bytes).
#[tauri::command]
pub async fn native_recorder_live_take() -> Result<tauri::ipc::Response, String> {
    let shared = lock(session()).as_ref().map(|s| s.shared.clone());
    let mut bytes = Vec::new();
    if let Some(shared) = shared {
        let mut engine = lock(&shared.engine);
        if let Some(live) = engine.live.as_mut() {
            bytes.reserve(live.len() * 2);
            for s in live.drain(..) {
                bytes.extend_from_slice(&s.to_le_bytes());
            }
        }
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn native_recorder_stop() -> Result<StopReply, String> {
    crate::recordings::off_main(stop_blocking).await
}

/// Decode an Ogg Opus file sent as the raw request body to mono 16-bit PCM
/// (raw bytes) at the `x-sample-rate` header's rate (default 16 kHz).
#[tauri::command]
pub async fn native_audio_decode(request: tauri::ipc::Request<'_>) -> Result<tauri::ipc::Response, String> {
    let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
        return Err("Expected the audio file as raw bytes.".into());
    };
    let data = data.clone();
    let rate = request
        .headers()
        .get("x-sample-rate")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(16_000);
    if ![8_000, 12_000, 16_000, 24_000, 48_000].contains(&rate) {
        return Err(format!("Unsupported sample rate: {rate}"));
    }
    let pcm = crate::recordings::off_main(move || engine::decode(&data, rate)).await?;
    let mut bytes = Vec::with_capacity(pcm.len() * 2);
    for s in pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real capture through the machine's sound devices (skipped by default:
    /// CI has none). E.g. with a PulseAudio server whose default source is a
    /// tone and something playing on the default output:
    /// `cargo test --lib -- --ignored records_from_the_sound_devices`
    #[test]
    #[ignore]
    fn records_from_the_sound_devices() {
        let root = std::env::temp_dir().join(format!("lt-native-rec-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mode = std::env::var("LT_REC_MODE").unwrap_or_else(|_| "dual".into());
        let reply = start_blocking(
            root.join("rec"),
            Some(root.join("docs")),
            StartRequest {
                meeting_id: "m1".into(),
                mode: mode.clone(),
                microphone: None,
                output: None,
                mirror_path: Some("Meeting-m1/audio.ogg".into()),
                live: true,
                started_at: 1,
            },
        )
        .unwrap();
        eprintln!("inputs: {:?}", reply.inputs);
        assert!(start_blocking(root.join("rec"), None, StartRequest {
            meeting_id: "m2".into(), mode: "speaker".into(), microphone: None, output: None,
            mirror_path: None, live: false, started_at: 2,
        }).is_err(), "one recording at a time");
        std::thread::sleep(Duration::from_millis(1500));
        let current = lock(session()).as_ref().map(|s| s.shared.clone()).unwrap();
        set_paused(true);
        std::thread::sleep(Duration::from_millis(1000));
        set_paused(false);
        std::thread::sleep(Duration::from_millis(1500));
        let status = status_of("m1", &current, true);
        eprintln!("status: {} {} ms, levels {:?}", status.state, status.elapsed_ms, status.levels);
        eprintln!("delivered/gap-filled: {:?}", lock(&current.engine).input_counts());
        let t0 = Instant::now();
        let stop = stop_blocking().unwrap();
        eprintln!("stop took {:?}: {} ms, {} chunks", t0.elapsed(), stop.duration_ms, stop.chunk_count);
        assert!(t0.elapsed() < Duration::from_secs(4));
        // ~3 s recorded: the 1 s pause is not part of the recording.
        assert!((2600..=3600).contains(&stop.duration_ms), "{}", stop.duration_ms);
        assert_eq!(stop.unsaved_chunks, 0);
        assert!(stop.mirror_ok);
        let file = crate::recordings::read_track(&root.join("rec"), "m1", "").unwrap();
        assert_eq!(std::fs::read(root.join("docs/Meeting-m1/audio.ogg")).unwrap(), file);
        if let Ok(out) = std::env::var("LT_OGG_SAMPLE") {
            std::fs::write(out, &file).unwrap();
        }
        let pcm = engine::decode(&file, 16_000).unwrap();
        let seconds = pcm.len() as f64 / 16_000.0;
        assert!((seconds - stop.duration_ms as f64 / 1000.0).abs() < 0.1, "{seconds}");
        let rms = (pcm.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum::<f64>() / pcm.len() as f64).sqrt();
        eprintln!("decoded {seconds:.2} s, rms {rms:.3}");
        for input in &stop.diagnostics.inputs {
            eprintln!(
                "{}: {:?} polls {} active {} wideband4k {} peak {:.1}",
                input.role, input.settings.label, input.polls, input.active_polls, input.wideband_4k_polls, input.peak_db
            );
        }
        assert_eq!(stop.diagnostics.inputs.len(), if mode == "dual" { 2 } else { 1 });
        assert!(stop.diagnostics.inputs[0].active_polls > 0, "the first input had signal");
        let _ = std::fs::remove_dir_all(&root);
    }
}
