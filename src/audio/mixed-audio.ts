import type { AudioSource } from './recorder';

/**
 * Mic + Device: several capture sources mixed into ONE mono stream, so the
 * recording is a single file (no separate microphone/device tracks, and so no
 * "Me"/"Others" split in the transcript).
 *
 * The mix runs through Web Audio: each input → a limiter (two full-scale
 * sources summed would clip) → a mono MediaStream destination that the
 * recorder encodes like any single source. When any input ends (mic unplugged,
 * system audio gone) the mixed track is ended too, so the recorder reports the
 * interruption instead of silently recording only half of the meeting.
 */
export class MixedAudioSource implements AudioSource {
  private ctx: AudioContext | null = null;
  private output: MediaStream | null = null;
  private inputStreams: MediaStream[] = [];

  constructor(
    private readonly inputs: AudioSource[],
    private readonly createContext: () => AudioContext = defaultContext,
  ) {}

  async start(): Promise<MediaStream> {
    // Start every input together: getDisplayMedia needs the click's
    // user-gesture token, which a sequential await could outlive.
    const results = await Promise.allSettled(this.inputs.map((s) => s.start()));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) {
      await this.stopInputs();
      throw failed.reason;
    }
    const streams = results.map((r) => (r as PromiseFulfilledResult<MediaStream>).value);
    this.inputStreams = streams;
    try {
      const ctx = this.createContext();
      this.ctx = ctx;
      const dest = ctx.createMediaStreamDestination();
      dest.channelCount = 1;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
      // Limiter: transparent at speech levels, catches peaks when both talk.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.25;
      limiter.connect(dest);
      for (const stream of streams) ctx.createMediaStreamSource(stream).connect(limiter);
      // Keep the graph rendering on engines that only pull nodes reachable
      // from the hardware destination; gain 0 = nothing is played back.
      const silent = ctx.createGain();
      silent.gain.value = 0;
      limiter.connect(silent);
      silent.connect(ctx.destination);
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);

      const out = dest.stream.getAudioTracks()[0];
      if (!out) throw new Error('The microphone and device audio could not be combined.');
      const end = () => {
        if (out.readyState === 'ended') return;
        out.stop();
        // stop() fires no event on the track itself; the recorder listens for it.
        out.dispatchEvent(new Event('ended'));
      };
      for (const stream of streams) {
        stream.getAudioTracks().forEach((t) => t.addEventListener('ended', end));
      }
      this.output = dest.stream;
      return dest.stream;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** The mixed stream being recorded (null before start / after stop). */
  currentStream(): MediaStream | null {
    return this.output;
  }

  /** The mix graph and its input streams (same order as `inputs`), for diagnostics. */
  graph(): { ctx: AudioContext; inputs: MediaStream[] } | null {
    return this.ctx ? { ctx: this.ctx, inputs: [...this.inputStreams] } : null;
  }

  async stop(): Promise<void> {
    this.inputStreams = [];
    this.output?.getTracks().forEach((t) => t.stop());
    this.output = null;
    const ctx = this.ctx;
    this.ctx = null;
    // Graph first, inputs second: the mix must stop pulling from the capture
    // pipelines before they are torn down (WebKitGTK/GStreamer).
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined);
    await this.stopInputs();
  }

  private async stopInputs(): Promise<void> {
    await Promise.all(this.inputs.map((s) => s.stop().catch(() => undefined)));
  }
}

function defaultContext(): AudioContext {
  // 48 kHz matches the capture rate (no extra resample before Opus).
  try {
    return new AudioContext({ sampleRate: 48000 });
  } catch {
    return new AudioContext();
  }
}
