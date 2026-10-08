import type { RecordingDiagnostics } from './audio-diagnostics';
import type { MeetingAgenda } from './agenda';
import type { StopStep } from './stop-trace';

export type RecordingMode = 'speaker' | 'device' | 'dual' | 'file';

/** Track identifiers written under `meetings/{id}/{track}/`. '' = single-track (legacy flat layout). */
export type TrackId = '' | 'microphone' | 'device';

/** Track layout of two-way recordings made before Mic + Device was mixed into one track (still readable). */
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
 * Speaker attribution for a legacy two-track recording (new Mic + Device
 * recordings are mixed into one track and get none). With mic and device captured on
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
  /** How the current transcript was made: live while recording (a preview
   * from a small/fast model) or from the whole recording. Absent on older meetings. */
  transcriptSource?: { kind: 'live' | 'file'; model: string; createdAt: number };
  /** Set when a crash/interrupt leaves endedAt undefined. */
  unfinished?: boolean;
  /** Audio chunks that could not be written to storage (§19): the saved
   * recording has gaps. Absent/0 when everything was stored. */
  unsavedChunks?: number;
  /** True when durationMs was estimated from recovered chunks (§15). */
  durationEstimated?: boolean;
  /** Last GitLab upload of this transcript, if any. */
  gitlab?: { url: string; target: string; uploadedAt: number };
  /** Last GitLab summary upload of this meeting, if any. */
  gitlabSummary?: { url: string; target: string; uploadedAt: number };
  /** Planned topics (written before or after recording). */
  agenda?: MeetingAgenda;
  /** Last GitLab agenda upload of this meeting, if any. */
  gitlabAgenda?: { url: string; target: string; uploadedAt: number };
  /** GitLab issues created from the summary's action items (newest last). */
  gitlabActionIssues?: { item: string; url: string; iid?: number; assignee?: string; createdAt: number }[];
  /** LLM summary; `sessionId` = Claude Code session that produced it. */
  summary?: {
    text: string;
    keyPoints: string[];
    actionItems?: string[];
    model: string;
    createdAt: number;
    sessionId?: string;
  };
  /** Audio health measured while recording (see audio-diagnostics.ts). */
  diagnostics?: RecordingDiagnostics;
  /** How long each step of Stop took (see stop-trace.ts). */
  stopTrace?: { steps: StopStep[]; totalMs: number };
  /** Last calendar event created from this meeting, if any. */
  calendarEvent?: { provider: string; createdAt: number };
  /** Every calendar event created from this meeting (newest last). */
  calendarEvents?: CalendarEventRecord[];
}

/** One calendar event created (after user approval) from a meeting summary. */
export interface CalendarEventRecord {
  uid: string;
  provider: string;
  title: string;
  startIso: string;
  createdAt: number;
  /** The summary action item this event was created for (absent = custom event). */
  item?: string;
}

/** MediaRecorder timeslice: every stored chunk holds about this much audio. */
export const CHUNK_MS = 5000;

/** Approximate recorded length from stored chunk counts (longest track). */
export function estimateDurationFromChunks(chunkCounts: number[]): number {
  return Math.max(0, ...chunkCounts) * CHUNK_MS;
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
