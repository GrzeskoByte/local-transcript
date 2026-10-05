import { describe, expect, it } from 'vitest';
import { Downsampler, LiveSegmenter } from './live-segmenter';

const SR = 16000;

/** 's' = speech-like modulated tone, '_' = near silence (same as chunking.test.ts). */
function build(parts: [string, number][]): Float32Array {
  const total = parts.reduce((n, [, s]) => n + Math.round(s * SR), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [kind, sec] of parts) {
    const n = Math.round(sec * SR);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[o + i] =
        kind === 's'
          ? 0.3 * Math.sin(2 * Math.PI * 220 * t) * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t))
          : 0.0005 * Math.sin(i);
    }
    o += n;
  }
  return out;
}

/** Feed audio in 0.25 s blocks, ticking every second like the app does. */
function stream(seg: LiveSegmenter, audio: Float32Array) {
  const out = [];
  const block = SR / 4;
  for (let i = 0; i < audio.length; i += block) {
    seg.push(audio.subarray(i, Math.min(audio.length, i + block)));
    if ((i / block) % 4 === 3) out.push(...seg.take());
  }
  return out;
}

const sec = (samples: number) => samples / SR;

describe('LiveSegmenter', () => {
  it('emits nothing for silence and does not keep it', () => {
    const seg = new LiveSegmenter();
    expect(stream(seg, build([['_', 30]]))).toEqual([]);
    expect(seg.take(true)).toEqual([]);
    expect(seg.position).toBe(30 * SR);
  });

  it('emits each sentence shortly after the speaker pauses, on the recording timeline', () => {
    const seg = new LiveSegmenter();
    const out = stream(seg, build([['_', 2], ['s', 3], ['_', 3], ['s', 2], ['_', 3]]));
    expect(out).toHaveLength(2);
    expect(sec(out[0]!.start)).toBeGreaterThan(1.5);
    expect(sec(out[0]!.start)).toBeLessThan(2.1);
    expect(sec(out[0]!.end)).toBeGreaterThan(4.9);
    expect(sec(out[0]!.end)).toBeLessThan(5.5);
    expect(sec(out[1]!.start)).toBeGreaterThan(7.5);
    expect(sec(out[1]!.audio.length)).toBeLessThan(3);
  });

  it('holds the sentence still being spoken until stop, then flushes it', () => {
    const seg = new LiveSegmenter();
    expect(stream(seg, build([['_', 1], ['s', 4]]))).toEqual([]);
    const last = seg.take(true);
    expect(last).toHaveLength(1);
    expect(sec(last[0]!.end)).toBeCloseTo(5, 1);
  });

  it('keeps text flowing during long talk without pauses', () => {
    const seg = new LiveSegmenter();
    const out = stream(seg, build([['s', 40]]));
    // Cut every ≤10 s, so the first text is out after ~11 s, not 24 s.
    expect(out.length).toBeGreaterThanOrEqual(3);
    expect(sec(out[0]!.end)).toBeLessThanOrEqual(10.5);
    for (const u of out) expect(sec(u.audio.length)).toBeLessThanOrEqual(10.5);
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBe(out[i - 1]!.end);
  });

  it('never sends the same audio twice', () => {
    const seg = new LiveSegmenter();
    const out = stream(seg, build([['s', 2], ['_', 1.5], ['s', 6], ['_', 2], ['s', 1], ['_', 2]]));
    out.push(...seg.take(true));
    for (let i = 1; i < out.length; i++) expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
  });
});

describe('Downsampler', () => {
  it('turns 48 kHz into 16 kHz across block edges without drift', () => {
    const ds = new Downsampler(48000);
    let total = 0;
    for (let i = 0; i < 100; i++) total += ds.push(new Float32Array(4096).fill(0.5)).length;
    expect(Math.abs(total - (100 * 4096) / 3)).toBeLessThanOrEqual(1);
  });

  it('handles non-integer ratios (44.1 kHz) and averages the input', () => {
    const ds = new Downsampler(44100);
    const out = ds.push(new Float32Array(44100).fill(0.25));
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
    expect(out.every((v) => Math.abs(v - 0.25) < 1e-6)).toBe(true);
  });

  it('passes 16 kHz through', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    expect(Array.from(new Downsampler(16000).push(input))).toEqual(Array.from(input));
  });
});
