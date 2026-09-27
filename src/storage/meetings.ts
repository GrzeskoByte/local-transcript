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
