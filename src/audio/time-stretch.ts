/**
 * Streaming WSOLA time-stretch for playback speed (1.25×, 1.5×, 2×) without
 * the pitch shift of a faster playbackRate. Speech-tuned: 40 ms Hann windows
 * at 50 % overlap; each next window is taken from around its nominal input
 * position, at the offset whose waveform best continues the previous one, so
 * periods line up and nothing clicks.
 */

const WINDOW_S = 0.04;
const SEEK_S = 0.012;

export class Wsola {
  private readonly hop: number;
  private readonly seek: number;
  private readonly window: Float32Array;
  private inPos: number;
  private prevPos: number | null = null;
  private tail: Float32Array;
  private pending: Float32Array;
  private pendingAt = 0;
  private done = false;

  constructor(
    private readonly pcm: Int16Array,
    sampleRate: number,
    private readonly rate: number,
    startSample = 0,
  ) {
    this.hop = Math.max(16, Math.round((WINDOW_S * sampleRate) / 2));
    this.seek = Math.round(SEEK_S * sampleRate);
    const n = this.hop * 2;
    this.window = new Float32Array(n);
    for (let k = 0; k < n; k++) this.window[k] = 0.5 * (1 - Math.cos((2 * Math.PI * k) / n));
    this.tail = new Float32Array(this.hop);
    this.pending = new Float32Array(0);
    this.inPos = Math.max(0, startSample);
  }

  /** Up to `n` output samples (fewer, or none, at the end of the input). */
  next(n: number): Float32Array {
    const out = new Float32Array(n);
    let filled = 0;
    while (filled < n) {
      if (this.pendingAt < this.pending.length) {
        const take = Math.min(n - filled, this.pending.length - this.pendingAt);
        out.set(this.pending.subarray(this.pendingAt, this.pendingAt + take), filled);
        this.pendingAt += take;
        filled += take;
        continue;
      }
      if (!this.step()) break;
    }
    return out.subarray(0, filled);
  }

  /** Produce one hop of output into `pending`; false once the input is used up. */
  private step(): boolean {
    if (this.done) return false;
    const { pcm, hop } = this;
    const p = Math.round(this.inPos);
    if (p + 2 * hop >= pcm.length) {
      // Fade out what the last window left behind, then stop.
      this.pending = this.tail;
      this.pendingAt = 0;
      this.tail = new Float32Array(hop);
      this.done = true;
      return this.pending.length > 0;
    }
    let best = p;
    if (this.prevPos !== null) {
      const ref = this.prevPos + hop;
      const lo = Math.max(0, p - this.seek);
      const hi = Math.min(pcm.length - 2 * hop - 1, p + this.seek);
      let bestScore = -Infinity;
      for (let c = lo; c <= hi; c += 2) {
        let corr = 0;
        let energy = 1;
        for (let k = 0; k < hop; k += 4) {
          const v = pcm[c + k]!;
          corr += pcm[ref + k]! * v;
          energy += v * v;
        }
        const score = corr / Math.sqrt(energy);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    const emit = new Float32Array(hop);
    const nextTail = new Float32Array(hop);
    for (let k = 0; k < hop; k++) {
      emit[k] = this.tail[k]! + (pcm[best + k]! / 0x8000) * this.window[k]!;
      nextTail[k] = (pcm[best + hop + k]! / 0x8000) * this.window[hop + k]!;
    }
    this.tail = nextTail;
    this.pending = emit;
    this.pendingAt = 0;
    this.prevPos = best;
    this.inPos += hop * this.rate;
    return true;
  }
}

/** Linear resample of `src` into `out` (whatever their lengths). */
export function resampleFloat(src: Float32Array, out: Float32Array): void {
  if (src.length === 0) {
    out.fill(0);
    return;
  }
  const step = out.length > 1 ? (src.length - 1) / (out.length - 1) : 0;
  for (let j = 0; j < out.length; j++) {
    const pos = j * step;
    const i = Math.floor(pos);
    const frac = pos - i;
    out[j] = i + 1 < src.length ? src[i]! * (1 - frac) + src[i + 1]! * frac : src[src.length - 1]!;
  }
}
