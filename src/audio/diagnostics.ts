import {
  assessDiagnostics,
  type BleedStats,
  type DiagEvent,
  type InputSettings,
  type InputStats,
  type NativeAudioLog,
  type ProbeRole,
  type RecordingDiagnostics,
} from '../domain/audio-diagnostics';
import { invokeDesktop, isDesktopApp } from '../platform/desktop';

/**
 * Measures each input (microphone, system sound) while recording, BEFORE the
 * Mic + Device mix — clipping and narrowband in an input are invisible after
 * the limiter. Analysers only read the streams: the recording is untouched,
 * and any failure here only loses the diagnostics.
 *
 * Every 500 ms each input's last ~340 ms is inspected: level, full-scale
 * samples, exact silence (dropout), spectrum above 4/8 kHz (Bluetooth call
 * mode is narrowband), and — with both inputs — how strongly the system sound
 * reappears in the microphone, and how late (acoustic bleed vs a loopback).
 */

const FFT_SIZE = 16384;
const POLL_MS = 500;
const ACTIVE_DB = -50;
const BUCKET_S = 10;
/** Correlation is computed at 6 kHz (48 kHz / 8), delays up to 250 ms. */
const DECIMATE = 8;
const MAX_LAG_S = 0.25;
const MAX_BLEED_SAMPLES = 2000;
const MAX_EVENTS = 200;

export interface FrameStats {
  rmsDb: number;
  peakDb: number;
  clipped: number;
  silent: boolean;
}

/** dBFS, floored at -120 (keeps the stored report JSON-safe). */
const FLOOR_DB = -120;
const toDb = (x: number): number => (x > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(x)) : FLOOR_DB);

export function frameStats(samples: Float32Array): FrameStats {
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]!);
    sum += a * a;
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
  }
  const rms = samples.length ? Math.sqrt(sum / samples.length) : 0;
  return { rmsDb: toDb(rms), peakDb: toDb(peak), clipped, silent: peak === 0 };
}

/** Share of spectral power above `hz` (from getFloatFrequencyData dB values). */
export function powerShareAbove(freqDb: Float32Array, binHz: number, hz: number): number {
  let total = 0;
  let above = 0;
  for (let i = 1; i < freqDb.length; i++) {
    const db = freqDb[i]!;
    if (!Number.isFinite(db)) continue;
    const p = 10 ** (db / 10);
    total += p;
    if (i * binHz > hz) above += p;
  }
  return total > 0 ? above / total : 0;
}

function decimate(x: Float32Array, factor: number): Float32Array {
  const out = new Float32Array(Math.floor(x.length / factor));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += x[i * factor + k]!;
    out[i] = s / factor;
  }
  return out;
}

/**
 * Best normalized correlation of `mic` against `dev` with the microphone
 * `0..maxLag` samples later. Returns |corr| and the delay in samples.
 */
export function bestLag(mic: Float32Array, dev: Float32Array, maxLag: number): { corr: number; lag: number } {
  const n = Math.min(mic.length, dev.length);
  let best = 0;
  let bestLagAt = 0;
  for (let lag = 0; lag <= Math.min(maxLag, n - 64); lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < n; i++) {
      const d = dev[i]!;
      const m = mic[i + lag]!;
      xy += d * m;
      xx += d * d;
      yy += m * m;
    }
    const c = xx > 0 && yy > 0 ? Math.abs(xy) / Math.sqrt(xx * yy) : 0;
    if (c > best) {
      best = c;
      bestLagAt = lag;
    }
  }
  return { corr: best, lag: bestLagAt };
}

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function summarizeBleed(samples: { corr: number; lagMs: number }[]): BleedStats | undefined {
  if (samples.length === 0) return undefined;
  const lagMs = median(samples.map((s) => s.lagMs));
  return {
    windows: samples.length,
    medianCorr: median(samples.map((s) => s.corr)),
    medianLagMs: lagMs,
    lagConsistency: samples.filter((s) => Math.abs(s.lagMs - lagMs) <= 10).length / samples.length,
  };
}

interface Probe {
  role: ProbeRole;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  time: Float32Array;
  freq: Float32Array;
  stats: InputStats;
  hadSignal: boolean;
  bucket: { t: number; sum: number; n: number; peak: number; clipped: number } | null;
  lastRmsDb: number;
}

export interface DiagnosticsInput {
  role: ProbeRole;
  stream: MediaStream;
}

function settingsOf(stream: MediaStream): InputSettings {
  const track = stream.getAudioTracks()[0];
  if (!track) return {};
  const s = (track.getSettings?.() ?? {}) as MediaTrackSettings;
  return {
    label: track.label || undefined,
    sampleRate: s.sampleRate,
    channelCount: s.channelCount,
    echoCancellation: typeof s.echoCancellation === 'boolean' ? s.echoCancellation : undefined,
    autoGainControl: s.autoGainControl,
    noiseSuppression: s.noiseSuppression,
  };
}

function emptyStats(role: ProbeRole, settings: InputSettings): InputStats {
  return {
    role,
    settings,
    polls: 0,
    activePolls: 0,
    wideband4kPolls: 0,
    wideband8kPolls: 0,
    clippedPolls: 0,
    clippedSamples: 0,
    sampledSamples: 0,
    dropoutPolls: 0,
    peakDb: FLOOR_DB,
    timeline: [],
  };
}

async function audioLabels(): Promise<string[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
      .map((d) => `${d.kind === 'audioinput' ? 'in' : 'out'}: ${d.label || d.deviceId.slice(0, 8)}`);
  } catch {
    return [];
  }
}

export class RecordingDiagnosticsCollector {
  private probes: Probe[] = [];
  private ownCtx: AudioContext | null = null;
  private ctx: AudioContext | null = null;
  private sink: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private events: DiagEvent[] = [];
  private bleed: { corr: number; lagMs: number }[] = [];
  private detach: (() => void)[] = [];
  private native: NativeAudioLog | null = null;
  private nativeStarted = false;
  private error: string | undefined;
  private knownDevices: string[] = [];
  private stopped = false;

  constructor(
    private readonly mode: string,
    private readonly startedAt: number,
    private readonly now: () => number = Date.now,
  ) {}

  private atMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  private push(e: DiagEvent): void {
    if (this.events.length < MAX_EVENTS) this.events.push(e);
  }

  /**
   * Start measuring. `ctx`: an AudioContext already reading these streams
   * (the Mic + Device mixer) — reused so no second capture graph is built;
   * otherwise one is created and closed again by `stop()`.
   */
  async start(inputs: DiagnosticsInput[], ctx?: AudioContext | null): Promise<void> {
    void this.startNative();
    this.knownDevices = await audioLabels();
    const onDevices = (): void => {
      void audioLabels().then((now) => {
        const added = now.filter((l) => !this.knownDevices.includes(l));
        const removed = this.knownDevices.filter((l) => !now.includes(l));
        this.knownDevices = now;
        if (added.length || removed.length) {
          this.push({
            atMs: this.atMs(),
            kind: 'devices',
            detail: [added.length ? `Added: ${added.join(', ')}.` : '', removed.length ? `Removed: ${removed.join(', ')}.` : '']
              .filter(Boolean)
              .join(' '),
          });
        }
      });
    };
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', onDevices);
      this.detach.push(() => navigator.mediaDevices?.removeEventListener?.('devicechange', onDevices));
    } catch {
      // No device events in this engine.
    }

    for (const input of inputs) {
      for (const track of input.stream.getAudioTracks()) {
        const label = track.label || input.role;
        const on = (type: 'ended' | 'mute' | 'unmute', kind: DiagEvent['kind'], detail: string) => {
          const h = (): void => this.push({ atMs: this.atMs(), kind, role: input.role, detail });
          track.addEventListener(type, h);
          this.detach.push(() => track.removeEventListener(type, h));
        };
        on('ended', 'ended', `“${label}” ended: unplugged, disconnected, or taken away by the system.`);
        on('mute', 'muted', `“${label}” stopped delivering audio.`);
        on('unmute', 'unmuted', `“${label}” resumed.`);
      }
    }

    try {
      const context = ctx ?? new AudioContext();
      if (!ctx) this.ownCtx = context;
      this.ctx = context;
      // Analysers are only rendered when connected to the destination: route
      // them into a muted gain so nothing is played back.
      const sink = context.createGain();
      sink.gain.value = 0;
      sink.connect(context.destination);
      this.sink = sink;
      for (const input of inputs) {
        const source = context.createMediaStreamSource(input.stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = FFT_SIZE;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser);
        analyser.connect(sink);
        this.probes.push({
          role: input.role,
          analyser,
          source,
          time: new Float32Array(FFT_SIZE),
          freq: new Float32Array(FFT_SIZE / 2),
          stats: emptyStats(input.role, settingsOf(input.stream)),
          hadSignal: false,
          bucket: null,
          lastRmsDb: FLOOR_DB,
        });
      }
      if (context.state === 'suspended') await context.resume().catch(() => undefined);
      this.timer = setInterval(() => this.poll(), POLL_MS);
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }

  private async startNative(): Promise<void> {
    if (!isDesktopApp()) return;
    try {
      const started = await invokeDesktop<unknown>('native_audio_diag_start');
      this.nativeStarted = started != null;
    } catch {
      this.nativeStarted = false;
    }
  }

  private poll(): void {
    const t = this.atMs() / 1000;
    const sampleRate = this.ctx?.sampleRate ?? 48000;
    for (const p of this.probes) {
      p.analyser.getFloatTimeDomainData(p.time);
      const f = frameStats(p.time);
      const s = p.stats;
      s.polls++;
      s.sampledSamples += p.time.length;
      s.clippedSamples += f.clipped;
      if (f.clipped > 0) s.clippedPolls++;
      if (f.peakDb > s.peakDb) s.peakDb = f.peakDb;
      p.lastRmsDb = f.rmsDb;
      if (f.silent && p.hadSignal) s.dropoutPolls++;
      if (f.rmsDb > ACTIVE_DB) {
        p.hadSignal = true;
        s.activePolls++;
        p.analyser.getFloatFrequencyData(p.freq);
        const binHz = sampleRate / FFT_SIZE;
        if (powerShareAbove(p.freq, binHz, 4000) > 0.0005) s.wideband4kPolls++;
        if (powerShareAbove(p.freq, binHz, 8000) > 0.0001) s.wideband8kPolls++;
      }
      const start = Math.floor(t / BUCKET_S) * BUCKET_S;
      if (!p.bucket || p.bucket.t !== start) {
        this.flushBucket(p);
        p.bucket = { t: start, sum: 0, n: 0, peak: FLOOR_DB, clipped: 0 };
      }
      const b = p.bucket;
      b.sum += 10 ** (f.rmsDb / 10);
      b.n++;
      b.peak = Math.max(b.peak, f.peakDb);
      b.clipped += f.clipped;
    }
    const mic = this.probes.find((p) => p.role === 'microphone');
    const dev = this.probes.find((p) => p.role === 'device');
    if (mic && dev && dev.lastRmsDb > -45 && mic.lastRmsDb > -65 && this.bleed.length < MAX_BLEED_SAMPLES) {
      const rate = sampleRate / DECIMATE;
      const r = bestLag(decimate(mic.time, DECIMATE), decimate(dev.time, DECIMATE), Math.round(MAX_LAG_S * rate));
      this.bleed.push({ corr: r.corr, lagMs: (r.lag / rate) * 1000 });
    }
  }

  private flushBucket(p: Probe): void {
    const b = p.bucket;
    if (!b) return;
    p.stats.timeline.push({
      t: b.t,
      rmsDb: b.n ? Math.round(toDb(Math.sqrt(b.sum / b.n)) * 10) / 10 : FLOOR_DB,
      peakDb: Math.round(b.peak * 10) / 10,
      clipped: b.clipped,
    });
    p.bucket = null;
  }

  /** Current state (for live warnings and periodic saves). */
  report(): RecordingDiagnostics {
    const inputs = this.probes.map((p) => {
      const timeline = [...p.stats.timeline];
      if (p.bucket && p.bucket.n > 0) {
        timeline.push({
          t: p.bucket.t,
          rmsDb: Math.round(toDb(Math.sqrt(p.bucket.sum / p.bucket.n)) * 10) / 10,
          peakDb: Math.round(p.bucket.peak * 10) / 10,
          clipped: p.bucket.clipped,
        });
      }
      return { ...p.stats, settings: { ...p.stats.settings }, timeline };
    });
    const base = {
      version: 1 as const,
      mode: this.mode,
      startedAt: this.startedAt,
      updatedAt: this.now(),
      complete: this.stopped,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
      inputs,
      bleed: summarizeBleed(this.bleed),
      events: [...this.events],
      native: this.native,
      ...(this.error ? { error: this.error } : {}),
    };
    return { ...base, issues: assessDiagnostics(base) };
  }

  /** Pull the sound-server log so far (periodic save; survives a crash). */
  async refreshNative(): Promise<void> {
    if (!this.nativeStarted) return;
    try {
      this.native = (await invokeDesktop<NativeAudioLog | null>('native_audio_diag_peek')) ?? this.native;
    } catch {
      // Keep the last copy.
    }
  }

  /**
   * Stop measuring BEFORE the sources are stopped: the analysers are
   * disconnected (and our own context closed) while the inputs still run.
   */
  async stop(): Promise<RecordingDiagnostics> {
    if (this.stopped) return this.report();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const p of this.probes) this.flushBucket(p);
    this.detach.forEach((d) => d());
    this.detach = [];
    for (const p of this.probes) {
      try {
        p.source.disconnect();
        p.analyser.disconnect();
      } catch {
        // Already gone with the context.
      }
    }
    try {
      this.sink?.disconnect();
    } catch {
      // Already gone.
    }
    const own = this.ownCtx;
    this.ownCtx = null;
    if (own && own.state !== 'closed') await own.close().catch(() => undefined);
    if (this.nativeStarted) {
      try {
        this.native = (await invokeDesktop<NativeAudioLog | null>('native_audio_diag_stop')) ?? this.native;
      } catch {
        // Keep the last peeked copy.
      }
    }
    return this.report();
  }
}
