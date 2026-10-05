/**
 * Reads the stream being recorded as raw PCM for live transcription.
 *
 * A ScriptProcessorNode (deprecated, but available in every engine the app
 * ships on, WebKitGTK included, and needs no worklet module) copies each
 * block, which is decimated to 16 kHz and handed on. Like the diagnostics
 * tap it reuses the Mic + Device mixer's AudioContext when there is one;
 * otherwise it borrows the shared capture context (never closed). It must be
 * stopped before the capture sources are (WebKitGTK/GStreamer).
 * Best-effort: it never affects the recording.
 */
import { Downsampler, LIVE_SAMPLE_RATE } from '../asr/live-segmenter';
import { acquireCaptureContext, releaseCaptureContext } from './capture-context';

const BLOCK = 4096;

export class LivePcmTap {
  private ctx: AudioContext | null = null;
  private ownCtx = false;
  private nodes: AudioNode[] = [];
  private processor: ScriptProcessorNode | null = null;
  private paused = false;
  private stopped = false;

  constructor(private readonly onAudio: (samples16k: Float32Array) => void) {}

  async start(stream: MediaStream, ctx?: AudioContext | null): Promise<void> {
    const context = ctx ?? acquireCaptureContext();
    this.ownCtx = !ctx;
    this.ctx = context;
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(BLOCK, 1, 1);
    const downsampler = new Downsampler(context.sampleRate, LIVE_SAMPLE_RATE);
    processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (this.paused) return;
      const block = downsampler.push(e.inputBuffer.getChannelData(0));
      if (block.length > 0) this.onAudio(block);
    };
    // Script processors only run when connected to the destination: route
    // through a muted gain so nothing is played back.
    const sink = context.createGain();
    sink.gain.value = 0;
    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);
    this.nodes = [source, processor, sink];
    this.processor = processor;
    if (context.state === 'suspended') await context.resume().catch(() => undefined);
    // Stopped while starting (a very short recording): tear down what was built.
    if (this.stopped) await this.stop();
  }

  /** Paused recording time is not recording time: drop audio meanwhile. */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    if (this.processor) this.processor.onaudioprocess = null;
    this.processor = null;
    this.nodes = [];
    const ctx = this.ctx;
    this.ctx = null;
    // Released, never closed (see capture-context.ts).
    if (ctx && this.ownCtx) releaseCaptureContext(ctx);
  }
}
