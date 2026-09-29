import type { TranscriptSegment } from '../domain/transcript';

/** ASR boundary (§12). App code depends on this, never on a concrete runtime. */
export interface TranscribeOptions {
  /** Whisper language pin (e.g. 'english'). Required for multilingual models:
   * transformers.js has no language detection and assumes English otherwise. */
  language?: string;
}

export interface ASREngine {
  initialize(modelId: string, onProgress?: (ratio: number) => void): Promise<void>;
  transcribe(
    audio: Float32Array,
    meetingId: string,
    onProgress?: (ratio: number) => void,
    options?: TranscribeOptions,
  ): Promise<TranscriptSegment[]>;
  /** Cooperative cancellation. Optional so simple engines can omit it. */
  cancel?(): void;
  dispose(): Promise<void>;
}

export type TranscriptionStage =
  | 'queued'
  | 'loading-model'
  | 'decoding-audio'
  | 'transcribing'
  | 'saving';

export interface RawSegment {
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
}

export function toTranscriptSegments(
  meetingId: string,
  raw: RawSegment[],
): TranscriptSegment[] {
  return raw.map((s, i) => ({
    id: `${meetingId}-seg-${i}`,
    meetingId,
    sequence: i,
    startMs: Math.round(s.startMs),
    endMs: Math.round(s.endMs),
    text: s.text,
    confidence: s.confidence,
  }));
}
