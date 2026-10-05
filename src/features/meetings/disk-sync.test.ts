import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveAudioMirror, mirrorMeetingToDisk } from './disk-sync';
import type { Meeting } from '../../domain/meeting';

vi.mock('../../storage/transcripts', () => ({ getSegments: async () => [] }));
vi.mock('../../storage/recordings', () => ({
  readRecordingBlob: async () => new Blob([new Uint8Array([9, 9, 9])]),
}));

/** Fake `native_save_file` / `native_storage_file_size` backed by a map. */
function fakeDisk(failOn?: number) {
  const files = new Map<string, Uint8Array>();
  const calls: string[] = [];
  let n = 0;
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'native_storage_file_size') {
      return files.get(args!.relativePath as string)?.length ?? null;
    }
    if (cmd !== 'native_save_file') return null;
    const { relativePath, dataBase64, append } = args!.request as {
      relativePath: string;
      dataBase64: string;
      append: boolean;
    };
    if (++n === failOn) throw new Error('disk full');
    calls.push(`${append ? 'append' : 'write'} ${relativePath}`);
    const bytes = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
    const prev = append ? (files.get(relativePath) ?? new Uint8Array(0)) : new Uint8Array(0);
    const next = new Uint8Array(prev.length + bytes.length);
    next.set(prev);
    next.set(bytes, prev.length);
    files.set(relativePath, next);
    return `/docs/${relativePath}`;
  });
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: { invoke } };
  return { files, calls, invoke };
}

const meeting = { id: 'abcdef0123456789', title: 'Weekly sync' };
const blob = (...bytes: number[]) => new Blob([new Uint8Array(bytes)]);

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('LiveAudioMirror', () => {
  it('appends every chunk in order: one write, then appends', async () => {
    const disk = fakeDisk();
    const mirror = new LiveAudioMirror(meeting);
    mirror.push('', 'audio/webm;codecs=opus', blob(1, 2));
    mirror.push('', 'audio/webm;codecs=opus', blob(3));
    mirror.push('', 'audio/webm;codecs=opus', blob(4, 5));
    expect(await mirror.finish()).toBe(true);
    expect(disk.calls).toEqual([
      'write Weekly-sync-23456789/audio.webm',
      'append Weekly-sync-23456789/audio.webm',
      'append Weekly-sync-23456789/audio.webm',
    ]);
    expect([...disk.files.get('Weekly-sync-23456789/audio.webm')!]).toEqual([1, 2, 3, 4, 5]);
  });

  it('reports an incomplete mirror after a failed write and stops writing', async () => {
    const disk = fakeDisk(2);
    const mirror = new LiveAudioMirror(meeting);
    for (let i = 0; i < 4; i++) mirror.push('', 'audio/webm', blob(i));
    expect(await mirror.finish()).toBe(false);
    expect(disk.calls).toHaveLength(1);
  });

  it('is incomplete when nothing was recorded', async () => {
    fakeDisk();
    expect(await new LiveAudioMirror(meeting).finish()).toBe(false);
  });
});

describe('mirrorMeetingToDisk audio modes', () => {
  const full: Meeting = {
    id: meeting.id,
    title: meeting.title,
    mode: 'speaker',
    createdAt: 1,
    startedAt: 1,
    durationMs: 5000,
    audioPath: `meetings/${meeting.id}`,
    mimeType: 'audio/webm',
    transcriptionStatus: 'not_started',
  };
  const audioPath = 'Weekly-sync-23456789/audio.webm';

  it("'skip' leaves the audio alone, 'if-missing' copies only when absent", async () => {
    const disk = fakeDisk();
    await mirrorMeetingToDisk(full, 'skip');
    expect(disk.files.has(audioPath)).toBe(false);
    await mirrorMeetingToDisk(full);
    expect([...disk.files.get(audioPath)!]).toEqual([9, 9, 9]);
    disk.calls.length = 0;
    await mirrorMeetingToDisk(full);
    expect(disk.calls.some((c) => c.endsWith(audioPath))).toBe(false);
  });
});
