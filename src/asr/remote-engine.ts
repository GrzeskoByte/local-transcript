import type { ASREngine, TranscribeOptions } from './engine';
import { toTranscriptSegments } from './engine';
import { encodeWav16 } from './wav';
import { preprocessForASR } from './preprocess';
import { assembleChunk, planSpeechChunks } from './chunking';
import type { TranscriptSegment } from '../domain/transcript';
import { RemoteAsrClient, remoteAsrConfigProblem, type RemoteAsrConfig } from '../integrations/remote-asr';

const SAMPLE_RATE = 16000;
/** Requests in flight at once: keeps a GPU server busy without flooding it. */
export const REMOTE_CONCURRENCY = 3;

/**
 * Whole-file transcription on the user's own server (Open WebUI). Its
 * endpoint returns plain text, so the recording is cut like for voxtype:
 * speech-only chunks of ≤24 s at pauses (silence is never sent, so it cannot
 * hallucinate), one 16 kHz WAV upload per chunk, one segment per chunk
 * spanning its real start/end on the recording.
 */
export class RemoteASREngine implements ASREngine {
  private abort = new AbortController();
  private cancelled = false;

  constructor(private config: RemoteAsrConfig) {}

  async initialize(_modelId: string, onProgress?: (ratio: number) => void): Promise<void> {
    this.cancelled = false;
    this.abort = new AbortController();
    const problem = remoteAsrConfigProblem(this.config);
    if (problem) throw new Error(`Transcription server: ${problem} (Settings → Models).`);
    onProgress?.(1);
  }

  async transcribe(
    audio: Float32Array,
    meetingId: string,
    onProgress?: (ratio: number) => void,
    options?: TranscribeOptions,
  ): Promise<TranscriptSegment[]> {
    const pre = preprocessForASR(audio);
    if (pre.empty) {
      onProgress?.(1);
      return [];
    }
    const samples = pre.audio;
    const chunks = planSpeechChunks(samples, SAMPLE_RATE);
    const client = new RemoteAsrClient(this.config);
    const texts: string[] = new Array<string>(chunks.length).fill('');
    const sizes = chunks.map((c) => c.parts.reduce((n, p) => n + p.end - p.start, 0));
    const total = sizes.reduce((a, b) => a + b, 0);
    let done = 0;
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < chunks.length) {
        if (this.cancelled) throw new Error('Transcription cancelled');
        const i = next++;
        const wav = encodeWav16(assembleChunk(samples, chunks[i]!, SAMPLE_RATE), SAMPLE_RATE);
        texts[i] = await client.transcribeWav(wav, options?.language, this.abort.signal);
        done += sizes[i]!;
        onProgress?.(total > 0 ? done / total : 1);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(REMOTE_CONCURRENCY, chunks.length) }, worker));
    } catch (err) {
      // One failed upload stops the others too.
      this.abort.abort();
      throw this.cancelled ? new Error('Transcription cancelled') : err;
    }
    if (this.cancelled) throw new Error('Transcription cancelled');
    onProgress?.(1);

    const raw = chunks
      .map((c, i) => ({
        startMs: (c.start / SAMPLE_RATE) * 1000,
        endMs: (c.end / SAMPLE_RATE) * 1000,
        text: texts[i]!.trim(),
      }))
      .filter((s) => s.text);
    return toTranscriptSegments(meetingId, raw);
  }

  cancel(): void {
    this.cancelled = true;
    this.abort.abort();
  }

  async dispose(): Promise<void> {
    // Stateless HTTP; nothing to release.
  }
}
