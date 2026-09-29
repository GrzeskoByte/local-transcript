/**
 * Speech-aligned chunk planning for backends that return plain text only
 * (voxtype prints one transcript per file, no timestamps).
 *
 * Every chunk becomes one transcript segment with a real start/end on the
 * recording timeline, which gives the transcript usable timestamps and lets
 * two-way tracks ("Me" / "Others") interleave by time.
 *
 * Cost model: Whisper pays for a full 30 s window per call no matter how much
 * audio is in it, plus a model load per process. So chunks are packed by
 * SPEECH time (up to ~28 s) and long silences between utterances are cut out
 * of the audio that is sent — full windows, no compute spent on silence.
 */
import { detectSpeechSpans } from './vad.ts';
import type { SpeechSpan, VadOptions } from './vad.ts';

/** See ChunkPlanOptions.maxChunkMs; measured with `npm run bench:native`. */
export const DEFAULT_MAX_CHUNK_MS = 24000;

export interface SpeechChunk {
  /** Original-timeline sample range the chunk covers: its segment's start/end. */
  start: number;
  end: number;
  /** Speech spans to send, in order; silence between them is not sent. */
  parts: SpeechSpan[];
}

export interface ChunkPlanOptions {
  /** Max audio sent per chunk (ms), including bridging gaps. Kept well under
   * Whisper's 30 s window: audio that runs up to the window edge loses its
   * trailing words (measured: 28 s → +6.7 pp WER on long-form; 24 s → parity). */
  maxChunkMs?: number;
  /** Max wall-clock span a chunk may cover (ms), so timestamps stay meaningful. */
  maxSpanMs?: number;
  /** Silence kept between two joined parts (ms); longer gaps are shortened to this. */
  bridgeMs?: number;
  /** Top a chunk up with the head of the next utterance when at least this
   * much room is left (ms); smaller leftovers just start a new chunk. */
  minTopUpMs?: number;
  /** When a single utterance exceeds maxChunkMs, cut at the quietest point
   * inside the last part of the chunk, searching this fraction of it. */
  cutSearchFraction?: number;
  vad?: VadOptions;
}

/** Plan chunks on the original timeline. Empty when there is no speech. */
export function planSpeechChunks(
  audio: Float32Array,
  sampleRate = 16000,
  opts: ChunkPlanOptions = {},
): SpeechChunk[] {
  const maxSamples = Math.round(((opts.maxChunkMs ?? DEFAULT_MAX_CHUNK_MS) * sampleRate) / 1000);
  const maxSpan = Math.round(((opts.maxSpanMs ?? 60000) * sampleRate) / 1000);
  const bridge = Math.round(((opts.bridgeMs ?? 300) * sampleRate) / 1000);
  const searchFraction = opts.cutSearchFraction ?? 0.4;
  let spans = detectSpeechSpans(audio, sampleRate, {
    minSilenceMs: 400,
    padMs: 200,
    ...opts.vad,
  });
  // The VAD threshold is relative to the recording's own noise floor, so audio
  // with almost no quiet frames (wall-to-wall speech) can yield no spans. Fall
  // back to all of it — but only when it is modulated like speech: stationary
  // noise (hum, hiss, fans) would just make Whisper hallucinate.
  if (spans.length === 0 && looksLikeSpeech(audio, sampleRate, opts.vad?.absoluteThreshold ?? 0.005)) {
    spans = [{ start: 0, end: audio.length }];
  }

  const chunks: SpeechChunk[] = [];
  let current: SpeechChunk | null = null;
  let sentSamples = 0;

  const minTopUp = Math.round(((opts.minTopUpMs ?? 6000) * sampleRate) / 1000);
  const frame = Math.round(sampleRate * 0.05);

  for (const span of spans) {
    // Break utterances that are longer than one chunk at their quietest point.
    for (let piece of splitLongSpan(audio, span, maxSamples, searchFraction, sampleRate)) {
      const cur: SpeechChunk | null = current;
      if (cur) {
        const gap = Math.min(piece.start - cur.end, bridge);
        const joined = sentSamples + gap + (piece.end - piece.start);
        const spanOk = piece.end - cur.start <= maxSpan;
        if (joined <= maxSamples && spanOk) {
          cur.parts.push({ ...piece });
          cur.end = piece.end;
          sentSamples = joined;
          continue;
        }
        // Top the chunk up instead of leaving much of Whisper's paid-for
        // window empty: take the head of this utterance up to its quietest
        // point (usually between words) and carry the rest forward.
        const room = maxSamples - sentSamples - gap;
        if (spanOk && room >= minTopUp) {
          const cut = quietestPoint(audio, piece.start + Math.floor(room * (1 - searchFraction)), piece.start + room, frame);
          cur.parts.push({ start: piece.start, end: cut });
          cur.end = cut;
          piece = { start: cut, end: piece.end };
        }
        chunks.push(cur);
      }
      current = { start: piece.start, end: piece.end, parts: [{ ...piece }] };
      sentSamples = piece.end - piece.start;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * The audio actually sent for a chunk: its parts in order, each gap between
 * them shortened to at most `bridgeMs` so words do not run together.
 */
export function assembleChunk(
  audio: Float32Array,
  chunk: SpeechChunk,
  sampleRate = 16000,
  bridgeMs = 300,
): Float32Array {
  const bridge = Math.round((bridgeMs * sampleRate) / 1000);
  let total = 0;
  chunk.parts.forEach((p, i) => {
    total += p.end - p.start;
    if (i > 0) total += Math.min(p.start - chunk.parts[i - 1]!.end, bridge);
  });
  const out = new Float32Array(total);
  let o = 0;
  chunk.parts.forEach((p, i) => {
    if (i > 0) {
      const gap = Math.min(p.start - chunk.parts[i - 1]!.end, bridge);
      // Keep the real room tone of a short gap; longer gaps become a short bridge.
      out.set(audio.subarray(chunk.parts[i - 1]!.end, chunk.parts[i - 1]!.end + gap), o);
      o += gap;
    }
    out.set(audio.subarray(p.start, p.end), o);
    o += p.end - p.start;
  });
  return out;
}

function splitLongSpan(
  audio: Float32Array,
  span: SpeechSpan,
  maxSamples: number,
  searchFraction: number,
  sampleRate: number,
): SpeechSpan[] {
  const out: SpeechSpan[] = [];
  let start = span.start;
  while (span.end - start > maxSamples) {
    const hi = start + maxSamples;
    const lo = start + Math.floor(maxSamples * (1 - searchFraction));
    const cut = quietestPoint(audio, lo, hi, Math.round(sampleRate * 0.05));
    out.push({ start, end: cut });
    start = cut;
  }
  out.push({ start, end: span.end });
  return out;
}

/** Centre of the lowest-energy frame in [lo, hi); ties favour the latest frame
 * so chunks stay as full as possible. */
function quietestPoint(audio: Float32Array, lo: number, hi: number, frame: number): number {
  let best = hi;
  let bestEnergy = Infinity;
  for (let s = lo; s + frame <= hi; s += frame) {
    let e = 0;
    for (let i = s; i < s + frame; i++) {
      const v = audio[i] ?? 0;
      e += v * v;
    }
    if (e <= bestEnergy) {
      bestEnergy = e;
      best = s + Math.floor(frame / 2);
    }
  }
  return best;
}

/**
 * Audible and strongly energy-modulated (syllables, words) rather than
 * stationary. Speech frame energy varies a lot even without pauses; white
 * noise, hum and hiss keep a near-constant level (coefficient of variation ≈ 0.1).
 */
function looksLikeSpeech(audio: Float32Array, sampleRate: number, minRms: number): boolean {
  const frame = Math.max(1, Math.round(sampleRate * 0.05));
  const levels: number[] = [];
  for (let s = 0; s + frame <= audio.length; s += frame) {
    let e = 0;
    for (let i = s; i < s + frame; i++) {
      const v = audio[i] ?? 0;
      e += v * v;
    }
    levels.push(Math.sqrt(e / frame));
  }
  if (levels.length < 4) return false;
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  if (mean < minRms) return false;
  const sd = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length);
  return sd / mean > 0.35;
}
