/**
 * Records in the desktop shell (Rust: `src-tauri/src/recorder`) instead of
 * the webview, on every OS: capture (microphone, system sound via WASAPI
 * loopback / CoreAudio tap / PulseAudio monitor), the Mic + Device mix, Opus
 * encoding and chunk writes all run natively. The webview owns no capture
 * stream, AudioContext or MediaRecorder, so nothing heavy is torn down on its
 * main thread at Stop — the cause of the "app freezes after Stop" reports.
 *
 * Same surface as MediaRecorderAudioRecorder for the store: state, errors,
 * pause/resume, retry, stop. Status, levels and diagnostics are polled.
 */
import { invokeDesktop, isDesktopApp } from '../platform/desktop';
import { getPref, setPref } from '../platform/prefs';
import { markNativeRecording, nativeBytes } from '../storage/recordings';
import type { RecordingMode } from '../domain/meeting';
import type { BleedStats, DiagEvent, InputStats } from '../domain/audio-diagnostics';
import { StopTrace } from '../domain/stop-trace';
import type { Recording, RecorderErrorKind, RecorderState } from './recorder';
import { pcm16 } from './native-decode';

export const NATIVE_MIME_TYPE = 'audio/ogg;codecs=opus';
/** Pref: 'false' turns native recording off (webview recording); default on. */
export const NATIVE_RECORDING_PREF = 'native-recording';

export function nativeRecordingEnabled(): boolean {
  return getPref(NATIVE_RECORDING_PREF) !== 'false';
}

export function setNativeRecordingEnabled(on: boolean): void {
  setPref(NATIVE_RECORDING_PREF, on ? 'true' : 'false');
}
const POLL_MS = 500;
/** Diagnostics (larger reply) every 2 s. */
const DIAG_EVERY = 4;

export interface NativeDeviceInfo {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface NativeRecorderDevices {
  host: string;
  inputs: NativeDeviceInfo[];
  outputs: NativeDeviceInfo[];
  /** System sound ("Device Audio") can be recorded natively. */
  systemAudio: boolean;
}

export interface NativeDiagnostics {
  inputs: InputStats[];
  bleed?: BleedStats;
  events: DiagEvent[];
}

interface NativeStatus {
  state: 'idle' | 'recording' | 'paused' | 'error';
  meetingId?: string | null;
  elapsedMs: number;
  chunks: number;
  unsavedChunks: number;
  error?: string | null;
  errorKind?: RecorderErrorKind | null;
  levels: number[];
  mirrorOk: boolean;
  diagnostics?: NativeDiagnostics;
}

interface StopReply {
  mimeType: string;
  durationMs: number;
  chunkCount: number;
  unsavedChunks: number;
  mirrorOk: boolean;
  diagnostics: NativeDiagnostics;
}

export interface NativeStartOptions {
  meetingId: string;
  mode: RecordingMode;
  startedAt: number;
  /** Saved microphone label (matched by name natively). */
  microphone?: string;
  /** Output to record (Linux: sink name). */
  output?: string;
  /** Path in the meeting folder the audio is appended to while recording. */
  mirrorPath?: string;
  /** Collect 16 kHz audio for live transcription. */
  live?: boolean;
}

/** Native recording devices, or null when the shell cannot record natively. */
export async function nativeRecorderDevices(): Promise<NativeRecorderDevices | null> {
  if (!isDesktopApp()) return null;
  try {
    const d = await invokeDesktop<NativeRecorderDevices | null>('native_recorder_devices');
    return d && Array.isArray(d.inputs) ? d : null;
  } catch {
    return null;
  }
}

/** Whether a recording in `mode` can run natively with these devices. */
export function nativeSupportsMode(devices: NativeRecorderDevices | null, mode: RecordingMode): boolean {
  if (!devices) return false;
  if (mode === 'speaker') return devices.inputs.length > 0;
  if (mode === 'device') return devices.systemAudio;
  return devices.inputs.length > 0 && devices.systemAudio;
}

export class NativeRecorder {
  private state: RecorderState = 'IDLE';
  private error: Error | null = null;
  private errorKind: RecorderErrorKind | null = null;
  private onStateChange: ((s: RecorderState) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polls = 0;
  private polling = false;
  private accumulatedMs = 0;
  private runningSince: number | null = null;
  private lastDiagnostics: NativeDiagnostics | null = null;
  private mirrorOk = true;
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
    return NATIVE_MIME_TYPE;
  }

  onState(cb: (s: RecorderState) => void): void {
    this.onStateChange = cb;
  }

  /** Last measurements of the inputs (null before the first diagnostics poll). */
  diagnostics(): NativeDiagnostics | null {
    return this.lastDiagnostics;
  }

  /** False once appending to the meeting folder failed (copy after Stop). */
  mirrorComplete(): boolean {
    return this.mirrorOk;
  }

  /** Recorded time, excluding pauses (the clock the UI shows). */
  getElapsedMs(): number {
    return this.accumulatedMs + (this.runningSince !== null ? Date.now() - this.runningSince : 0);
  }

  private setState(s: RecorderState): void {
    this.state = s;
    this.onStateChange?.(s);
  }

  async start(options: NativeStartOptions): Promise<void> {
    this.setState('STARTING');
    markNativeRecording(options.meetingId);
    try {
      await invokeDesktop('native_recorder_start', {
        request: {
          meetingId: options.meetingId,
          mode: options.mode,
          microphone: options.microphone || null,
          output: options.output || null,
          mirrorPath: options.mirrorPath ?? null,
          live: !!options.live,
          startedAt: options.startedAt,
        },
      });
    } catch (err) {
      this.setState('IDLE');
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.runningSince = Date.now();
    this.setState('RECORDING');
    this.timer = setInterval(() => void this.poll(), POLL_MS);
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const withDiag = this.polls++ % DIAG_EVERY === 0;
      const s = await invokeDesktop<NativeStatus>('native_recorder_poll', { diagnostics: withDiag });
      if (!s || s.state === 'idle') return;
      if (s.diagnostics) this.lastDiagnostics = s.diagnostics;
      this.mirrorOk = s.mirrorOk !== false;
      if (s.state === 'error' && this.state !== 'ERROR' && this.state !== 'STOPPING') {
        this.error = new Error(s.error ?? 'Recording error');
        this.errorKind = s.errorKind ?? 'source';
        if (this.state === 'RECORDING' || this.state === 'PAUSED') this.resumeState = this.state;
        this.setState('ERROR');
      } else if (s.state !== 'error' && this.state === 'ERROR' && this.errorKind === 'storage') {
        // Held chunks were written after all.
        this.error = null;
        this.errorKind = null;
        this.setState(this.resumeState);
      }
    } catch {
      // A missed poll changes nothing; the next one catches up.
    } finally {
      this.polling = false;
    }
  }

  async pause(): Promise<void> {
    if (this.state !== 'RECORDING') return;
    await invokeDesktop('native_recorder_pause');
    if (this.runningSince !== null) this.accumulatedMs += Date.now() - this.runningSince;
    this.runningSince = null;
    this.setState('PAUSED');
  }

  async resume(): Promise<void> {
    if (this.state !== 'PAUSED') return;
    await invokeDesktop('native_recorder_resume');
    this.runningSince = Date.now();
    this.setState('RECORDING');
  }

  /** Write chunks held after a storage error again. */
  async retryPending(): Promise<boolean> {
    const ok = await invokeDesktop<boolean>('native_recorder_retry').catch(() => false);
    await this.poll();
    return ok !== false && this.errorKind !== 'storage';
  }

  /** Audio since the last call, 16 kHz mono, for live transcription. */
  async takeLiveAudio(): Promise<Float32Array> {
    const bytes = nativeBytes(await invokeDesktop<unknown>('native_recorder_live_take').catch(() => null));
    if (!bytes) return new Float32Array(0);
    const pcm = pcm16(bytes);
    const out = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 0x8000;
    return out;
  }

  async stop(trace?: StopTrace): Promise<Recording & { diagnostics: NativeDiagnostics | null }> {
    const t = trace ?? new StopTrace();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.runningSince !== null) this.accumulatedMs += Date.now() - this.runningSince;
    this.runningSince = null;
    this.setState('STOPPING');
    // Devices are released, the last chunk written — all in the shell, off
    // the webview's thread.
    const reply = await t.time('native stop', () => invokeDesktop<StopReply>('native_recorder_stop'));
    this.mirrorOk = reply?.mirrorOk !== false;
    this.lastDiagnostics = reply?.diagnostics ?? this.lastDiagnostics;
    this.error = null;
    this.errorKind = null;
    this.setState('COMPLETED');
    return {
      mimeType: reply?.mimeType || NATIVE_MIME_TYPE,
      chunkCount: reply?.chunkCount ?? 0,
      tracks: [''],
      durationMs: reply?.durationMs ?? this.accumulatedMs,
      unsavedChunks: reply?.unsavedChunks ?? 0,
      diagnostics: this.lastDiagnostics,
    };
  }

  /** Stop without keeping the meeting (a failed start). */
  async abort(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await invokeDesktop('native_recorder_stop').catch(() => undefined);
    this.setState('IDLE');
  }
}

/** What live transcription reads the recording through (LivePcmTap or this). */
export interface LiveFeed {
  stop(): Promise<void>;
  setPaused(paused: boolean): void;
}

/** Live transcription audio from the native recorder (16 kHz, pulled). */
export class NativeLiveFeed implements LiveFeed {
  private timer: ReturnType<typeof setInterval> | null = null;
  private paused = false;
  private pulling: Promise<void> | null = null;

  constructor(
    private readonly recorder: NativeRecorder,
    private readonly onAudio: (samples16k: Float32Array) => void,
  ) {}

  start(intervalMs = 500): void {
    this.timer = setInterval(() => void this.pull(), intervalMs);
  }

  private pull(): Promise<void> {
    if (this.pulling) return this.pulling;
    this.pulling = this.recorder
      .takeLiveAudio()
      .then((audio) => {
        // The shell drops audio while paused; this guards the in-flight pull.
        if (audio.length > 0 && !this.paused) this.onAudio(audio);
      })
      .catch(() => undefined)
      .finally(() => {
        this.pulling = null;
      });
    return this.pulling;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** Take what is left, then stop pulling (before the recorder stops). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pull();
  }
}
