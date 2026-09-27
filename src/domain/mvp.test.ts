import { describe, expect, it } from 'vitest';
import { formatDuration } from '../domain/meeting';
import {
  searchSegments,
  segmentsToJSON,
  segmentsToMarkdown,
  segmentsToText,
} from '../domain/transcript';
import type { TranscriptSegment } from '../domain/transcript';
import { extensionForMimeType, pickSupportedMimeType } from '../audio/formats';
import { isStorageLow } from '../storage/recordings';

const segs: TranscriptSegment[] = [
  { id: 'a', meetingId: 'm', sequence: 1, startMs: 1200, endMs: 4800, text: "Let's review the roadmap." },
  { id: 'b', meetingId: 'm', sequence: 0, startMs: 0, endMs: 1000, text: 'Hello.' },
];

describe('transcript formatting', () => {
  it('sorts by sequence and joins text', () => {
    expect(segmentsToText(segs)).toBe("Hello.\nLet's review the roadmap.");
  });

  it('markdown includes timestamps', () => {
    const md = segmentsToMarkdown('Weekly Planning', Date.now(), segs);
    expect(md).toContain('# Weekly Planning');
    expect(md).toContain('[00:00]');
  });

  it('json preserves timestamps and metadata', () => {
    const parsed = JSON.parse(segmentsToJSON('m', 'Weekly Planning', segs));
    expect(parsed.meetingId).toBe('m');
    expect(parsed.segments[0]).toEqual({ startMs: 0, endMs: 1000, text: 'Hello.' });
  });
});

describe('transcript search', () => {
  it('finds case-insensitive matches with snippet', () => {
    const hits = searchSegments(segs, 'roadmap');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).toContain('roadmap');
  });

  it('returns empty for blank query', () => {
    expect(searchSegments(segs, '  ')).toEqual([]);
  });
});

describe('meeting helpers', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('00:00');
    expect(formatDuration(54 * 60 * 1000 + 21 * 1000)).toBe('54:21');
    expect(formatDuration(37 * 60 * 1000 + 24 * 1000 + 3600 * 1000)).toBe('01:37:24');
  });
});

describe('audio formats', () => {
  it('maps mime to extension', () => {
    expect(extensionForMimeType('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMimeType('audio/mp4')).toBe('mp4');
  });

  it('pickSupportedMimeType does not throw without MediaRecorder', () => {
    expect(() => pickSupportedMimeType()).not.toThrow();
  });
});

describe('storage warnings', () => {
  it('flags low storage', () => {
    expect(isStorageLow({ quota: 100, usage: 95 })).toBe(true);
    expect(isStorageLow({ quota: 100, usage: 10 })).toBe(false);
    expect(isStorageLow({})).toBe(false);
  });
});
