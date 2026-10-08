import { describe, expect, it } from 'vitest';
import { resampleFloat, Wsola } from './time-stretch';

const SR = 24000;
function sine(freq: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(SR * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * 12000);
  return out;
}
function drain(w: Wsola): Float32Array {
  const parts: Float32Array[] = [];
  for (;;) {
    const c = w.next(4096);
    if (c.length === 0) break;
    parts.push(c);
  }
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
/** Frequency from zero crossings over the middle of the signal. */
function frequency(x: Float32Array): number {
  const from = Math.floor(x.length * 0.2);
  const to = Math.floor(x.length * 0.8);
  let crossings = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1]! < 0 && x[i]! >= 0) crossings++;
  return crossings / ((to - from) / SR);
}

describe('Wsola', () => {
  for (const rate of [1.25, 1.5, 2]) {
    it(`plays ${rate}× faster at the same pitch`, () => {
      const input = sine(220, 4);
      const out = drain(new Wsola(input, SR, rate));
      expect(out.length / SR).toBeCloseTo(4 / rate, 1);
      expect(Math.abs(frequency(out) - 220)).toBeLessThan(220 * 0.03);
    });
  }

  it('starts at the given sample and ends cleanly', () => {
    const input = sine(220, 2);
    const out = drain(new Wsola(input, SR, 1.5, SR));
    expect(out.length / SR).toBeCloseTo(1 / 1.5, 1);
    expect(new Wsola(input, SR, 1.5, input.length).next(100).length).toBeLessThanOrEqual(100);
  });
});

describe('resampleFloat', () => {
  it('stretches a ramp linearly', () => {
    const out = new Float32Array(5);
    resampleFloat(Float32Array.from([0, 1, 2]), out);
    expect([...out]).toEqual([0, 0.5, 1, 1.5, 2]);
  });
});
