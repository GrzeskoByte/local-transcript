/**
 * Desktop OS services (src-tauri/src/system.rs, recorder/monitor.rs,
 * diarize.rs): machine facts, storage sizes, the folder picker, keeping the
 * computer awake while recording, the microphone privacy page, app logs, the
 * pre-recording level monitor and local speaker detection.
 */
import { invokeDesktop, invokeDesktopRaw, isDesktopApp } from './desktop';

export interface SystemInfo {
  os: string;
  osVersion: string;
  arch: string;
  cpus: number;
  memoryBytes: number | null;
  freeDiskBytes: number | null;
  appVersion: string;
}

export interface StorageUsage {
  audioBytes: number;
  modelBytes: number;
  textBytes: number;
  freeBytes: number | null;
  folder: string;
}

export function systemInfo(): Promise<SystemInfo> {
  return invokeDesktop<SystemInfo>('native_system_info');
}

export function storageUsage(): Promise<StorageUsage> {
  return invokeDesktop<StorageUsage>('native_storage_usage');
}

/** The OS folder dialog; null when cancelled. */
export function pickFolder(title?: string): Promise<string | null> {
  return invokeDesktop<string | null>('native_pick_folder', { title });
}

/** Use `path` for local files ('' = the default), moving the meeting folders there when asked. */
export function setStorageDir(path: string, moveFiles: boolean): Promise<string> {
  return invokeDesktop<string>('native_set_storage_dir', { path, moveFiles });
}

/** Keep the computer awake while a recording runs (best-effort; false outside the shell). */
export async function keepAwake(on: boolean): Promise<boolean> {
  if (!isDesktopApp()) return false;
  return invokeDesktop<boolean>('native_keep_awake', { on }).catch(() => false);
}

export function openPrivacySettings(): Promise<void> {
  return invokeDesktop<void>('native_open_privacy_settings');
}

export function appLogs(): Promise<string[]> {
  return invokeDesktop<string[]>('native_logs');
}

// ---- level monitor ---------------------------------------------------------

export interface MonitorInput {
  role: 'microphone' | 'device';
  /** Microphone label / output name; empty = the default device. */
  device?: string;
}

export function startLevelMonitor(inputs: MonitorInput[]): Promise<number> {
  return invokeDesktop<number>('native_level_monitor_start', { inputs });
}

/** Peak (0..1) per input since the last poll. */
export function pollLevelMonitor(): Promise<number[]> {
  return invokeDesktop<number[]>('native_level_monitor_poll');
}

export function stopLevelMonitor(): Promise<void> {
  return invokeDesktop<void>('native_level_monitor_stop');
}

// ---- speaker detection -----------------------------------------------------

export interface DiarizeStatus {
  available: boolean;
  dir: string | null;
}

export async function diarizeStatus(): Promise<DiarizeStatus> {
  if (!isDesktopApp()) return { available: false, dir: null };
  return invokeDesktop<DiarizeStatus>('native_diarize_status').catch(() => ({ available: false, dir: null }));
}

/** 16 kHz mono WAV in, the engine's "start -- end speaker_NN" lines out. */
export function runDiarize(wav: Uint8Array, speakers = 0): Promise<string> {
  return invokeDesktopRaw<string>('native_diarize_run', wav, { 'x-num-speakers': String(speakers) });
}

/** 0..100 */
export function diarizeProgress(): Promise<number> {
  return invokeDesktop<number>('native_diarize_progress');
}

export function cancelDiarize(): Promise<void> {
  return invokeDesktop<void>('native_diarize_cancel');
}

/** "1.6 GB" / "550 MB" */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}
