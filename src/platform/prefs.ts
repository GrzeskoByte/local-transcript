/**
 * Small synchronous preferences (save-to-disk, update checks). On desktop
 * they live in the settings file (see native-settings.ts) so they survive
 * updates and webview-profile problems; localStorage is the fallback and the
 * migration source.
 *
 * Server edition: the per-user settings on the server are the store, and the
 * browser is shared by every account that signs in on it, so the localStorage
 * copy is keyed `u:<userId>:<key>` — and nothing else in localStorage is ever
 * read or migrated (it may belong to another account or to a desktop build).
 */
import { nativeSettingsSnapshot, setNativeSetting } from './native-settings';
import { isServerApp, serverSession } from './server';

/** The localStorage key for `key`, or null when none may be used. */
function localKey(key: string): string | null {
  if (!isServerApp()) return key;
  const userId = serverSession()?.user.id;
  return userId ? `u:${userId}:${key}` : null;
}

function readLocal(key: string): string | null {
  const scoped = localKey(key);
  if (scoped === null) return null;
  try {
    return localStorage.getItem(scoped);
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
  // Migrate a value only localStorage knows about (never on the server: its
  // settings are per user already).
  if (settings && local !== null && !isServerApp()) void setNativeSetting(key, local).catch(() => undefined);
  return local;
}

export function setPref(key: string, value: string): void {
  const scoped = localKey(key);
  if (scoped !== null) {
    try {
      localStorage.setItem(scoped, value);
    } catch {
      /* best-effort */
    }
  }
  if (nativeSettingsSnapshot()) void setNativeSetting(key, value).catch(() => undefined);
}
