//! Level monitor: opens microphones / system sound without recording, so
//! Home, setup and Settings can show live level bars before a recording
//! starts ("Can it hear you?", "Test sound heard"). Never runs while a
//! recording does (the recorder owns the devices then; its poll has levels).

use super::capture::{self, Capture, InputBuffer, InputRequest, Role};
use serde::Deserialize;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInput {
    /// 'microphone' | 'device'
    pub role: String,
    /// Microphone label / output name; None = the default.
    #[serde(default)]
    pub device: Option<String>,
}

struct Monitor {
    capture: Capture,
    buffers: Vec<Arc<InputBuffer>>,
}

fn monitor() -> &'static Mutex<Option<Monitor>> {
    static M: OnceLock<Mutex<Option<Monitor>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(None))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn stop_blocking() {
    if let Some(m) = lock(monitor()).take() {
        m.capture.stop(Duration::from_secs(3));
    }
}

/// Peak (0..1) of what each input delivered since the last poll; drains it.
fn levels(buffers: &[Arc<InputBuffer>]) -> Vec<f64> {
    buffers
        .iter()
        .map(|b| {
            let mut q = b.lock();
            let peak = q.data.iter().fold(0f32, |m, &s| m.max(s.abs()));
            let end = q.cursor();
            q.drop_before(end);
            peak.min(1.0) as f64
        })
        .collect()
}

/// Start monitoring `inputs` (replacing a running monitor). Each input that
/// cannot be opened fails the whole call, like a recording would.
#[tauri::command]
pub async fn native_level_monitor_start(inputs: Vec<MonitorInput>) -> Result<usize, String> {
    if super::is_recording() {
        return Err("A recording is running.".into());
    }
    crate::recordings::off_main(move || {
        stop_blocking();
        let requests: Vec<InputRequest> = inputs
            .into_iter()
            .map(|i| InputRequest {
                role: if i.role == "device" { Role::Device } else { Role::Microphone },
                device: i.device.filter(|d| !d.trim().is_empty()),
            })
            .collect();
        if requests.is_empty() {
            return Ok(0);
        }
        let (capture, opened) = capture::start(requests)?;
        let n = opened.len();
        *lock(monitor()) = Some(Monitor { capture, buffers: opened.into_iter().map(|o| o.buffer).collect() });
        Ok(n)
    })
    .await
}

/// Levels since the last poll, one per input (empty when not monitoring).
#[tauri::command]
pub async fn native_level_monitor_poll() -> Result<Vec<f64>, String> {
    Ok(lock(monitor()).as_ref().map(|m| levels(&m.buffers)).unwrap_or_default())
}

#[tauri::command]
pub async fn native_level_monitor_stop() -> Result<(), String> {
    crate::recordings::off_main(|| {
        stop_blocking();
        Ok(())
    })
    .await
}

/// Release the devices when the app quits or a recording starts.
pub fn shutdown() {
    stop_blocking();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_report_the_peak_and_drain() {
        let b = Arc::new(InputBuffer::unpaced());
        b.push(&[0.1, -0.6, 0.3], None);
        let first = levels(&[b.clone()]);
        assert!((first[0] - 0.6).abs() < 1e-6, "{first:?}");
        assert_eq!(levels(&[b])[0], 0.0, "drained after a poll");
    }
}
