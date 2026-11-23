import type { Meeting } from '../domain/meeting';
import { db } from './database';
import { invokeDesktop } from '../platform/desktop';
import { isServerApp } from '../platform/server';

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
  // Server: the meeting and its segments go in one transaction.
  if (isServerApp()) {
    await invokeDesktop('server_db_delete_meeting', { id });
    return;
  }
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
  if (isServerApp()) return updateOnServer(id, change);
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

/** Attempts of the compare-and-set loop before a contended update gives up. */
const SERVER_UPDATE_ATTEMPTS = 5;

/**
 * Server edition. A partial change is merged by the server in ONE transaction
 * (`server_db_patch`: nothing else in the record is overwritten). A function
 * needs the current value, so it is compare-and-set: read, apply, write only
 * when the stored value is still the one read (`server_db_put_if_unchanged`),
 * else read again. Without this a concurrent writer's fields would be lost.
 */
async function updateOnServer(
  id: string,
  change: Partial<Meeting> | ((m: Meeting) => Meeting),
): Promise<Meeting | undefined> {
  if (typeof change !== 'function') {
    const merged = await invokeDesktop<Meeting | null>('server_db_patch', { store: STORE, key: id, patch: change });
    return merged ?? undefined;
  }
  for (let attempt = 0; attempt < SERVER_UPDATE_ATTEMPTS; attempt++) {
    const current = await db.get<Meeting>(STORE, id);
    if (!current) return undefined;
    // `change` may mutate `current`: compare against an untouched copy.
    const expected = JSON.parse(JSON.stringify(current)) as Meeting;
    const next = change(current);
    const stored = await invokeDesktop<boolean>('server_db_put_if_unchanged', {
      store: STORE,
      value: next,
      expected,
    });
    if (stored) return next;
  }
  throw new Error(`The meeting kept changing while it was being updated (${SERVER_UPDATE_ATTEMPTS} attempts). Try again.`);
}
