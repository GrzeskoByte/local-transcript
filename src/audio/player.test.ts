import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatClock, PcmPlayer, peaks, resampleSlice, toMonoInt16 } from './player';

class FakeSource {
  buffer: { length: number; data: Float32Array } | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  offset = 0;
  stopped = false;
  connect(): void {}
  disconnect(): void {}
  start(when: number, offset = 0): void {
    this.startedAt = when;
    this.offset = offset;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeContext {
  currentTime = 0;
  state: 'running' | 'suspended' = 'suspended';
  readonly sampleRate: number;
  readonly sources: FakeSource[] = [];
  destination = {};
  constructor(rate: number) {
    this.sampleRate = rate;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async suspend(): Promise<void> {
    this.state = 'suspended';
  }
  createBuffer(_channels: number, length: number): { length: number; data: Float32Array; getChannelData: () => Float32Array } {
    const data = new Float32Array(length);
    return { length, data, getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

function player(seconds: number, rate = 100, outRate = 100) {
  const pcm = new Int16Array(seconds * rate).map((_, i) => (i % 100) * 100);
  const ctx = new FakeContext(outRate);
  const p = new PcmPlayer({ pcm, sampleRate: rate }, ctx as unknown as AudioContext);
  return { p, ctx };
}

afterEach(() => vi.useRealTimers());

describe('helpers', () => {
  it('downmixes to mono int16 and clamps', () => {
    const out = toMonoInt16([new Float32Array([1, -1, 0.5]), new Float32Array([1, -1, -0.5])]);
    expect([...out]).toEqual([0x7fff, -0x8000, 0]);
  });

  it('resamples continuously across slice boundaries', () => {
    const pcm = new Int16Array([0, 1000, 2000, 3000]);
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    resampleSlice(pcm, 1, 2, 0, a);
    resampleSlice(pcm, 1, 2, 3, b);
    const whole = new Float32Array(6);
    resampleSlice(pcm, 1, 2, 0, whole);
    expect([...a, ...b]).toEqual([...whole]);
    expect(whole[1]).toBeCloseTo(500 / 0x8000);
  });

  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('builds a peak envelope', () => {
    const env = peaks(new Int16Array([0, 0x4000, 0, -0x8000]), 2);
    expect(env[0]).toBeCloseTo(0.5);
    expect(env[1]).toBeCloseTo(1);
  });
});

describe('PcmPlayer', () => {
  it('schedules gapless slices ahead of the playhead', async () => {
    vi.useFakeTimers();
    const { p, ctx } = player(30);
    await p.play();
    expect(p.playing).toBe(true);
    // 6 s ahead in 2 s slices.
    expect(ctx.sources).toHaveLength(3);
    const starts = ctx.sources.map((s) => s.startedAt!);
    expect(starts[1]! - starts[0]!).toBeCloseTo(2);
    expect(starts[2]! - starts[1]!).toBeCloseTo(2);
    ctx.currentTime = 3;
    vi.advanceTimersByTime(250);
    expect(ctx.sources.length).toBeGreaterThan(3);
    p.dispose();
  });

  it('seeks exactly, while paused and while playing', async () => {
    vi.useFakeTimers();
    const { p, ctx } = player(60);
    p.seek(42.5);
    expect(p.currentTime).toBe(42.5);
    await p.play();
    const before = ctx.sources.length;
    p.seek(10);
    expect(ctx.sources.slice(0, before).every((s) => s.stopped)).toBe(true);
    expect(p.currentTime).toBeCloseTo(10 - 0.06, 1);
    p.seek(1e9);
    expect(p.currentTime).toBeLessThanOrEqual(60);
    p.dispose();
  });

  it('pauses at the end and restarts from 0 on the next play', async () => {
    vi.useFakeTimers();
    const { p, ctx } = player(4);
    await p.play();
    ctx.currentTime = 10;
    vi.advanceTimersByTime(250);
    expect(p.playing).toBe(false);
    expect(p.currentTime).toBe(4);
    expect(ctx.state).toBe('suspended');
    await p.play();
    expect(p.currentTime).toBeLessThan(1);
    p.dispose();
  });

  it('plays one recording at a time', async () => {
    vi.useFakeTimers();
    const a = player(10);
    const b = player(10);
    await a.p.play();
    await b.p.play();
    expect(a.p.playing).toBe(false);
    expect(b.p.playing).toBe(true);
    b.p.dispose();
  });
});
