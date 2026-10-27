/**
 * Every network connection the app makes, each one started by the user
 * (Settings → Storage & privacy: "Network activity"). Kept on this device
 * (last 30 days, at most 300 entries). Nothing here is ever sent anywhere.
 */
import { getPref, setPref } from './prefs';

export interface NetworkEntry {
  at: number;
  host: string;
  /** What the user did ("Created 3 issues from \"Q4 sync\""). */
  why: string;
  /** What left the computer ("3 titles", "Nothing (download)"). */
  sent: string;
}

const PREF = 'network-log';
const KEEP_MS = 30 * 24 * 3600 * 1000;
const MAX = 300;

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0] || url;
  }
}

export function networkLog(now = Date.now()): NetworkEntry[] {
  try {
    const rows = JSON.parse(getPref(PREF) ?? '[]') as NetworkEntry[];
    return Array.isArray(rows) ? rows.filter((r) => now - r.at < KEEP_MS) : [];
  } catch {
    return [];
  }
}

/** Record a connection; `urlOrHost` may be a full URL. Best-effort. */
export function logNetwork(urlOrHost: string, why: string, sent: string, now = Date.now()): void {
  try {
    const entry: NetworkEntry = { at: now, host: hostOf(urlOrHost), why, sent };
    setPref(PREF, JSON.stringify([entry, ...networkLog(now)].slice(0, MAX)));
  } catch {
    /* best-effort */
  }
}

export function clearNetworkLog(): void {
  setPref(PREF, '[]');
}
