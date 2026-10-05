import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativeLiveFeed, NativeRecorder, nativeRecorderDevices, nativeSupportsMode } from './native-recorder';
import { decodeOggNative, pcm16 } from './native-decode';
import type { RecorderState } from './recorder';

/** A fake desktop shell standing in for `src-tauri/src/recorder`. */
function installShell(overrides: Record<string, (args: unknown, options?: unknown) => unknown> = {}) {
  const calls: { cmd: string; args: unknown; options?: unknown }[] = [];
  let status: Record<string, unknown> = { state: 'recording', elapsedMs: 0, chunks: 0, unsavedChunks: 0, levels: [], mirrorOk: true };
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown, options?: unknown) => {
        calls.push({ cmd, args, options });
        if (overrides[cmd]) return overrides[cmd]!(args, options);
        switch (cmd) {
          case 'native_recorder_poll':
            return status;
          case 'native_recorder_stop':
            return {
              mimeType: 'audio/ogg;codecs=opus',
              durationMs: 4200,
              chunkCount: 1,
              unsavedChunks: 0,
              mirrorOk: true,
              diagnostics: { inputs: [], events: [] },
            };
          case 'native_recorder_live_take':
            return new Int16Array([16384, -16384]).buffer;
          default:
            return null;
        }
      },
    },
  };
  return { calls, setStatus: (s: Record<string, unknown>) => (status = { ...status, ...s }) };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe('nativeSupportsMode', () => {
  const devices = { host: 'WASAPI', inputs: [{ id: 'm', name: 'Mic', isDefault: true }], outputs: [], systemAudio: false };
  it('needs a microphone for Speaker and system sound for Device / Mic + Device', () => {
    expect(nativeSupportsMode(devices, 'speaker')).toBe(true);
    expect(nativeSupportsMode(devices, 'device')).toBe(false);
    expect(nativeSupportsMode(devices, 'dual')).toBe(false);
    expect(nativeSupportsMode({ ...devices, systemAudio: true }, 'dual')).toBe(true);
    expect(nativeSupportsMode(null, 'speaker')).toBe(false);
  });

  it('reports no native recorder outside the desktop shell or on an older shell', async () => {
    expect(await nativeRecorderDevices()).toBeNull();
    installShell();
    expect(await nativeRecorderDevices()).toBeNull();
  });
});

describe('NativeRecorder', () => {
  beforeEach(() => vi.useFakeTimers());

  it('starts, pauses, resumes and stops through the shell', async () => {
    const shell = installShell();
    const rec = new NativeRecorder();
    const states: RecorderState[] = [];
    rec.onState((s) => states.push(s));
    await rec.start({ meetingId: 'm1', mode: 'dual', startedAt: 1, microphone: 'USB Mic', mirrorPath: 'x/audio.ogg', live: true });
    const start = shell.calls.find((c) => c.cmd === 'native_recorder_start')!.args as { request: Record<string, unknown> };
    expect(start.request).toMatchObject({ meetingId: 'm1', mode: 'dual', microphone: 'USB Mic', mirrorPath: 'x/audio.ogg', live: true });
    vi.advanceTimersByTime(1000);
    await rec.pause();
    const paused = rec.getElapsedMs();
    vi.advanceTimersByTime(5000);
    expect(rec.getElapsedMs()).toBe(paused);
    await rec.resume();
    const result = await rec.stop();
    expect(result).toMatchObject({ mimeType: 'audio/ogg;codecs=opus', durationMs: 4200, chunkCount: 1, tracks: [''] });
    expect(states).toEqual(['STARTING', 'RECORDING', 'PAUSED', 'RECORDING', 'STOPPING', 'COMPLETED']);
  });

  it('turns a lost device into a source error and a storage failure into a recoverable one', async () => {
    const shell = installShell();
    const rec = new NativeRecorder();
    await rec.start({ meetingId: 'm1', mode: 'speaker', startedAt: 1 });
    shell.setStatus({ state: 'error', error: 'Disk full', errorKind: 'storage', unsavedChunks: 2 });
    await vi.advanceTimersByTimeAsync(600);
    expect(rec.getState()).toBe('ERROR');
    expect(rec.getErrorKind()).toBe('storage');
    shell.setStatus({ state: 'recording', error: null, errorKind: null, unsavedChunks: 0 });
    await vi.advanceTimersByTimeAsync(600);
    expect(rec.getState()).toBe('RECORDING');
    shell.setStatus({ state: 'error', error: 'The microphone stopped', errorKind: 'source' });
    await vi.advanceTimersByTimeAsync(600);
    expect(rec.getErrorKind()).toBe('source');
    expect(rec.getError()?.message).toContain('microphone');
  });

  it('a failed start leaves the recorder idle and reports the reason', async () => {
    installShell({
      native_recorder_start: () => {
        throw new Error('Could not open the system sound');
      },
    });
    const rec = new NativeRecorder();
    await expect(rec.start({ meetingId: 'm1', mode: 'device', startedAt: 1 })).rejects.toThrow('system sound');
    expect(rec.getState()).toBe('IDLE');
  });

  it('feeds live transcription with 16 kHz floats', async () => {
    installShell();
    const rec = new NativeRecorder();
    await rec.start({ meetingId: 'm1', mode: 'speaker', startedAt: 1, live: true });
    const got: number[] = [];
    const feed = new NativeLiveFeed(rec, (s) => got.push(...s));
    feed.start();
    await vi.advanceTimersByTimeAsync(600);
    await feed.stop();
    expect(got.slice(0, 2)).toEqual([0.5, -0.5]);
  });
});

describe('native decode', () => {
  it('reads little-endian PCM, aligned or not', () => {
    const bytes = new Uint8Array([0, 0, 0x00, 0x40, 0x00, 0xc0]);
    expect([...pcm16(bytes.subarray(2))]).toEqual([16384, -16384]);
    expect([...pcm16(bytes.subarray(1, 5))]).toEqual([0, 64]);
  });

  it('decodes Ogg Opus in the shell with the wanted rate, and falls back otherwise', async () => {
    const shell = installShell({ native_audio_decode: () => new Int16Array([1, 2, 3]).buffer });
    const blob = new Blob([new Uint8Array([79, 103, 103, 83])], { type: 'audio/ogg;codecs=opus' });
    const pcm = await decodeOggNative(blob, 24000);
    expect([...pcm!]).toEqual([1, 2, 3]);
    const call = shell.calls.find((c) => c.cmd === 'native_audio_decode')!;
    expect(call.args).toBeInstanceOf(Uint8Array);
    expect(call.options).toEqual({ headers: { 'x-sample-rate': '24000' } });
    expect(await decodeOggNative(new Blob([], { type: 'audio/webm' }), 16000)).toBeNull();
  });
});
