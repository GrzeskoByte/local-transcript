import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChunk,
  assertDurableStorage,
  deleteRecording,
  listChunkNames,
  listTracks,
  readMeta,
  readRecordingBlob,
  writeMeta,
} from './recordings';

/**
 * Desktop shell without OPFS (the AppImage's WebKitGTK): chunks must go to
 * disk through the Rust commands, never into memory. A fake shell stands in
 * for `src-tauri/src/recordings.rs` with the same on-disk layout.
 */
function installShell() {
  const files = new Map<string, Uint8Array>(); // "<id>/<track>/<name>" ('' track = flat)
  const meta = new Map<string, string>();
  const calls: string[] = [];
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push(cmd);
        const id = args.meetingId as string;
        switch (cmd) {
          case 'native_recording_write': {
            const r = args.request as { meetingId: string; track: string; name: string; dataBase64: string };
            files.set(`${r.meetingId}/${r.track}/${r.name}`, new Uint8Array(Buffer.from(r.dataBase64, 'base64')));
            return null;
          }
          case 'native_recording_write_meta':
            meta.set(id, args.meta as string);
            return null;
          case 'native_recording_read_meta':
            return meta.get(id) ?? null;
          case 'native_recording_list': {
            const tracks = new Map<string, string[]>();
            for (const key of files.keys()) {
              const [mid, track, name] = key.split('/') as [string, string, string];
              if (mid === id) tracks.set(track, [...(tracks.get(track) ?? []), name].sort());
            }
            return [...tracks].sort().map(([track, chunks]) => ({ track, chunks }));
          }
          case 'native_recording_read': {
            const prefix = `${id}/${args.track as string}/`;
            const parts = [...files].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
            return b64(Buffer.concat(parts.map(([, v]) => v)));
          }
          case 'native_recording_delete':
            for (const key of [...files.keys()]) if (key.startsWith(`${id}/`)) files.delete(key);
            meta.delete(id);
            return null;
          default:
            throw new Error(`unexpected ${cmd}`);
        }
      },
    },
  };
  return { files, calls };
}

describe('recording storage on a desktop shell without OPFS', () => {
  let shell: ReturnType<typeof installShell>;
  beforeEach(() => {
    shell = installShell();
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('allows recording (durable on disk) instead of refusing', () => {
    expect(() => assertDurableStorage()).not.toThrow();
  });

  it('writes chunks and meta to disk and reads them back in order', async () => {
    await writeMeta('m1', { mimeType: 'audio/mp4;codecs=opus', startedAt: 1, tracks: [''] });
    await appendChunk('m1', '000001.mp4', new Blob(['BB']));
    await appendChunk('m1', '000000.mp4', new Blob(['AA']));
    expect(shell.files.size).toBe(2);
    expect(await readMeta('m1')).toEqual({ mimeType: 'audio/mp4;codecs=opus', startedAt: 1, tracks: [''] });
    expect(await listTracks('m1')).toEqual(['']);
    expect(await listChunkNames('m1')).toEqual(['000000.mp4', '000001.mp4']);
    const blob = await readRecordingBlob('m1', 'audio/mp4');
    expect(await blob!.text()).toBe('AABB');
    expect(blob!.type).toBe('audio/mp4');
  });

  it('keeps legacy two-track recordings readable', async () => {
    await appendChunk('m2', '000000.webm', new Blob(['mic']), 'microphone');
    await appendChunk('m2', '000000.webm', new Blob(['dev']), 'device');
    expect(await listTracks('m2')).toEqual(['device', 'microphone']);
    expect(await (await readRecordingBlob('m2', 'audio/webm', 'device'))!.text()).toBe('dev');
  });

  it('deletes every chunk of a meeting', async () => {
    await appendChunk('m3', '000000.mp4', new Blob(['x']));
    await deleteRecording('m3');
    expect(await listTracks('m3')).toEqual([]);
    expect(await readRecordingBlob('m3', 'audio/mp4')).toBeNull();
    expect(shell.calls).toContain('native_recording_delete');
  });
});
