//! Audio capture through cpal, outside the webview: WASAPI (Windows),
//! CoreAudio (macOS), PulseAudio/PipeWire with an ALSA fallback (Linux).
//!
//! System sound ("Device Audio") is recorded from the output device itself:
//! WASAPI loopback, a CoreAudio process tap (macOS 14.2+), or the output's
//! monitor source on Linux. Each input is downmixed and resampled to 48 kHz
//! mono in its callback and queued for the mixer. Streams live on their own
//! thread (cpal streams are not `Send` everywhere) until `stop`.

use super::dsp::{downmix, Resampler};
use super::stats::InputSettings;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub const RATE: u32 = 48_000;
/// Longest audio an input may queue before the oldest is dropped (10 s).
const MAX_QUEUED: usize = RATE as usize * 10;
const BUILD_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Microphone,
    Device,
}

impl Role {
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Microphone => "microphone",
            Role::Device => "device",
        }
    }
}

/// What to open for one input.
#[derive(Debug, Clone)]
pub struct InputRequest {
    pub role: Role,
    /// Microphone: label of the saved device (matched by name), if any.
    /// Device: output device name (Linux: PulseAudio sink name), if any.
    pub device: Option<String>,
}

/// One input's queue: samples not mixed yet, and where the first of them
/// sits on the recording timeline (48 kHz samples since the start).
#[derive(Default)]
pub struct Queue {
    pub data: VecDeque<f32>,
    pub front: u64,
    /// The input delivered audio since the start.
    started: bool,
}

impl Queue {
    /// Timeline position just after the last queued sample.
    pub fn cursor(&self) -> u64 {
        self.front + self.data.len() as u64
    }

    /// Drop queued samples positioned before `pos`.
    pub fn drop_before(&mut self, pos: u64) {
        if pos <= self.front {
            return;
        }
        let n = ((pos - self.front) as usize).min(self.data.len());
        self.data.drain(..n);
        self.front = if self.data.is_empty() { pos } else { self.front + n as u64 };
    }
}

/// A gap this long between where an input's audio should be (wall clock
/// since start) and what it delivered is a real gap — e.g. WASAPI loopback
/// sends nothing while no app plays sound — and is filled with silence.
/// PulseAudio/PipeWire deliver continuously but in bursts of up to ~2 s, so
/// only a much longer silence counts there. The same bound applies to the
/// delay before an input's first audio (start-up latency, not a gap).
const GAP_MS: u64 = 300;
const PULSE_GAP_MS: u64 = 2500;

/// Samples queued by one input's callback (48 kHz mono).
pub struct InputBuffer {
    pub queue: Mutex<Queue>,
    /// Set by the stream's error callback when the device is gone.
    pub lost: Mutex<Option<String>>,
    pub overflowed: AtomicBool,
    /// Samples the device delivered / silence inserted for gaps (48 kHz).
    pub delivered: AtomicU64,
    pub gap_filled: AtomicU64,
    gap: u64,
    bursty: bool,
    /// Start of the recording timeline: set once every input plays (opening
    /// devices can take seconds); audio delivered before it is dropped.
    start: OnceLock<Instant>,
}

impl InputBuffer {
    /// `gap_ms`: shortest silence filled (see `GAP_MS`).
    pub fn new(gap_ms: u64) -> Self {
        Self {
            gap: gap_ms * RATE as u64 / 1000,
            bursty: gap_ms >= PULSE_GAP_MS,
            queue: Mutex::new(Queue::default()),
            lost: Mutex::new(None),
            overflowed: AtomicBool::new(false),
            delivered: AtomicU64::new(0),
            gap_filled: AtomicU64::new(0),
            start: OnceLock::new(),
        }
    }

    /// The device delivered its audio up to timeline position `pos` (within
    /// 60 ms). Only bursty sources (PulseAudio) are waited for: others
    /// deliver every few ms, or nothing at all (WASAPI loopback in silence).
    pub fn delivered_until(&self, pos: u64) -> bool {
        let q = self.lock();
        !self.bursty || !q.started || q.cursor() + RATE as u64 * 6 / 100 >= pos
    }

    /// Current position on the recording timeline (48 kHz samples).
    pub fn now_pos(&self) -> u64 {
        self.start.get().map_or(0, |s| (s.elapsed().as_secs_f64() * RATE as f64) as u64)
    }

    /// For tests that queue audio faster than real time: no gaps, no drops.
    #[cfg(test)]
    pub fn unpaced() -> Self {
        let mut b = Self::new(0);
        b.gap = u64::MAX / 4;
        let past = Instant::now().checked_sub(Duration::from_secs(600)).unwrap_or_else(Instant::now);
        b.arm(past);
        b.lock().started = true;
        b
    }

    /// Start the timeline (the same instant for every input, so they line up).
    pub fn arm(&self, start: Instant) {
        let _ = self.start.set(start);
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Queue a block. `age`: how long ago its first sample was captured
    /// (from the stream's timestamps), which places it on the timeline:
    /// audio from before the start is dropped, a gap is filled with silence.
    /// Without it, the block is assumed to have just been captured.
    pub fn push(&self, mono48: &[f32], age: Option<Duration>) {
        let Some(start) = self.start.get() else { return };
        let rate = RATE as f64;
        let n = mono48.len() as i64;
        let now = (start.elapsed().as_secs_f64() * rate) as i64;
        let mut q = self.lock();
        // Where the block's first sample belongs on the timeline: from the
        // capture timestamp, else assume it was just captured.
        let age = age.filter(|a| a.as_secs() < 10).map_or(n, |a| (a.as_secs_f64() * rate) as i64);
        let first = now - age;
        // Captured before the recording started: drop that part.
        let skip = (-first).clamp(0, n) as usize;
        let first = first.max(0) as u64;
        // Before an input's first audio is silence on the shared timeline
        // (inputs start at different times); later, only a real gap is.
        let threshold = if q.started { self.gap } else { 0 };
        q.started = true;
        let cursor = q.cursor();
        if first > cursor + threshold {
            let gap = first - cursor;
            if q.data.is_empty() {
                q.front = first;
            } else {
                q.data.extend(std::iter::repeat_n(0.0, gap.min(MAX_QUEUED as u64) as usize));
            }
            self.gap_filled.fetch_add(gap, Ordering::Relaxed);
        }
        let block = &mono48[skip..];
        self.delivered.fetch_add(block.len() as u64, Ordering::Relaxed);
        q.data.extend(block.iter().copied());
        // Audio cannot be from the future. A burst handed over as many
        // callbacks in a row (PulseAudio) ends now, and so does the audio of
        // a device whose clock runs fast: move the queue back so it does.
        let now = now.max(0) as u64;
        let cursor = q.cursor();
        if cursor > now {
            let shift = cursor - now;
            if shift > q.front {
                let extra = ((shift - q.front) as usize).min(q.data.len());
                q.data.drain(..extra);
                q.front = 0;
            } else {
                q.front -= shift;
            }
        }
        if q.data.len() > MAX_QUEUED {
            let excess = q.data.len() - MAX_QUEUED;
            q.data.drain(..excess);
            q.front += excess as u64;
            self.overflowed.store(true, Ordering::Relaxed);
        }
    }
}

pub struct OpenedInput {
    pub role: Role,
    pub settings: InputSettings,
    pub buffer: Arc<InputBuffer>,
}

/// Running capture streams; dropping them (in `stop`) releases the devices.
pub struct Capture {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<()>,
}

impl Capture {
    /// Release the devices; waits at most `timeout` (a stuck driver must
    /// never hold Stop — the thread then finishes on its own).
    pub fn stop(self, timeout: Duration) -> bool {
        let _ = self.stop_tx.send(());
        self.done_rx.recv_timeout(timeout).is_ok()
    }
}

fn host() -> cpal::Host {
    // On Linux the default host is PulseAudio (PipeWire's pulse server
    // included) when a server runs, else ALSA.
    cpal::default_host()
}

fn name_of(device: &cpal::Device) -> String {
    device.description().map(|d| d.name().to_string()).unwrap_or_default()
}

fn id_of(device: &cpal::Device) -> String {
    device.id().map(|id| id.id().to_string()).unwrap_or_default()
}

/// Our own virtual system-audio source (webview path) and monitors are never microphones.
fn is_virtual_input(device: &cpal::Device) -> bool {
    let id = id_of(device);
    id.ends_with(".monitor") || id.contains("local_transcribe_system_audio")
}

fn same_name(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().to_lowercase();
    !a.trim().is_empty() && (norm(a) == norm(b) || norm(a).contains(&norm(b)) || norm(b).contains(&norm(a)))
}

fn pick_microphone(host: &cpal::Host, label: Option<&str>) -> Result<cpal::Device, String> {
    if let Some(label) = label.filter(|l| !l.trim().is_empty()) {
        if let Ok(devices) = host.input_devices() {
            for d in devices {
                if !is_virtual_input(&d) && (same_name(&name_of(&d), label) || id_of(&d) == label) {
                    return Ok(d);
                }
            }
        }
    }
    host.default_input_device().ok_or_else(|| "No microphone was found.".to_string())
}

/// The device whose input stream records the system sound.
fn pick_system(host: &cpal::Host, output: Option<&str>) -> Result<cpal::Device, String> {
    let wanted = output.filter(|o| !o.trim().is_empty());
    if is_pulse(host) {
        // PulseAudio: record the output's monitor source.
        let sink = match wanted {
            Some(s) => s.to_string(),
            None => host.default_output_device().map(|d| id_of(&d)).unwrap_or_default(),
        };
        let devices = host.input_devices().map_err(|e| e.to_string())?;
        let monitors: Vec<cpal::Device> = devices.filter(|d| id_of(d).ends_with(".monitor")).collect();
        let exact = format!("{sink}.monitor");
        if let Some(d) = monitors.iter().find(|d| id_of(d) == exact) {
            return Ok(d.clone());
        }
        // The chosen output is gone: fall back to the default output's monitor.
        let default = host.default_output_device().map(|d| format!("{}.monitor", id_of(&d)));
        return monitors
            .into_iter()
            .find(|d| Some(id_of(d)) == default)
            .ok_or_else(|| "The system sound monitor was not found.".to_string());
    }
    if cfg!(target_os = "linux") {
        return Err("Recording system sound needs PulseAudio or PipeWire.".into());
    }
    // WASAPI / CoreAudio: an input stream on an output device is a loopback.
    if let Some(name) = wanted {
        if let Ok(devices) = host.output_devices() {
            for d in devices {
                if same_name(&name_of(&d), name) || id_of(&d) == name {
                    return Ok(d);
                }
            }
        }
    }
    host.default_output_device().ok_or_else(|| "No sound output was found.".to_string())
}

#[cfg(target_os = "linux")]
fn is_pulse(host: &cpal::Host) -> bool {
    host.id() == cpal::HostId::PulseAudio
}

#[cfg(not(target_os = "linux"))]
fn is_pulse(_host: &cpal::Host) -> bool {
    false
}

/// Callback for one sample type: convert → downmix → resample → queue.
fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    buffer: Arc<InputBuffer>,
    pulse: bool,
) -> Result<cpal::Stream, cpal::Error>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let mut resampler = Resampler::new(config.sample_rate, RATE);
    let mut floats: Vec<f32> = Vec::new();
    let mut mono: Vec<f32> = Vec::new();
    let mut out: Vec<f32> = Vec::new();
    let lost = buffer.clone();
    device.build_input_stream(
        config,
        move |data: &[T], info: &cpal::InputCallbackInfo| {
            // WASAPI/CoreAudio timestamps come from the device clock; the
            // PulseAudio host derives them from latency reports that some
            // sources get wrong, so they are not used there.
            let ts = info.timestamp();
            let age = (!pulse).then(|| ts.callback.duration_since(ts.capture));
            floats.clear();
            floats.extend(data.iter().map(|&s| cpal::Sample::to_sample::<f32>(s)));
            mono.clear();
            downmix(&floats, channels, &mut mono);
            out.clear();
            resampler.push(&mono, &mut out);
            buffer.push(&out, age);
        },
        move |err: cpal::Error| {
            use cpal::ErrorKind::*;
            match err.kind() {
                Xrun | RealtimeDenied | DeviceChanged => {}
                _ => {
                    let mut l = lost.lost.lock().unwrap_or_else(|e| e.into_inner());
                    l.get_or_insert_with(|| err.to_string());
                }
            }
        },
        Some(BUILD_TIMEOUT),
    )
}

fn open(device: &cpal::Device, role: Role, pulse: bool) -> Result<(cpal::Stream, OpenedInput), String> {
    let supported = if device.supports_input() {
        device.default_input_config()
    } else {
        // Loopback: capture in the output's own format.
        device.default_output_config()
    }
    .map_err(|e| e.to_string())?;
    // Default buffering: a fixed PulseAudio fragment size starves some
    // sources (no audio at all). PulseAudio/PipeWire may then deliver in
    // bursts of up to ~2 s, which the engine absorbs (STALL_FRAMES).
    let config = supported.config();
    let buffer = Arc::new(InputBuffer::new(if pulse { PULSE_GAP_MS } else { GAP_MS }));
    let b = buffer.clone();
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(device, config, b, pulse),
        SampleFormat::F64 => build::<f64>(device, config, b, pulse),
        SampleFormat::I16 => build::<i16>(device, config, b, pulse),
        SampleFormat::I32 => build::<i32>(device, config, b, pulse),
        SampleFormat::I8 => build::<i8>(device, config, b, pulse),
        SampleFormat::U8 => build::<u8>(device, config, b, pulse),
        SampleFormat::U16 => build::<u16>(device, config, b, pulse),
        SampleFormat::I24 => build::<cpal::I24>(device, config, b, pulse),
        other => return Err(format!("Unsupported sample format {other}")),
    }
    .map_err(|e| e.to_string())?;
    stream.play().map_err(|e| e.to_string())?;
    let settings = InputSettings {
        label: Some(name_of(device)).filter(|n| !n.is_empty()),
        sample_rate: Some(config.sample_rate),
        channel_count: Some(config.channels),
    };
    Ok((stream, OpenedInput { role, settings, buffer }))
}

/// Open every requested input on a capture thread. All or nothing: if one
/// input fails, the others are released and the error is returned.
pub fn start(requests: Vec<InputRequest>) -> Result<(Capture, Vec<OpenedInput>), String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<Vec<OpenedInput>, String>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (done_tx, done_rx) = mpsc::channel::<()>();
    std::thread::Builder::new()
        .name("lt-capture".into())
        .spawn(move || {
            let host = host();
            let pulse = is_pulse(&host);
            let mut streams = Vec::new();
            let mut opened = Vec::new();
            for req in &requests {
                let device = match req.role {
                    Role::Microphone => pick_microphone(&host, req.device.as_deref()),
                    Role::Device => pick_system(&host, req.device.as_deref()),
                };
                match device.and_then(|d| open(&d, req.role, pulse)) {
                    Ok((stream, input)) => {
                        streams.push(stream);
                        opened.push(input);
                    }
                    Err(e) => {
                        let what = match req.role {
                            Role::Microphone => "microphone",
                            Role::Device => "system sound",
                        };
                        drop(streams);
                        let _ = ready_tx.send(Err(format!("Could not open the {what}: {e}")));
                        let _ = done_tx.send(());
                        return;
                    }
                }
            }
            let start = Instant::now();
            for input in &opened {
                input.buffer.arm(start);
            }
            let _ = ready_tx.send(Ok(opened));
            let _ = stop_rx.recv();
            drop(streams);
            let _ = done_tx.send(());
        })
        .map_err(|e| format!("Could not start capture: {e}"))?;
    match ready_rx.recv_timeout(BUILD_TIMEOUT * 3) {
        Ok(Ok(inputs)) => Ok((Capture { stop_tx, done_rx }, inputs)),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = stop_tx.send(());
            Err("The audio devices did not respond.".into())
        }
    }
}

/// A device the recorder can use, for the pickers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub host: String,
    pub inputs: Vec<DeviceInfo>,
    pub outputs: Vec<DeviceInfo>,
    /// System sound can be recorded natively on this machine.
    pub system_audio: bool,
}

pub fn devices() -> Devices {
    let host = host();
    let default_in = host.default_input_device().map(|d| id_of(&d));
    let default_out = host.default_output_device().map(|d| id_of(&d));
    let list = |devices: Vec<cpal::Device>, default: &Option<String>| -> Vec<DeviceInfo> {
        devices
            .iter()
            .map(|d| {
                let id = id_of(d);
                DeviceInfo { is_default: Some(&id) == default.as_ref(), name: name_of(d), id }
            })
            .collect()
    };
    let inputs: Vec<cpal::Device> =
        host.input_devices().map(|d| d.filter(|d| !is_virtual_input(d)).collect()).unwrap_or_default();
    let outputs: Vec<cpal::Device> = host.output_devices().map(|d| d.collect()).unwrap_or_default();
    let system_audio = if cfg!(target_os = "linux") {
        is_pulse(&host)
    } else if cfg!(target_os = "macos") {
        // CoreAudio process taps exist from macOS 14.2.
        !outputs.is_empty() && macos_version().is_some_and(|v| v >= (14, 2))
    } else {
        // WASAPI loopback.
        !outputs.is_empty()
    };
    Devices {
        host: host.id().name().to_string(),
        inputs: list(inputs, &default_in),
        outputs: list(outputs, &default_out),
        system_audio,
    }
}

fn macos_version() -> Option<(u32, u32)> {
    let plist = std::fs::read_to_string("/System/Library/CoreServices/SystemVersion.plist").ok()?;
    product_version(&plist)
}

/// `ProductVersion` (major, minor) from SystemVersion.plist.
fn product_version(plist: &str) -> Option<(u32, u32)> {
    let after = plist.split("<key>ProductVersion</key>").nth(1)?;
    let value = after.split("<string>").nth(1)?.split("</string>").next()?;
    let mut parts = value.trim().split('.').map(|p| p.parse::<u32>().ok());
    Some((parts.next()??, parts.next().flatten().unwrap_or(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_macos_version() {
        let plist = "<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>14.4.1</string>\n</dict>";
        assert_eq!(product_version(plist), Some((14, 4)));
        assert_eq!(product_version("<key>ProductVersion</key><string>15</string>"), Some((15, 0)));
        assert_eq!(product_version("nothing"), None);
        assert!(product_version(plist).unwrap() >= (14, 2));
        assert!((13, 6) < (14, 2));
    }

    #[test]
    fn matches_device_names_loosely() {
        assert!(same_name("Default - Microphone (Realtek(R) Audio)", "Microphone (Realtek(R) Audio)"));
        assert!(same_name("USB Mic", "usb mic"));
        assert!(!same_name("", "USB Mic"));
        assert!(!same_name("USB Mic", "Built-in"));
    }
}
