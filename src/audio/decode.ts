/**
 * Decode stored audio Blob → mono 16kHz Float32Array for the ASR engine (§12).
 *
 * decodeAudioData on a 16 kHz OfflineAudioContext resamples while decoding
 * (the trick `decodeForPlayback` uses too), so a long recording is never held
 * at 48 kHz. Downmix and the 80 Hz high-pass then run in place on the decoded
 * buffer: one full-length allocation instead of four (~4× less peak memory per
 * hour), and no realtime AudioContext is opened or closed (closing one tears
 * down WebKitGTK's GStreamer sink).
 */
import { decodeOggNative } from './native-decode';

export const ASR_SAMPLE_RATE = 16000;

export async function decodeToMono16k(
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Float32Array> {
  onProgress?.(0);
  // Native recordings (Ogg Opus): libopus in the desktop shell, at 16 kHz.
  const native = await decodeOggNative(blob, ASR_SAMPLE_RATE);
  if (native) {
    const mono = new Float32Array(native.length);
    for (let i = 0; i < native.length; i++) mono[i] = native[i]! / 0x8000;
    highpassInPlace(mono, ASR_SAMPLE_RATE, 80, 0.7);
    onProgress?.(1);
    return mono;
  }
  const arrayBuffer = await blob.arrayBuffer();
  const Offline =
    typeof window === 'undefined'
      ? undefined
      : (window.OfflineAudioContext ??
        (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
          .webkitOfflineAudioContext);
  // Fallback: raw PCM16 assumption if Web Audio unavailable (tests).
  if (!Offline) {
    onProgress?.(1);
    return new Float32Array(arrayBuffer.slice(0, 16000 * 10));
  }
  const ctx = new Offline(1, 1, ASR_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(arrayBuffer);
  onProgress?.(0.5);
  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const mono = downmixInPlace(channels);
  // High-pass at 80 Hz: rumble, HVAC, desk thumps and DC offset carry no
  // speech energy but do bias Whisper's mel input and drive hallucination.
  highpassInPlace(mono, decoded.sampleRate, 80, 0.7);
  onProgress?.(1);
  return mono;
}

/** Average all channels into the first one (no new allocation). */
export function downmixInPlace(channels: Float32Array[]): Float32Array {
  const out = channels[0] ?? new Float32Array(0);
  const n = channels.length;
  if (n <= 1) return out;
  const scale = 1 / n;
  for (let i = 0; i < out.length; i++) {
    let sum = out[i]!;
    for (let c = 1; c < n; c++) sum += channels[c]![i]!;
    out[i] = sum * scale;
  }
  return out;
}

/**
 * Second-order high-pass, in place. Same response as a Web Audio
 * BiquadFilterNode of type 'highpass' (whose Q is in dB), so transcription
 * input matches what the previous OfflineAudioContext render produced.
 */
export function highpassInPlace(x: Float32Array, sampleRate: number, frequency: number, qDb: number): void {
  const w0 = (2 * Math.PI * frequency) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const a0 = 1 + alpha;
  const b0 = (1 + cos) / 2 / a0;
  const b1 = -(1 + cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  // Transposed direct form II, state in doubles.
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const input = x[i]!;
    const y = b0 * input + z1;
    z1 = b1 * input - a1 * y + z2;
    z2 = b2 * input - a2 * y;
    x[i] = y;
  }
}
