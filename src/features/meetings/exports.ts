import { fileExtensionForMimeType } from '../../audio/formats';
import type { Meeting } from '../../domain/meeting';
import { getMeeting } from '../../storage/meetings';
import { getSegments } from '../../storage/transcripts';
import { deleteRecording, readRecordingBlob } from '../../storage/recordings';
import { deleteMeetingRecord } from '../../storage/meetings';
import { deleteSegments } from '../../storage/transcripts';
import { segmentsToJSON, segmentsToMarkdown, segmentsToText } from '../../domain/transcript';

function downloadTextFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function exportTranscript(meetingId: string, format: 'txt' | 'md' | 'json'): Promise<void> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('Meeting not found');
  const segments = await getSegments(meetingId);
  const base = (meeting.title || 'meeting').replace(/[^\w\-]+/g, '-');
  if (format === 'txt') downloadTextFile(`${base}.txt`, segmentsToText(segments), 'text/plain');
  else if (format === 'md')
    downloadTextFile(`${base}.md`, segmentsToMarkdown(meeting.title, meeting.startedAt, segments), 'text/markdown');
  else downloadTextFile(`${base}.json`, segmentsToJSON(meetingId, meeting.title, segments), 'application/json');
}

export async function exportAudio(meeting: Meeting): Promise<void> {
  const ext = fileExtensionForMimeType(meeting.mimeType);
  const base = (meeting.title || 'meeting').replace(/[^\w\-]+/g, '-');
  // Two-way recordings export one file per track (mic and device are distinct
  // WebM streams and cannot be concatenated into a single playable file).
  const tracks = meeting.tracks?.length ? meeting.tracks : [''];
  let exported = 0;
  for (const track of tracks) {
    const blob = await readRecordingBlob(meeting.id, meeting.mimeType, track);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = track ? `${base}-${track}.${ext}` : `${base}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    exported += 1;
  }
  if (exported === 0) throw new Error('Recording audio not found');
}

/** Delete meeting: IndexedDB metadata + segments AND all OPFS chunks (§23). */
export async function deleteMeetingEverywhere(meetingId: string): Promise<void> {
  await deleteSegments(meetingId);
  await deleteMeetingRecord(meetingId);
  await deleteRecording(meetingId);
}
