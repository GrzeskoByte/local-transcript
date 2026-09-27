import { describe, expect, it } from 'vitest';
import { compactSpeech, detectSpeechSpans, mapCompactedSample } from './vad';

const SR = 16000;

function tone(seconds: number, amp: number, freq = 440): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function silence(seconds: number, amp = 0.0002): Float32Array {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * 120 * i) / SR);
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe('detectSpeechSpans', () => {
  it('finds the speech region inside surrounding silence', () => {
    const audio = concat([silence(1), tone(1, 0.5), silence(1)]);
    const spans = detectSpeechSpans(audio, SR);
    expect(spans.length).toBe(1);
    expect(spans[0]!.start).toBeLessThanOrEqual(SR);
    expect(spans[0]!.start).toBeGreaterThan(SR * 0.8);
    expect(spans[0]!.end).toBeGreaterThanOrEqual(SR * 2);
  });

  it('bridges short pauses instead of over-splitting', () => {
    const audio = concat([tone(0.5, 0.5), silence(0.1), tone(0.5, 0.5)]);
    expect(detectSpeechSpans(audio, SR).length).toBe(1);
  });

  it('returns nothing for pure silence', () => {
    expect(detectSpeechSpans(silence(2), SR)).toEqual([]);
  });
});

describe('compactSpeech', () => {
  it('removes surrounding silence and reports the removed fraction', () => {
    const audio = concat([silence(1), tone(1, 0.5), silence(1)]);
    const res = compactSpeech(audio, SR);
    expect(res.compacted).toBe(true);
    expect(res.audio.length).toBeLessThan(audio.length);
    expect(res.removedFraction).toBeGreaterThan(0.3);
  });

  it('keeps the original audio untouched when little would be removed', () => {
    const audio = concat([silence(0.2), tone(3, 0.5)]);
    const res = compactSpeech(audio, SR);
    expect(res.compacted).toBe(false);
    expect(res.audio).toBe(audio);
  });

  it('keeps the original audio for pure silence', () => {
    const audio = silence(2);
    const res = compactSpeech(audio, SR);
    expect(res.compacted).toBe(false);
    expect(res.audio).toBe(audio);
  });
});

describe('mapCompactedSample', () => {
  it('maps compacted positions back onto the original timeline', () => {
    const audio = concat([silence(1), tone(1, 0.5), silence(1)]);
    const res = compactSpeech(audio, SR);
    const startOfSpeech = mapCompactedSample(0, res);
    expect(startOfSpeech).toBeGreaterThan(SR * 0.8);
    expect(startOfSpeech).toBeLessThanOrEqual(SR * 1.05);
    const endOfSpeech = mapCompactedSample(res.audio.length, res);
    expect(endOfSpeech).toBeGreaterThan(SR * 2);
  });

  it('is the identity when not compacted', () => {
    const audio = tone(0.5, 0.5);
    const res = compactSpeech(audio, SR);
    expect(mapCompactedSample(1234, res)).toBe(1234);
  });
});
