import { describe, expect, it } from 'vitest';
import { DUAL_TRACKS, modeLabel, trackSpeakerLabel } from './meeting';
import {
  segmentsToJSON,
  segmentsToMarkdown,
  segmentsToText,
} from './transcript';
import type { TranscriptSegment } from './transcript';

describe('two-way recording modes', () => {
  it('labels every mode', () => {
    expect(modeLabel('speaker')).toBe('Speaker');
    expect(modeLabel('device')).toBe('Device Audio');
    expect(modeLabel('dual')).toBe('Mic + Device');
  });

  it('defines the two captured tracks', () => {
    expect(DUAL_TRACKS).toEqual(['microphone', 'device']);
  });

  it('derives a speaker from the track (no diarization needed)', () => {
    expect(trackSpeakerLabel('microphone')).toBe('Me');
    expect(trackSpeakerLabel('device')).toBe('Others');
    expect(trackSpeakerLabel('')).toBeUndefined();
  });
});

describe('speaker-aware transcript formatting', () => {
  const segs: TranscriptSegment[] = [
    { id: 'a', meetingId: 'm', sequence: 0, startMs: 0, endMs: 1000, text: 'Hi there', speaker: 'Me' },
    { id: 'b', meetingId: 'm', sequence: 1, startMs: 1000, endMs: 2000, text: 'Hello', speaker: 'Others' },
  ];

  it('prefixes the speaker in plain text', () => {
    expect(segmentsToText(segs)).toBe('Me: Hi there\nOthers: Hello');
  });

  it('prefixes the speaker in markdown', () => {
    const md = segmentsToMarkdown('Standup', 0, segs);
    expect(md).toContain('[00:00] Me:');
    expect(md).toContain('[00:01] Others:');
  });

  it('carries the speaker into JSON', () => {
    const parsed = JSON.parse(segmentsToJSON('m', 'Standup', segs));
    expect(parsed.segments[0].speaker).toBe('Me');
    expect(parsed.segments[1].speaker).toBe('Others');
  });

  it('omits the speaker field for single-track segments', () => {
    const plain: TranscriptSegment[] = [
      { id: 'x', meetingId: 'm', sequence: 0, startMs: 0, endMs: 1, text: 'Solo' },
    ];
    expect(segmentsToText(plain)).toBe('Solo');
    const parsed = JSON.parse(segmentsToJSON('m', 'Solo', plain));
    expect(parsed.segments[0]).not.toHaveProperty('speaker');
  });
});
