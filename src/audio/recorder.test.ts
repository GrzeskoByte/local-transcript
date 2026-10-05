import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writes: string[] = [];
let writeImpl: (name: string) => Promise<void> = async () => undefined;

vi.mock('../storage/recordings', () => ({
  assertDurableStorage: () => undefined,
  writeMeta: async () => undefined,
  appendChunk: async (_id: string, name: string, _data: Blob, track = '') => {
    await writeImpl(name);
    writes.push(`${track}/${name}`);
  },
}));

const { MediaRecorderAudioRecorder } = await import('./recorder');
import type { AudioSource } from './recorder';

class FakeTrack extends EventTarget {
  readyState: 'live' | 'ended' = 'live';
  stop(): void {}
  end(): void {
    this.readyState = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly track = new FakeTrack();
  getAudioTracks(): FakeTrack[] {
    return [this.track];
  }
  getTracks(): FakeTrack[] {
    return [this.track];
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(mime: string): boolean {
    return mime === 'audio/webm;codecs=opus';
  }
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((ev: Event & { data: Blob }) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  requestDataCalls = 0;

  constructor(readonly stream: FakeStream) {
    super();
    FakeMediaRecorder.instances.push(this);
    // Like browsers: the recorder stops by itself when its track ends.
    stream.track.addEventListener('ended', () => {
      if (this.state !== 'inactive') this.finish();
    });
  }
  start(): void {
    this.state = 'recording';
  }
  pause(): void {
    this.state = 'paused';
  }
  resume(): void {
    this.state = 'recording';
  }
  requestData(): void {
    this.requestDataCalls++;
    this.emit();
  }
  stop(): void {
    this.finish();
  }
  emit(bytes = 10): void {
    const ev = Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array(bytes)]) });
    this.ondataavailable?.(ev);
  }
  private finish(): void {
    this.emit();
    this.state = 'inactive';
    this.onstop?.();
    this.dispatchEvent(new Event('stop'));
  }
}

function source(stream = new FakeStream()): AudioSource & { stream: FakeStream } {
  return { stream, start: async () => stream as unknown as MediaStream, stop: async () => undefined };
}

beforeEach(() => {
  writes.length = 0;
  writeImpl = async () => undefined;
  FakeMediaRecorder.instances = [];
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
});

afterEach(() => vi.unstubAllGlobals());

describe('MediaRecorderAudioRecorder', () => {
  it('waits for slow chunk writes before reporting the recording', async () => {
    const rec = new MediaRecorderAudioRecorder();
    await rec.start(source(), 'm1', Date.now());
    // The final slice lands on a slow disk (e.g. antivirus scanning it).
    writeImpl = (name) => new Promise((r) => setTimeout(r, name.startsWith('000000') ? 0 : 400));
    FakeMediaRecorder.instances[0]!.emit();
    const result = await rec.stop();
    expect(writes).toEqual(['/000000.webm', '/000001.webm']);
    expect(result).toMatchObject({ chunkCount: 2, unsavedChunks: 0 });
    expect(rec.getState()).toBe('COMPLETED');
  });

  it('times each step of stop for the stop trace', async () => {
    const { StopTrace } = await import('../domain/stop-trace');
    const rec = new MediaRecorderAudioRecorder();
    await rec.start(source(), 'm-trace', Date.now());
    const trace = new StopTrace();
    await rec.stop(trace);
    expect(trace.steps.map((s) => s.step)).toEqual([
      'MediaRecorder.stop',
      'finish recorder',
      'release capture',
      'save chunks',
    ]);
  });

  it('hands every chunk to the chunk listener in order, even when saving fails', async () => {
    const rec = new MediaRecorderAudioRecorder();
    const seen: number[] = [];
    rec.onChunk((c) => seen.push(c.data.size));
    await rec.start(source(), 'm1', Date.now());
    writeImpl = async () => {
      throw new Error('disk full');
    };
    FakeMediaRecorder.instances[0]!.emit(3);
    FakeMediaRecorder.instances[0]!.emit(4);
    await rec.stop();
    expect(seen).toEqual([3, 4, 10]);
  });

  it('reports a final chunk that could not be written as unsaved', async () => {
    const rec = new MediaRecorderAudioRecorder();
    await rec.start(source(), 'm1', Date.now());
    writeImpl = async () => {
      throw new Error('disk full');
    };
    const result = await rec.stop();
    expect(result.unsavedChunks).toBe(1);
  });

  it('turns a disconnected source into a non-retryable error', async () => {
    const rec = new MediaRecorderAudioRecorder();
    const src = source();
    await rec.start(src, 'm1', Date.now());
    src.stream.track.end();
    expect(rec.getState()).toBe('ERROR');
    expect(rec.getErrorKind()).toBe('source');
    expect(rec.getError()?.message).toMatch(/disconnected/);
    // Retry must not pretend the recording resumed.
    await rec.retryPending();
    expect(rec.getState()).toBe('ERROR');
    const result = await rec.stop();
    expect(result.chunkCount).toBe(1);
    expect(rec.getState()).toBe('COMPLETED');
  });

  it('keeps recording the other track when one source of a two-way recording drops', async () => {
    const rec = new MediaRecorderAudioRecorder();
    const mic = source();
    const device = source();
    await rec.startTracks(
      [
        { track: 'microphone', source: mic },
        { track: 'device', source: device },
      ],
      'm1',
      Date.now(),
    );
    device.stream.track.end();
    expect(rec.getErrorKind()).toBe('source');
    expect(rec.getError()?.message).toMatch(/Device audio.*other source is still recording/);
    expect(FakeMediaRecorder.instances[0]!.state).toBe('recording');
  });

  it('recovers from a storage failure once Retry succeeds', async () => {
    const rec = new MediaRecorderAudioRecorder();
    await rec.start(source(), 'm1', Date.now());
    writeImpl = async () => {
      throw new Error('quota');
    };
    FakeMediaRecorder.instances[0]!.emit();
    await vi.waitFor(() => expect(rec.getState()).toBe('ERROR'));
    expect(rec.getErrorKind()).toBe('storage');
    writeImpl = async () => undefined;
    expect(await rec.retryPending()).toBe(true);
    expect(rec.getState()).toBe('RECORDING');
    expect(rec.getErrorKind()).toBeNull();
  });

  it('flushes the current slice when the window goes away', async () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    const rec = new MediaRecorderAudioRecorder();
    await rec.start(source(), 'm1', Date.now());
    win.dispatchEvent(new Event('pagehide'));
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(FakeMediaRecorder.instances[0]!.requestDataCalls).toBe(2);
    await rec.stop();
    // Listeners are removed after stop.
    win.dispatchEvent(new Event('pagehide'));
    expect(FakeMediaRecorder.instances[0]!.requestDataCalls).toBe(2);
  });
});
