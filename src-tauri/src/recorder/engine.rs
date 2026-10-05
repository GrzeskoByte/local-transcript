//! The recording engine: pulls 20 ms frames from the capture queues, mixes
//! (Mic + Device), measures, encodes Opus and writes Ogg pages as chunk files
//! (`000000.ogg`, one every 5 s) — the same incremental layout as the webview
//! recorder, so crash recovery, listing and deletion work unchanged.
//!
//! Pure Rust with no device access: tests drive it with synthetic input.

use super::capture::{InputBuffer, Role};
use super::dsp::{decimate3, Limiter};
use super::ogg::{OggWriter, FRAME, OPUS_RATE};
use super::stats::{BleedStats, InputSettings, InputStats, Stats};
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;

pub const MIME_TYPE: &str = "audio/ogg;codecs=opus";
const BITRATE: i32 = 48_000;
/// 50 packets (1 s) per Ogg page, 5 pages (5 s, `CHUNK_MS`) per chunk file.
const PACKETS_PER_PAGE: usize = 50;
const FRAMES_PER_CHUNK: usize = 250;
/// Measurements every 500 ms.
const FRAMES_PER_POLL: u64 = 25;
/// Live transcription audio kept for the webview (16 kHz, 60 s).
const LIVE_CAP: usize = 16_000 * 60;
const MAX_EVENTS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagEvent {
    pub at_ms: u64,
    pub kind: &'static str,
    pub role: &'static str,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub inputs: Vec<InputStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bleed: Option<BleedStats>,
    pub events: Vec<DiagEvent>,
}

/// Where the chunks go: the app's recording store, plus (optionally) the
/// user's meeting folder, appended live so Stop has nothing to copy.
pub struct ChunkStore {
    dir: PathBuf,
    mirror: Option<PathBuf>,
    next: u32,
    pending: Vec<(String, Vec<u8>)>,
    pub mirror_ok: bool,
    pub last_error: Option<String>,
}

impl ChunkStore {
    pub fn new(dir: PathBuf, mirror: Option<PathBuf>) -> Self {
        Self { dir, mirror, next: 0, pending: Vec::new(), mirror_ok: true, last_error: None }
    }

    pub fn written(&self) -> u32 {
        self.next - self.pending.len() as u32
    }

    pub fn unsaved(&self) -> usize {
        self.pending.len()
    }

    fn save(&mut self, bytes: Vec<u8>) {
        let name = format!("{:06}.ogg", self.next);
        self.next += 1;
        if let Some(mirror) = &self.mirror {
            if self.mirror_ok {
                let ok = mirror.parent().map(fs::create_dir_all).transpose().is_ok()
                    && fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(mirror)
                        .and_then(|mut f| f.write_all(&bytes))
                        .is_ok();
                // A gap in the mirror would corrupt it: stop appending; the
                // webview copies the whole recording after Stop instead.
                self.mirror_ok = ok;
            }
        }
        self.pending.push((name, bytes));
        self.retry();
    }

    /// Write every held chunk, in order. False while any write still fails.
    pub fn retry(&mut self) -> bool {
        while let Some((name, bytes)) = self.pending.first() {
            match crate::recordings::write_atomic(&self.dir.join(name), bytes) {
                Ok(()) => {
                    self.pending.remove(0);
                    self.last_error = None;
                }
                Err(e) => {
                    self.last_error = Some(e);
                    return false;
                }
            }
        }
        true
    }
}

pub struct Input {
    pub role: Role,
    pub buffer: Arc<InputBuffer>,
    lost_reported: bool,
}

impl Input {
    pub fn new(role: Role, buffer: Arc<InputBuffer>) -> Self {
        Self { role, buffer, lost_reported: false }
    }
}

pub struct Engine {
    inputs: Vec<Input>,
    encoder: opus::Encoder,
    ogg: OggWriter,
    pre_skip: u64,
    limiter: Limiter,
    stats: Stats,
    packets: Vec<Vec<u8>>,
    chunk: Vec<u8>,
    frames_in_chunk: usize,
    /// Frames encoded (each 20 ms of recording, pauses excluded).
    pub frames: u64,
    /// Timeline position (48 kHz samples since the start) of the next frame.
    pub next_pos: u64,
    /// Paused stretches of the timeline: [start, end), end None while paused.
    skips: Vec<(u64, Option<u64>)>,
    paused_at: u64,
    /// Stop position: nothing after it is mixed.
    limit: Option<u64>,
    pub store: ChunkStore,
    pub live: Option<VecDeque<i16>>,
    pub events: Vec<DiagEvent>,
    /// Message of the first input that stopped delivering audio.
    pub source_lost: Option<String>,
    mix: Vec<f32>,
    frame: Vec<f32>,
    out: Vec<u8>,
}

impl Engine {
    pub fn new(
        inputs: Vec<(Input, InputSettings)>,
        store: ChunkStore,
        live: bool,
        serial: u32,
    ) -> Result<Self, String> {
        let mut encoder = opus::Encoder::new(OPUS_RATE, opus::Channels::Mono, opus::Application::Audio)
            .map_err(|e| format!("Opus encoder: {e}"))?;
        encoder.set_bitrate(opus::Bitrate::Bits(BITRATE)).map_err(|e| format!("Opus encoder: {e}"))?;
        let pre_skip = encoder.get_lookahead().unwrap_or(312).max(0) as u64;
        let stats = Stats::new(inputs.iter().map(|(i, s)| (i.role.as_str(), s.clone())).collect());
        let mut ogg = OggWriter::new(serial);
        let chunk = ogg.headers(pre_skip as u16, OPUS_RATE);
        Ok(Self {
            inputs: inputs.into_iter().map(|(i, _)| i).collect(),
            encoder,
            ogg,
            pre_skip,
            limiter: Limiter::new(OPUS_RATE),
            stats,
            packets: Vec::new(),
            chunk,
            frames_in_chunk: 0,
            frames: 0,
            next_pos: 0,
            skips: Vec::new(),
            paused_at: 0,
            limit: None,
            store,
            live: live.then(VecDeque::new),
            events: Vec::new(),
            source_lost: None,
            mix: vec![0.0; FRAME],
            frame: vec![0.0; FRAME],
            out: vec![0u8; 4000],
        })
    }

    pub fn elapsed_ms(&self) -> u64 {
        self.frames * 20
    }

    /// Inputs (by buffer), for waiting on their last audio at Stop.
    pub fn buffers(&self) -> Vec<Arc<InputBuffer>> {
        self.inputs.iter().map(|i| i.buffer.clone()).collect()
    }

    /// Pause at timeline position `pos`: audio from there on is not
    /// recorded until `resume_at`. Snapped to the frame grid.
    pub fn pause_at(&mut self, pos: u64) {
        if self.paused() {
            return;
        }
        // Never before what is mixed already (an input may run early).
        let from = self.next_pos.max(self.skips.last().and_then(|s| s.1).unwrap_or(0));
        let start = from + pos.saturating_sub(from).div_ceil(FRAME as u64) * FRAME as u64;
        self.skips.push((start, None));
        self.paused_at = pos;
    }

    /// The skipped stretch lasts as long as the pause did.
    pub fn resume_at(&mut self, pos: u64) {
        let length = pos.saturating_sub(self.paused_at).div_ceil(FRAME as u64) * FRAME as u64;
        if let Some(last) = self.skips.last_mut().filter(|s| s.1.is_none()) {
            last.1 = Some(last.0 + length);
        }
    }

    pub fn paused(&self) -> bool {
        self.skips.last().is_some_and(|s| s.1.is_none())
    }

    /// Step over paused stretches. True when the next frame is inside the
    /// current pause (nothing to mix until resume).
    fn at_pause(&mut self) -> bool {
        for &(start, end) in &self.skips {
            if self.next_pos >= start {
                match end {
                    Some(end) if self.next_pos < end => self.next_pos = end,
                    None => return true,
                    _ => {}
                }
            }
        }
        false
    }

    /// Stop at timeline position `pos`: audio after it is never mixed (the
    /// engine keeps mixing up to it while late audio arrives).
    pub fn stop_at(&mut self, pos: u64) {
        self.limit = Some(pos);
    }

    /// Every input has delivered the audio of the next frame.
    pub fn frame_ready(&mut self) -> bool {
        if self.at_pause() {
            return false;
        }
        let end = self.next_pos + FRAME as u64;
        if self.limit.is_some_and(|limit| end > limit) {
            return false;
        }
        self.inputs.iter().all(|i| i.buffer.lock().cursor() >= end)
    }

    /// Mix every frame up to timeline position `pos` (pauses skipped),
    /// with silence where an input delivered nothing. For Stop and stalls.
    pub fn mix_until(&mut self, pos: u64) {
        let pos = self.limit.map_or(pos, |limit| limit.min(pos));
        while !self.at_pause() && self.next_pos + FRAME as u64 <= pos {
            self.frame();
        }
    }

    /// While paused: drop what the devices deliver (their positions stay).
    pub fn discard_paused(&mut self) {
        if !self.at_pause() {
            return;
        }
        for input in &self.inputs {
            let mut q = input.buffer.lock();
            let end = q.cursor();
            q.drop_before(end);
        }
    }

    /// Where the recording ends if stopped at `pos`: there, or where the
    /// current pause began.
    pub fn record_end(&self, pos: u64) -> u64 {
        match self.skips.last() {
            Some(&(start, None)) => start.min(pos),
            _ => pos,
        }
    }

    /// Current timeline position (all inputs share the start).
    pub fn now_pos(&self) -> u64 {
        self.inputs.first().map_or(0, |i| i.buffer.now_pos())
    }

    fn check_sources(&mut self) {
        let at_ms = self.elapsed_ms();
        for input in &mut self.inputs {
            if input.lost_reported {
                continue;
            }
            let lost = input.buffer.lost.lock().map(|l| l.clone()).unwrap_or(None);
            if let Some(msg) = lost {
                input.lost_reported = true;
                let what = match input.role {
                    Role::Microphone => "The microphone",
                    Role::Device => "System sound",
                };
                let detail = format!("{what} stopped: {msg}");
                if self.events.len() < MAX_EVENTS {
                    self.events.push(DiagEvent { at_ms, kind: "ended", role: input.role.as_str(), detail: detail.clone() });
                }
                self.source_lost.get_or_insert(detail);
            }
        }
    }

    /// Encode one 20 ms frame of every input (silence where an input has
    /// nothing queued: a device that delivers nothing — e.g. loopback while
    /// no app plays sound — must not shorten the recording).
    pub fn frame(&mut self) {
        self.check_sources();
        self.at_pause();
        self.mix.iter_mut().for_each(|s| *s = 0.0);
        let several = self.inputs.len() > 1;
        let pos = self.next_pos;
        for (index, input) in self.inputs.iter().enumerate() {
            {
                // The samples at [pos, pos + FRAME); silence where missing.
                let mut q = input.buffer.lock();
                q.drop_before(pos);
                let lead = (q.front.saturating_sub(pos) as usize).min(FRAME);
                let n = q.data.len().min(FRAME - lead);
                self.frame[..lead].iter_mut().for_each(|s| *s = 0.0);
                for (i, s) in q.data.drain(..n).enumerate() {
                    self.frame[lead + i] = s;
                }
                self.frame[lead + n..].iter_mut().for_each(|s| *s = 0.0);
                q.front += n as u64;
                // Nothing left: the input missed this frame (stall); its next
                // audio belongs after it.
                if q.data.is_empty() {
                    q.front = q.front.max(pos + FRAME as u64);
                }
            }
            self.stats.feed(index, &self.frame);
            for (m, s) in self.mix.iter_mut().zip(&self.frame) {
                *m += s;
            }
        }
        if several {
            self.limiter.process(&mut self.mix);
        } else {
            self.mix.iter_mut().for_each(|s| *s = s.clamp(-1.0, 1.0));
        }
        if let Some(live) = &mut self.live {
            let mut down = Vec::with_capacity(FRAME / 3);
            decimate3(&self.mix, &mut down);
            live.extend(down.iter().map(|&s| (s.clamp(-1.0, 1.0) * 32767.0) as i16));
            if live.len() > LIVE_CAP {
                let excess = live.len() - LIVE_CAP;
                live.drain(..excess);
            }
        }
        let packet = match self.encoder.encode_float(&self.mix, &mut self.out) {
            Ok(n) => self.out[..n].to_vec(),
            // Never drop time: an encoder hiccup becomes a silent packet.
            Err(_) => vec![0xF8, 0xFF, 0xFE],
        };
        self.packets.push(packet);
        self.frames += 1;
        self.next_pos += FRAME as u64;
        self.frames_in_chunk += 1;
        if self.frames.is_multiple_of(FRAMES_PER_POLL) {
            self.stats.poll(self.frames as f64 * 0.02);
        }
        if self.packets.len() == PACKETS_PER_PAGE {
            self.flush_page(false);
        }
        if self.frames_in_chunk == FRAMES_PER_CHUNK {
            self.flush_chunk();
        }
    }

    fn granule(&self) -> u64 {
        self.frames * FRAME as u64 + self.pre_skip
    }

    fn flush_page(&mut self, last: bool) {
        let packets = std::mem::take(&mut self.packets);
        let page = self.ogg.audio(&packets, self.granule(), last);
        self.chunk.extend(page);
    }

    fn flush_chunk(&mut self) {
        self.frames_in_chunk = 0;
        let chunk = std::mem::take(&mut self.chunk);
        if !chunk.is_empty() {
            self.store.save(chunk);
        }
    }

    /// End the stream (EOS page) and write the last chunk.
    pub fn finish(&mut self) {
        self.flush_page(true);
        self.flush_chunk();
        self.store.retry();
    }

    pub fn diagnostics(&self) -> Diagnostics {
        Diagnostics { inputs: self.stats.inputs(), bleed: self.stats.bleed(), events: self.events.clone() }
    }

    /// Per input: (delivered, gap-filled) samples (tests).
    #[cfg(test)]
    pub fn input_counts(&self) -> Vec<(u64, u64)> {
        use std::sync::atomic::Ordering::Relaxed;
        self.inputs.iter().map(|i| (i.buffer.delivered.load(Relaxed), i.buffer.gap_filled.load(Relaxed))).collect()
    }

    pub fn levels(&self) -> Vec<f64> {
        self.stats.levels()
    }
}

/// Decode an Ogg Opus recording to mono 16-bit PCM at `rate` (8/12/16/24/48 kHz:
/// libopus resamples internally, so long recordings never exist at 48 kHz).
pub fn decode(data: &[u8], rate: u32) -> Result<Vec<i16>, String> {
    let stream = super::ogg::read_opus(data)?;
    let mut decoder = opus::Decoder::new(rate, opus::Channels::Mono).map_err(|e| format!("Opus decoder: {e}"))?;
    let max = rate as usize * 120 / 1000;
    let mut out = Vec::with_capacity(stream.packets.len() * rate as usize / 50);
    let mut buf = vec![0i16; max];
    for packet in &stream.packets {
        match decoder.decode(packet, &mut buf, false) {
            Ok(n) => out.extend_from_slice(&buf[..n]),
            // A damaged packet: conceal it instead of failing the recording.
            Err(_) => {
                if let Ok(n) = decoder.decode(&[], &mut buf, false) {
                    out.extend_from_slice(&buf[..n]);
                }
            }
        }
    }
    let skip = (stream.pre_skip as usize * rate as usize / OPUS_RATE as usize).min(out.len());
    out.drain(..skip);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lt-engine-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn input(role: Role) -> (Arc<InputBuffer>, (Input, InputSettings)) {
        let buffer = Arc::new(InputBuffer::unpaced());
        (buffer.clone(), (Input::new(role, buffer), InputSettings::default()))
    }

    fn sine(hz: f32, amp: f32, n: usize, offset: usize) -> Vec<f32> {
        (offset..offset + n).map(|i| amp * (i as f32 * hz * std::f32::consts::TAU / 48_000.0).sin()).collect()
    }

    fn read_all(dir: &PathBuf) -> Vec<u8> {
        let mut names: Vec<_> = fs::read_dir(dir).unwrap().flatten().map(|e| e.path()).collect();
        names.sort();
        names.iter().flat_map(|p| fs::read(p).unwrap()).collect()
    }

    #[test]
    fn records_chunks_that_decode_back_to_the_input() {
        let dir = tmp("roundtrip");
        let mirror = dir.join("mirror").join("audio.ogg");
        let (mic, i) = input(Role::Microphone);
        let mut engine = Engine::new(vec![i], ChunkStore::new(dir.join("rec"), Some(mirror.clone())), true, 9).unwrap();
        // 12 s of a 440 Hz tone, delivered in 10 ms blocks.
        for block in 0..1200 {
            mic.push(&sine(440.0, 0.4, 480, block * 480), None);
            while engine.frame_ready() {
                engine.frame();
            }
        }
        engine.mix_until(mic.lock().cursor());
        engine.finish();
        assert_eq!(engine.elapsed_ms(), 12_000);
        // 12 s → chunks of 5 s: 000000, 000001, 000002 (the last 2 s).
        let names: Vec<_> = fs::read_dir(dir.join("rec")).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names.len(), 3);
        assert_eq!(engine.store.written(), 3);
        let file = read_all(&dir.join("rec"));
        assert_eq!(fs::read(&mirror).unwrap(), file, "the mirror is the same Ogg file");
        // For checking with an independent decoder (ffprobe/ffmpeg, a browser).
        if let Ok(out) = std::env::var("LT_OGG_SAMPLE") {
            fs::write(out, &file).unwrap();
        }
        let pcm = decode(&file, 16_000).unwrap();
        assert!((pcm.len() as i64 - 192_000).abs() < 400, "{}", pcm.len());
        // Same tone back: compare level in the middle (lossy codec).
        let mid = &pcm[80_000..96_000];
        let rms = (mid.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum::<f64>() / mid.len() as f64).sqrt();
        assert!((rms - 0.4 / 2f64.sqrt()).abs() < 0.03, "rms {rms}");
        // Live audio for transcription: 16 kHz.
        assert!((engine.live.as_ref().unwrap().len() as i64 - 192_000).abs() < 400);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_crash_cut_recording_still_decodes() {
        let dir = tmp("crash");
        let (mic, i) = input(Role::Microphone);
        let mut engine = Engine::new(vec![i], ChunkStore::new(dir.clone(), None), false, 1).unwrap();
        mic.push(&sine(300.0, 0.3, 48_000 * 6, 0), None);
        while engine.frame_ready() {
            engine.frame();
        }
        // No finish(): only the first full chunk exists, no EOS page.
        let pcm = decode(&read_all(&dir), 24_000).unwrap();
        assert!((pcm.len() as i64 - 120_000).abs() < 400, "{}", pcm.len());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mixes_inputs_and_pads_silence() {
        let dir = tmp("mix");
        let (mic, a) = input(Role::Microphone);
        let (dev, b) = input(Role::Device);
        let mut engine = Engine::new(vec![a, b], ChunkStore::new(dir.clone(), None), false, 1).unwrap();
        mic.push(&sine(200.0, 0.9, 48_000 * 3, 0), None);
        // The device delivers nothing for now (loopback while nothing plays).
        for _ in 0..25 {
            engine.frame();
        }
        assert_eq!(engine.elapsed_ms(), 500);
        dev.push(&sine(1000.0, 0.9, 48_000, 0), None);
        engine.frame();
        engine.finish();
        let d = engine.diagnostics();
        assert_eq!(d.inputs.len(), 2);
        assert_eq!(d.inputs[1].role, "device");
        let pcm = decode(&read_all(&dir), 48_000).unwrap();
        assert!(pcm.iter().all(|&s| (s as i32).abs() < 32700), "limited, never clipped");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_device_that_goes_quiet_is_padded_to_stay_in_time() {
        let buffer = InputBuffer::new(300);
        buffer.arm(std::time::Instant::now() - std::time::Duration::from_secs(2));
        // First audio 2 s in: the input starts 2 s into the recording.
        buffer.push(&[0.5; 480], None);
        {
            let q = buffer.lock();
            let expected = 2 * 48_000;
            assert!((q.cursor() as i64 - expected as i64).abs() < 500, "{}", q.cursor());
            assert_eq!(q.data.len(), 480, "the gap is position, not queued silence");
            assert_eq!(q.data.back(), Some(&0.5));
        }
        // With timestamps: a 1 s block captured 2.5 s ago (0.5 s before the
        // start) keeps its last 0.5 s; the next one, now, follows a gap.
        let stamped = InputBuffer::new(300);
        stamped.arm(std::time::Instant::now() - std::time::Duration::from_secs(2));
        stamped.push(&[0.25; 48_000], Some(std::time::Duration::from_millis(2500)));
        assert!((stamped.lock().data.len() as i64 - 24_000).abs() < 500, "{}", stamped.lock().data.len());
        stamped.push(&[0.25; 480], Some(std::time::Duration::ZERO));
        let q = stamped.lock();
        assert!((q.cursor() as i64 - (2 * 48_000 + 480)).abs() < 500, "{}", q.cursor());
    }

    #[test]
    fn a_burst_of_callbacks_ends_now_not_in_the_future() {
        // PulseAudio hands over 2 s of audio as 100 callbacks in a row, 3 s
        // into the recording: it belongs to [1 s, 3 s), not after 3 s.
        let buffer = InputBuffer::new(2500);
        buffer.arm(std::time::Instant::now() - std::time::Duration::from_secs(3));
        for _ in 0..100 {
            buffer.push(&[0.5; 960], None);
        }
        let q = buffer.lock();
        assert!((q.cursor() as i64 - 3 * 48_000).abs() < 500, "{}", q.cursor());
        assert!((q.front as i64 - 48_000).abs() < 500, "{}", q.front);
        drop(q);
        // A burst longer than the recording so far keeps only its end.
        let early = InputBuffer::new(2500);
        early.arm(std::time::Instant::now() - std::time::Duration::from_secs(1));
        for _ in 0..100 {
            early.push(&[0.5; 960], None);
        }
        let q = early.lock();
        assert_eq!(q.front, 0);
        assert!((q.data.len() as i64 - 48_000).abs() < 500, "{}", q.data.len());
    }

    #[test]
    fn pauses_skip_their_stretch_even_when_audio_arrives_late() {
        let dir = tmp("pause");
        let (mic, i) = input(Role::Microphone);
        let mut engine = Engine::new(vec![i], ChunkStore::new(dir.clone(), None), false, 1).unwrap();
        // Paused at 1 s, resumed at 2 s, stopped at 3 s — and the device
        // delivers all 3 s afterwards in one burst (a PulseAudio fragment).
        engine.pause_at(48_000);
        engine.resume_at(96_000);
        let tone: Vec<f32> = (0..48_000 * 3).map(|i| if (48_000..96_000).contains(&i) { 0.9 } else { 0.1 }).collect();
        mic.push(&tone, None);
        while engine.frame_ready() {
            engine.frame();
        }
        engine.mix_until(48_000 * 3);
        assert_eq!(engine.elapsed_ms(), 2000, "the paused second is not recorded");
        engine.finish();
        let pcm = decode(&read_all(&dir), 48_000).unwrap();
        let peak = pcm.iter().map(|&s| (s as i32).abs()).max().unwrap();
        assert!(peak < 32768 / 2, "audio from the pause was mixed: peak {peak}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lost_device_is_reported_once() {
        let dir = tmp("lost");
        let (mic, i) = input(Role::Microphone);
        let mut engine = Engine::new(vec![i], ChunkStore::new(dir.clone(), None), false, 1).unwrap();
        *mic.lost.lock().unwrap() = Some("device unplugged".into());
        engine.frame();
        engine.frame();
        assert_eq!(engine.events.len(), 1);
        assert!(engine.source_lost.as_deref().unwrap().contains("unplugged"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn failed_writes_are_held_and_retried_in_order() {
        let root = tmp("retry");
        // A file where the directory should be: every write fails.
        fs::create_dir_all(root.parent().unwrap()).unwrap();
        fs::write(&root, b"x").unwrap();
        let mut store = ChunkStore::new(root.join("rec"), None);
        store.save(vec![1]);
        store.save(vec![2]);
        assert_eq!((store.written(), store.unsaved()), (0, 2));
        assert!(store.last_error.is_some());
        fs::remove_file(&root).unwrap();
        assert!(store.retry());
        assert_eq!(store.written(), 2);
        assert_eq!(fs::read(root.join("rec").join("000001.ogg")).unwrap(), vec![2]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn decode_rejects_other_formats() {
        assert!(decode(b"not ogg", 16_000).is_err());
    }
}
