import { fileExtensionForMimeType } from '../../audio/formats';
import type { Meeting } from '../../domain/meeting';
import { segmentsToJSON, segmentsToMarkdown, segmentsToText } from '../../domain/transcript';
import { agendaDocument, agendaToJSON } from '../../domain/agenda';
import { readRecordingBlob } from '../../storage/recordings';
import { getSegments } from '../../storage/transcripts';
import { diskFileSize, saveBlobToDisk, saveFileToDisk } from '../../platform/desktop-storage';
import { Mp4StreamRepair } from '../../audio/mp4-repair';

const encoder = new TextEncoder();

/** `"Weekly planning-1a2b3c4d"` — readable, collision-proof enough. */
function folderName(meeting: Pick<Meeting, 'id' | 'title'>): string {
  const base =
    (meeting.title || 'meeting')
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'meeting';
  return `${base}-${meeting.id.slice(-8)}`;
}

/** Where a recording's audio goes in the meeting folder (relative path). */
export function audioMirrorPath(meeting: Pick<Meeting, 'id' | 'title'>, mimeType: string, track = ''): string {
  return `${folderName(meeting)}/${audioName(track, mimeType)}`;
}

function audioName(track: string, mimeType: string): string {
  const ext = fileExtensionForMimeType(mimeType);
  return track ? `${track}.${ext}` : `audio.${ext}`;
}

/**
 * How a mirror handles the audio files:
 *  - 'if-missing': copy only tracks not on disk yet (the default — audio never
 *    changes after recording, so transcript/agenda updates skip it)
 *  - 'copy': always (re)write them
 *  - 'skip': leave them alone (the live mirror already wrote them)
 */
export type MirrorAudio = 'if-missing' | 'copy' | 'skip';

/**
 * Mirror a meeting's audio tracks and transcripts into the desktop storage
 * folder. Returns the absolute paths written. Throws only on I/O failure —
 * callers treat this as best-effort.
 */
export async function mirrorMeetingToDisk(
  meeting: Meeting,
  audio: MirrorAudio = 'if-missing',
): Promise<string[]> {
  const folder = folderName(meeting);
  const written: string[] = [];
  const tracks = meeting.tracks?.length ? meeting.tracks : [''];

  for (const track of audio === 'skip' ? [] : tracks) {
    const path = `${folder}/${audioName(track, meeting.mimeType)}`;
    if (audio === 'if-missing' && ((await diskFileSize(path).catch(() => null)) ?? 0) > 0) continue;
    const blob = await readRecordingBlob(meeting.id, meeting.mimeType, track);
    if (!blob) continue;
    written.push(await saveBlobToDisk(path, blob));
  }

  const agenda = meeting.agenda?.items ?? [];
  if (agenda.length > 0) {
    written.push(
      await saveFileToDisk(
        `${folder}/agenda.md`,
        encoder.encode(agendaDocument(meeting.title, meeting.startedAt, agenda)),
      ),
    );
  }

  const segments = await getSegments(meeting.id);
  written.push(
    await saveFileToDisk(`${folder}/transcript.txt`, encoder.encode(segmentsToText(segments, agenda))),
  );
  if (segments.length > 0) {
    written.push(
      await saveFileToDisk(
        `${folder}/transcript.md`,
        encoder.encode(segmentsToMarkdown(meeting.title, meeting.startedAt, segments, agenda)),
      ),
    );
    written.push(
      await saveFileToDisk(
        `${folder}/transcript.json`,
        encoder.encode(segmentsToJSON(meeting.id, meeting.title, segments, agenda)),
      ),
    );
  }

  if (meeting.diagnostics) {
    written.push(
      await saveFileToDisk(
        `${folder}/diagnostics.json`,
        encoder.encode(JSON.stringify(meeting.diagnostics, null, 2)),
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
            ...(agenda.length ? { agenda: agendaToJSON(agenda) } : {}),
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

/**
 * Writes a recording's audio into the desktop storage folder while it is being
 * recorded: every chunk is appended as it arrives (serialised, in order), so
 * stopping does not have to copy the whole recording at once. MP4 recordings
 * are repaired on the fly (Mp4StreamRepair) like readRecordingBlob does.
 * Best-effort: a failed write marks the mirror incomplete, and `finish()`
 * returning false tells the caller to copy the audio from storage instead.
 */
export class LiveAudioMirror {
  private queue: Promise<void> = Promise.resolve();
  private failed = false;
  private readonly files = new Map<string, { path: string; repair: Mp4StreamRepair | null; written: boolean }>();

  constructor(private readonly meeting: Pick<Meeting, 'id' | 'title'>) {}

  push(track: string, mimeType: string, data: Blob): void {
    let file = this.files.get(track);
    if (!file) {
      file = {
        path: `${folderName(this.meeting)}/${audioName(track, mimeType)}`,
        repair: mimeType.includes('mp4') ? new Mp4StreamRepair() : null,
        written: false,
      };
      this.files.set(track, file);
    }
    const target = file;
    this.enqueue(async () => {
      const raw = new Uint8Array(await data.arrayBuffer());
      await this.write(target, target.repair ? target.repair.push(raw) : raw);
    });
  }

  /** Flush and wait for every write. True when the audio on disk is complete. */
  async finish(): Promise<boolean> {
    for (const file of this.files.values()) {
      const target = file;
      this.enqueue(() => this.write(target, target.repair?.end() ?? new Uint8Array(0)));
    }
    await this.queue;
    return !this.failed && this.files.size > 0 && [...this.files.values()].every((f) => f.written);
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      try {
        await task();
      } catch {
        this.failed = true;
      }
    });
  }

  private async write(
    file: { path: string; written: boolean },
    bytes: Uint8Array,
  ): Promise<void> {
    if (bytes.length === 0) return;
    // The first write replaces any stale file; the rest append.
    await saveFileToDisk(file.path, bytes, file.written);
    file.written = true;
  }
}
