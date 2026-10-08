/**
 * Recording playback without <audio>.
 *
 * In the AppImage (WebKitGTK 2.50 + GStreamer 1.20) every <audio> element is a
 * GStreamer playbin, and tearing one down deadlocks the web process
 * (`gst_pad_stop_task` in wavparse/decodebin on the main thread) until WebKit's
 * watchdog kills it: the app "crashes", typically right after Stop → Meeting
 * Detail. Recorded WebM/MP4 chunks also carry no duration/seek index, so the
 * native timeline could not seek.
 *
 * Instead the recording is decoded once (decodeAudioData — the same decoder
 * transcription uses) into compact mono 16-bit PCM, and played by scheduling
 * short AudioBufferSourceNodes back to back on ONE shared AudioContext that is
 * never closed. Seeking is exact and instant; nothing is torn down mid-stream.
 */

import { decodeOggNative } from './native-decode';
import { resampleFloat, Wsola } from './time-stretch';

/** Decode rate: plenty for speech, half the memory of 48 kHz (~170 MB/hour). */
export const PLAYER_SAMPLE_RATE = 24000;
/** Length of each scheduled slice and how far ahead we keep scheduled. */
const SLICE_S = 2;
const AHEAD_S = 6;
/** Lead time so the first slice is not scheduled in the past. */
const START_LEAD_S = 0.06;

export interface DecodedAudio {
  pcm: Int16Array;
  sampleRate: number;
}

/** Average the channels into mono 16-bit PCM. */
export function toMonoInt16(channels: Float32Array[]): Int16Array {
  const length = channels[0]?.length ?? 0;
  const out = new Int16Array(length);
  const n = channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < n; c++) sum += channels[c]![i]!;
    const v = Math.max(-1, Math.min(1, sum / n));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

/** Decode a recording into mono PCM for playback. */
export async function decodeForPlayback(blob: Blob, rate = PLAYER_SAMPLE_RATE): Promise<DecodedAudio> {
  // Native recordings (Ogg Opus) decode in the desktop shell, at `rate`.
  const native = await decodeOggNative(blob, rate);
  if (native) return { pcm: native, sampleRate: rate };
  const data = await blob.arrayBuffer();
  // decodeAudioData resamples to the context's rate; an offline context avoids
  // opening an output device just to decode.
  const ctx = new OfflineAudioContext(1, 1, rate);
  const buffer = await ctx.decodeAudioData(data);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return { pcm: toMonoInt16(channels), sampleRate: buffer.sampleRate };
}

/**
 * Fill `out` with PCM resampled (linear) from `pcm` at `srcRate`, starting at
 * output frame `outStart` of a stream at `outRate`. Interpolating against the
 * whole recording keeps consecutive slices seamless (no click at boundaries).
 */
export function resampleSlice(
  pcm: Int16Array,
  srcRate: number,
  outRate: number,
  outStart: number,
  out: Float32Array,
): void {
  const step = srcRate / outRate;
  const last = pcm.length - 1;
  for (let j = 0; j < out.length; j++) {
    const pos = (outStart + j) * step;
    const i = Math.floor(pos);
    if (i >= last) {
      out[j] = i === last ? pcm[last]! / 0x8000 : 0;
      continue;
    }
    const frac = pos - i;
    out[j] = (pcm[i]! * (1 - frac) + pcm[i + 1]! * frac) / 0x8000;
  }
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** Peak envelope (0..1) in `bins` buckets, for the waveform overview. */
export function peaks(pcm: Int16Array, bins: number): Float32Array {
  const out = new Float32Array(Math.max(0, bins));
  if (pcm.length === 0 || bins <= 0) return out;
  const per = pcm.length / bins;
  for (let b = 0; b < bins; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(pcm.length, Math.max(from + 1, Math.floor((b + 1) * per)));
    // Sample at most ~256 points per bin: an overview, not a measurement.
    const stride = Math.max(1, Math.floor((to - from) / 256));
    let max = 0;
    for (let i = from; i < to; i += stride) {
      const v = Math.abs(pcm[i]!);
      if (v > max) max = v;
    }
    out[b] = max / 0x8000;
  }
  return out;
}

let shared: AudioContext | null = null;
const playing = new Set<PcmPlayer>();

/**
 * The one playback context. Never closed: closing tears down WebKitGTK's
 * GStreamer sink, the kind of teardown this player exists to avoid.
 */
export function playbackContext(): AudioContext {
  if (!shared || shared.state === 'closed') shared = new AudioContext();
  return shared;
}

export class PcmPlayer {
  private sources = new Set<AudioBufferSourceNode>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isPlaying = false;
  private position = 0;
  /** ctx time at which source frame `anchorFrame` (output-rate units) plays. */
  private anchorTime = 0;
  private anchorFrame = 0;
  /** Output frames scheduled since the anchor. */
  private scheduledOut = 0;
  /** Playback speed; ≠ 1 plays through a pitch-keeping time-stretch. */
  private speed = 1;
  private stretcher: Wsola | null = null;
  private readonly totalFrames: number;
  private readonly outRate: number;

  constructor(
    private readonly audio: DecodedAudio,
    private readonly ctx: AudioContext,
    private readonly onChange: () => void = () => undefined,
  ) {
    this.outRate = ctx.sampleRate;
    this.totalFrames = Math.floor((audio.pcm.length * this.outRate) / audio.sampleRate);
  }

  get duration(): number {
    return this.audio.pcm.length / this.audio.sampleRate;
  }

  get playing(): boolean {
    return this.isPlaying;
  }

  get currentTime(): number {
    if (!this.isPlaying) return this.position;
    const t = this.anchorFrame / this.outRate + (this.ctx.currentTime - this.anchorTime) * this.speed;
    return Math.max(0, Math.min(this.duration, t));
  }

  get rate(): number {
    return this.speed;
  }

  /** Change the speed (0.5–3); keeps the position and keeps playing. */
  setRate(rate: number): void {
    const r = Math.max(0.5, Math.min(3, Number.isFinite(rate) ? rate : 1));
    if (r === this.speed) return;
    if (this.isPlaying) {
      const t = this.currentTime;
      this.stopSources();
      this.speed = r;
      this.anchor(t);
    } else {
      this.speed = r;
    }
    this.onChange();
  }

  get pcm(): Int16Array {
    return this.audio.pcm;
  }

  async play(): Promise<void> {
    if (this.isPlaying) return;
    // Pausing other players: one recording plays at a time.
    for (const p of [...playing]) if (p !== this) p.pause();
    if (this.position >= this.duration - 0.05) this.position = 0;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
    this.isPlaying = true;
    playing.add(this);
    this.anchor(this.position);
    this.timer = setInterval(() => this.tick(), 200);
    this.onChange();
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.position = this.currentTime;
    this.halt();
    this.onChange();
  }

  /** Jump to `seconds`; keeps playing if it was playing. */
  seek(seconds: number): void {
    const t = Math.max(0, Math.min(this.duration, Number.isFinite(seconds) ? seconds : 0));
    this.position = t;
    if (this.isPlaying) {
      this.stopSources();
      this.anchor(t);
    }
    this.onChange();
  }

  dispose(): void {
    this.halt();
  }

  private anchor(seconds: number): void {
    this.anchorFrame = Math.min(this.totalFrames, Math.round(seconds * this.outRate));
    this.anchorTime = this.ctx.currentTime + START_LEAD_S;
    this.scheduledOut = 0;
    this.stretcher =
      this.speed === 1
        ? null
        : new Wsola(this.audio.pcm, this.audio.sampleRate, this.speed, Math.round(seconds * this.audio.sampleRate));
    this.pump();
  }

  private tick(): void {
    if (!this.isPlaying) return;
    if (this.currentTime >= this.duration - 0.01) {
      this.position = this.duration;
      this.halt();
    } else {
      this.pump();
    }
    this.onChange();
  }

  /** Keep AHEAD_S of audio scheduled past the playhead. */
  private pump(): void {
    const elapsedOut = Math.max(0, this.ctx.currentTime - this.anchorTime) * this.outRate;
    const targetOut = elapsedOut + AHEAD_S * this.outRate;
    const sliceFrames = Math.round(SLICE_S * this.outRate);
    while (this.scheduledOut < targetOut) {
      let buffer: AudioBuffer;
      let frames: number;
      if (!this.stretcher) {
        const start = this.anchorFrame + this.scheduledOut;
        frames = Math.min(sliceFrames, this.totalFrames - start);
        if (frames <= 0) break;
        buffer = this.ctx.createBuffer(1, frames, this.outRate);
        resampleSlice(this.audio.pcm, this.audio.sampleRate, this.outRate, start, buffer.getChannelData(0));
      } else {
        const chunk = this.stretcher.next(Math.round((sliceFrames * this.audio.sampleRate) / this.outRate));
        if (chunk.length === 0) break;
        frames = Math.max(1, Math.round((chunk.length * this.outRate) / this.audio.sampleRate));
        buffer = this.ctx.createBuffer(1, frames, this.outRate);
        resampleFloat(chunk, buffer.getChannelData(0));
      }
      const when = this.anchorTime + this.scheduledOut / this.outRate;
      this.scheduledOut += frames;
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      if (when >= now) node.start(when);
      else if (now - when < frames / this.outRate) node.start(now, now - when);
      else {
        node.disconnect();
        continue;
      }
      node.onended = () => {
        this.sources.delete(node);
        node.disconnect();
      };
      this.sources.add(node);
    }
  }

  private stopSources(): void {
    for (const node of this.sources) {
      node.onended = null;
      try {
        node.stop();
      } catch {
        // Already stopped.
      }
      node.disconnect();
    }
    this.sources.clear();
  }

  private halt(): void {
    this.stopSources();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.isPlaying = false;
    playing.delete(this);
    // Idle output: let the sound server release the device (kept open, not closed).
    if (playing.size === 0 && this.ctx.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }
}
