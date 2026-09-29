import { describe, expect, it } from 'vitest';
import { updateBlockedReason, updateRatio } from './updater';

describe('updater helpers', () => {
  it('blocks installing while recording or transcribing', () => {
    expect(updateBlockedReason('IDLE', 0)).toBeNull();
    expect(updateBlockedReason('COMPLETED', 0)).toBeNull();
    for (const s of ['STARTING', 'RECORDING', 'PAUSED', 'STOPPING', 'ERROR'] as const) {
      expect(updateBlockedReason(s, 0)).toMatch(/recording/);
    }
    expect(updateBlockedReason('IDLE', 1)).toMatch(/transcription/);
  });

  it('reports download ratio only when the size is known', () => {
    expect(updateRatio({ stage: 'downloading', downloaded: 50, total: 200, error: null })).toBe(0.25);
    expect(updateRatio({ stage: 'downloading', downloaded: 50, total: null, error: null })).toBeNull();
    expect(updateRatio({ stage: 'downloading', downloaded: 300, total: 200, error: null })).toBe(1);
  });
});
