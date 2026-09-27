/**
 * OPFS recording storage (§14). Layout:
 *   single-track: meetings/{id}/{chunk}      + meetings/{id}/meta.json
 *   two-way:      meetings/{id}/{track}/{chunk} + meetings/{id}/meta.json
 * Falls back to an in-memory map when OPFS is unavailable (tests, some browsers).
 */
export interface RecordingMeta {
  mimeType: string;
  startedAt: number;
  /** Track ids present for a two-way recording (e.g. ['microphone','device']). */
  tracks?: string[];
}

/** In-memory fallback store. Key: `${id}::${track}::${name}`. */
const memFallback = new Map<string, Blob>();

function memKey(id: string, track: string, name: string): string {
  return `${id}::${track}::${name}`;
}

function hasOPFS(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

async function meetingDir(id: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!hasOPFS()) return null;
  const root = await navigator.storage.getDirectory();
  const meetings = await root.getDirectoryHandle('meetings', { create });
  return meetings.getDirectoryHandle(id, { create });
}

/** Directory for a track. '' maps to the meeting dir itself (legacy flat layout). */
async function trackDir(
  id: string,
  track: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | null> {
  const dir = await meetingDir(id, create);
  if (!dir || !track) return dir;
  return dir.getDirectoryHandle(track, { create });
}

export async function writeMeta(id: string, meta: RecordingMeta): Promise<void> {
  if (!hasOPFS()) return;
  const dir = await meetingDir(id, true);
  if (!dir) return;
  const file = await dir.getFileHandle('meta.json', { create: true });
  const writable = await file.createWritable();
  await writable.write(JSON.stringify(meta));
  await writable.close();
}

export async function readMeta(id: string): Promise<RecordingMeta | null> {
  if (!hasOPFS()) return null;
  try {
    const dir = await meetingDir(id, false);
    if (!dir) return null;
    const file = await dir.getFileHandle('meta.json');
    const blob = await file.getFile();
    return JSON.parse(await blob.text()) as RecordingMeta;
  } catch {
    return null;
  }
}

export async function appendChunk(
  id: string,
  name: string,
  data: Blob,
  track = '',
): Promise<void> {
  if (!hasOPFS()) {
    // Accumulate per (meeting, track) so readRecordingBlob can reassemble.
    const key = memKey(id, track, name);
    if (!memFallback.has(key)) memFallback.set(key, data);
    return;
  }
  try {
    const dir = await trackDir(id, track, true);
    if (!dir) throw new Error('OPFS directory unavailable');
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    throw err instanceof Error ? err : new Error(`Storage write failed: ${String(err)}`);
  }
}

/**
 * Tracks that hold audio for a meeting.
 *  - two-way: the sub-directory names (e.g. ['device','microphone'])
 *  - single-track: [''] (flat chunks)
 *  - nothing stored: []
 */
export async function listTracks(id: string): Promise<string[]> {
  if (!hasOPFS()) {
    const tracks = new Set<string>();
    const prefix = `${id}::`;
    for (const key of memFallback.keys()) {
      if (!key.startsWith(prefix)) continue;
      tracks.add(key.slice(prefix.length).split('::')[0] ?? '');
    }
    return [...tracks].sort();
  }
  try {
    const dir = await meetingDir(id, false);
    if (!dir) return [];
    const tracks: string[] = [];
    let hasFlat = false;
    const entries = dir as unknown as {
      entries(): AsyncIterableIterator<[string, { kind: string }]>;
    };
    for await (const [name, handle] of entries.entries()) {
      if (handle.kind === 'directory') tracks.push(name);
      else if (name !== 'meta.json') hasFlat = true;
    }
    tracks.sort();
    if (tracks.length) return tracks;
    return hasFlat ? [''] : [];
  } catch {
    return [];
  }
}

export async function listChunkNames(id: string, track = ''): Promise<string[]> {
  if (!hasOPFS()) {
    const names: string[] = [];
    const prefix = `${id}::${track}::`;
    for (const key of memFallback.keys()) {
      if (key.startsWith(prefix)) names.push(key.slice(prefix.length));
    }
    return names.sort();
  }
  try {
    const dir = await trackDir(id, track, false);
    if (!dir) return [];
    const names: string[] = [];
    const entries = dir as unknown as {
      entries(): AsyncIterableIterator<[string, { kind: string }]>;
    };
    for await (const [name, handle] of entries.entries()) {
      if (handle.kind !== 'directory' && name !== 'meta.json') names.push(name);
    }
    return names.sort();
  } catch {
    return [];
  }
}

export async function readRecordingBlob(
  id: string,
  mimeType: string,
  track = '',
): Promise<Blob | null> {
  const names = await listChunkNames(id, track);
  if (names.length === 0) return null;
  if (!hasOPFS()) {
    const parts: Blob[] = [];
    for (const name of names) {
      const part = memFallback.get(memKey(id, track, name));
      if (part) parts.push(part);
    }
    return parts.length ? new Blob(parts, { type: mimeType }) : null;
  }
  const dir = await trackDir(id, track, false);
  if (!dir) return null;
  const parts: Blob[] = [];
  for (const name of names) {
    const file = await dir.getFileHandle(name);
    parts.push(await file.getFile());
  }
  return new Blob(parts, { type: mimeType });
}

export async function deleteRecording(id: string): Promise<void> {
  if (!hasOPFS()) {
    const prefix = `${id}::`;
    for (const key of [...memFallback.keys()]) {
      if (key.startsWith(prefix)) memFallback.delete(key);
    }
    return;
  }
  try {
    const root = await navigator.storage.getDirectory();
    const meetings = await root.getDirectoryHandle('meetings', { create: false });
    await meetings.removeEntry(id, { recursive: true });
  } catch {
    // Already gone — treat as deleted.
  }
}

/** Storage estimate check (§19). Returns quota/usage where supported. */
export async function estimateStorage(): Promise<{ quota?: number; usage?: number }> {
  try {
    const est = await navigator.storage?.estimate();
    return { quota: est?.quota, usage: est?.usage };
  } catch {
    return {};
  }
}

export function isStorageLow(
  estimate: { quota?: number; usage?: number },
  threshold = 0.9,
): boolean {
  if (!estimate.quota) return false;
  return (estimate.usage ?? 0) / estimate.quota >= threshold;
}
