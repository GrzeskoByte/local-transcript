import { describe, expect, it } from 'vitest';
import {
  appendChunk,
  deleteRecording,
  listChunkNames,
  listTracks,
  readRecordingBlob,
} from './recordings';

// OPFS is unavailable under Node, so these exercise the in-memory fallback with
// the same track-aware API the browser path uses.

describe('two-way recording storage', () => {
  it('keeps microphone and device tracks separate', async () => {
    const id = `two-way-${Math.random()}`;
    await appendChunk(id, '000000.webm', new Blob(['mic-1']), 'microphone');
    await appendChunk(id, '000001.webm', new Blob(['mic-2']), 'microphone');
    await appendChunk(id, '000000.webm', new Blob(['dev-1']), 'device');

    expect(await listTracks(id)).toEqual(['device', 'microphone']);
    expect(await listChunkNames(id, 'microphone')).toEqual(['000000.webm', '000001.webm']);
    expect(await listChunkNames(id, 'device')).toEqual(['000000.webm']);

    const mic = await readRecordingBlob(id, 'audio/webm', 'microphone');
    expect(await mic!.text()).toBe('mic-1mic-2');
    const dev = await readRecordingBlob(id, 'audio/webm', 'device');
    expect(await dev!.text()).toBe('dev-1');

    await deleteRecording(id);
    expect(await listTracks(id)).toEqual([]);
  });

  it('still supports the flat single-track layout', async () => {
    const id = `single-${Math.random()}`;
    await appendChunk(id, '000000.webm', new Blob(['one']));
    expect(await listTracks(id)).toEqual(['']);
    expect(await listChunkNames(id)).toEqual(['000000.webm']);
    const blob = await readRecordingBlob(id, 'audio/webm');
    expect(await blob!.text()).toBe('one');
    await deleteRecording(id);
  });
});
