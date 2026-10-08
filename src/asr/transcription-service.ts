import type { ASREngine, TranscriptionStage } from './engine';
import { NativeASREngine } from './native-engine';
import { getMeeting, updateMeeting } from '../storage/meetings';
import { commitTranscript, getSegments } from '../storage/transcripts';
import { listTracks, readRecordingBlob } from '../storage/recordings';
import { decodeToMono16k } from '../audio/decode';
import { getTranscriptionLanguage, DEFAULT_NATIVE_LANGUAGE } from './model-manager';
import { trackSpeakerLabel } from '../domain/meeting';
import type { TranscriptSegment } from '../domain/transcript';

export interface TranscriptionCallbacks {
  onProgress?: (meetingId: string, ratio: number) => void;
  onStage?: (meetingId: string, stage: TranscriptionStage) => void;
}

/**
 * TranscriptionService (§25). Keeps recording and transcription workflows
 * explicitly separate: only completed recordings, manual trigger, failure
 * never touches the stored audio. The engine is the native desktop CLI;
 * callers may inject a different one for tests.
 */
export class TranscriptionService {
  private createEngine: () => ASREngine;
  private running = new Map<string, { cancel: () => void; done: Promise<void> }>();
  /** Runs are serialized: the native side drives one CLI process at a time,
   * and two large models at once would starve a laptop anyway. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private callbacks: TranscriptionCallbacks = {},
    opts?: { engine?: ASREngine; createEngine?: () => ASREngine },
  ) {
    // One engine per run, so two meetings transcribing at once never share
    // (or dispose) each other's engine state.
    const injected = opts?.engine;
    this.createEngine = opts?.createEngine ?? (injected ? () => injected : () => new NativeASREngine());
  }

  async transcribe(meetingId: string, modelId: string): Promise<void> {
    const meeting = await getMeeting(meetingId);
    if (!meeting) throw new Error('Meeting not found');
    if (meeting.endedAt === undefined) throw new Error('Recording is not completed yet');
    if (this.running.has(meetingId)) return;

    const engine = this.createEngine();
    let cancelled = false;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    this.running.set(meetingId, {
      cancel: () => {
        cancelled = true;
        engine.cancel?.();
      },
      done,
    });

    await updateMeeting(meetingId, { transcriptionStatus: 'processing' });
    const report = (ratio: number) => this.callbacks.onProgress?.(meetingId, ratio);
    const stage = (s: TranscriptionStage) => this.callbacks.onStage?.(meetingId, s);
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => (release = resolve));
    try {
      stage('queued');
      await previous;
      if (cancelled) throw new Error('Transcription cancelled');
      stage('loading-model');
      await engine.initialize(modelId, (ratio) => report(ratio * 0.15));
      // Two-way recordings store mic and device audio as separate tracks. They
      // start together, so each track's timestamps share one timeline; we
      // transcribe each independently (track = speaker) and merge by time.
      const tracks = await listTracks(meetingId);
      if (tracks.length === 0) throw new Error('Recording audio not found');
      const language = await getTranscriptionLanguage().catch(() => DEFAULT_NATIVE_LANGUAGE);
      const collected: TranscriptSegment[] = [];
      const span = 0.8 / tracks.length;
      for (let ti = 0; ti < tracks.length; ti++) {
        if (cancelled) throw new Error('Transcription cancelled');
        const track = tracks[ti]!;
        const base = 0.15 + ti * span;
        stage('decoding-audio');
        const blob = await readRecordingBlob(meetingId, meeting.mimeType, track);
        if (!blob) continue;
        if (cancelled) throw new Error('Transcription cancelled');
        const audio = await decodeToMono16k(blob, (r) => report(base + r * span * 0.2));
        if (cancelled) throw new Error('Transcription cancelled');
        stage('transcribing');
        const segments = await engine.transcribe(
          audio,
          meetingId,
          (r) => report(base + span * 0.2 + r * span * 0.8),
          { language },
        );
        if (cancelled) throw new Error('Transcription cancelled');
        const speaker = trackSpeakerLabel(track);
        for (const s of segments) collected.push(speaker ? { ...s, speaker } : s);
      }
      stage('saving');
      collected.sort((a, b) => a.startMs - b.startMs);
      const merged = collected.map((s, i) => ({
        ...s,
        id: `${meetingId}-seg-${i}`,
        sequence: i,
      }));
      // Atomic, and a no-op if the meeting was deleted while we worked.
      await commitTranscript(meetingId, merged, {
        transcriptSource: { kind: 'file', model: modelId, createdAt: Date.now() },
        transcriptionError: undefined,
      });
      this.callbacks.onProgress?.(meetingId, 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.toLowerCase().includes('cancel')) {
        const prev = (await getSegments(meetingId)).length > 0 ? 'completed' : 'not_started';
        await updateMeeting(meetingId, { transcriptionStatus: prev });
      } else {
        // The reason is kept: Meeting Detail shows it (also after a restart).
        await updateMeeting(meetingId, { transcriptionStatus: 'failed', transcriptionError: msg.slice(0, 500) });
      }
      throw err;
    } finally {
      this.running.delete(meetingId);
      await engine.dispose().catch(() => undefined);
      release();
      finished();
    }
  }

  async cancel(meetingId: string): Promise<void> {
    this.running.get(meetingId)?.cancel();
  }

  /** Cancel a run and resolve once it has fully stopped writing. */
  async cancelAndWait(meetingId: string): Promise<void> {
    const run = this.running.get(meetingId);
    if (!run) return;
    run.cancel();
    await run.done;
  }

  isRunning(meetingId: string): boolean {
    return this.running.has(meetingId);
  }
}
