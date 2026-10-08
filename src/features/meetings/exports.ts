import { fileExtensionForMimeType } from '../../audio/formats';
import type { Meeting } from '../../domain/meeting';
import { getMeeting } from '../../storage/meetings';
import { getSegments } from '../../storage/transcripts';
import { deleteRecording, readRecordingBlob } from '../../storage/recordings';
import { deleteMeetingRecord } from '../../storage/meetings';
import { deleteSegments } from '../../storage/transcripts';
import { segmentsToJSON, segmentsToMarkdown, segmentsToText } from '../../domain/transcript';
import { agendaDocument } from '../../domain/agenda';
import { invokeDesktop, invokeDesktopRaw, isDesktopApp } from '../../platform/desktop';

/** Where an export went: a path on disk (desktop), or null (browser download). */
export type ExportResult = string | null;

/**
 * Save one export. The desktop webviews do not save `<a download>` blob links
 * (the click does nothing), so there the shell writes the file to the
 * Downloads folder (`native_export_file`) and returns its path. In a browser
 * the usual download is used.
 */
export async function saveExport(filename: string, blob: Blob): Promise<ExportResult> {
  if (isDesktopApp()) {
    return invokeDesktopRaw<string>('native_export_file', new Uint8Array(await blob.arrayBuffer()), {
      'x-file-name': encodeURIComponent(filename),
    });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return null;
}

/** Show an exported file in the system file manager (desktop). */
export async function revealExport(path: string): Promise<void> {
  await invokeDesktop('native_reveal_export', { path });
}

function saveText(filename: string, text: string, mime: string): Promise<ExportResult> {
  return saveExport(filename, new Blob([text], { type: mime }));
}

export async function exportTranscript(meetingId: string, format: 'txt' | 'md' | 'json'): Promise<ExportResult> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  const segments = await getSegments(meetingId);
  const base = (meeting.title || 'meeting').replace(/[^\w\-]+/g, '-');
  // The agenda (if any) is part of every transcript export.
  const agenda = meeting.agenda?.items ?? [];
  if (format === 'txt') return saveText(`${base}.txt`, segmentsToText(segments, agenda), 'text/plain');
  if (format === 'md')
    return saveText(`${base}.md`, segmentsToMarkdown(meeting.title, meeting.startedAt, segments, agenda), 'text/markdown');
  return saveText(`${base}.json`, segmentsToJSON(meetingId, meeting.title, segments, agenda), 'application/json');
}

/** Agenda on its own, as Markdown. */
export async function exportAgenda(meeting: Meeting): Promise<ExportResult> {
  const items = meeting.agenda?.items ?? [];
  if (items.length === 0) throw new Error('This meeting has no agenda yet');
  const base = (meeting.title || 'meeting').replace(/[^\w\-]+/g, '-');
  return saveText(`${base}-agenda.md`, agendaDocument(meeting.title, meeting.startedAt, items), 'text/markdown');
}

export async function exportAudio(meeting: Meeting): Promise<ExportResult[]> {
  const ext = fileExtensionForMimeType(meeting.mimeType);
  const base = (meeting.title || 'meeting').replace(/[^\w\-]+/g, '-');
  // Two-way recordings export one file per track (mic and device are distinct
  // WebM streams and cannot be concatenated into a single playable file).
  const tracks = meeting.tracks?.length ? meeting.tracks : [''];
  const saved: ExportResult[] = [];
  for (const track of tracks) {
    const blob = await readRecordingBlob(meeting.id, meeting.mimeType, track);
    if (!blob) continue;
    saved.push(await saveExport(track ? `${base}-${track}.${ext}` : `${base}.${ext}`, blob));
  }
  if (saved.length === 0) throw new Error('Recording audio not found');
  return saved;
}

/** Delete meeting: IndexedDB metadata + segments AND all OPFS chunks (§23). */
export async function deleteMeetingEverywhere(meetingId: string): Promise<void> {
  await deleteSegments(meetingId);
  await deleteMeetingRecord(meetingId);
  await deleteRecording(meetingId);
}
