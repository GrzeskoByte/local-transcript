/**
 * In-app updates (desktop only). Rust `src-tauri/src/updater.rs` wraps
 * tauri-plugin-updater: `native_update_check` reads latest.json from the
 * `updater` GitHub release, `native_update_install` downloads + verifies the
 * signed artifact, installs it and restarts; `native_update_progress` is polled.
 * Checking contacts GitHub only; nothing installs without a click.
 */
import { invokeDesktop } from './desktop';
import { getPref, setPref } from './prefs';
import type { RecordingState } from '../domain/meeting';

export interface UpdateInfo {
  currentVersion: string;
  available: boolean;
  version: string | null;
  notes: string | null;
  date: string | null;
  /** False for Linux .deb/.rpm installs (only the AppImage replaces itself). */
  canSelfUpdate: boolean;
  downloadUrl: string;
}

export interface UpdateProgress {
  /** `installed`: installed with "On next launch", waiting for a restart. */
  stage: 'idle' | 'downloading' | 'installing' | 'restarting' | 'installed' | 'error';
  downloaded: number;
  total: number | null;
  error: string | null;
}

/** Settings → App: "Include test releases" (canary builds; off by default). */
export const TEST_RELEASES_KEY = 'update-test-releases';
export function getTestReleases(): boolean {
  return getPref(TEST_RELEASES_KEY) === 'true';
}
export function setTestReleases(value: boolean): void {
  setPref(TEST_RELEASES_KEY, String(value));
}

export function checkForUpdate(): Promise<UpdateInfo> {
  return invokeDesktop<UpdateInfo>('native_update_check', { channel: getTestReleases() ? 'canary' : 'stable' });
}

/**
 * `relaunch` true ("Restart now"): resolves only on failure — the app
 * restarts. false ("On next launch"): installs and resolves; the new
 * version starts next time (or via `relaunchApp`).
 */
export function installUpdate(relaunch = true): Promise<void> {
  return invokeDesktop<void>('native_update_install', { relaunch });
}

export function relaunchApp(): Promise<void> {
  return invokeDesktop<void>('native_relaunch');
}

export function getUpdateProgress(): Promise<UpdateProgress> {
  return invokeDesktop<UpdateProgress>('native_update_progress');
}

export const AUTO_CHECK_KEY = 'update-auto-check';
export const LAST_CHECK_KEY = 'update-last-check';
/** Opt-in: the app never goes online on its own unless the user turned this on. */
export function getAutoCheck(): boolean {
  return getPref(AUTO_CHECK_KEY) === 'true';
}

export function setAutoCheck(value: boolean): void {
  setPref(AUTO_CHECK_KEY, String(value));
}

export function getLastCheck(): number {
  return Number(getPref(LAST_CHECK_KEY)) || 0;
}

export function setLastCheck(at: number): void {
  setPref(LAST_CHECK_KEY, String(at));
}

/** Why installing now would be unsafe (it restarts the app), or null. */
export function updateBlockedReason(
  recordingState: RecordingState,
  runningTranscriptions: number,
): string | null {
  if (recordingState !== 'IDLE' && recordingState !== 'COMPLETED') {
    return 'Finish or stop the current recording first — updating restarts the app.';
  }
  if (runningTranscriptions > 0) {
    return 'Wait for the running transcription to finish — updating restarts the app.';
  }
  return null;
}

/** 0..1 download ratio, or null when the size is unknown. */
export function updateRatio(p: UpdateProgress): number | null {
  return p.total && p.total > 0 ? Math.min(1, p.downloaded / p.total) : null;
}
