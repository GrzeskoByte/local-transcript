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
  stage: 'idle' | 'downloading' | 'installing' | 'restarting' | 'error';
  downloaded: number;
  total: number | null;
  error: string | null;
}

export function checkForUpdate(): Promise<UpdateInfo> {
  return invokeDesktop<UpdateInfo>('native_update_check');
}

/** Resolves only on failure: a successful install restarts the app. */
export function installUpdate(): Promise<void> {
  return invokeDesktop<void>('native_update_install');
}

export function getUpdateProgress(): Promise<UpdateProgress> {
  return invokeDesktop<UpdateProgress>('native_update_progress');
}

export const AUTO_CHECK_KEY = 'update-auto-check';
export const LAST_CHECK_KEY = 'update-last-check';
export function getAutoCheck(): boolean {
  return getPref(AUTO_CHECK_KEY) !== 'false';
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
