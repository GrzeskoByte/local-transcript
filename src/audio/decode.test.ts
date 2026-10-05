import { describe, expect, it } from 'vitest';
import { downmixInPlace, highpassInPlace } from './decode';

const RATE = 16000;
function sine(freq: number, seconds = 1, amp = 0.5): Float32Array {
  const x = new Float32Array(RATE * seconds);
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return x;
}
/** RMS over the second half (after the filter settles). */
function rms(x: Float32Array): number {
  let s = 0;
  const from = x.length >> 1;
  for (let i = from; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / (x.length - from));
}

describe('highpassInPlace (80 Hz)', () => {
  it('removes DC offset', () => {
    const x = new Float32Array(RATE).fill(0.3);
    highpassInPlace(x, RATE, 80, 0.7);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-4);
  });

  it('passes speech frequencies and cuts rumble', () => {
    for (const f of [300, 1000, 4000]) {
      const x = sine(f);
      const before = rms(x);
      highpassInPlace(x, RATE, 80, 0.7);
      expect(rms(x) / before).toBeGreaterThan(0.97);
      expect(rms(x) / before).toBeLessThan(1.06);
    }
    const hum = sine(20);
    const before = rms(hum);
    highpassInPlace(hum, RATE, 80, 0.7);
    // 2nd order: ~12 dB/octave, two octaves below the corner.
    expect(rms(hum) / before).toBeLessThan(0.1);
  });
});

describe('downmixInPlace', () => {
  it('averages channels into the first buffer', () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([0, 0.5, 1]);
    const out = downmixInPlace([l, r]);
    expect(out).toBe(l);
    expect([...out]).toEqual([0.5, 0.5, 0]);
  });

  it('returns mono input untouched', () => {
    const m = Float32Array.from([0.1, 0.2]);
    expect(downmixInPlace([m])).toBe(m);
  });
});
