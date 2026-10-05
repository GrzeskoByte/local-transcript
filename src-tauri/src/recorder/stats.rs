//! Recording diagnostics measured on the raw inputs (before the Mic + Device
//! mix), the native counterpart of `src/audio/diagnostics.ts`: the same
//! measurements and the same JSON shape (`InputStats`, `BleedStats`), so the
//! frontend's `assessDiagnostics` reads them unchanged.
//!
//! Every 500 ms each input's last 16384 samples (~340 ms) are inspected:
//! level, full-scale samples, exact silence after signal (dropout), spectrum
//! above 4/8 kHz (Bluetooth call mode is narrowband) and — with both inputs —
//! how strongly the system sound reappears in the microphone, and how late.

use serde::Serialize;

pub const SAMPLE_RATE: f64 = 48_000.0;
const WINDOW: usize = 16_384;
const ACTIVE_DB: f64 = -50.0;
const BUCKET_S: f64 = 10.0;
const FLOOR_DB: f64 = -120.0;
const DECIMATE: usize = 8;
const MAX_LAG_S: f64 = 0.25;
const MAX_BLEED_SAMPLES: usize = 2000;

fn to_db(x: f64) -> f64 {
    if x > 0.0 {
        (20.0 * x.log10()).max(FLOOR_DB)
    } else {
        FLOOR_DB
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel_count: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelBucket {
    pub t: f64,
    pub rms_db: f64,
    pub peak_db: f64,
    pub clipped: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputStats {
    pub role: &'static str,
    pub settings: InputSettings,
    pub polls: u64,
    pub active_polls: u64,
    #[serde(rename = "wideband4kPolls")]
    pub wideband_4k_polls: u64,
    #[serde(rename = "wideband8kPolls")]
    pub wideband_8k_polls: u64,
    pub clipped_polls: u64,
    pub clipped_samples: u64,
    pub sampled_samples: u64,
    pub dropout_polls: u64,
    pub peak_db: f64,
    pub timeline: Vec<LevelBucket>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BleedStats {
    pub windows: usize,
    pub median_corr: f64,
    pub median_lag_ms: f64,
    pub lag_consistency: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FrameStats {
    pub rms_db: f64,
    pub peak_db: f64,
    pub clipped: u64,
    pub silent: bool,
}

pub fn frame_stats(x: &[f32]) -> FrameStats {
    let mut sum = 0.0f64;
    let mut peak = 0.0f64;
    let mut clipped = 0;
    for &s in x {
        let a = s.abs() as f64;
        sum += a * a;
        peak = peak.max(a);
        if a >= 0.999 {
            clipped += 1;
        }
    }
    let rms = if x.is_empty() { 0.0 } else { (sum / x.len() as f64).sqrt() };
    FrameStats { rms_db: to_db(rms), peak_db: to_db(peak), clipped, silent: peak == 0.0 }
}

/// In-place iterative radix-2 FFT (power-of-two length).
fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let next = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = next;
            }
        }
        len <<= 1;
    }
}

/// Share of spectral power above `hz` (Blackman window, like AnalyserNode).
pub fn power_share_above(x: &[f32], hz: &[f64]) -> Vec<f64> {
    let n = x.len();
    let mut re: Vec<f64> = x
        .iter()
        .enumerate()
        .map(|(i, &s)| {
            let a = 2.0 * std::f64::consts::PI * i as f64 / n as f64;
            s as f64 * (0.42 - 0.5 * a.cos() + 0.08 * (2.0 * a).cos())
        })
        .collect();
    let mut im = vec![0.0; n];
    fft(&mut re, &mut im);
    let bin_hz = SAMPLE_RATE / n as f64;
    let mut total = 0.0;
    let mut above = vec![0.0; hz.len()];
    for i in 1..n / 2 {
        let p = re[i] * re[i] + im[i] * im[i];
        total += p;
        for (k, &h) in hz.iter().enumerate() {
            if i as f64 * bin_hz > h {
                above[k] += p;
            }
        }
    }
    above.iter().map(|a| if total > 0.0 { a / total } else { 0.0 }).collect()
}

fn decimate(x: &[f32], factor: usize) -> Vec<f32> {
    x.chunks_exact(factor).map(|c| c.iter().sum::<f32>() / factor as f32).collect()
}

/// Best normalized |correlation| of `mic` against `dev`, the microphone
/// `0..max_lag` samples later. Returns (corr, lag in samples).
pub fn best_lag(mic: &[f32], dev: &[f32], max_lag: usize) -> (f64, usize) {
    let n = mic.len().min(dev.len());
    let mut best = (0.0, 0);
    let upper = max_lag.min(n.saturating_sub(64));
    for lag in 0..=upper {
        let (mut xy, mut xx, mut yy) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..n - lag {
            let d = dev[i] as f64;
            let m = mic[i + lag] as f64;
            xy += d * m;
            xx += d * d;
            yy += m * m;
        }
        let c = if xx > 0.0 && yy > 0.0 { xy.abs() / (xx * yy).sqrt() } else { 0.0 };
        if c > best.0 {
            best = (c, lag);
        }
    }
    best
}

fn median(xs: &mut [f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let m = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[m]
    } else {
        (xs[m - 1] + xs[m]) / 2.0
    }
}

pub fn summarize_bleed(samples: &[(f64, f64)]) -> Option<BleedStats> {
    if samples.is_empty() {
        return None;
    }
    let lag = median(&mut samples.iter().map(|s| s.1).collect::<Vec<_>>());
    Some(BleedStats {
        windows: samples.len(),
        median_corr: median(&mut samples.iter().map(|s| s.0).collect::<Vec<_>>()),
        median_lag_ms: lag,
        lag_consistency: samples.iter().filter(|s| (s.1 - lag).abs() <= 10.0).count() as f64 / samples.len() as f64,
    })
}

struct Bucket {
    t: f64,
    sum: f64,
    n: u64,
    peak: f64,
    clipped: u64,
}

struct Probe {
    ring: Vec<f32>,
    at: usize,
    filled: bool,
    stats: InputStats,
    had_signal: bool,
    bucket: Option<Bucket>,
    last_rms_db: f64,
}

impl Probe {
    fn window(&self) -> Vec<f32> {
        if !self.filled {
            return self.ring[..self.at].to_vec();
        }
        let mut w = Vec::with_capacity(WINDOW);
        w.extend_from_slice(&self.ring[self.at..]);
        w.extend_from_slice(&self.ring[..self.at]);
        w
    }

    fn flush_bucket(&mut self) {
        if let Some(b) = self.bucket.take() {
            self.stats.timeline.push(bucket_entry(&b));
        }
    }
}

fn bucket_entry(b: &Bucket) -> LevelBucket {
    LevelBucket {
        t: b.t,
        rms_db: if b.n > 0 { round1(to_db((b.sum / b.n as f64).sqrt())) } else { FLOOR_DB },
        peak_db: round1(b.peak),
        clipped: b.clipped,
    }
}

/// Measures every input of one recording.
pub struct Stats {
    probes: Vec<Probe>,
    bleed: Vec<(f64, f64)>,
}

impl Stats {
    pub fn new(inputs: Vec<(&'static str, InputSettings)>) -> Self {
        let probes = inputs
            .into_iter()
            .map(|(role, settings)| Probe {
                ring: vec![0.0; WINDOW],
                at: 0,
                filled: false,
                stats: InputStats {
                    role,
                    settings,
                    polls: 0,
                    active_polls: 0,
                    wideband_4k_polls: 0,
                    wideband_8k_polls: 0,
                    clipped_polls: 0,
                    clipped_samples: 0,
                    sampled_samples: 0,
                    dropout_polls: 0,
                    peak_db: FLOOR_DB,
                    timeline: Vec::new(),
                },
                had_signal: false,
                bucket: None,
                last_rms_db: FLOOR_DB,
            })
            .collect();
        Self { probes, bleed: Vec::new() }
    }

    /// Feed one 48 kHz mono frame of input `index`.
    pub fn feed(&mut self, index: usize, frame: &[f32]) {
        let Some(p) = self.probes.get_mut(index) else { return };
        for &s in frame {
            p.ring[p.at] = s;
            p.at += 1;
            if p.at == WINDOW {
                p.at = 0;
                p.filled = true;
            }
        }
    }

    /// Take one measurement of every input; `t` = seconds into the recording.
    pub fn poll(&mut self, t: f64) {
        for p in &mut self.probes {
            let w = p.window();
            if w.is_empty() {
                continue;
            }
            let f = frame_stats(&w);
            let s = &mut p.stats;
            s.polls += 1;
            s.sampled_samples += w.len() as u64;
            s.clipped_samples += f.clipped;
            if f.clipped > 0 {
                s.clipped_polls += 1;
            }
            s.peak_db = s.peak_db.max(f.peak_db);
            p.last_rms_db = f.rms_db;
            if f.silent && p.had_signal {
                s.dropout_polls += 1;
            }
            if f.rms_db > ACTIVE_DB {
                p.had_signal = true;
                s.active_polls += 1;
                if w.len() == WINDOW {
                    let shares = power_share_above(&w, &[4000.0, 8000.0]);
                    if shares[0] > 0.0005 {
                        s.wideband_4k_polls += 1;
                    }
                    if shares[1] > 0.0001 {
                        s.wideband_8k_polls += 1;
                    }
                }
            }
            let start = (t / BUCKET_S).floor() * BUCKET_S;
            if p.bucket.as_ref().map(|b| b.t) != Some(start) {
                p.flush_bucket();
                p.bucket = Some(Bucket { t: start, sum: 0.0, n: 0, peak: FLOOR_DB, clipped: 0 });
            }
            let b = p.bucket.as_mut().unwrap();
            b.sum += 10f64.powf(f.rms_db / 10.0);
            b.n += 1;
            b.peak = b.peak.max(f.peak_db);
            b.clipped += f.clipped;
        }
        let mic = self.probes.iter().position(|p| p.stats.role == "microphone");
        let dev = self.probes.iter().position(|p| p.stats.role == "device");
        if let (Some(m), Some(d)) = (mic, dev) {
            let (mp, dp) = (&self.probes[m], &self.probes[d]);
            if dp.last_rms_db > -45.0 && mp.last_rms_db > -65.0 && self.bleed.len() < MAX_BLEED_SAMPLES {
                let rate = SAMPLE_RATE / DECIMATE as f64;
                let (corr, lag) = best_lag(
                    &decimate(&mp.window(), DECIMATE),
                    &decimate(&dp.window(), DECIMATE),
                    (MAX_LAG_S * rate).round() as usize,
                );
                self.bleed.push((corr, lag as f64 / rate * 1000.0));
            }
        }
    }

    /// Current measurements (the running bucket included).
    pub fn inputs(&self) -> Vec<InputStats> {
        self.probes
            .iter()
            .map(|p| {
                let mut s = p.stats.clone();
                if let Some(b) = p.bucket.as_ref().filter(|b| b.n > 0) {
                    s.timeline.push(bucket_entry(b));
                }
                s
            })
            .collect()
    }

    pub fn bleed(&self) -> Option<BleedStats> {
        summarize_bleed(&self.bleed)
    }

    /// Last measured level of each input (dBFS), for the live meter.
    pub fn levels(&self) -> Vec<f64> {
        self.probes.iter().map(|p| p.last_rms_db).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(hz: f64, amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f64::consts::PI * hz * i as f64 / SAMPLE_RATE).sin() as f32).collect()
    }

    #[test]
    fn frame_stats_measure_level_peak_and_clipping() {
        let f = frame_stats(&[0.5, -0.5, 1.0, 0.0]);
        assert!((f.peak_db - 0.0).abs() < 1e-9);
        assert_eq!(f.clipped, 1);
        assert!(!f.silent);
        assert!(frame_stats(&[0.0; 8]).silent);
    }

    #[test]
    fn spectrum_share_tells_wideband_from_narrowband() {
        let low = power_share_above(&tone(1000.0, 0.5, WINDOW), &[4000.0, 8000.0]);
        assert!(low[0] < 0.0005, "{low:?}");
        let mut mixed = tone(1000.0, 0.5, WINDOW);
        for (a, b) in mixed.iter_mut().zip(tone(10_000.0, 0.1, WINDOW)) {
            *a += b;
        }
        let wide = power_share_above(&mixed, &[4000.0, 8000.0]);
        assert!(wide[0] > 0.01 && wide[1] > 0.01, "{wide:?}");
    }

    #[test]
    fn bleed_finds_the_delay() {
        // Noise-like signal; the microphone hears it 30 ms later.
        let mut seed = 1u32;
        let dev: Vec<f32> = (0..WINDOW)
            .map(|_| {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        let delay = (0.030 * SAMPLE_RATE) as usize;
        let mic: Vec<f32> = (0..WINDOW).map(|i| if i >= delay { 0.5 * dev[i - delay] } else { 0.0 }).collect();
        let mut stats = Stats::new(vec![("microphone", InputSettings::default()), ("device", InputSettings::default())]);
        stats.feed(0, &mic);
        stats.feed(1, &dev);
        stats.poll(0.5);
        let b = stats.bleed().unwrap();
        assert!(b.median_corr > 0.8, "{b:?}");
        assert!((b.median_lag_ms - 30.0).abs() < 2.0, "{b:?}");
    }

    #[test]
    fn polls_build_buckets_and_count_dropouts() {
        let mut stats = Stats::new(vec![("microphone", InputSettings::default())]);
        stats.feed(0, &tone(440.0, 0.3, WINDOW));
        stats.poll(0.5);
        stats.feed(0, &vec![0.0; WINDOW]);
        stats.poll(11.0);
        let s = &stats.inputs()[0];
        assert_eq!((s.polls, s.active_polls, s.dropout_polls), (2, 1, 1));
        assert_eq!(s.timeline.len(), 2);
        assert_eq!(s.timeline[1].t, 10.0);
        let json = serde_json::to_value(s).unwrap();
        assert!(json.get("wideband4kPolls").is_some() && json.get("activePolls").is_some());
    }
}
