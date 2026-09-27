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

/** Write bytes to `<storage>/<relativePath>`. Returns the absolute path. */
export async function saveFileToDisk(
  relativePath: string,
  data: Uint8Array,
): Promise<string> {
  return invokeDesktop<string>('native_save_file', {
    request: { relativePath, dataBase64: bytesToBase64(data) },
  });
}

/** Reveal the storage folder in the system file manager. */
export async function openDesktopStorageDir(): Promise<void> {
  await invokeDesktop('native_open_storage_dir');
}
