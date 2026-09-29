import { describe, expect, it } from 'vitest';
import { assembleChunk, planSpeechChunks } from './chunking';

const SR = 16000;

/** Build audio from [kind, seconds] parts: 's' = tone (speech-like), '_' = near silence. */
function build(parts: [string, number][]): Float32Array {
  const total = parts.reduce((n, [, s]) => n + Math.round(s * SR), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      // 's': a 220 Hz tone with 4 Hz syllable-like modulation; '_': near silence;
      // 'n': stationary white-ish noise.
      out[o + i] =
        kind === 's' ? 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t))
        : kind === 'n' ? 0.05 * (((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2 - 1)
        : 0.0005 * Math.sin(i);
    }
    o += n;
  }
  return out;
}

const sec = (samples: number) => samples / SR;

describe('planSpeechChunks', () => {
  it('returns no chunks for silence', () => {
    expect(planSpeechChunks(build([['_', 10]]))).toEqual([]);
  });

  it('sends nothing for stationary noise (Whisper would hallucinate)', () => {
    expect(planSpeechChunks(build([['n', 8]]))).toEqual([]);
  });

  it('keeps wall-to-wall speech that has no pauses to detect', () => {
    const chunks = planSpeechChunks(build([['s', 20]]));
    const covered = chunks.reduce((n, c) => n + c.end - c.start, 0);
    expect(sec(covered)).toBeGreaterThan(19);
  });

  it('packs nearby utterances into one chunk spanning them', () => {
    const chunks = planSpeechChunks(build([['_', 1], ['s', 4], ['_', 1], ['s', 5], ['_', 1]]));
    expect(chunks).toHaveLength(1);
    expect(sec(chunks[0]!.start)).toBeCloseTo(0.8, 0);
    expect(sec(chunks[0]!.end)).toBeCloseTo(11.2, 0);
    expect(chunks[0]!.parts).toHaveLength(2);
  });

  it('cuts long silences out of the audio it sends, keeping real timestamps', () => {
    const audio = build([['s', 5], ['_', 12], ['s', 5]]);
    const chunks = planSpeechChunks(audio);
    expect(chunks).toHaveLength(1);
    expect(sec(chunks[0]!.end)).toBeGreaterThan(21.5); // covers both utterances
    const sent = assembleChunk(audio, chunks[0]!);
    expect(sec(sent.length)).toBeLessThan(11.5); // ~10.5 s speech + 0.3 s bridge, not 22 s
  });

  it('fills chunks by speech time, never over the max, in order', () => {
    const parts: [string, number][] = [];
    for (let i = 0; i < 12; i++) parts.push(['s', 6], ['_', 3]);
    const audio = build(parts);
    const chunks = planSpeechChunks(audio, SR, { maxChunkMs: 28000 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(sec(assembleChunk(audio, chunks[i]!).length)).toBeLessThanOrEqual(28);
      if (i > 0) expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end);
    }
    // ~6.6 s per utterance with padding → 4 utterances fit per 28 s chunk.
    expect(chunks[0]!.parts.length).toBe(4);
  });

  it('tops a chunk up with the head of the next utterance instead of wasting the window', () => {
    const audio = build([['s', 18], ['_', 1], ['s', 18]]);
    const chunks = planSpeechChunks(audio, SR, { maxChunkMs: 28000 });
    expect(chunks).toHaveLength(2);
    const first = sec(assembleChunk(audio, chunks[0]!).length);
    expect(first).toBeGreaterThan(24); // filled, not ~18 s
    expect(first).toBeLessThanOrEqual(28);
    expect(chunks[1]!.start).toBe(chunks[0]!.end); // contiguous hand-off, nothing lost
  });

  it('caps the wall-clock span of one chunk', () => {
    const audio = build([['s', 2], ['_', 50], ['s', 2], ['_', 50], ['s', 2]]);
    const chunks = planSpeechChunks(audio, SR, { maxSpanMs: 60000 });
    expect(chunks.length).toBe(2);
    for (const c of chunks) expect(sec(c.end - c.start)).toBeLessThanOrEqual(60);
  });

  it('splits one very long utterance into bounded, contiguous pieces', () => {
    const chunks = planSpeechChunks(build([['s', 70]]), SR, { maxChunkMs: 28000 });
    expect(chunks.length).toBe(3);
    for (const c of chunks) expect(sec(c.end - c.start)).toBeLessThanOrEqual(28);
    expect(chunks[1]!.start).toBe(chunks[0]!.end);
    expect(chunks[2]!.start).toBe(chunks[1]!.end);
  });
});
