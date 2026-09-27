export type RecordingMode = 'speaker' | 'device' | 'dual' | 'file';

/** Track identifiers written under `meetings/{id}/{track}/`. '' = single-track (legacy flat layout). */
export type TrackId = '' | 'microphone' | 'device';

export const DUAL_TRACKS: TrackId[] = ['microphone', 'device'];

export const MODE_LABELS: Record<RecordingMode, string> = {
  speaker: 'Speaker',
  device: 'Device Audio',
  dual: 'Mic + Device',
  file: 'Imported audio',
};

export function modeLabel(mode: RecordingMode): string {
  return MODE_LABELS[mode] ?? 'Speaker';
}

/**
 * Speaker attribution for a two-way recording. With mic and device captured on
 * separate tracks, the track *is* the speaker — no diarization model needed.
 * Returns undefined for single-track recordings (no attribution available).
 */
export function trackSpeakerLabel(track: TrackId | string): string | undefined {
  if (track === 'microphone') return 'Me';
  if (track === 'device') return 'Others';
  return undefined;
}

export type TranscriptionStatus =
  | 'not_started'
  | 'processing'
  | 'completed'
  | 'failed';

export type RecordingState =
  | 'IDLE'
  | 'STARTING'
  | 'RECORDING'
  | 'PAUSED'
  | 'STOPPING'
  | 'COMPLETED'
  | 'ERROR';

export interface Meeting {
  id: string;
  title: string;
  mode: RecordingMode;
  createdAt: number;
  startedAt: number;
  endedAt?: number;
  durationMs: number;
  /** OPFS directory: meetings/{id}. Single-track: chunks at 000001.webm.
   * Two-way: chunks under meetings/{id}/{microphone|device}/. + meta.json */
  audioPath: string;
  mimeType: string;
  /** Track ids when recorded two-way; undefined for single-track recordings. */
  tracks?: string[];
  transcriptionStatus: TranscriptionStatus;
  /** Set when a crash/interrupt leaves endedAt undefined. */
  unfinished?: boolean;
  /** Last GitLab upload of this transcript, if any. */
  gitlab?: { url: string; target: string; uploadedAt: number };
}

export function newMeetingId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatTimestamp(t: number): string {
  const totalSec = Math.floor(t / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export { formatTimestamp as formatSegmentTime };
