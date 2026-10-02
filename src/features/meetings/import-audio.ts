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

/**
 * Best-effort duration (0 when unknown). Decoded with Web Audio at a low rate
 * rather than read by an <audio> element: in the AppImage each <audio> is a
 * GStreamer playbin whose teardown can deadlock the page (see audio/player.ts).
 */
export async function measureDuration(blob: Blob): Promise<number> {
  if (typeof OfflineAudioContext === 'undefined') return 0;
  try {
    const ctx = new OfflineAudioContext(1, 1, 8000);
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const ms = buffer.duration * 1000;
    return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  } catch {
    return 0;
  }
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
