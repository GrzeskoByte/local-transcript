import { chunkFileName } from '../../audio/formats';
import type { Meeting } from '../../domain/meeting';
import { newMeetingId } from '../../domain/meeting';
import { saveMeeting } from '../../storage/meetings';
import { appendChunk, writeMeta } from '../../storage/recordings';

/** Fallback MIME types for files the browser does not label. */
const EXTENSION_MIME: Record<string, string> = {
  webm: 'audio/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  flac: 'audio/flac',
};

/** Declared `audio/*` wins; otherwise infer from the extension. */
export function audioMimeFor(name: string, declared?: string): string {
  if (declared && declared.startsWith('audio/')) return declared;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return EXTENSION_MIME[ext] ?? 'audio/mpeg';
}

/** Best-effort duration read from the file's metadata (0 when unknown). */
export function measureDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined' || typeof URL?.createObjectURL !== 'function') {
      resolve(0);
      return;
    }
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    let done = false;
    const finish = (ms: number): void => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      audio.removeAttribute('src');
      resolve(Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => finish(audio.duration * 1000);
    audio.onerror = () => finish(0);
    // Some containers never report metadata — don't hang the import.
    window.setTimeout(() => finish(0), 10_000);
    audio.src = url;
  });
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || 'Imported audio';
}

/**
 * Turn an existing audio file into a meeting. Stored as a single flat chunk so
 * playback, export and transcription work through the normal recording path.
 */
export async function importAudioFile(file: File, title?: string): Promise<Meeting> {
  const id = newMeetingId();
  const mimeType = audioMimeFor(file.name, file.type);
  const now = Date.now();
  const durationMs = await measureDuration(file);

  await appendChunk(id, chunkFileName(0, mimeType), file, '');
  await writeMeta(id, { mimeType, startedAt: now });

  const meeting: Meeting = {
    id,
    title: title?.trim() ? title.trim() : titleFromFileName(file.name),
    mode: 'file',
    createdAt: now,
    startedAt: now,
    endedAt: now,
    durationMs,
    audioPath: '',
    mimeType,
    transcriptionStatus: 'not_started',
    unfinished: false,
  };
  await saveMeeting(meeting);
  return meeting;
}
