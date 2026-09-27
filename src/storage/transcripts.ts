import type { TranscriptSegment } from '../domain/transcript';
import { db } from './database';

const STORE = 'segments';

export async function saveSegments(segments: TranscriptSegment[]): Promise<void> {
  for (const seg of segments) {
    await db.put(STORE, seg);
  }
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
