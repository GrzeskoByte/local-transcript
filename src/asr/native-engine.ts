import type { ASREngine, TranscribeOptions } from './engine';
import { toTranscriptSegments } from './engine';
import { invokeDesktop } from '../platform/desktop';
import { bytesToBase64, encodeWav16 } from './wav';
import { NATIVE_DEFAULT_MODEL } from './model-manager';
import type { NativeAsrStatus, NativeModelInfo, NativeSegment } from './native-types';
import type { TranscriptSegment } from '../domain/transcript';

/**
 * Window size for the IPC hand-off. A whole long meeting as base64 would be
 * hundreds of MB of JSON, so we ship bounded 10-minute WAVs (≈25 MB base64) and
 * stitch the timestamps. whisper itself still seeks internally within a window.
 */
export const NATIVE_WINDOW_SECONDS = 600;
const NATIVE_SAMPLE_RATE = 16000;
const SEPARATOR = /^\s*$/;

/** Query the desktop backend: which CLI is available, accel, and models. */
export async function nativeStatus(): Promise<NativeAsrStatus> {
  return invokeDesktop<NativeAsrStatus>('native_asr_status');
}

export async function nativeModels(): Promise<NativeModelInfo[]> {
  return invokeDesktop<NativeModelInfo[]>('native_asr_models');
}

/** Download a model through the backend (`voxtype setup --download`). */
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
    onProgress?.(1);
  }

  async transcribe(
    audio: Float32Array,
    meetingId: string,
    onProgress?: (ratio: number) => void,
    options?: TranscribeOptions,
  ): Promise<TranscriptSegment[]> {
    this.cancelled = false;
    if (audio.length === 0) {
      onProgress?.(1);
      return [];
    }
    const windowSamples = NATIVE_WINDOW_SECONDS * NATIVE_SAMPLE_RATE;
    const windows = Math.max(1, Math.ceil(audio.length / windowSamples));
    const raw: { startMs: number; endMs: number; text: string }[] = [];

    for (let w = 0; w < windows; w++) {
      if (this.cancelled) throw new Error('Transcription cancelled');
      const from = w * windowSamples;
      const slice = audio.subarray(from, Math.min(audio.length, from + windowSamples));
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
      const offsetMs = (from / NATIVE_SAMPLE_RATE) * 1000;
      for (const s of segments) {
        if (s.text === undefined || SEPARATOR.test(s.text)) continue;
        raw.push({
          startMs: s.startMs + offsetMs,
          endMs: s.endMs + offsetMs,
          text: s.text.trim(),
        });
      }
      onProgress?.((w + 1) / windows);
    }

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
