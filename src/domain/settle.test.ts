import { describe, expect, it, vi } from 'vitest';
import { settleWithin } from './settle';

describe('settleWithin', () => {
  it('returns the result when the work finishes in time', async () => {
    await expect(settleWithin(Promise.resolve(7), 100, 0)).resolves.toBe(7);
  });

  it('returns the fallback when the work fails', async () => {
    await expect(settleWithin(Promise.reject(new Error('x')), 100, 'f')).resolves.toBe('f');
  });

  it('stops waiting for work that hangs', async () => {
    vi.useFakeTimers();
    const pending = settleWithin(new Promise<number>(() => undefined), 3000, -1);
    vi.advanceTimersByTime(3000);
    await expect(pending).resolves.toBe(-1);
    vi.useRealTimers();
  });
});
