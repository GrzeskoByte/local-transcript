/**
 * Live transcription: turn a growing 16 kHz stream into short utterances as
 * soon as each one ends, so they can be transcribed while recording.
 *
 * Reuses the whole-file chunk planner (`planSpeechChunks`): every tick the
 * pending audio is re-planned, and a chunk is emitted once at least `holdMs`
 * of audio follows it (the speaker paused, or the chunk is already full).
 * `maxChunkMs`/`maxSpanMs` keep chunks short (≤10 s, cut at the quietest
 * point when nobody pauses), so text appears every few seconds instead of
 * after 24 s of speech.
 */
import { assembleChunk, planSpeechChunks } from './chunking';

export const LIVE_SAMPLE_RATE = 16000;

export interface LiveUtterance {
  /** Recording-timeline span (samples since capture started, pauses excluded). */
  start: number;
  end: number;
  /** The audio to transcribe: speech parts with long gaps shortened. */
  audio: Float32Array;
}

export interface LiveSegmenterOptions {
  sampleRate?: number;
  /** Audio that must follow a chunk before it is final (ms). */
  holdMs?: number;
  /** Longest audio sent per utterance (ms); longer talk is cut at its quietest point. */
  maxChunkMs?: number;
  /** Longest wall-clock stretch one utterance may cover (ms). */
  maxSpanMs?: number;
  /** Silence-only audio kept while waiting for speech (ms). */
  keepSilenceMs?: number;
  /** Longest audio held without emitting anything (ms); then it is flushed. */
  maxPendingMs?: number;
}

export class LiveSegmenter {
  private parts: Float32Array[] = [];
  private length = 0;
  /** Timeline index of the first pending sample. */
  private base = 0;
  private readonly rate: number;
  private readonly hold: number;
  private readonly maxSpanMs: number;
  private readonly maxChunkMs: number;
  private readonly keepSilence: number;
  private readonly maxPending: number;

  constructor(opts: LiveSegmenterOptions = {}) {
    this.rate = opts.sampleRate ?? LIVE_SAMPLE_RATE;
    this.hold = Math.round(((opts.holdMs ?? 1000) * this.rate) / 1000);
    this.maxSpanMs = opts.maxSpanMs ?? 10000;
    this.maxChunkMs = opts.maxChunkMs ?? 10000;
    this.keepSilence = Math.round(((opts.keepSilenceMs ?? 2000) * this.rate) / 1000);
    this.maxPending = Math.round(((opts.maxPendingMs ?? 15000) * this.rate) / 1000);
  }

  /** Total samples received so far (the recording-timeline clock). */
  get position(): number {
    return this.base + this.length;
  }

  push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.parts.push(samples);
    this.length += samples.length;
  }

  /**
   * Utterances that are complete. `final` (on stop) also emits the one still
   * being spoken.
   */
  take(final = false): LiveUtterance[] {
    if (this.length === 0) return [];
    const audio = this.pending();
    const chunks = planSpeechChunks(audio, this.rate, { maxSpanMs: this.maxSpanMs, maxChunkMs: this.maxChunkMs });
    const limit = final ? audio.length : audio.length - this.hold;
    const out: LiveUtterance[] = [];
    let consumed = 0;
    for (const chunk of chunks) {
      if (chunk.end > limit) break;
      out.push({
        start: this.base + chunk.start,
        end: this.base + chunk.end,
        audio: assembleChunk(audio, chunk, this.rate),
      });
      consumed = chunk.end;
    }
    // Wall-to-wall speech without a single quiet frame plans as one chunk
    // that never ends: cap how long text can lag behind.
    if (!final && out.length === 0 && audio.length > this.maxPending) return this.take(true);
    if (final) consumed = audio.length;
    else if (chunks.length === 0 || (out.length === chunks.length && consumed < audio.length)) {
      // Nothing (more) to say yet: drop silence, keeping a little lead-in so
      // the next utterance's onset is not cut.
      consumed = Math.max(consumed, audio.length - this.keepSilence);
    }
    this.drop(audio, consumed);
    return out;
  }

  private pending(): Float32Array {
    if (this.parts.length === 1) return this.parts[0]!;
    const all = new Float32Array(this.length);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [all];
    return all;
  }

  private drop(audio: Float32Array, count: number): void {
    if (count <= 0) return;
    const rest = audio.slice(count);
    this.parts = rest.length > 0 ? [rest] : [];
    this.length = rest.length;
    this.base += count;
  }
}

/**
 * Streaming box-filter decimator (e.g. 48 kHz capture → 16 kHz for ASR).
 * Averaging each output period is a cheap anti-alias filter that is plenty for
 * speech; state carries across calls so block edges add no clicks or drift.
 */
export class Downsampler {
  private readonly ratio: number;
  private sum = 0;
  private count = 0;
  /** Input samples consumed, and the input index where the next output ends. */
  private consumed = 0;
  private nextEdge: number;

  constructor(
    readonly inputRate: number,
    readonly outputRate: number = LIVE_SAMPLE_RATE,
  ) {
    this.ratio = inputRate / outputRate;
    this.nextEdge = this.ratio;
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const out = new Float32Array(Math.ceil(input.length / this.ratio) + 1);
    let o = 0;
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i]!;
      this.count++;
      this.consumed++;
      if (this.consumed >= this.nextEdge) {
        out[o++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.nextEdge += this.ratio;
      }
    }
    return out.subarray(0, o);
  }
}
