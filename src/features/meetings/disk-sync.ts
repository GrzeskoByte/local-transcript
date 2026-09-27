import type { Meeting } from '../../domain/meeting';
import { segmentsToJSON, segmentsToMarkdown, segmentsToText } from '../../domain/transcript';
import { readRecordingBlob } from '../../storage/recordings';
import { getSegments } from '../../storage/transcripts';
import { saveFileToDisk } from '../../platform/desktop-storage';

const encoder = new TextEncoder();

/** `"Weekly planning-1a2b3c4d"` — readable, collision-proof enough. */
function folderName(meeting: Meeting): string {
  const base =
    (meeting.title || 'meeting')
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'meeting';
  return `${base}-${meeting.id.slice(-8)}`;
}

function audioName(track: string, mimeType: string): string {
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  return track ? `${track}.${ext}` : `audio.${ext}`;
}

/**
 * Mirror a meeting's audio tracks and transcripts into the desktop storage
 * folder. Returns the absolute paths written. Throws only on I/O failure —
 * callers treat this as best-effort.
 */
export async function mirrorMeetingToDisk(meeting: Meeting): Promise<string[]> {
  const folder = folderName(meeting);
  const written: string[] = [];
  const tracks = meeting.tracks?.length ? meeting.tracks : [''];

  for (const track of tracks) {
    const blob = await readRecordingBlob(meeting.id, meeting.mimeType, track);
    if (!blob) continue;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    written.push(await saveFileToDisk(`${folder}/${audioName(track, meeting.mimeType)}`, bytes));
  }

  const segments = await getSegments(meeting.id);
  written.push(
    await saveFileToDisk(`${folder}/transcript.txt`, encoder.encode(segmentsToText(segments))),
  );
  if (segments.length > 0) {
    written.push(
      await saveFileToDisk(
        `${folder}/transcript.md`,
        encoder.encode(segmentsToMarkdown(meeting.title, meeting.startedAt, segments)),
      ),
    );
    written.push(
      await saveFileToDisk(
        `${folder}/transcript.json`,
        encoder.encode(segmentsToJSON(meeting.id, meeting.title, segments)),
      ),
    );
  }

  written.push(
    await saveFileToDisk(
      `${folder}/meeting.json`,
      encoder.encode(
        JSON.stringify(
          {
            id: meeting.id,
            title: meeting.title,
            mode: meeting.mode,
            startedAt: meeting.startedAt,
            endedAt: meeting.endedAt ?? null,
            durationMs: meeting.durationMs ?? null,
            mimeType: meeting.mimeType,
            tracks,
            transcriptionStatus: meeting.transcriptionStatus,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      ),
    ),
  );

  return written;
}
