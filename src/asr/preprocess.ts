/**
 * Preprocessing for the ASR engine: peak-normalize quiet microphones and
 * attenuate background hiss/silence in place (timing-preserving) so Whisper
 * hears soft speech and stops hallucinating words into pauses.
 */
export interface PreprocessResult {
  audio: Float32Array;
  empty: boolean;
  speechRatio: number;
}

export function preprocessForASR(
  input: Float32Array,
  opts?: { silenceThreshold?: number },
): PreprocessResult {
  const threshold = opts?.silenceThreshold ?? 0.01;
  if (input.length === 0) return { audio: input, empty: true, speechRatio: 0 };

  let peak = 0;
  for (let i = 0; i < input.length; i++) {
    const a = Math.abs(input[i] ?? 0);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return { audio: input, empty: true, speechRatio: 0 };

  // Lift quiet recordings toward full scale; leave loud ones untouched.
  const gain = peak < 0.95 ? 0.95 / peak : 1;
  const out = new Float32Array(input.length);
  const frame = 1600; // 100ms at 16kHz
  let speechFrames = 0;
  let totalFrames = 0;
  for (let start = 0; start < input.length; start += frame) {
    const end = Math.min(input.length, start + frame);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = input[i] ?? 0;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / (end - start));
    totalFrames++;
    const silent = rms * gain < threshold;
    if (!silent) speechFrames++;
    for (let i = start; i < end; i++) {
      out[i] = silent ? (input[i] ?? 0) * gain * 0.05 : (input[i] ?? 0) * gain;
    }
  }
  const speechRatio = totalFrames > 0 ? speechFrames / totalFrames : 0;
  return { audio: out, empty: speechRatio < 0.01, speechRatio };
}
