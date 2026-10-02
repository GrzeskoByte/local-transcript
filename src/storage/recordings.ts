/**
 * OPFS recording storage (§14). Layout:
 *   single-track: meetings/{id}/{chunk}      + meetings/{id}/meta.json
 *   two-way:      meetings/{id}/{track}/{chunk} + meetings/{id}/meta.json
 * Files are written with `createWritable()` or, where the engine lacks it
 * (WKWebView before Safari 26), through a worker using sync access handles.
 * Without OPFS (the AppImage's WebKitGTK 2.50 has no getDirectory), the
 * desktop shell stores the same layout on disk (`src-tauri/src/recordings.rs`).
 * Elsewhere recording is refused (audio would only live in memory); the
 * in-memory map below serves Node unit tests.
 */
import { invokeDesktop, isDesktopApp } from '../platform/desktop';
import { repairFragmentedMp4 } from '../audio/mp4-repair';
import { bytesToBase64 } from '../asr/wav';

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

/** Desktop shell without OPFS: chunks go to disk through Rust. */
function useNative(): boolean {
  return !hasOPFS() && isDesktopApp();
}

interface NativeTrack {
  track: string;
  chunks: string[];
}

async function nativeList(id: string): Promise<NativeTrack[]> {
  const list = await invokeDesktop<NativeTrack[] | null>('native_recording_list', { meetingId: id });
  return Array.isArray(list) ? list : [];
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Throws when recordings could not be stored durably. Only Node (unit tests)
 * may use the in-memory fallback — in a webview it would report audio as
 * saved that is gone after a restart (§19).
 */
export function assertDurableStorage(): void {
  if (hasOPFS() || useNative() || typeof window === 'undefined') return;
  throw new Error(
    'This system cannot store recordings safely (the app’s private file storage is unavailable). ' +
      'Update your operating system or its web engine, then try again.',
  );
}

function hasCreateWritable(): boolean {
  return (
    typeof FileSystemFileHandle !== 'undefined' &&
    typeof (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable === 'function'
  );
}

type WriteReply = { id: number; ok: boolean; error?: string };
let writer: Worker | null = null;
let nextWriteId = 0;
const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

function opfsWorker(): Worker {
  if (writer) return writer;
  const w = new Worker(new URL('./opfs-writer.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (event: MessageEvent<WriteReply>) => {
    const entry = waiting.get(event.data.id);
    if (!entry) return;
    waiting.delete(event.data.id);
    if (event.data.ok) entry.resolve();
    else entry.reject(new Error(event.data.error ?? 'OPFS write failed'));
  };
  w.onerror = (event) => {
    // A worker that cannot load/run fails every queued write; the next write
    // starts a fresh one.
    const error = new Error(`OPFS writer failed: ${event.message || 'worker error'}`);
    for (const entry of waiting.values()) entry.reject(error);
    waiting.clear();
    writer = null;
    w.terminate();
  };
  writer = w;
  return w;
}

/** Write (replace) one OPFS file at `path` (below the OPFS root). */
async function writeOpfsFile(path: string[], data: Blob | string): Promise<void> {
  const blob = typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data;
  if (!hasCreateWritable()) {
    const id = nextWriteId++;
    await new Promise<void>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      opfsWorker().postMessage({ id, path, data: blob });
    });
    return;
  }
  let dir = await navigator.storage.getDirectory();
  for (const segment of path.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  const file = await dir.getFileHandle(path[path.length - 1]!, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
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
  if (useNative()) {
    await invokeDesktop('native_recording_write_meta', { meetingId: id, meta: JSON.stringify(meta) });
    return;
  }
  if (!hasOPFS()) return;
  await writeOpfsFile(['meetings', id, 'meta.json'], JSON.stringify(meta));
}

export async function readMeta(id: string): Promise<RecordingMeta | null> {
  if (useNative()) {
    const raw = await invokeDesktop<string | null>('native_recording_read_meta', { meetingId: id }).catch(() => null);
    try {
      return raw ? (JSON.parse(raw) as RecordingMeta) : null;
    } catch {
      return null;
    }
  }
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
  if (useNative()) {
    const dataBase64 = bytesToBase64(new Uint8Array(await data.arrayBuffer()));
    try {
      await invokeDesktop('native_recording_write', { request: { meetingId: id, track, name, dataBase64 } });
    } catch (err) {
      throw err instanceof Error ? err : new Error(`Storage write failed: ${String(err)}`);
    }
    return;
  }
  if (!hasOPFS()) {
    // Accumulate per (meeting, track) so readRecordingBlob can reassemble.
    const key = memKey(id, track, name);
    if (!memFallback.has(key)) memFallback.set(key, data);
    return;
  }
  try {
    await writeOpfsFile(track ? ['meetings', id, track, name] : ['meetings', id, name], data);
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
  if (useNative()) {
    const tracks = (await nativeList(id).catch(() => [])).filter((t) => t.chunks.length > 0);
    const named = tracks.filter((t) => t.track).map((t) => t.track);
    // Like OPFS: sub-directories win over flat chunks.
    return named.length ? named : tracks.length ? [''] : [];
  }
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
  if (useNative()) {
    return (await nativeList(id).catch(() => [])).find((t) => t.track === track)?.chunks ?? [];
  }
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
  if (useNative()) {
    const b64 = await invokeDesktop<string>('native_recording_read', { meetingId: id, track });
    return b64 ? assembled([base64ToBytes(b64)], mimeType) : null;
  }
  const names = await listChunkNames(id, track);
  if (names.length === 0) return null;
  if (!hasOPFS()) {
    const parts: Blob[] = [];
    for (const name of names) {
      const part = memFallback.get(memKey(id, track, name));
      if (part) parts.push(part);
    }
    return parts.length ? assembled(parts, mimeType) : null;
  }
  const dir = await trackDir(id, track, false);
  if (!dir) return null;
  const parts: Blob[] = [];
  for (const name of names) {
    const file = await dir.getFileHandle(name);
    parts.push(await file.getFile());
  }
  return assembled(parts, mimeType);
}

/** Joins stored chunks; MP4 recordings are repaired (see repairFragmentedMp4). */
async function assembled(parts: BlobPart[], mimeType: string): Promise<Blob> {
  const blob = new Blob(parts, { type: mimeType });
  if (!mimeType.includes('mp4')) return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const repaired = repairFragmentedMp4(bytes);
  return repaired === bytes ? blob : new Blob([repaired], { type: mimeType });
}

export async function deleteRecording(id: string): Promise<void> {
  if (useNative()) {
    await invokeDesktop('native_recording_delete', { meetingId: id });
    return;
  }
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
