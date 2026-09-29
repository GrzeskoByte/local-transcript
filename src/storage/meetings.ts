import type { Meeting } from '../domain/meeting';
import { db } from './database';

const STORE = 'meetings';

export async function saveMeeting(meeting: Meeting): Promise<void> {
  await db.put(STORE, meeting);
}

export async function getMeeting(id: string): Promise<Meeting | undefined> {
  return db.get<Meeting>(STORE, id);
}

export async function listMeetings(): Promise<Meeting[]> {
  const all = await db.getAll<Meeting>(STORE);
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteMeetingRecord(id: string): Promise<void> {
  await db.delete(STORE, id);
}

export async function findUnfinishedMeetings(): Promise<Meeting[]> {
  const all = await listMeetings();
  return all.filter((m) => m.unfinished || m.endedAt === undefined);
}

/**
 * Read-modify-write a meeting in ONE transaction, and only if it still exists.
 * Long-running work (transcription, uploads, summaries) must use this instead
 * of getMeeting → saveMeeting: if the user deletes the meeting meanwhile, a
 * plain save would resurrect it as a zombie record with no audio (§23).
 * Returns the stored meeting, or undefined when it no longer exists.
 */
export async function updateMeeting(
  id: string,
  change: Partial<Meeting> | ((m: Meeting) => Meeting),
): Promise<Meeting | undefined> {
  let result: Meeting | undefined;
  await db.transaction([STORE], 'readwrite', (t) => {
    const os = t.objectStore(STORE);
    const req = os.get(id);
    req.onsuccess = () => {
      const current = req.result as Meeting | undefined;
      if (!current) return;
      result = typeof change === 'function' ? change(current) : { ...current, ...change };
      os.put(result);
    };
  });
  return result;
}
