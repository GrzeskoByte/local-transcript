import { invokeDesktop, isDesktopApp } from './desktop';
import { bytesToBase64 } from '../asr/wav';

/** True when the desktop filesystem bridge is usable. */
export function desktopStorageAvailable(): boolean {
  return isDesktopApp();
}

/** Absolute path of the app's local storage folder (created on demand). */
export async function desktopStorageDir(): Promise<string> {
  return invokeDesktop<string>('native_storage_dir');
}

/**
 * Write bytes to `<storage>/<relativePath>` (or append them with
 * `append: true`). Returns the absolute path.
 */
export async function saveFileToDisk(
  relativePath: string,
  data: Uint8Array,
  append = false,
): Promise<string> {
  return invokeDesktop<string>('native_save_file', {
    request: { relativePath, dataBase64: bytesToBase64(data), append },
  });
}

/** Slice size for copying large files: bounds memory and IPC message size. */
const COPY_SLICE_BYTES = 2 * 1024 * 1024;

/**
 * Write a (possibly large) blob in slices, so a long recording never becomes
 * one huge base64 string and IPC message. Returns the absolute path.
 */
export async function saveBlobToDisk(relativePath: string, blob: Blob): Promise<string> {
  let path = await saveFileToDisk(
    relativePath,
    new Uint8Array(await blob.slice(0, COPY_SLICE_BYTES).arrayBuffer()),
  );
  for (let at = COPY_SLICE_BYTES; at < blob.size; at += COPY_SLICE_BYTES) {
    const slice = new Uint8Array(await blob.slice(at, at + COPY_SLICE_BYTES).arrayBuffer());
    path = await saveFileToDisk(relativePath, slice, true);
  }
  return path;
}

/** Size in bytes of `<storage>/<relativePath>`, or null when it is missing. */
export async function diskFileSize(relativePath: string): Promise<number | null> {
  const size = await invokeDesktop<number | null>('native_storage_file_size', { relativePath });
  return typeof size === 'number' ? size : null;
}

/** Reveal the storage folder in the system file manager. */
export async function openDesktopStorageDir(): Promise<void> {
  await invokeDesktop('native_open_storage_dir');
}
