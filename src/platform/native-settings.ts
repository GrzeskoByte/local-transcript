/**
 * Desktop settings file (`native_settings_load` / `native_settings_set`).
 *
 * Settings used to live in IndexedDB/localStorage, inside WebKit's profile.
 * That profile can become unreadable (a database written by a newer WebKit
 * than the AppImage bundles fails with "Unable to establish IDB database
 * file") and every setting looked lost. The desktop shell keeps them in a
 * JSON file instead; values are cached here after one load. Outside the
 * desktop shell — or when the command is missing — `loadNativeSettings`
 * resolves `null` and callers fall back to IndexedDB/localStorage.
 */
import { invokeDesktop, isDesktopApp } from './desktop';

type SettingsMap = Record<string, unknown>;

let cache: SettingsMap | null = null;
let loading: Promise<SettingsMap | null> | null = null;

function isMap(value: unknown): value is SettingsMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load (once) the settings file. `null` when unavailable. */
export function loadNativeSettings(): Promise<SettingsMap | null> {
  if (cache) return Promise.resolve(cache);
  if (!isDesktopApp()) return Promise.resolve(null);
  if (!loading) {
    loading = invokeDesktop<unknown>('native_settings_load')
      .then((value) => {
        cache = isMap(value) ? { ...value } : null;
        return cache;
      })
      .catch(() => null)
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/** Settings already loaded (synchronous readers use this). */
export function nativeSettingsSnapshot(): SettingsMap | null {
  return cache;
}

/**
 * Store one value; `undefined` deletes (kept as a `null` tombstone so a
 * deleted key is not migrated back from IndexedDB).
 */
export async function setNativeSetting(key: string, value: unknown): Promise<void> {
  const settings = await loadNativeSettings();
  if (!settings) throw new Error('Desktop settings are unavailable');
  const stored = value === undefined ? null : value;
  await invokeDesktop<void>('native_settings_set', { key, value: stored });
  settings[key] = stored;
}

/** Test hook. */
export function resetNativeSettingsCache(): void {
  cache = null;
  loading = null;
}
