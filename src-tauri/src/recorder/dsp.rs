//! Small, allocation-light DSP for the recorder: downmix, resampling to
//! 48 kHz, the Mic + Device limiter and 48 → 16 kHz decimation for live
//! transcription.

/// Average interleaved channels into mono.
pub fn downmix(interleaved: &[f32], channels: usize, out: &mut Vec<f32>) {
    if channels <= 1 {
        out.extend_from_slice(interleaved);
        return;
    }
    let scale = 1.0 / channels as f32;
    out.extend(interleaved.chunks_exact(channels).map(|f| f.iter().sum::<f32>() * scale));
}

/// Streaming linear-interpolation resampler (mono). Speech-grade: devices
/// almost always run at 48 kHz already, where this is a plain copy.
pub struct Resampler {
    step: f64,
    /// Position of the next output sample, relative to `prev`'s index (-1).
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        Self { step: from as f64 / to as f64, pos: 1.0, prev: 0.0 }
    }

    pub fn push(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < f64::EPSILON {
            out.extend_from_slice(input);
            return;
        }
        // Sample i of `input` sits at position i + 1 (prev at 0).
        let n = input.len() as f64;
        while self.pos <= n {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = if i == 0 { self.prev } else { input[i - 1] };
            let b = if i < input.len() { input[i] } else { a };
            out.push(a + (b - a) * frac);
            self.pos += self.step;
        }
        self.pos -= n;
        if let Some(&last) = input.last() {
            self.prev = last;
        }
    }
}

/// Peak limiter for the Mic + Device sum (like the webview mixer's
/// DynamicsCompressor: -3 dBFS, fast attack, 250 ms release).
pub struct Limiter {
    threshold: f32,
    release: f32,
    env: f32,
}

impl Limiter {
    pub fn new(sample_rate: u32) -> Self {
        let release = (-1.0 / (0.25 * sample_rate as f32)).exp();
        Self { threshold: 10f32.powf(-3.0 / 20.0), release, env: 0.0 }
    }

    pub fn process(&mut self, x: &mut [f32]) {
        for s in x.iter_mut() {
            let a = s.abs();
            self.env = if a > self.env { a } else { self.env * self.release + a * (1.0 - self.release) };
            if self.env > self.threshold {
                *s *= self.threshold / self.env;
            }
            *s = s.clamp(-1.0, 1.0);
        }
    }
}

/// 48 kHz → 16 kHz by averaging each 3 samples (as the webview's Downsampler).
pub fn decimate3(x: &[f32], out: &mut Vec<f32>) {
    out.extend(x.chunks_exact(3).map(|c| (c[0] + c[1] + c[2]) / 3.0));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downmix_averages_channels() {
        let mut out = Vec::new();
        downmix(&[1.0, 0.0, 0.5, 0.5], 2, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn resampler_keeps_duration_and_shape_across_blocks() {
        let tone: Vec<f32> = (0..44_100).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 44_100.0).sin()).collect();
        let mut r = Resampler::new(44_100, 48_000);
        let mut out = Vec::new();
        for block in tone.chunks(441) {
            r.push(block, &mut out);
        }
        assert!((out.len() as i64 - 48_000).abs() <= 2, "{}", out.len());
        // Still a 440 Hz sine at 48 kHz (compare away from the start).
        for (i, v) in out.iter().enumerate().skip(100).step_by(997) {
            let expected = (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin();
            assert!((v - expected).abs() < 0.05, "at {i}: {v} vs {expected}");
        }
    }

    #[test]
    fn resampler_is_a_copy_at_the_same_rate() {
        let mut r = Resampler::new(48_000, 48_000);
        let mut out = Vec::new();
        r.push(&[0.1, 0.2], &mut out);
        assert_eq!(out, vec![0.1, 0.2]);
    }

    #[test]
    fn limiter_keeps_the_sum_below_full_scale() {
        let mut l = Limiter::new(48_000);
        let mut x: Vec<f32> = (0..4800).map(|i| 1.6 * (i as f32 * 0.05).sin()).collect();
        l.process(&mut x);
        assert!(x.iter().all(|v| v.abs() <= 0.71 + 1e-3), "{:?}", x.iter().cloned().fold(0.0f32, f32::max));
        let mut quiet = vec![0.2f32; 100];
        Limiter::new(48_000).process(&mut quiet);
        assert!(quiet.iter().all(|&v| v == 0.2));
    }

    #[test]
    fn decimate3_averages() {
        let mut out = Vec::new();
        decimate3(&[0.0, 0.3, 0.6, 1.0, 1.0, 1.0, 9.0], &mut out);
        assert_eq!(out.len(), 2);
        assert!((out[0] - 0.3).abs() < 1e-6 && (out[1] - 1.0).abs() < 1e-6);
    }
}
