import { chunkFileName, pickSupportedMimeType } from './formats';
import { settleWithin } from '../domain/settle';
import { appendChunk, assertDurableStorage, writeMeta } from '../storage/recordings';
import { CHUNK_MS } from '../domain/meeting';

/** Longest wait for MediaRecorder's final `stop` event. */
export const RECORDER_STOP_TIMEOUT_MS = 5000;
/** Longest wait for a capture source to release its device. */
export const SOURCE_STOP_TIMEOUT_MS = 5000;

export interface AudioSource {
  start(): Promise<MediaStream>;
  stop(): Promise<void>;
  /** The live capture stream, for diagnostics (optional). */
  currentStream?(): MediaStream | null;
}

/** One capture channel. `track` names the OPFS sub-directory ('' = flat, single-track). */
export interface TrackSpec {
  track: string;
  source: AudioSource;
}

export interface Recording {
  mimeType: string;
  chunkCount: number;
  /** Track ids that were recorded ('' for a single-track recording). */
  tracks: string[];
  /** Recorded time, excluding pauses. */
  durationMs: number;
  /** Chunks that could not be written to storage even after a final retry. */
  unsavedChunks: number;
}

/** A chunk as it comes out of MediaRecorder. */
export interface RecordedChunk {
  track: string;
  mimeType: string;
  data: Blob;
}

interface PendingChunk {
  track: string;
  name: string;
  data: Blob;
}

export type RecorderState =
  | 'IDLE'
  | 'STARTING'
  | 'RECORDING'
  | 'PAUSED'
  | 'STOPPING'
  | 'COMPLETED'
  | 'ERROR';

const CHUNK_TIMESLICE_MS = CHUNK_MS;

/**
 * Why the recorder is in ERROR:
 *  - 'storage': chunks could not be written (held in memory; Retry can fix it)
 *  - 'source': a capture source ended (mic unplugged, headset dropped, screen
 *    share stopped) or its MediaRecorder failed. Nothing more is captured from
 *    that source; what was recorded before is saved. Retry cannot fix it.
 */
export type RecorderErrorKind = 'storage' | 'source';

interface ActiveTrack {
  track: string;
  source: AudioSource;
  recorder: MediaRecorder;
  mimeType: string;
  chunkIndex: number;
  /** False once the source ended or the MediaRecorder failed. */
  alive: boolean;
}

function trackLabel(track: string): string {
  if (track === 'microphone') return 'The microphone';
  if (track === 'device') return 'Device audio';
  return 'The audio source';
}

/**
 * MediaRecorder wrapper (§8). Writes chunks incrementally to OPFS so long
 * recordings survive memory pressure / crashes (§15). Never keeps the whole
 * recording in memory.
 *
 * Supports several parallel tracks (two-way recording): each track gets its own
 * MediaRecorder and its own OPFS sub-directory, so the microphone and the
 * device/system audio stay separable — which is what lets transcription label
 * "Me" vs "Others" without a diarization model.
 */
export class MediaRecorderAudioRecorder {
  private tracks: ActiveTrack[] = [];
  private meetingId: string | null = null;
  private state: RecorderState = 'IDLE';
  private error: Error | null = null;
  private errorKind: RecorderErrorKind | null = null;
  /** Chunk writes that have not settled yet; stop() waits for all of them. */
  private inflight = new Set<Promise<void>>();
  private detachLifecycle: (() => void) | null = null;
  private onStateChange: ((s: RecorderState) => void) | null = null;
  private onChunkData: ((chunk: RecordedChunk) => void) | null = null;
  /** Chunks whose write failed; kept in memory so Retry / Stop can save them. */
  private pending: PendingChunk[] = [];
  /** Recorded time bookkeeping: accumulated ms + start of the running stretch. */
  private accumulatedMs = 0;
  private runningSince: number | null = null;
  /** State to return to once a storage error is resolved. */
  private resumeState: 'RECORDING' | 'PAUSED' = 'RECORDING';

  getState(): RecorderState {
    return this.state;
  }

  getError(): Error | null {
    return this.error;
  }

  getErrorKind(): RecorderErrorKind | null {
    return this.errorKind;
  }

  getMimeType(): string {
    return this.tracks[0]?.mimeType ?? '';
  }

  /** Recorded time so far, excluding pauses. */
  getElapsedMs(now = Date.now()): number {
    return this.accumulatedMs + (this.runningSince !== null ? now - this.runningSince : 0);
  }

  /** Number of chunks waiting to be written after a storage failure. */
  getUnsavedCount(): number {
    return this.pending.length;
  }

  onState(fn: (s: RecorderState) => void): void {
    this.onStateChange = fn;
  }

  /**
   * Called for every chunk as it is recorded, in order per track (before it
   * is saved). Lets the desktop mirror append it to disk in real time.
   */
  onChunk(fn: ((chunk: RecordedChunk) => void) | null): void {
    this.onChunkData = fn;
  }

  private setState(s: RecorderState): void {
    this.state = s;
    this.onStateChange?.(s);
  }

  /** Single-source convenience wrapper (flat OPFS layout). */
  async start(source: AudioSource, meetingId: string, startedAt: number): Promise<Recording> {
    return this.startTracks([{ track: '', source }], meetingId, startedAt);
  }

  async startTracks(
    specs: TrackSpec[],
    meetingId: string,
    startedAt: number,
  ): Promise<Recording> {
    if (this.state === 'RECORDING' || this.state === 'STARTING') {
      return this.snapshot(0);
    }
    this.setState('STARTING');
    this.error = null;
    this.errorKind = null;
    const started: ActiveTrack[] = [];
    try {
      // Before any permission prompt: never record into memory only.
      assertDurableStorage();
      if (typeof MediaRecorder === 'undefined') {
        throw new Error(
          'This system’s web engine cannot record audio (MediaRecorder is unavailable). ' +
            'Update your operating system or its web engine, then try again.',
        );
      }
      // Start every source up front. Requesting both streams together keeps the
      // user-gesture token valid for getDisplayMedia and surfaces a missing
      // device/screen track before any recorder is created.
      const streams = await Promise.all(specs.map((s) => s.source.start()));
      this.meetingId = meetingId;
      const baseMime = pickSupportedMimeType();
      await writeMeta(meetingId, {
        mimeType: baseMime,
        startedAt,
        tracks: specs.map((s) => s.track),
      }).catch((err: unknown) => {
        // Storage that cannot even be opened: say so, not a raw DOMException.
        const cause = err instanceof Error ? err.message : String(err);
        throw new Error(`The recording could not be saved to this device's storage (${cause}).`);
      });
      specs.forEach((spec, i) => {
        const stream = streams[i]!;
        const options: MediaRecorderOptions = {
          ...(baseMime ? { mimeType: baseMime } : {}),
          // Mono speech: Opus is transparent around 32–48 kbps and ASR
          // resamples to 16 kHz anyway. 48 kbps ≈ 18 MB per 50 min (128 kbps
          // was ≈ 55 MB with no audible gain). Engines may clamp it.
          audioBitsPerSecond: 48000,
        };
        const recorder = new MediaRecorder(stream, options);
        const active: ActiveTrack = {
          track: spec.track,
          source: spec.source,
          recorder,
          // Re-read actual mimeType (browser may ignore the hint).
          mimeType: recorder.mimeType || baseMime,
          chunkIndex: 0,
          alive: true,
        };
        recorder.ondataavailable = (ev: BlobEvent) => {
          if (ev.data && ev.data.size > 0 && this.meetingId) {
            const idx = active.chunkIndex++;
            const name = chunkFileName(idx, active.mimeType);
            const chunk: PendingChunk = { track: active.track, name, data: ev.data };
            const write = appendChunk(this.meetingId, name, ev.data, active.track)
              .catch((err) => this.onWriteFailed(chunk, err))
              .finally(() => this.inflight.delete(write));
            this.inflight.add(write);
            try {
              this.onChunkData?.({ track: active.track, mimeType: active.mimeType, data: ev.data });
            } catch {
              // A listener must never affect the recording.
            }
          }
        };
        recorder.onerror = (ev: Event) => {
          const detail = (ev as Event & { error?: { message?: string } }).error?.message;
          this.onSourceLost(active, `${trackLabel(active.track)} stopped recording${detail ? ` (${detail})` : ''}.`);
        };
        // Unplugged mic, dropped Bluetooth headset, screen share stopped from
        // the OS/browser bar: the track ends and MediaRecorder stops on its own.
        stream.getAudioTracks().forEach((t) =>
          t.addEventListener('ended', () =>
            this.onSourceLost(active, `${trackLabel(active.track)} was disconnected.`),
          ),
        );
        recorder.addEventListener('stop', () => {
          if (this.state !== 'STOPPING' && this.state !== 'COMPLETED' && this.state !== 'IDLE') {
            // The recorder's stop can arrive before the track's `ended`.
            const ended = stream.getAudioTracks().some((t) => t.readyState === 'ended');
            this.onSourceLost(
              active,
              `${trackLabel(active.track)} ${ended ? 'was disconnected' : 'stopped unexpectedly'}.`,
            );
          }
        });
        started.push(active);
      });
      started.forEach((t) => t.recorder.start(CHUNK_TIMESLICE_MS));
      this.tracks = started;
      this.pending = [];
      this.accumulatedMs = 0;
      this.runningSince = Date.now();
      this.resumeState = 'RECORDING';
      this.attachLifecycle();
      this.setState('RECORDING');
      return this.snapshot(0);
    } catch (err) {
      // Never leak a live stream/recorder when a later track fails to start.
      await Promise.all(
        specs.map((s) => s.source.stop().catch(() => undefined)),
      );
      this.tracks = [];
      this.meetingId = null;
      this.error = err instanceof Error ? err : new Error(String(err));
      this.setState('ERROR');
      throw this.error;
    }
  }

  async pause(): Promise<void> {
    let paused = false;
    for (const t of this.tracks) {
      if (t.recorder.state === 'recording') {
        t.recorder.pause();
        paused = true;
      }
    }
    if (paused) {
      this.stopClock();
      this.resumeState = 'PAUSED';
      // A storage error stays visible until it is resolved.
      if (this.state !== 'ERROR') this.setState('PAUSED');
    }
  }

  async resume(): Promise<void> {
    let resumed = false;
    for (const t of this.tracks) {
      if (t.recorder.state === 'paused') {
        t.recorder.resume();
        resumed = true;
      }
    }
    if (resumed) {
      this.runningSince = Date.now();
      this.resumeState = 'RECORDING';
      if (this.state !== 'ERROR') this.setState('RECORDING');
    }
  }

  /**
   * Retry writing chunks that failed (§9 Retry). Returns true when everything
   * is on disk again, in which case the recorder leaves the ERROR state.
   */
  async retryPending(): Promise<boolean> {
    const id = this.meetingId;
    if (!id) return this.pending.length === 0;
    const still: PendingChunk[] = [];
    let lastErr: unknown = null;
    for (const chunk of this.pending) {
      try {
        await appendChunk(id, chunk.name, chunk.data, chunk.track);
      } catch (err) {
        still.push(chunk);
        lastErr = err;
      }
    }
    this.pending = still;
    if (still.length === 0) {
      // A lost source cannot be fixed by retrying: keep that error visible.
      if (this.errorKind === 'source') return true;
      this.error = null;
      this.errorKind = null;
      if (this.state === 'ERROR') this.setState(this.resumeState);
      return true;
    }
    this.error = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    return false;
  }

  private onWriteFailed(chunk: PendingChunk, err: unknown): void {
    this.pending.push(chunk);
    // During stop the final retry decides; a source error stays the headline.
    if (this.state === 'STOPPING' || this.errorKind === 'source') return;
    const cause = err instanceof Error ? err.message : String(err);
    this.error = new Error(`Storage write failed (${cause}).`);
    this.errorKind = 'storage';
    if (this.state === 'RECORDING' || this.state === 'PAUSED') this.resumeState = this.state;
    this.setState('ERROR');
  }

  private onSourceLost(active: ActiveTrack, message: string): void {
    if (!active.alive) return;
    active.alive = false;
    if (this.state === 'STOPPING' || this.state === 'COMPLETED' || this.state === 'IDLE') return;
    // The clock only runs while at least one source still records.
    if (!this.tracks.some((t) => t.alive)) this.stopClock();
    const others = this.tracks.some((t) => t.alive) ? ' The other source is still recording.' : '';
    this.error = new Error(`${message}${others}`);
    this.errorKind = 'source';
    this.setState('ERROR');
  }

  /** Ask every live recorder for its buffered audio (≤ one chunk) right now. */
  private flush(): void {
    for (const t of this.tracks) {
      try {
        if (t.recorder.state === 'recording') t.recorder.requestData();
      } catch {
        // ignore: best effort
      }
    }
  }

  /**
   * Closing the window or hiding the app must not lose the current slice:
   * flush on pagehide / when the document becomes hidden.
   */
  private attachLifecycle(): void {
    this.detachLifecycle?.();
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const onPageHide = () => this.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.flush();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    this.detachLifecycle = () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      this.detachLifecycle = null;
    };
  }

  /** Wait until every chunk write (including ones queued meanwhile) settled. */
  private async drainWrites(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  private stopClock(): void {
    if (this.runningSince !== null) {
      this.accumulatedMs += Date.now() - this.runningSince;
      this.runningSince = null;
    }
  }

  private snapshot(chunkCount: number): Recording {
    return {
      mimeType: this.getMimeType(),
      chunkCount,
      tracks: this.tracks.map((t) => t.track),
      durationMs: this.getElapsedMs(),
      unsavedChunks: this.pending.length,
    };
  }

  async stop(): Promise<Recording> {
    const tracks = this.tracks;
    if (tracks.length === 0) return { mimeType: '', chunkCount: 0, tracks: [], durationMs: 0, unsavedChunks: 0 };
    this.stopClock();
    this.setState('STOPPING');
    await Promise.all(
      tracks.map(
        (t) =>
          new Promise<void>((resolve) => {
            // Flush the final slice, then resolve on the next tick so
            // ondataavailable lands first. If the engine never fires onstop,
            // stop waiting: everything delivered so far is saved below.
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              setTimeout(resolve, 50);
            };
            setTimeout(finish, RECORDER_STOP_TIMEOUT_MS);
            t.recorder.onstop = finish;
            try {
              if (t.recorder.state !== 'inactive') t.recorder.stop();
              else finish();
            } catch {
              finish();
            }
          }),
      ),
    );
    // Releasing a capture device can stall in the OS / GStreamer; it must
    // not hold the recording (or the UI) hostage.
    await Promise.all(tracks.map((t) => settleWithin(t.source.stop(), SOURCE_STOP_TIMEOUT_MS, undefined)));
    this.detachLifecycle?.();
    // Every write must settle before the recording is reported: a slow disk
    // (e.g. antivirus scanning each file) must not turn into silent loss.
    await this.drainWrites();
    if (this.pending.length) await this.retryPending();
    const result: Recording = {
      mimeType: tracks[0]?.mimeType ?? '',
      chunkCount: tracks.reduce((n, t) => n + t.chunkIndex, 0),
      tracks: tracks.map((t) => t.track),
      durationMs: this.accumulatedMs,
      unsavedChunks: this.pending.length,
    };
    this.pending = [];
    this.tracks = [];
    this.meetingId = null;
    this.error = null;
    this.errorKind = null;
    this.setState('COMPLETED');
    return result;
  }

  async abort(): Promise<void> {
    for (const t of this.tracks) {
      try {
        if (t.recorder.state !== 'inactive') t.recorder.stop();
      } catch {
        // ignore
      }
    }
    await Promise.all(this.tracks.map((t) => t.source.stop().catch(() => undefined)));
    this.detachLifecycle?.();
    this.tracks = [];
    this.meetingId = null;
    this.setState('IDLE');
  }
}
