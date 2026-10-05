import { describe, expect, it } from 'vitest';
import { StopTrace, formatStopTrace, nextPaint, slowestStep } from './stop-trace';

describe('StopTrace', () => {
  it('records each step, including failing ones', async () => {
    const trace = new StopTrace();
    expect(await trace.time('fast', () => 1)).toBe(1);
    await trace.time('slow', () => new Promise((r) => setTimeout(r, 30)));
    await expect(trace.time('broken', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(trace.steps.map((s) => s.step)).toEqual(['fast', 'slow', 'broken']);
    expect(trace.slowest()?.step).toBe('slow');
    expect(trace.totalMs()).toBeGreaterThanOrEqual(25);
  });

  it('formats a terminal line marking the slowest step', () => {
    const steps = [
      { step: 'diagnostics', ms: 12 },
      { step: 'release capture', ms: 4100 },
    ];
    expect(slowestStep(steps)?.step).toBe('release capture');
    expect(formatStopTrace(steps, 4210)).toBe(
      'Stop took 4210 ms: diagnostics 12 ms, release capture 4100 ms (slowest)',
    );
    expect(formatStopTrace([{ step: 'save', ms: 3 }], 3)).toBe('Stop took 3 ms: save 3 ms');
  });

  it('nextPaint resolves even without animation frames', async () => {
    await expect(nextPaint()).resolves.toBeUndefined();
  });
});
