import { chunkFileName, pickSupportedMimeType } from './formats';
import { appendChunk, writeMeta } from '../storage/recordings';
import { CHUNK_MS } from '../domain/meeting';

export interface AudioSource {
  start(): Promise<MediaStream>;
  stop(): Promise<void>;
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

interface ActiveTrack {
  track: string;
  source: AudioSource;
  recorder: MediaRecorder;
  mimeType: string;
  chunkIndex: number;
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
  private onStateChange: ((s: RecorderState) => void) | null = null;
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
    const started: ActiveTrack[] = [];
    try {
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
      });
      specs.forEach((spec, i) => {
        const stream = streams[i]!;
        const options: MediaRecorderOptions = {
          ...(baseMime ? { mimeType: baseMime } : {}),
          // Opus default is voice-grade; 128 kbps keeps consonants crisp before
          // the 16 kHz resample and costs little space. Browsers may clamp it.
          audioBitsPerSecond: 128000,
        };
        const recorder = new MediaRecorder(stream, options);
        const active: ActiveTrack = {
          track: spec.track,
          source: spec.source,
          recorder,
          // Re-read actual mimeType (browser may ignore the hint).
          mimeType: recorder.mimeType || baseMime,
          chunkIndex: 0,
        };
        recorder.ondataavailable = (ev: BlobEvent) => {
          if (ev.data && ev.data.size > 0 && this.meetingId) {
            const idx = active.chunkIndex++;
            const name = chunkFileName(idx, active.mimeType);
            const chunk: PendingChunk = { track: active.track, name, data: ev.data };
            void appendChunk(this.meetingId, name, ev.data, active.track).catch((err) =>
              this.onWriteFailed(chunk, err),
            );
          }
        };
        recorder.onerror = () => {
          this.error = new Error('Recording error');
          this.setState('ERROR');
        };
        started.push(active);
      });
      started.forEach((t) => t.recorder.start(CHUNK_TIMESLICE_MS));
      this.tracks = started;
      this.pending = [];
      this.accumulatedMs = 0;
      this.runningSince = Date.now();
      this.resumeState = 'RECORDING';
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
      this.error = null;
      if (this.state === 'ERROR') this.setState(this.resumeState);
      return true;
    }
    this.error = lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    return false;
  }

  private onWriteFailed(chunk: PendingChunk, err: unknown): void {
    this.pending.push(chunk);
    const cause = err instanceof Error ? err.message : String(err);
    this.error = new Error(`Storage write failed (${cause}).`);
    if (this.state === 'RECORDING' || this.state === 'PAUSED') this.resumeState = this.state;
    this.setState('ERROR');
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
            // ondataavailable lands first.
            const finish = () => setTimeout(resolve, 50);
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
    await Promise.all(tracks.map((t) => t.source.stop().catch(() => undefined)));
    // Let the final slice's write settle, then give failed chunks one last try.
    await new Promise((r) => setTimeout(r, 100));
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
    this.tracks = [];
    this.meetingId = null;
    this.setState('IDLE');
  }
}
