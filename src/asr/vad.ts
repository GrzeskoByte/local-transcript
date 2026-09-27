/**
 * Energy-based voice activity detection + speech-only compaction.
 *
 * Whisper hallucinates and repeats on long non-speech stretches, and feeding it
 * silence wastes compute. `compactSpeech` removes the silent parts, and
 * `mapCompactedSample` translates timestamps on the shortened timeline back to
 * the original recording so transcript timing stays correct.
 *
 * Deliberately conservative: if compaction would remove little (<15%) we keep
 * the original audio untouched, so the common "mostly speech" case is unchanged.
 */

export interface SpeechSpan {
  /** Half-open sample range [start, end) in the ORIGINAL audio. */
  start: number;
  end: number;
}

export interface VadOptions {
  /** Analysis frame length (ms). */
  frameMs?: number;
  /** Frame hop (ms). */
  hopMs?: number;
  /** Spans shorter than this are discarded (ms). */
  minSpeechMs?: number;
  /** Gaps shorter than this are bridged rather than split (ms). */
  minSilenceMs?: number;
  /** Padding added around each kept span (ms). */
  padMs?: number;
  /** Speech threshold = noiseFloor * this. */
  noiseMultiplier?: number;
  /** Floor for the speech threshold, so pure silence yields no spans. */
  absoluteThreshold?: number;
}

export interface CompactionResult {
  audio: Float32Array;
  /** Spans kept, in original-timeline sample indices, ordered. */
  spans: SpeechSpan[];
  /** Compacted-timeline start offset for each kept span. */
  compactedStarts: number[];
  /** Fraction of samples removed (0 when not compacted). */
  removedFraction: number;
  /** False when the original audio was returned unchanged. */
  compacted: boolean;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

/** Detect speech spans (original-timeline sample indices). Empty => no speech. */
export function detectSpeechSpans(
  input: Float32Array,
  sampleRate = 16000,
  opts: VadOptions = {},
): SpeechSpan[] {
  if (input.length === 0) return [];
  const frameMs = opts.frameMs ?? 20;
  const hopMs = opts.hopMs ?? 10;
  const minSpeechMs = opts.minSpeechMs ?? 200;
  const minSilenceMs = opts.minSilenceMs ?? 300;
  const padMs = opts.padMs ?? 120;
  const noiseMultiplier = opts.noiseMultiplier ?? 3;
  const absoluteThreshold = opts.absoluteThreshold ?? 0.005;

  const frameLen = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const rms: number[] = [];
  for (let start = 0; start < input.length; start += hop) {
    const end = Math.min(input.length, start + frameLen);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = input[i] ?? 0;
      sum += v * v;
    }
    rms.push(Math.sqrt(sum / Math.max(1, end - start)));
  }

  // Noise floor from a low percentile. Taking the min of two low percentiles
  // keeps the estimate from jumping to speech level when silence is scarce
  // (<10% of the recording), which would otherwise suppress all detection.
  const noiseFloor = Math.min(percentile(rms, 0.1), percentile(rms, 0.02));
  const threshold = Math.max(noiseFloor * noiseMultiplier, absoluteThreshold);

  const raw: SpeechSpan[] = [];
  let current: SpeechSpan | null = null;
  for (let i = 0; i < rms.length; i++) {
    const voiced = (rms[i] ?? 0) >= threshold;
    const start = i * hop;
    const end = Math.min(input.length, start + frameLen);
    if (voiced) {
      if (current) current.end = end;
      else current = { start, end };
    } else if (current) {
      raw.push(current);
      current = null;
    }
  }
  if (current) raw.push(current);

  // Bridge short gaps (breaths, pauses inside a sentence).
  const minSilenceSamples = (sampleRate * minSilenceMs) / 1000;
  const merged: SpeechSpan[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minSilenceSamples) last.end = s.end;
    else merged.push({ ...s });
  }

  // Drop too-short blips, then pad and coalesce overlaps.
  const minSpeechSamples = (sampleRate * minSpeechMs) / 1000;
  const pad = Math.round((sampleRate * padMs) / 1000);
  const out: SpeechSpan[] = [];
  for (const s of merged) {
    if (s.end - s.start < minSpeechSamples) continue;
    const start = Math.max(0, s.start - pad);
    const end = Math.min(input.length, s.end + pad);
    const last = out[out.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

/**
 * Remove non-speech, keeping speech spans in order. Falls back to the original
 * audio (compacted: false) when nothing meaningful would be removed.
 */
export function compactSpeech(
  input: Float32Array,
  sampleRate = 16000,
  opts: VadOptions & { minRemovedFraction?: number } = {},
): CompactionResult {
  const total = input.length;
  const minRemovedFraction = opts.minRemovedFraction ?? 0.15;
  const spans = detectSpeechSpans(input, sampleRate, opts);
  const kept = spans.reduce((n, s) => n + (s.end - s.start), 0);
  const removedFraction = total > 0 ? Math.max(0, 1 - kept / total) : 0;

  if (spans.length === 0 || removedFraction < minRemovedFraction) {
    return {
      audio: input,
      spans: [{ start: 0, end: total }],
      compactedStarts: [0],
      removedFraction: 0,
      compacted: false,
    };
  }

  const audio = new Float32Array(kept);
  const compactedStarts: number[] = [];
  let offset = 0;
  for (const s of spans) {
    compactedStarts.push(offset);
    audio.set(input.subarray(s.start, s.end), offset);
    offset += s.end - s.start;
  }
  return { audio, spans, compactedStarts, removedFraction, compacted: true };
}

/** Map a compacted-timeline sample index back to the original recording. */
export function mapCompactedSample(sample: number, result: CompactionResult): number {
  if (!result.compacted) return sample;
  const { spans, compactedStarts } = result;
  if (spans.length === 0) return sample;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i]!;
    const len = span.end - span.start;
    const cStart = compactedStarts[i]!;
    if (sample < cStart) return span.start;
    if (sample < cStart + len) return span.start + (sample - cStart);
  }
  return spans[spans.length - 1]!.end;
}
