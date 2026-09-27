import { describe, expect, it } from 'vitest';
import { preprocessForASR } from './preprocess';

function tone(length: number, amplitude: number): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.sin(i * 0.1) * amplitude;
  return out;
}

describe('preprocessForASR', () => {
  it('marks digital silence as empty', () => {
    const res = preprocessForASR(new Float32Array(16000));
    expect(res.empty).toBe(true);
    expect(res.speechRatio).toBe(0);
  });

  it('peak-normalizes quiet speech and preserves length', () => {
    const res = preprocessForASR(tone(16000, 0.1));
    expect(res.empty).toBe(false);
    expect(res.audio.length).toBe(16000);
    let peak = 0;
    for (const v of res.audio) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeCloseTo(0.95, 1);
  });

  it('leaves loud audio gain untouched', () => {
    const res = preprocessForASR(tone(16000, 1.0));
    let peak = 0;
    for (const v of res.audio) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(res.empty).toBe(false);
  });

  it('attenuates silent halves without shifting timing', () => {
    const half = 16000;
    const mixed = new Float32Array(half * 2);
    mixed.set(tone(half, 0.5), half); // first half silence, second half speech
    const res = preprocessForASR(mixed);
    expect(res.empty).toBe(false);
    expect(res.speechRatio).toBeGreaterThan(0.4);
    expect(res.speechRatio).toBeLessThan(0.6);
    // Silent region pushed near zero, speech region intact.
    expect(Math.abs(res.audio[100] ?? 1)).toBeLessThan(0.01);
    expect(Math.abs(res.audio[half + 100] ?? 0)).toBeGreaterThan(0.1);
  });
});
