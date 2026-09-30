/**
 * Small synchronous preferences (save-to-disk, update checks). On desktop
 * they live in the settings file (see native-settings.ts) so they survive
 * updates and webview-profile problems; localStorage is the fallback and the
 * migration source.
 */
import { nativeSettingsSnapshot, setNativeSetting } from './native-settings';

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function getPref(key: string): string | null {
  const settings = nativeSettingsSnapshot();
  if (settings && key in settings) {
    const value = settings[key];
    return typeof value === 'string' ? value : null;
  }
  const local = readLocal(key);
  // Migrate a value only localStorage knows about.
  if (settings && local !== null) void setNativeSetting(key, local).catch(() => undefined);
  return local;
}

export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* best-effort */
  }
  if (nativeSettingsSnapshot()) void setNativeSetting(key, value).catch(() => undefined);
}
