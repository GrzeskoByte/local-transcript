/**
 * Live transcription (desktop, opt-in): transcribe while recording.
 *
 * The recording stays authoritative and is written exactly as before; live
 * text is derived data. A tap on the recorded stream feeds 16 kHz audio into
 * `LiveSegmenter`, each finished utterance goes to the native side
 * (`native_live_transcribe`, its own process slot), and the text is shown on
 * Active Meeting. On stop the live text becomes the meeting's transcript;
 * whole-file transcription (any model) stays available as Re-transcribe.
 *
 * Engines: Cactus Whistle (16.9 MB, CPU, 7 languages; downloaded on request)
 * or any installed whisper.cpp / voxtype model.
 */
import { invokeDesktop } from '../platform/desktop';
import { getPref, setPref } from '../platform/prefs';
import type { TranscriptSegment } from '../domain/transcript';
import type { CatalogModel } from './model-tiers';
import type { NativeDownloadProgress, NativeSegment } from './native-types';
import { preprocessForASR } from './preprocess';
import { bytesToBase64, encodeWav16 } from './wav';
import { LIVE_SAMPLE_RATE, LiveSegmenter } from './live-segmenter';

export const LIVE_ENABLED_PREF = 'live-transcription';
export const LIVE_MODEL_PREF = 'live-transcription-model';
/** Model id of Cactus Whistle in the live model picker. */
export const WHISTLE_MODEL = 'whistle';
export const WHISTLE_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'];
/** Approximate download: the engine (~1.5 MB) plus the weights (16.9 MB). */
export const WHISTLE_DOWNLOAD_MB = 18;

export interface WhistleStatus {
  /** A Whistle engine build exists for this OS/CPU (not Intel Macs). */
  supported: boolean;
  installed: boolean;
  platform: string | null;
  dir: string | null;
}

export function getLiveEnabled(): boolean {
  return getPref(LIVE_ENABLED_PREF) === 'true';
}

export function setLiveEnabled(value: boolean): void {
  setPref(LIVE_ENABLED_PREF, value ? 'true' : 'false');
}

export function getLiveModel(): string {
  return getPref(LIVE_MODEL_PREF) || WHISTLE_MODEL;
}

export function setLiveModel(id: string): void {
  setPref(LIVE_MODEL_PREF, id);
}

export async function whistleStatus(): Promise<WhistleStatus> {
  return invokeDesktop<WhistleStatus>('native_whistle_status');
}

export async function downloadWhistle(): Promise<void> {
  await invokeDesktop('native_whistle_download');
}

export async function whistleDownloadProgress(): Promise<NativeDownloadProgress> {
  return invokeDesktop<NativeDownloadProgress>('native_whistle_download_progress');
}

/** One choice in the live model picker. */
export interface LiveModelOption {
  id: string;
  label: string;
  detail: string;
  /** Usable right now (installed). */
  ready: boolean;
}

/** Whistle first (when this computer can run it), then every installed model, fastest first. */
export function liveModelOptions(whistle: WhistleStatus | null, installed: CatalogModel[]): LiveModelOption[] {
  const out: LiveModelOption[] = [];
  if (whistle?.supported) {
    out.push({
      id: WHISTLE_MODEL,
      label: 'Whistle',
      detail: whistle.installed
        ? '17 MB · fastest · en, de, fr, es, it, nl, pl'
        : `not downloaded (~${WHISTLE_DOWNLOAD_MB} MB) · fastest · 7 languages`,
      ready: whistle.installed,
    });
  }
  for (const m of [...installed].sort((a, b) => a.accuracy - b.accuracy || a.label.localeCompare(b.label))) {
    out.push({
      id: m.id,
      label: m.label,
      detail: [m.engine, m.detail, m.accuracy >= 4 ? 'may lag behind on a CPU' : ''].filter(Boolean).join(' · '),
      ready: true,
    });
  }
  return out;
}

/** The model live transcription will use: the saved choice if usable, else the first usable one. */
export function resolveLiveModel(saved: string, options: LiveModelOption[]): LiveModelOption | null {
  return options.find((o) => o.id === saved && o.ready) ?? options.find((o) => o.ready) ?? null;
}

/** Native request for one utterance (`native_live_transcribe`). */
export function liveRequest(model: string, wav: Uint8Array, language: string) {
  return {
    samplesBase64: bytesToBase64(wav),
    sampleRate: LIVE_SAMPLE_RATE,
    engine: model === WHISTLE_MODEL ? 'whistle' : 'native',
    ...(model === WHISTLE_MODEL ? {} : { model }),
    language,
  };
}

export type LiveStatus = 'listening' | 'transcribing' | 'finishing' | 'stopped' | 'failed';

export interface LiveSnapshot {
  model: string;
  status: LiveStatus;
  segments: TranscriptSegment[];
  /** Utterances waiting for (or in) transcription. */
  pending: number;
  /** Last error; after repeated errors live transcription stops (`failed`). */
  error: string | null;
}

type Invoke = (request: ReturnType<typeof liveRequest>) => Promise<NativeSegment[]>;

const defaultInvoke: Invoke = (request) =>
  invokeDesktop<NativeSegment[]>('native_live_transcribe', { request });

/** Consecutive engine failures before live transcription gives up. */
const MAX_FAILURES = 3;

/**
 * Turns pushed 16 kHz audio into transcript segments on the recording
 * timeline, one utterance at a time (the native side runs one process).
 * Never throws into the recorder: every failure is reported in the snapshot.
 */
export class LiveTranscriber {
  private readonly segmenter = new LiveSegmenter();
  private queue: { start: number; end: number; audio: Float32Array }[] = [];
  private segments: TranscriptSegment[] = [];
  private status: LiveStatus = 'listening';
  private error: string | null = null;
  private failures = 0;
  private working = false;
  private cancelled = false;
  private idle: (() => void)[] = [];
  private listeners: ((s: LiveSnapshot) => void)[] = [];

  constructor(
    readonly meetingId: string,
    readonly model: string,
    private readonly language: string,
    private readonly invoke: Invoke = defaultInvoke,
  ) {}

  onUpdate(fn: (s: LiveSnapshot) => void): void {
    this.listeners.push(fn);
  }

  /** `cancel()` was called: what was transcribed is incomplete. */
  get wasCancelled(): boolean {
    return this.cancelled;
  }

  snapshot(): LiveSnapshot {
    return {
      model: this.model,
      status: this.status,
      segments: this.segments,
      pending: this.queue.length + (this.working ? 1 : 0),
      error: this.error,
    };
  }

  /** Recorded audio (16 kHz mono, pauses already excluded by the caller). */
  push(samples: Float32Array): void {
    if (this.status !== 'listening' && this.status !== 'transcribing') return;
    this.segmenter.push(samples);
  }

  /** Cut finished utterances and transcribe them (call every ~0.5–1 s). */
  tick(): void {
    if (this.status !== 'listening' && this.status !== 'transcribing') return;
    this.enqueue(this.segmenter.take(false));
  }

  /**
   * Capture ended: transcribe what is left and resolve with the full
   * transcript once the queue is empty (or `cancel()` was called).
   */
  async finish(onProgress?: (ratio: number) => void): Promise<TranscriptSegment[]> {
    if (this.status === 'listening' || this.status === 'transcribing') {
      this.enqueue(this.segmenter.take(true));
      this.status = this.queue.length > 0 || this.working ? 'finishing' : 'stopped';
      this.emit();
    }
    const total = this.queue.length + (this.working ? 1 : 0);
    if (total > 0) {
      await new Promise<void>((resolve) => {
        const report = () => {
          const left = this.queue.length + (this.working ? 1 : 0);
          onProgress?.(total > 0 ? 1 - left / total : 1);
        };
        this.listeners.push(report);
        this.idle.push(resolve);
        this.pump();
      });
    }
    if (this.status === 'finishing') this.status = 'stopped';
    this.emit();
    return this.segments;
  }

  /** Stop transcribing (and drop the queue); `finish()` resolves with what is done. */
  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    if (this.status !== 'failed') this.status = 'stopped';
    void invokeDesktop('native_live_cancel').catch(() => undefined);
    this.settle();
    this.emit();
  }

  private enqueue(utterances: { start: number; end: number; audio: Float32Array }[]): void {
    if (utterances.length === 0) return;
    this.queue.push(...utterances);
    this.emit();
    this.pump();
  }

  private pump(): void {
    if (this.working || this.cancelled) return;
    const next = this.queue.shift();
    if (!next) {
      if (this.status === 'transcribing') this.status = 'listening';
      this.settle();
      this.emit();
      return;
    }
    this.working = true;
    if (this.status === 'listening') this.status = 'transcribing';
    this.emit();
    void this.transcribeOne(next).finally(() => {
      this.working = false;
      this.pump();
    });
  }

  private async transcribeOne(u: { start: number; end: number; audio: Float32Array }): Promise<void> {
    const pre = preprocessForASR(u.audio);
    if (pre.empty) return;
    try {
      const wav = encodeWav16(pre.audio, LIVE_SAMPLE_RATE);
      const result = await this.invoke(liveRequest(this.model, wav, this.language));
      if (this.cancelled) return;
      this.failures = 0;
      this.error = null;
      const text = result
        .map((s) => s.text.trim())
        .filter(Boolean)
        .join(' ');
      if (!text) return;
      const i = this.segments.length;
      this.segments = [
        ...this.segments,
        {
          id: `${this.meetingId}-seg-${i}`,
          meetingId: this.meetingId,
          sequence: i,
          startMs: Math.round((u.start / LIVE_SAMPLE_RATE) * 1000),
          endMs: Math.round((u.end / LIVE_SAMPLE_RATE) * 1000),
          text,
        },
      ];
    } catch (err) {
      if (this.cancelled) return;
      this.failures++;
      this.error = err instanceof Error ? err.message : String(err);
      if (this.failures >= MAX_FAILURES) {
        this.status = 'failed';
        this.queue = [];
        this.settle();
      }
    }
  }

  private settle(): void {
    if (this.working && !this.cancelled) return;
    const waiting = this.idle;
    this.idle = [];
    waiting.forEach((r) => r());
  }

  private emit(): void {
    const snap = this.snapshot();
    this.listeners.forEach((fn) => fn(snap));
  }
}
