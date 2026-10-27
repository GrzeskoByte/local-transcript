import type { TranscriptSegment } from '../domain/transcript';
import type { Meeting } from '../domain/meeting';
import { db } from './database';

const STORE = 'segments';

/**
 * Commit a finished transcript: replace the meeting's segments and mark it
 * completed in ONE transaction — and only if the meeting still exists, so a
 * transcription that outlives a delete never leaves orphan segments (§23).
 * Returns false when the meeting was deleted meanwhile.
 */
export async function commitTranscript(
  meetingId: string,
  segments: TranscriptSegment[],
  patch: Partial<Meeting> = {},
): Promise<boolean> {
  let committed = false;
  await db.transaction(['meetings', STORE], 'readwrite', (t) => {
    const meetings = t.objectStore('meetings');
    const segs = t.objectStore(STORE);
    const req = meetings.get(meetingId);
    req.onsuccess = () => {
      const meeting = req.result as Meeting | undefined;
      if (!meeting) return;
      const keys = segs.index('by-meeting').getAllKeys(meetingId);
      keys.onsuccess = () => {
        for (const k of keys.result) segs.delete(k);
        for (const s of segments) segs.put(s);
        meetings.put({ ...meeting, ...patch, transcriptionStatus: 'completed' });
        committed = true;
      };
    };
  });
  return committed;
}

export async function getSegments(meetingId: string): Promise<TranscriptSegment[]> {
  const rows = await db.getAllByIndex<TranscriptSegment>(STORE, 'by-meeting', meetingId);
  return rows.sort((a, b) => a.sequence - b.sequence);
}

export async function deleteSegments(meetingId: string): Promise<void> {
  const rows = await getSegments(meetingId);
  for (const row of rows) {
    await db.delete(STORE, row.id);
  }
}

/**
 * Change one line's text (the user fixed a word) or its speaker. No-op when
 * the line is gone. Returns the updated line.
 */
export async function updateSegment(
  id: string,
  patch: Partial<Pick<TranscriptSegment, 'text' | 'speaker'>>,
): Promise<TranscriptSegment | undefined> {
  let updated: TranscriptSegment | undefined;
  await db.transaction([STORE], 'readwrite', (t) => {
    const segs = t.objectStore(STORE);
    const req = segs.get(id);
    req.onsuccess = () => {
      const cur = req.result as TranscriptSegment | undefined;
      if (!cur) return;
      updated = { ...cur, ...patch };
      segs.put(updated);
    };
  });
  return updated;
}

/** Replace the speaker of every line at once (speaker detection result). */
export async function setSegmentSpeakers(meetingId: string, speakers: Map<string, string>): Promise<void> {
  await db.transaction([STORE], 'readwrite', (t) => {
    const segs = t.objectStore(STORE);
    const req = segs.index('by-meeting').getAll(meetingId);
    req.onsuccess = () => {
      for (const s of req.result as TranscriptSegment[]) {
        const sp = speakers.get(s.id);
        if (sp !== undefined) segs.put({ ...s, speaker: sp });
      }
    };
  });
}
