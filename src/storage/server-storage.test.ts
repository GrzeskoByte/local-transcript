import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from './database';
import { deleteMeetingRecord, getMeeting, updateMeeting } from './meetings';
import { commitTranscript, deleteSegments, getSegments, setSegmentSpeakers } from './transcripts';
import { appendChunk, deleteRecording, readRecordingBlob } from './recordings';
import { resetNativeSettingsCache } from '../platform/native-settings';
import { SessionChangedError, setServerSession } from '../platform/server';
import { importAudioFile } from '../features/meetings/import-audio';

interface Call {
  cmd: string;
  args: Record<string, unknown>;
}
let calls: Call[];
let handler: (cmd: string, args: Record<string, unknown>) => unknown;

beforeEach(() => {
  calls = [];
  handler = () => null;
  (globalThis as unknown as { document: unknown }).document = {
    querySelector: () => ({ getAttribute: () => 'server' }),
  };
  (globalThis as unknown as { window: unknown }).window = { location: { hash: '' } };
  setServerSession({ user: { id: 'u', email: 'a@x', name: 'A', role: 'member', auth: 'local' }, csrf: 'c', capabilities: [] });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const cmd = decodeURIComponent(url.replace('/api/invoke/', ''));
    const args = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ cmd, args });
    const out = handler(cmd, args);
    if (out instanceof Uint8Array) {
      return new Response(out, { headers: { 'content-type': 'application/octet-stream' } });
    }
    return new Response(JSON.stringify(out ?? null), { headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  setServerSession(null);
  resetNativeSettingsCache();
});

describe('server mode storage routing (no IndexedDB here: any IDB access would throw)', () => {
  it('db.* maps onto server_db_*', async () => {
    handler = (cmd) => (cmd === 'server_db_get' ? null : cmd === 'server_db_get_all' ? [{ id: 'a' }] : null);
    expect(await db.get('meetings', 'x')).toBeUndefined();
    await db.put('meetings', { id: 'x' });
    await db.delete('meetings', 'x');
    expect(await db.getAll('meetings')).toEqual([{ id: 'a' }]);
    await db.getAllByIndex('segments', 'by-meeting', 'm1');
    expect(calls.map((c) => c.cmd)).toEqual([
      'server_db_get', 'server_db_put', 'server_db_delete', 'server_db_get_all', 'server_db_get_by_index',
    ]);
    expect(calls[4]!.args).toEqual({ store: 'segments', index: 'by-meeting', key: 'm1' });
  });

  it('updateMeeting with a partial change is one server_db_patch (no read, no overwrite)', async () => {
    handler = (cmd) => (cmd === 'server_db_patch' ? { id: 'm1', title: 'New', other: 1 } : null);
    const out = await updateMeeting('m1', { title: 'New' });
    expect(out).toEqual({ id: 'm1', title: 'New', other: 1 });
    expect(calls).toEqual([{ cmd: 'server_db_patch', args: { store: 'meetings', key: 'm1', patch: { title: 'New' } } }]);
  });

  it('updateMeeting is a no-op when the meeting is gone (deleted mid-run)', async () => {
    handler = () => null; // patch → null, get → null
    expect(await updateMeeting('gone', { title: 'x' })).toBeUndefined();
    expect(await updateMeeting('gone', (m) => m)).toBeUndefined();
    expect(calls.map((c) => c.cmd)).toEqual(['server_db_patch', 'server_db_get']);
  });

  it('a function update is compare-and-set against the value it read', async () => {
    handler = (cmd) => (cmd === 'server_db_get' ? { id: 'm1', n: 1 } : cmd === 'server_db_put_if_unchanged' ? true : null);
    const out = await updateMeeting('m1', (m) => {
      const next = { ...m, n: 2 };
      (m as unknown as { n: number }).n = 99; // mutating the input must not corrupt `expected`
      return next as never;
    });
    expect(out).toEqual({ id: 'm1', n: 2 });
    expect(calls[1]).toEqual({
      cmd: 'server_db_put_if_unchanged',
      args: { store: 'meetings', value: { id: 'm1', n: 2 }, expected: { id: 'm1', n: 1 } },
    });
  });

  it('a lost race re-reads and retries, then gives up after 5 attempts', async () => {
    let writes = 0;
    handler = (cmd) => {
      if (cmd === 'server_db_get') return { id: 'm1', n: writes };
      if (cmd === 'server_db_put_if_unchanged') return ++writes === 3; // two losses, then it wins
      return null;
    };
    const out = await updateMeeting('m1', (m) => ({ ...m, seen: true }) as never);
    expect(out).toEqual({ id: 'm1', n: 2, seen: true });
    expect(calls.filter((c) => c.cmd === 'server_db_get')).toHaveLength(3);

    calls = [];
    handler = (cmd) => (cmd === 'server_db_get' ? { id: 'm1' } : false);
    await expect(updateMeeting('m1', (m) => m)).rejects.toThrow(/kept changing/);
    expect(calls.filter((c) => c.cmd === 'server_db_put_if_unchanged')).toHaveLength(5);
  });

  it('commitTranscript, speakers and delete use their atomic commands', async () => {
    handler = (cmd) => (cmd === 'server_db_commit_transcript' ? true : null);
    const segs = [{ id: 's1', meetingId: 'm1', sequence: 0, startMs: 0, endMs: 1, text: 'hi' }];
    expect(await commitTranscript('m1', segs as never, { transcriptSource: { kind: 'file', model: 'x' } } as never)).toBe(true);
    expect(calls[0]).toEqual({
      cmd: 'server_db_commit_transcript',
      args: { meetingId: 'm1', segments: segs, patch: { transcriptSource: { kind: 'file', model: 'x' } } },
    });
    await setSegmentSpeakers('m1', new Map([['s1', 'Ann']]));
    expect(calls[1]).toEqual({ cmd: 'server_db_set_segment_speakers', args: { meetingId: 'm1', speakers: { s1: 'Ann' } } });
    await deleteMeetingRecord('m1');
    expect(calls[2]).toEqual({ cmd: 'server_db_delete_meeting', args: { id: 'm1' } });
  });

  it('getSegments sorts and deleteSegments removes one by one', async () => {
    handler = (cmd) =>
      cmd === 'server_db_get_by_index' ? [{ id: 'b', sequence: 2 }, { id: 'a', sequence: 1 }] : null;
    expect((await getSegments('m1')).map((s) => s.id)).toEqual(['a', 'b']);
    calls = [];
    await deleteSegments('m1');
    expect(calls.filter((c) => c.cmd === 'server_db_delete').map((c) => c.args.key)).toEqual(['a', 'b']);
    expect(await getMeeting('x')).toBeUndefined();
  });

  it('recordings always use the server store, even where OPFS exists', async () => {
    vi.stubGlobal('navigator', { storage: { getDirectory: () => Promise.reject(new Error('OPFS must not be used')) } });
    try {
      await appendChunk('m1', '000000.webm', new Blob([new Uint8Array([1, 2, 3])]));
      expect(calls[0]!.cmd).toBe('native_recording_write');
      const request = calls[0]!.args.request as { meetingId: string; track: string; name: string; dataBase64: string };
      expect(request).toMatchObject({ meetingId: 'm1', track: '', name: '000000.webm', dataBase64: 'AQID' });
      handler = (cmd) => (cmd === 'native_recording_read' ? new Uint8Array([1, 2, 3]) : null);
      const blob = await readRecordingBlob('m1', 'audio/webm');
      expect(blob?.size).toBe(3);
      await deleteRecording('m1');
      expect(calls.at(-1)!.cmd).toBe('native_recording_delete');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('settings keys go to the per-user settings, calendar caches to the kv store', async () => {
    handler = (cmd) => (cmd === 'native_settings_load' ? { 'llm-config': { model: 'x' } } : null);
    expect(await db.kvGet('llm-config')).toEqual({ model: 'x' });
    await db.kvSet('gitlab-config', { url: 'u' });
    expect(calls.map((c) => c.cmd)).toEqual(['native_settings_load', 'native_settings_set']);
    await db.kvSet('calendar-cache:x', [1]);
    expect(calls.at(-1)).toEqual({ cmd: 'server_db_put', args: { store: 'kv', value: { key: 'calendar-cache:x', value: [1] } } });
  });
});

describe('in-flight work cannot cross accounts', () => {
  const as = (id: string) =>
    setServerSession({ user: { id, email: `${id}@x`, name: id, role: 'member', auth: 'local' }, csrf: `c-${id}`, capabilities: [] });

  it("a recorder's later chunks are refused after the account changed", async () => {
    as('alice');
    await appendChunk('rec1', '000000.webm', new Blob(['a']), '');
    as('bob');
    await expect(appendChunk('rec1', '000001.webm', new Blob(['b']), '')).rejects.toBeInstanceOf(SessionChangedError);
    expect(calls.map((c) => c.cmd)).toEqual(['native_recording_write']); // only Alice's own chunk was sent
    // Bob's own recordings are not affected.
    await appendChunk('rec2', '000000.webm', new Blob(['c']), '');
    expect(calls).toHaveLength(2);
  });

  it('an import that outlives the session never writes under the new account', async () => {
    as('alice');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const send = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (url.endsWith('native_recording_write')) await gate; // the chunk upload is in flight
      return send(url, init);
    });
    const file = new File([new Uint8Array(8)], 'call.webm', { type: 'audio/webm' });
    const pending = importAudioFile(file);
    await new Promise((r) => setTimeout(r, 0));
    as('bob');
    release();
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    expect(calls.map((c) => c.cmd)).not.toContain('server_db_put');
  });

  it('an aborted import (sign-out) writes nothing and removes what it started', async () => {
    as('alice');
    const abort = new AbortController();
    abort.abort();
    const file = new File([new Uint8Array(8)], 'call.webm', { type: 'audio/webm' });
    await expect(importAudioFile(file, undefined, abort.signal)).rejects.toThrow(/cancelled/);
    expect(calls.map((c) => c.cmd)).not.toContain('native_recording_write');
  });
});
