import type { ASREngine, TranscribeOptions } from './engine';
import { toTranscriptSegments } from './engine';
import { invokeDesktop } from '../platform/desktop';
import { bytesToBase64, encodeWav16 } from './wav';
import { NATIVE_DEFAULT_MODEL } from './model-manager';
import type { NativeAsrStatus, NativeModelInfo, NativeSegment } from './native-types';
import type { TranscriptSegment } from '../domain/transcript';
import { preprocessForASR } from './preprocess';
import { assembleChunk, planSpeechChunks } from './chunking';
import type { SpeechChunk } from './chunking';

/**
 * Window size for the IPC hand-off. A whole long meeting as base64 would be
 * hundreds of MB of JSON, so we ship bounded 10-minute WAVs (≈25 MB base64) and
 * stitch the timestamps. whisper itself still seeks internally within a window.
 */
export const NATIVE_WINDOW_SECONDS = 600;
const NATIVE_SAMPLE_RATE = 16000;
const SEPARATOR = /^\s*$/;

/** Backends that print one plain transcript per file, without timestamps. */
const TEXT_ONLY_BACKENDS = new Set(['voxtype']);

/**
 * How the recording is cut before it crosses the IPC boundary.
 *  - 'windows': fixed 10-minute windows; the backend (whisper-cli) returns its
 *    own timestamped segments, which are offset onto the recording timeline.
 *  - 'speech': speech-only chunks of ≤28 s, cut at pauses with long silences
 *    removed (see chunking.ts); each chunk becomes one segment spanning its
 *    real start/end. Used for text-only backends (voxtype).
 */
export type NativeChunkMode = 'windows' | 'speech';

export function chunkModeForBackend(backend: string | undefined): NativeChunkMode {
  return backend && TEXT_ONLY_BACKENDS.has(backend) ? 'speech' : 'windows';
}

/** Fixed-size windows covering the whole recording. */
export function planWindows(length: number, windowSamples: number): SpeechChunk[] {
  const out: SpeechChunk[] = [];
  for (let from = 0; from < length; from += windowSamples) {
    const end = Math.min(length, from + windowSamples);
    out.push({ start: from, end, parts: [{ start: from, end }] });
  }
  return out;
}

/** Query the desktop backend: which CLI is available, accel, and models. */
export async function nativeStatus(): Promise<NativeAsrStatus> {
  return invokeDesktop<NativeAsrStatus>('native_asr_status');
}

export async function nativeModels(): Promise<NativeModelInfo[]> {
  return invokeDesktop<NativeModelInfo[]>('native_asr_models');
}

/** Download a model through the backend (voxtype, or a direct ggml download). */
export async function nativeDownloadModel(name: string): Promise<void> {
  await invokeDesktop('native_asr_download_model', { name });
}

/** Enable GPU acceleration (may open a system password prompt). */
export async function nativeEnableGpu(): Promise<string> {
  return invokeDesktop<string>('native_asr_enable_gpu');
}

/**
 * Desktop ASR engine: decodes nothing itself (the service already produced
 * 16 kHz mono Float32) and delegates recognition to the native CLI via Tauri
 * IPC. Supports the larger native-only models and true language auto-detection.
 */
export class NativeASREngine implements ASREngine {
  private modelId: string = NATIVE_DEFAULT_MODEL;
  private cancelled = false;
  private mode: NativeChunkMode = 'windows';

  async initialize(modelId: string, onProgress?: (ratio: number) => void): Promise<void> {
    this.modelId = modelId || NATIVE_DEFAULT_MODEL;
    this.cancelled = false;
    onProgress?.(0.2);
    // Verify the native side is reachable; the CLI loads the model per call.
    const status = await nativeStatus();
    if (!status.available) {
      throw new Error(
        status.installHint ??
          'No desktop transcription engine found. Install whisper.cpp (whisper-cli) or voxtype.',
      );
    }
    this.mode = chunkModeForBackend(status.backend);
    onProgress?.(1);
  }

  async transcribe(
    audio: Float32Array,
    meetingId: string,
    onProgress?: (ratio: number) => void,
    options?: TranscribeOptions,
  ): Promise<TranscriptSegment[]> {
    this.cancelled = false;
    // Same preprocessing the dev bench measures: lift quiet mics, damp hiss.
    const pre = preprocessForASR(audio);
    if (pre.empty) {
      onProgress?.(1);
      return [];
    }
    const samples = pre.audio;
    const chunks =
      this.mode === 'speech'
        ? planSpeechChunks(samples, NATIVE_SAMPLE_RATE)
        : planWindows(samples.length, NATIVE_WINDOW_SECONDS * NATIVE_SAMPLE_RATE);
    const speech = this.mode === 'speech';
    const payloads = chunks.map((c) => (speech ? assembleChunk(samples, c, NATIVE_SAMPLE_RATE) : null));
    // Progress by audio actually sent, so it moves smoothly and skipped
    // silence costs nothing.
    const sentLength = (i: number) => payloads[i]?.length ?? chunks[i]!.end - chunks[i]!.start;
    const totalSamples = chunks.reduce((n, _c, i) => n + sentLength(i), 0);
    let doneSamples = 0;
    const raw: { startMs: number; endMs: number; text: string }[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (this.cancelled) throw new Error('Transcription cancelled');
      const slice = payloads[i] ?? samples.subarray(chunk.start, chunk.end);
      const samplesBase64 = bytesToBase64(encodeWav16(slice, NATIVE_SAMPLE_RATE));
      const segments = await invokeDesktop<NativeSegment[]>('native_asr_transcribe', {
        request: {
          samplesBase64,
          sampleRate: NATIVE_SAMPLE_RATE,
          model: this.modelId,
          language: options?.language,
        },
      });
      if (this.cancelled) throw new Error('Transcription cancelled');
      const offsetMs = (chunk.start / NATIVE_SAMPLE_RATE) * 1000;
      const chunkEndMs = (chunk.end / NATIVE_SAMPLE_RATE) * 1000;
      const texts = segments.filter((s) => s.text !== undefined && !SEPARATOR.test(s.text));
      if (speech) {
        // Silence was cut out of what we sent, so backend times don't map back;
        // the chunk's own span on the recording is the honest timestamp.
        const text = texts.map((s) => s.text.trim()).join(' ');
        if (text) raw.push({ startMs: offsetMs, endMs: chunkEndMs, text });
      } else {
        for (const s of texts) {
          raw.push({
            startMs: s.startMs + offsetMs,
            endMs: Math.min(s.endMs + offsetMs, chunkEndMs),
            text: s.text.trim(),
          });
        }
      }
      doneSamples += sentLength(i);
      onProgress?.(totalSamples > 0 ? doneSamples / totalSamples : 1);
    }
    onProgress?.(1);

    return toTranscriptSegments(meetingId, raw);
  }

  cancel(): void {
    this.cancelled = true;
    // Kill the in-flight CLI process on the native side (best effort).
    void invokeDesktop('native_asr_cancel').catch(() => undefined);
  }

  async dispose(): Promise<void> {
    // Per-call processes; nothing to release.
  }
}
