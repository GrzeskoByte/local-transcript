/**
 * Preferences introduced by the redesign (Settings → Recording, After
 * recording, Storage, App). Small synchronous values in the settings file
 * (desktop) / localStorage (browser) via `getPref`/`setPref`.
 */
import { useSyncExternalStore } from 'react';
import { getPref, setPref } from '../platform/prefs';
import type { ExportFormat, RecordingMode, WrapStepId } from '../domain/meeting';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = getPref(key);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' ? { ...fallback, ...(value as object) } : fallback;
  } catch {
    return fallback;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = getPref(key);
  return raw === null ? fallback : raw === 'true';
}

const listeners = new Set<() => void>();
/** Re-render hook support: components subscribe to preference changes. */
export function subscribePrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
let version = 0;
export function prefsVersion(): number {
  return version;
}
function write(key: string, value: string): void {
  setPref(key, value);
  version += 1;
  listeners.forEach((l) => l());
}

// ---- Recording & devices -------------------------------------------------

const SOURCES: RecordingMode[] = ['speaker', 'device', 'dual'];

/** Source preselected on Home: the saved default, else the last one used. */
export function defaultSource(): RecordingMode {
  const saved = getPref('default-recording-mode') ?? getPref('last-recording-mode');
  return SOURCES.includes(saved as RecordingMode) ? (saved as RecordingMode) : 'speaker';
}
export function setDefaultSource(mode: RecordingMode): void {
  write('default-recording-mode', mode);
}

export interface RecordingPrefs {
  /** Use the calendar event title when a meeting is on now. */
  nameFromCalendar: boolean;
  /** A line about consent when a call recording starts. */
  consentReminder: boolean;
  /** Show live audio problems on the recording screen. */
  audioWarnings: boolean;
  /** Keep the computer awake (and recording with the lid closed, on power). */
  keepAwake: boolean;
}
const RECORDING_DEFAULTS: RecordingPrefs = {
  nameFromCalendar: true,
  consentReminder: true,
  audioWarnings: true,
  keepAwake: false,
};
export function recordingPrefs(): RecordingPrefs {
  return readJson('recording-prefs', RECORDING_DEFAULTS);
}
export function setRecordingPrefs(patch: Partial<RecordingPrefs>): void {
  write('recording-prefs', JSON.stringify({ ...recordingPrefs(), ...patch }));
}

// ---- After recording -------------------------------------------------------

export interface WrapPrefs {
  /** Open the guided wrap-up after Stop. */
  guide: boolean;
  /** Optional steps that are on (Transcribe is always first). */
  steps: Record<Exclude<WrapStepId, 'transcribe'>, boolean>;
  /** List unfinished steps on Home. */
  homeList: boolean;
  /** Banner in the meeting when steps were skipped. */
  banner: boolean;
  /** Pre-tick action items (owner + date → GitLab, date + time → calendar). */
  pretick: boolean;
}
const WRAP_DEFAULTS: WrapPrefs = {
  guide: true,
  steps: { summary: true, gitlab: true, calendar: false, export: true },
  homeList: true,
  banner: true,
  pretick: true,
};
export function wrapPrefs(): WrapPrefs {
  const v = readJson('wrapup-prefs', WRAP_DEFAULTS);
  return { ...v, steps: { ...WRAP_DEFAULTS.steps, ...v.steps } };
}
export function setWrapPrefs(patch: Partial<WrapPrefs>): void {
  write('wrapup-prefs', JSON.stringify({ ...wrapPrefs(), ...patch }));
}
export function enabledWrapSteps(p: WrapPrefs = wrapPrefs()): WrapStepId[] {
  return ['transcribe', ...(['summary', 'gitlab', 'calendar', 'export'] as const).filter((s) => p.steps[s])];
}

export interface ExportPrefs {
  formats: Record<ExportFormat, boolean>;
  /** File name pattern: {date}, {title}, {time}. */
  fileName: string;
  /** Post the summary to the GitLab wiki in the Export step. */
  wiki: boolean;
}
const EXPORT_DEFAULTS: ExportPrefs = {
  formats: { md: true, txt: false, json: false, audio: true },
  fileName: '{date}-{title}',
  wiki: true,
};
export function exportPrefs(): ExportPrefs {
  const v = readJson('export-prefs', EXPORT_DEFAULTS);
  return { ...v, formats: { ...EXPORT_DEFAULTS.formats, ...v.formats } };
}
export function setExportPrefs(patch: Partial<ExportPrefs>): void {
  write('export-prefs', JSON.stringify({ ...exportPrefs(), ...patch }));
}

/** "{date}-{title}" → "2026-10-21-q4-roadmap-sync" (safe for every file system). */
export function exportBaseName(pattern: string, title: string, startedAt: number): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const slug =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting';
  const name = (pattern.trim() || '{date}-{title}')
    .replace(/\{date\}/g, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replace(/\{title\}/g, slug);
  return name.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/^\.+/, '').slice(0, 120) || slug;
}

// ---- Storage ---------------------------------------------------------------

export type KeepAudio = 'always' | '30d' | 'exported';
export function keepAudio(): KeepAudio {
  const v = getPref('keep-audio');
  return v === '30d' || v === 'exported' ? v : 'always';
}
export function setKeepAudio(v: KeepAudio): void {
  write('keep-audio', v);
}

// ---- Home ------------------------------------------------------------------

export function remindToRecord(): boolean {
  return readBool('remind-to-record', true);
}
export function setRemindToRecord(v: boolean): void {
  write('remind-to-record', String(v));
}

// ---- Setup -----------------------------------------------------------------

/** First-run setup finished or skipped. */
export function setupDone(): boolean {
  return readBool('setup-done', false);
}
export function setSetupDone(v: boolean): void {
  write('setup-done', String(v));
}
/** Languages picked in setup (drives the model recommendation). */
export function meetingLanguages(): string[] {
  try {
    const v = JSON.parse(getPref('meeting-languages') ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
export function setMeetingLanguages(v: string[]): void {
  write('meeting-languages', JSON.stringify(v));
}

// ---- Library ---------------------------------------------------------------

export function libraryView(): 'list' | 'month' {
  return getPref('library-view') === 'month' ? 'month' : 'list';
}
export function setLibraryView(v: 'list' | 'month'): void {
  write('library-view', v);
}

// ---- Calendar (Settings → GitLab & calendar) -------------------------------

export interface CalendarPrefs {
  /** Show the next meetings on Home, with a reminder to record. */
  comingUp: boolean;
  /** Attach the event's agenda (its description) to the recording. */
  useAgendas: boolean;
  /** Calendar URL follow-ups are added to (CalDAV collection; '' = the configured one). */
  followupCalendar: string;
}
const CALENDAR_DEFAULTS: CalendarPrefs = { comingUp: true, useAgendas: true, followupCalendar: '' };
export function calendarPrefs(): CalendarPrefs {
  return readJson('calendar-prefs', CALENDAR_DEFAULTS);
}
export function setCalendarPrefs(patch: Partial<CalendarPrefs>): void {
  write('calendar-prefs', JSON.stringify({ ...calendarPrefs(), ...patch }));
}

/** Re-render when any preference changes. */
export function usePrefsVersion(): number {
  return useSyncExternalStore(subscribePrefs, prefsVersion);
}
