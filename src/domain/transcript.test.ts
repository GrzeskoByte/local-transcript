import { describe, expect, it } from 'vitest';
import { activeSegmentIndex, type TranscriptSegment } from './transcript';

describe('activeSegmentIndex', () => {
  const segs = [
    { id: 'a', meetingId: 'm', startMs: 0, endMs: 2000, text: 'a', sequence: 0 },
    { id: 'b', meetingId: 'm', startMs: 5000, endMs: 9000, text: 'b', sequence: 1 },
  ] as TranscriptSegment[];
  it('finds the line being played, none in a gap or before the start', () => {
    expect(activeSegmentIndex(segs, -1)).toBe(-1);
    expect(activeSegmentIndex(segs, 1500)).toBe(0);
    expect(activeSegmentIndex(segs, 3500)).toBe(-1);
    expect(activeSegmentIndex(segs, 5000)).toBe(1);
    expect(activeSegmentIndex(segs, 8999)).toBe(1);
  });
});
