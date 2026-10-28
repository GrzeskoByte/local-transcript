import { autoTranscribeEnabled } from './auto-transcribe';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Meeting, Participant, RecordingMode, RecordingState } from '../domain/meeting';
import { estimateDurationFromChunks, formatDuration, newMeetingId } from '../domain/meeting';
import { DeviceAudioSource } from '../audio/device-audio';
import { SystemAudioSource, systemAudioStatus } from '../audio/system-audio';
import type { SystemAudioStatus } from '../audio/system-audio';
import { MicrophoneAudioSource } from '../audio/microphone';
import { MixedAudioSource } from '../audio/mixed-audio';
import { chosenMicrophoneId, getSystemOutput } from '../audio/devices';
import { MediaRecorderAudioRecorder } from '../audio/recorder';
import type { RecorderErrorKind, TrackSpec } from '../audio/recorder';
import { RecordingDiagnosticsCollector, type DiagnosticsInput } from '../audio/diagnostics';
import type { AudioIssue } from '../domain/audio-diagnostics';
import { TranscriptionService, recoverInterruptedTranscriptions } from '../asr/transcription-service';
import {
  DEFAULT_NATIVE_LANGUAGE,
  NATIVE_DEFAULT_MODEL,
  getModelMeta,
  setModelMeta,
  reconcileModelMeta,
  getTranscriptionLanguage,
  setTranscriptionLanguage,
} from '../asr/model-manager';
import type { ModelMeta } from '../asr/model-manager';
import { nativeCatalog } from '../asr/model-tiers';
import type { CatalogModel } from '../asr/model-tiers';
import { deleteMeetingRecord, findUnfinishedMeetings, getMeeting, listMeetings, saveMeeting, updateMeeting } from '../storage/meetings';
import { deleteMeetingEverywhere } from '../features/meetings/exports';
import { commitTranscript, getSegments } from '../storage/transcripts';
import { DatabaseOpenError } from '../storage/database';
import { segmentsToMarkdown, type TranscriptSegment } from '../domain/transcript';
import type { TranscriptionStage } from '../asr/engine';
import { deleteRecording, estimateStorage, isStorageLow, listChunkNames, listTracks, readMeta, readRecordingBlob } from '../storage/recordings';
import { trackSpeakerLabel } from '../domain/meeting';
import { invokeDesktop, isDesktopApp } from '../platform/desktop';
import { getPref, setPref } from '../platform/prefs';
import {
  checkForUpdate,
  getAutoCheck,
  setLastCheck,
  type UpdateInfo,
} from '../platform/updater';
import {
  LiveTranscriber,
  getLiveEnabled,
  getLiveModel,
  liveModelOptions,
  resolveLiveModel,
  setLiveEnabled,
  setLiveModel,
  type LiveModelOption,
  type LiveSnapshot,
} from '../asr/live';
import { LivePcmTap } from '../audio/live-tap';
import {
  NATIVE_MIME_TYPE,
  NativeLiveFeed,
  NativeRecorder,
  type LiveFeed,
  nativeRecorderDevices,
  nativeRecordingEnabled,
  nativeSupportsMode,
  type NativeDiagnostics,
  type NativeRecorderDevices,
} from '../audio/native-recorder';
import { getMicrophoneDevice } from '../audio/devices';
import { nativeDownloadModel, nativeDownloadProgress, nativeEnableGpu, nativeStatus as fetchNativeStatus } from '../asr/native-engine';
import type { NativeAsrStatus, NativeModelInfo } from '../asr/native-types';
import { desktopStorageDir, openDesktopStorageDir } from '../platform/desktop-storage';
import { LiveAudioMirror, audioMirrorPath, mirrorMeetingToDisk, type MirrorAudio } from '../features/meetings/disk-sync';
import { importAudioFile } from '../features/meetings/import-audio';
import { actionItemsOf, createGitlabClient, DEFAULT_GITLAB_CONFIG } from '../integrations/gitlab';
import type { ActionIssueResult, GitlabConfig, GitlabUploadResult, IssueOverride } from '../integrations/gitlab';
import { getGitlabConfig, setGitlabConfig } from '../integrations/gitlab-store';
import { buildTransport, DEFAULT_CALENDAR_CONFIG, eventUid } from '../integrations/calendar';
import type { CalendarConfig, CalendarCreateResult, CalendarEventDraft, CalendarProvider, ServerEvent } from '../integrations/calendar';
import { fetchServerEvents } from '../integrations/calendar';
import { getCalendarConfig, setActiveCalendarProvider, setCalendarConfig } from '../integrations/calendar-store';

import { createLlmClient, DEFAULT_LLM_CONFIG, summaryDestination } from '../integrations/llm';
import type { LlmConfig, MeetingSummary } from '../integrations/llm';
import { getLlmConfig, setLlmConfig } from '../integrations/llm-store';
import {
  DEFAULT_REMOTE_ASR_CONFIG,
  getRemoteAsrConfig,
  remoteAsrActive,
  remoteAsrEndpoint,
  remoteAsrLabel,
  setRemoteAsrConfig,
  type RemoteAsrConfig,
} from '../integrations/remote-asr';
import { RemoteASREngine } from '../asr/remote-engine';
import { normalizeAgendaItems, type AgendaItem } from '../domain/agenda';
import { settleWithin } from '../domain/settle';
import type { ExportFormat, Moment, WrapStepId, WrapUp } from '../domain/meeting';
import { issueStateKey, newWrapUp } from '../domain/wrapup';
import { updateSegment } from '../storage/transcripts';
import { detectSpeakers } from '../features/meetings/diarize';
import { namedSegments } from '../domain/speakers';
import { keepAwake } from '../platform/system';
import { isWebBuild, WEB_TRANSCRIPTION_HINT } from '../platform/pwa';
import { logNetwork } from '../platform/network-log';
import { recordingPrefs, wrapPrefs, keepAudio, calendarPrefs } from './preferences';
import { StopTrace, formatStopTrace, nextPaint } from '../domain/stop-trace';

/**
 * Where a summary request goes, for the network log: null when it stays on
 * this computer (Ollama/Open WebUI on localhost, local agents' own engine).
 */
/** Longest wait for one best-effort teardown step when a recording stops. */
const STOP_STEP_TIMEOUT_MS = 3000;

/** Print the Stop timings to the console and, on desktop, the terminal. */
function reportStopTrace(trace: StopTrace): void {
  const line = formatStopTrace(trace.steps, trace.totalMs());
  console.info(line);
  if (isDesktopApp()) void invokeDesktop('native_log', { message: line }).catch(() => undefined);
}

export type SettingsTab =
  | 'models'
  | 'recording'
  | 'after'
  | 'summaries'
  | 'integrations'
  | 'storage'
  | 'appearance'
  | 'app';
const SETTINGS_TABS: SettingsTab[] = ['models', 'recording', 'after', 'summaries', 'integrations', 'storage', 'appearance', 'app'];
/** Settings tabs before the redesign (old links keep working). */
const LEGACY_TABS: Record<string, SettingsTab> = {
  calendar: 'integrations',
  sharing: 'integrations',
  ai: 'summaries',
  audio: 'recording',
};

/** Meeting screen tabs (the wrap-up steps, revisited). */
export type MeetingTab = 'transcript' | 'summary' | 'gitlab' | 'calendar' | 'export';
const MEETING_TABS: MeetingTab[] = ['transcript', 'summary', 'gitlab', 'calendar', 'export'];

export type Route =
  | { name: 'home' }
  | { name: 'library'; view?: 'list' | 'month'; q?: string }
  | { name: 'active' }
  /** `q`: a search to pre-fill the transcript filter with (Library hits). */
  | { name: 'detail'; id: string; q?: string; tab?: MeetingTab }
  /** The guided wrap-up after Stop (or "Continue wrap-up"). */
  | { name: 'wrapup'; id: string; step?: WrapStepId }
  | { name: 'settings'; tab?: SettingsTab }
  /** First-run setup (steps 1–7). */
  | { name: 'setup'; step?: number };

/** The route a location hash names. */
export function routeFromHash(h: string): Route {
  if (h.startsWith('#/meeting/')) {
    const [path, rawQuery] = h.slice(10).split('?q=');
    const [rawId, rawTab] = (path ?? '').split('/');
    const q = rawQuery ? decodeURIComponent(rawQuery) : undefined;
    const tab = MEETING_TABS.includes(rawTab as MeetingTab) ? (rawTab as MeetingTab) : undefined;
    return { name: 'detail', id: decodeURIComponent(rawId ?? ''), ...(q ? { q } : {}), ...(tab ? { tab } : {}) };
  }
  if (h.startsWith('#/wrapup/')) {
    const [rawId, rawStep] = h.slice(9).split('/');
    const step = (['transcribe', 'summary', 'gitlab', 'calendar', 'export'] as const).find((x) => x === rawStep);
    return { name: 'wrapup', id: decodeURIComponent(rawId ?? ''), ...(step ? { step } : {}) };
  }
  if (h === '#/active') return { name: 'active' };
  if (h === '#/library' || h.startsWith('#/library?q=')) {
    const q = h.includes('?q=') ? decodeURIComponent(h.split('?q=')[1] ?? '') : undefined;
    return { name: 'library', view: 'list', ...(q ? { q } : {}) };
  }
  if (h === '#/library/month' || h === '#/calendar') return { name: 'library', view: 'month' };
  if (h === '#/settings') return { name: 'settings' };
  if (h.startsWith('#/settings/')) {
    const raw = h.slice(11);
    const tab = LEGACY_TABS[raw] ?? (SETTINGS_TABS.includes(raw as SettingsTab) ? (raw as SettingsTab) : undefined);
    return tab ? { name: 'settings', tab } : { name: 'settings' };
  }
  if (h.startsWith('#/setup')) {
    const step = Number(h.slice(8)) || 1;
    return { name: 'setup', step };
  }
  // '#/', '#/new' (New Meeting now lives on Home) and anything else.
  return { name: 'home' };
}

export function hashOf(r: Route): string {
  switch (r.name) {
    case 'home':
      return '#/';
    case 'active':
      return '#/active';
    case 'library':
      return r.view === 'month' ? '#/library/month' : `#/library${r.q ? `?q=${encodeURIComponent(r.q)}` : ''}`;
    case 'settings':
      return r.tab ? `#/settings/${r.tab}` : '#/settings';
    case 'setup':
      return `#/setup/${r.step ?? 1}`;
    case 'wrapup':
      return `#/wrapup/${encodeURIComponent(r.id)}${r.step ? `/${r.step}` : ''}`;
    case 'detail':
      return `#/meeting/${encodeURIComponent(r.id)}${r.tab ? `/${r.tab}` : ''}${r.q ? `?q=${encodeURIComponent(r.q)}` : ''}`;
  }
}

/** One playable track of a recording (single-track recordings have track ''). */
export interface AudioTrackView {
  track: string;
  label: string;
  /**
   * Reads the recording. Called on first play, not when Meeting Detail opens:
   * a long recording is tens of MB, and Stop → Meeting Detail must stay light.
   */
  load: () => Promise<Blob | null>;
}

interface AppState {
  route: Route;
  go: (r: Route) => void;
  meetings: Meeting[];
  refresh: () => Promise<void>;
  // recording session
  recordingState: RecordingState;
  recordingError: string | null;
  /** 'source' = a capture source was lost (Retry cannot help); 'storage' = writes failed. */
  recordingErrorKind: RecorderErrorKind | null;
  activeMeeting: Meeting | null;
  /** Audio problems detected so far in the running recording (live). */
  recordingIssues: AudioIssue[];
  storageWarning: string | null;
  startRecording: (
    title: string,
    mode: RecordingMode,
    agenda?: AgendaItem[],
    extra?: { calendarSource?: Meeting['calendarSource'] },
  ) => Promise<void>;
  /** Mark a moment in the running recording (press M); returns it. */
  addMoment: (label?: string) => Promise<Moment | null>;
  /** Label (or relabel) a moment of a meeting. */
  labelMoment: (meetingId: string, momentId: string, label: string) => Promise<void>;
  /** While recording: start an agenda topic or tick it off. */
  markAgenda: (itemId: string, what: 'start' | 'done' | 'undo') => Promise<void>;
  /** Fix one transcript line. */
  editSegment: (segmentId: string, text: string) => Promise<void>;
  /** Give a detected speaker a name in this meeting. */
  renameSpeaker: (meetingId: string, speaker: string, name: string) => Promise<void>;
  /** Run local speaker detection; progress in `diarizing`. */
  detectSpeakers: (meetingId: string, speakers?: number) => Promise<void>;
  /** Speaker detection runs by meeting id (0..1). */
  diarizing: Record<string, number>;
  /** Update the guided wrap-up state of a meeting. */
  setWrapUp: (meetingId: string, change: (w: WrapUp) => WrapUp) => Promise<Meeting | undefined>;
  /** Remember a file the Export step / tab saved. */
  recordExport: (meetingId: string, format: ExportFormat, path?: string) => Promise<void>;
  /** Remove every meeting (Settings → Storage: Delete everything). */
  deleteAllMeetings: () => Promise<number>;
  /** Live input levels of the running recording (0..1; microphone first). Polled by the recording screen. */
  recordingLevels: () => Array<{ role: 'microphone' | 'device'; level: number }>;
  /** Remove the audio of meetings past the Keep audio setting; returns how many. */
  applyRetention: (dryRun?: boolean) => Promise<Meeting[]>;
  /** Replace a meeting's agenda (empty list removes it). */
  saveAgenda: (meetingId: string, items: AgendaItem[]) => Promise<Meeting | undefined>;
  /** Upload a meeting's agenda to GitLab (agenda.md / wiki page / issue). */
  uploadAgendaToGitlab: (meetingId: string) => Promise<GitlabUploadResult>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  /** Retry writing audio chunks after a storage failure (§9 Retry). */
  retrySaving: () => Promise<boolean>;
  /** Delete a meeting everywhere, stopping its transcription first (§23). */
  deleteMeeting: (id: string) => Promise<void>;
  /** Change a meeting's title (blank = "Untitled meeting"). */
  renameMeeting: (id: string, title: string) => Promise<void>;
  stopRecording: () => Promise<Meeting | null>;
  /** True from the Stop click until the recording is saved (Active Meeting shows a loader). */
  stopping: boolean;
  /** Desktop: what the shell can record natively (null: webview recording only). */
  nativeRecording: NativeRecorderDevices | null;
  // detail
  detailMeeting: Meeting | null;
  detailSegments: TranscriptSegment[];
  detailTracks: AudioTrackView[];
  loadDetail: (id: string) => Promise<void>;
  // transcription
  txProgress: Record<string, number>;
  txStage: Record<string, TranscriptionStage>;
  transcribe: (id: string, modelId?: string) => Promise<void>;
  /** One click: download the recommended model if none is installed, then transcribe. */
  setupAndTranscribe: (id: string) => Promise<void>;
  /** Model download in flight (bytes), for progress bars; null when idle. */
  modelDownload: { name: string; received: number; total: number } | null;
  /** Model the app downloads on first use for the current engine. */
  firstRunModel: string;
  cancelTranscription: (id: string) => Promise<void>;
  // model
  modelMeta: ModelMeta;
  downloadModel: (id?: string) => Promise<void>;
  selectModel: (id: string) => Promise<void>;
  language: string;
  setLanguage: (id: string) => Promise<void>;
  /** Full native catalog, for the settings screen. */
  modelCatalog: CatalogModel[];
  /** Models already available for transcription (installed). */
  installedModels: CatalogModel[];
  /** Desktop backend probe (null before it resolves). */
  nativeStatus: NativeAsrStatus | null;
  nativeModels: NativeModelInfo[];
  refreshNativeStatus: () => Promise<void>;
  /** Desktop: mirror each finished meeting to a real local folder. */
  saveToDisk: boolean;
  setSaveToDisk: (value: boolean) => void;
  /** Absolute path of the desktop storage folder (null outside desktop). */
  storageDir: string | null;
  openStorageDir: () => Promise<void>;
  /** Create a meeting from an uploaded audio file. */
  importMeeting: (file: File) => Promise<void>;
  /** GitLab integration settings (kept on-device in IndexedDB). */
  gitlabConfig: GitlabConfig;
  saveGitlabConfig: (config: GitlabConfig) => Promise<void>;
  /** Upload a meeting's transcript to GitLab; returns the created URL. */
  uploadToGitlab: (meetingId: string) => Promise<GitlabUploadResult>;

  uploadSummaryToGitlab: (meetingId: string) => Promise<GitlabUploadResult>;
  /** One GitLab issue per selected summary action item (their text). */
  createGitlabActionIssues: (
    meetingId: string,
    items: string[],
    overrides?: Record<string, IssueOverride>,
    /** Project path to create them in (default: the configured project). */
    project?: string,
  ) => Promise<ActionIssueResult[]>;
  /** Open/closed state of a meeting's issues, keyed by `issueStateKey`, with when it was read. */
  issueStates: Record<string, { at: number; states: Record<string, 'opened' | 'closed'> }>;
  /** The meeting's participants (owners, assignees, invitees). */
  meetingParticipants: (meetingId: string) => Participant[];
  setParticipants: (meetingId: string, people: Participant[]) => Promise<void>;
  /** Members of a GitLab project or group as participants (with public e-mails). */
  loadGitlabPeople: (from: { project: string } | { groupId: number; name: string }) => Promise<Participant[]>;
  refreshIssueStates: (meetingId: string) => Promise<void>;
  /** Post the summary to the wiki page Meetings/<date>-<title>. */
  postSummaryToWiki: (meetingId: string) => Promise<GitlabUploadResult>;

  calendarConfig: CalendarConfig;
  saveCalendarConfig: (config: CalendarConfig) => Promise<void>;
  switchCalendarProvider: (provider: CalendarProvider) => Promise<void>;
  fetchCalendarEvents: (start: Date, end: Date) => Promise<ServerEvent[]>;
  /** Create one approved event; `item` = the summary action item it is for. */
  createCalendarEvent: (meetingId: string, draft: CalendarEventDraft, item?: string) => Promise<CalendarCreateResult>;
  /** Custom LLM provider settings (kept on-device in IndexedDB). */
  llmConfig: LlmConfig;
  saveLlmConfig: (config: LlmConfig) => Promise<void>;
  /** Save an edited / reviewed summary (wrap-up "Review summary", Summary tab). */
  saveSummary: (meetingId: string, summary: NonNullable<Meeting['summary']>) => Promise<void>;
  /** External transcription server (Open WebUI); used when enabled. */
  remoteAsrConfig: RemoteAsrConfig;
  saveRemoteAsrConfig: (config: RemoteAsrConfig) => Promise<void>;
  /** Summarize a transcribed meeting with the configured LLM provider. */
  summarizeMeeting: (meetingId: string) => Promise<MeetingSummary>;
  summarizing: Record<string, true>;
  /** The list Meeting Detail was opened from (its back link). */
  returnTo: 'home' | 'library' | 'month';
  /** Result of the last update check (desktop only; null before any check). */
  updateInfo: UpdateInfo | null;
  /** Ask GitHub for a newer release (never installs anything). */
  checkUpdates: () => Promise<UpdateInfo>;
  /** Enable GPU acceleration via the desktop backend (desktop only). */
  enableGpu: () => Promise<void>;
  // live transcription (desktop, opt-in)
  /** Transcribe while recording (pref; applies to the next recording). */
  liveEnabled: boolean;
  setLiveTranscription: (enabled: boolean) => void;
  /** Saved live model choice (a native model name). */
  liveModel: string;
  setLiveModelChoice: (id: string) => void;
  /** Models live transcription can use (installed + the recommended small one). */
  liveOptions: LiveModelOption[];
  /** The model the next recording will use live (null = none usable). */
  liveChoice: LiveModelOption | null;
  /** Live-model download in flight (bytes); null when idle. */
  liveDownload: { name: string; received: number; total: number } | null;
  /** Download a model for live use without changing the main transcription model. */
  downloadLiveModel: (name: string) => Promise<void>;
  /** Live transcript of the recording in progress (null when off). */
  live: LiveSnapshot | null;
  // recovery
  unfinished: Meeting[];
  recoverUnfinished: (id: string) => Promise<void>;
  discardUnfinished: (id: string) => Promise<void>;
  /**
   * Linux desktop: system audio is captured through the sound server (Device
   * Audio / Two-way record what the computer plays, no screen picker).
   */
  systemAudio: SystemAudioStatus | null;
  /** The app database could not be opened (null when fine). */
  databaseError: string | null;
  /**
   * Desktop (Linux): move the unreadable database into a backup folder and
   * relaunch with a fresh one. Settings and the local-files mirror are kept.
   */
  resetDatabase: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);
/**
 * The recording clock ticks every 500 ms. It lives in its own context so only
 * the components that show it re-render, not every `useApp()` consumer.
 */
const ElapsedCtx = createContext(0);

/** Recorded time of the live recording (excludes pauses). */
export function useElapsedMs(): number {
  return useContext(ElapsedCtx);
}

/** The live recording time as text; re-renders alone on every tick. */
export function ElapsedClock(): React.JSX.Element {
  return <>{formatDuration(useElapsedMs())}</>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [recordingState, setRecordingState] = useState<RecordingState>('IDLE');
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [recordingErrorKind, setRecordingErrorKind] = useState<RecorderErrorKind | null>(null);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);
  const [detailSegments, setDetailSegments] = useState<TranscriptSegment[]>([]);
  const [detailTracks, setDetailTracks] = useState<AudioTrackView[]>([]);
  const [txProgress, setTxProgress] = useState<Record<string, number>>({});
  const [txStage, setTxStage] = useState<Record<string, TranscriptionStage>>({});
  /** Meetings whose summary is being written (survives leaving the page). */
  const [summarizing, setSummarizing] = useState<Record<string, true>>({});
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const checkUpdates = useCallback(async (): Promise<UpdateInfo> => {
    logNetwork('github.com', 'Checked for updates', 'App version');
    const info = await checkForUpdate();
    setLastCheck(Date.now());
    setUpdateInfo(info);
    return info;
  }, []);

  // Launch check (desktop, opt-out in Settings): only tells the user a new
  // version exists; installing always needs a click.
  useEffect(() => {
    if (!isDesktopApp() || !getAutoCheck()) return;
    const t = window.setTimeout(() => void checkUpdates().catch(() => undefined), 5000);
    return () => window.clearTimeout(t);
  }, [checkUpdates]);
  const [modelMeta, setModelMetaState] = useState<ModelMeta>({
    modelId: NATIVE_DEFAULT_MODEL,
    state: 'not_installed',
    progress: 0,
    updatedAt: Date.now(),
  });
  const [language, setLanguageState] = useState<string>(DEFAULT_NATIVE_LANGUAGE);
  /** The user picked a language: the (slower) startup load must not overwrite it. */
  const languageChosenRef = useRef(false);
  const [nativeStatus, setNativeStatusState] = useState<NativeAsrStatus | null>(null);
  // Desktop-only: mirror finished meetings to a user-visible folder.
  const [saveToDisk, setSaveToDiskState] = useState<boolean>(
    () => getPref('desktop-save-to-disk') !== 'false',
  );
  const [storageDir, setStorageDir] = useState<string | null>(null);
  const [gitlabConfig, setGitlabConfigState] = useState<GitlabConfig>(DEFAULT_GITLAB_CONFIG);
  const [llmConfig, setLlmConfigState] = useState<LlmConfig>(DEFAULT_LLM_CONFIG);
  const [remoteAsrConfig, setRemoteAsrConfigState] = useState<RemoteAsrConfig>(DEFAULT_REMOTE_ASR_CONFIG);
  const [calendarConfig, setCalendarConfigState] = useState<CalendarConfig>(DEFAULT_CALENDAR_CONFIG);
  const [unfinished, setUnfinished] = useState<Meeting[]>([]);
  const [databaseError, setDatabaseError] = useState<string | null>(null);
  const [systemAudio, setSystemAudio] = useState<SystemAudioStatus | null>(null);
  const [modelDownload, setModelDownload] = useState<{ name: string; received: number; total: number } | null>(null);
  const [liveEnabled, setLiveEnabledState] = useState<boolean>(() => getLiveEnabled());
  const [liveModel, setLiveModelState] = useState<string>(() => getLiveModel());
  const [liveDownload, setLiveDownload] = useState<{ name: string; received: number; total: number } | null>(null);
  const [live, setLive] = useState<LiveSnapshot | null>(null);
  /** Live transcription of the recording in progress. */
  const liveRef = useRef<{ transcriber: LiveTranscriber; tap: LiveFeed; timer: ReturnType<typeof setInterval> } | null>(null);
  /** Model live transcription uses (computed further down, read when a recording starts). */
  const liveChoiceRef = useRef<LiveModelOption | null>(null);
  /** Meeting Detail currently shown (late async results must not land on another one). */
  const detailIdRef = useRef<string | null>(null);
  /** Live transcripts still finishing after Stop, by meeting id. */
  /** Latest transcribe / installed-model count for the Stop flow (opt-in auto-transcribe). */
  const transcribeRef = useRef<((id: string) => Promise<void>) | null>(null);
  const installedCountRef = useRef(0);
  const remoteActiveRef = useRef(false);
  const liveDrainRef = useRef(new Map<string, { transcriber: LiveTranscriber; done: Promise<void> }>());
  const recorderRef = useRef<MediaRecorderAudioRecorder | NativeRecorder | null>(null);
  /** Desktop: what the native recorder can capture (null: webview recording only). */
  const [nativeDevices, setNativeDevices] = useState<NativeRecorderDevices | null>(null);
  const nativeDevicesRef = useRef<NativeRecorderDevices | null>(null);
  /** Desktop: writes the live recording into the local folder chunk by chunk. */
  const liveMirrorRef = useRef<LiveAudioMirror | null>(null);
  /** The native recorder appends the audio to the local folder itself. */
  const nativeMirrorRef = useRef(false);
  const diagRef = useRef<{ collector: RecordingDiagnosticsCollector; timer: ReturnType<typeof setInterval> } | null>(null);
  const [recordingIssues, setRecordingIssues] = useState<AudioIssue[]>([]);
  const timerRef = useRef<number | null>(null);
  /** Id of the recording in progress: it is never "unfinished" (§15). */
  const activeIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMeetings(await listMeetings());
      setDatabaseError(null);
    } catch (err) {
      if (err instanceof DatabaseOpenError) {
        setDatabaseError(err.message);
        return;
      }
      throw err;
    }
    const found = (await findUnfinishedMeetings()).filter((m) => m.id !== activeIdRef.current);
    // Estimate each interrupted recording's length from its stored chunks,
    // not from "now - startedAt" (which grows for as long as the app was closed).
    const withEstimates = await Promise.all(
      found.map(async (m) => {
        const tracks = await listTracks(m.id).catch(() => [] as string[]);
        const counts = await Promise.all(tracks.map((t) => listChunkNames(m.id, t).then((n) => n.length)));
        return { ...m, durationMs: estimateDurationFromChunks(counts), durationEstimated: true };
      }),
    );
    setUnfinished(withEstimates);
  }, []);

  // Resolve the desktop storage folder once, for the Settings card.
  useEffect(() => {
    if (!isDesktopApp()) return;
    void desktopStorageDir().then(setStorageDir).catch(() => undefined);
  }, []);

  useEffect(() => {
    // Nothing transcribes yet: a meeting still at `processing` is left over
    // from a run the app did not survive (closed or crashed mid-run).
    void listMeetings()
      .then(recoverInterruptedTranscriptions)
      .catch(() => 0)
      .then(async (recovered) => {
        // Meeting Detail may have loaded the stale row first (app opened on it).
        const id = detailIdRef.current;
        if (recovered > 0 && id) {
          const m = await getMeeting(id).catch(() => undefined);
          if (m) setDetailMeeting((d) => (detailIdRef.current === id ? m : d));
        }
        await refresh();
      });
    // Hash routing so navigation survives reloads.
    const sync = () => {
      const h = window.location.hash;
      const r = routeFromHash(h);
      // Old links (#/new, #/calendar, old settings tabs) show their new address.
      if (/^#\/(new|calendar)$/.test(h) || (h.startsWith('#/settings/') && hashOf(r) !== h)) {
        history.replaceState(null, '', hashOf(r));
      }
      setRoute(r);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [refresh]);

  // Linux desktop: can Device Audio capture system sound directly?
  useEffect(() => {
    if (!isDesktopApp()) return;
    void systemAudioStatus().then(setSystemAudio);
  }, []);

  // Desktop: recording runs in the shell when it can capture the inputs.
  useEffect(() => {
    if (!isDesktopApp()) return;
    void nativeRecorderDevices().then((d) => {
      nativeDevicesRef.current = d;
      setNativeDevices(d);
    });
  }, []);

  // Detect the desktop backend on mount.
  useEffect(() => {
    if (!isDesktopApp()) return;
    let cancelled = false;
    void fetchNativeStatus()
      .then((status) => {
        if (!cancelled) setNativeStatusState(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshNativeStatus = useCallback(async () => {
    if (!isDesktopApp()) return;
    try {
      setNativeStatusState(await fetchNativeStatus());
    } catch {
      // Native probe is best-effort; keep the current status on failure.
    }
  }, []);

  const enableGpu = useCallback(async () => {
    await nativeEnableGpu();
    await refreshNativeStatus();
  }, [refreshNativeStatus]);

  // Native model + language selection.
  useEffect(() => {
    void getModelMeta().then(setModelMetaState).catch(() => undefined);
    void getTranscriptionLanguage()
      .then((stored) => {
        if (!languageChosenRef.current) setLanguageState(stored);
      })
      .catch(() => undefined);
    void getGitlabConfig().then(setGitlabConfigState).catch(() => undefined);
    void getCalendarConfig().then(setCalendarConfigState).catch(() => undefined);
    void getLlmConfig().then(setLlmConfigState).catch(() => undefined);
    void getRemoteAsrConfig().then(setRemoteAsrConfigState).catch(() => undefined);
  }, []);

  /** Where Meeting Detail's back link leads (the list the meeting was opened from). */
  const [returnTo, setReturnTo] = useState<'home' | 'library' | 'month'>('library');
  const routeRef = useRef<Route>({ name: 'home' });
  routeRef.current = route;
  const go = useCallback((r: Route) => {
    const from = routeRef.current;
    if (r.name === 'detail' && (from.name === 'home' || from.name === 'library')) {
      setReturnTo(from.name === 'library' ? (from.view === 'month' ? 'month' : 'library') : 'home');
    }
    window.location.hash = hashOf(r);
    setRoute(r);
  }, []);

  useEffect(() => {
    const live = recordingState === 'RECORDING' || recordingState === 'PAUSED' || recordingState === 'ERROR';
    if (live && activeMeeting) {
      // Pause-aware: the recorder's clock excludes paused stretches.
      const tick = () => setElapsedMs(recorderRef.current?.getElapsedMs() ?? 0);
      tick();
      timerRef.current = window.setInterval(tick, 500);
    } else if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [recordingState, activeMeeting]);

  // Native transcription service (tests can inject their own engine).
  const txService = useMemo(() => {
    const callbacks = {
      onProgress: (id: string, ratio: number) => setTxProgress((p) => ({ ...p, [id]: ratio })),
      onStage: (id: string, stage: TranscriptionStage) =>
        setTxStage((p) => ({ ...p, [id]: stage })),
    };
    return new TranscriptionService(callbacks);
  }, []);

  /**
   * Measure the inputs while recording (levels, clipping, bleed, Bluetooth
   * call mode, device changes). Best-effort: never affects the recording.
   * Saved on the meeting every 30 s so a crash keeps what was measured.
   */
  const startDiagnostics = useCallback(
    (id: string, mode: RecordingMode, startedAt: number, source: TrackSpec['source'] | NativeRecorder) => {
      const collector = new RecordingDiagnosticsCollector(mode, startedAt);
      let inputs: DiagnosticsInput[] = [];
      let ctx: AudioContext | null = null;
      // Native recording: measured in the shell; the collector only adds the
      // sound-server log and the device events.
      const native = source instanceof NativeRecorder ? source : null;
      if (source instanceof NativeRecorder) {
        inputs = [];
      } else if (source instanceof MixedAudioSource) {
        const graph = source.graph();
        ctx = graph?.ctx ?? null;
        const [micStream, deviceStream] = graph?.inputs ?? [];
        inputs = [
          ...(micStream ? [{ role: 'microphone' as const, stream: micStream }] : []),
          ...(deviceStream ? [{ role: 'device' as const, stream: deviceStream }] : []),
        ];
      } else {
        const stream = source.currentStream?.() ?? null;
        if (stream) inputs = [{ role: mode === 'device' ? 'device' : 'microphone', stream }];
      }
      let ticks = 0;
      const timer = setInterval(() => {
        ticks++;
        if (native) collector.setNativeMeasurements(native.diagnostics());
        setRecordingIssues(collector.report().issues.filter((i) => i.severity === 'problem'));
        if (ticks % 15 === 0) {
          void collector
            .refreshNative()
            .then(() => updateMeeting(id, { diagnostics: collector.report() }))
            .catch(() => undefined);
        }
      }, 2000);
      diagRef.current = { collector, timer };
      setRecordingIssues([]);
      void collector.start(inputs, ctx).catch(() => undefined);
    },
    [],
  );

  /** Stop measuring (before the sources stop) and return the final report. */
  const stopDiagnostics = useCallback(async (native?: NativeDiagnostics | null) => {
    const diag = diagRef.current;
    diagRef.current = null;
    setRecordingIssues([]);
    if (!diag) return undefined;
    clearInterval(diag.timer);
    if (native) diag.collector.setNativeMeasurements(native);
    // Best-effort and bounded: a stuck sound-server log never holds Stop.
    const report = await settleWithin(diag.collector.stop(), STOP_STEP_TIMEOUT_MS, undefined);
    return report ?? diag.collector.report();
  }, []);

  /**
   * Transcribe while recording, when enabled and a model is usable. Taps the
   * recorded stream (the mix for Mic + Device). Best-effort: a failure here
   * only shows on Active Meeting and never affects the recording.
   */
  const startLive = useCallback(
    async (id: string, source: TrackSpec['source'] | NativeRecorder) => {
      const choice = liveChoiceRef.current;
      if (!isDesktopApp() || !getLiveEnabled() || !choice) return;
      const transcriber = new LiveTranscriber(id, choice.id, language);
      transcriber.onUpdate(setLive);
      if (source instanceof NativeRecorder) {
        // The shell collects 16 kHz audio of the mix; pull it.
        const feed = new NativeLiveFeed(source, (samples) => transcriber.push(samples));
        feed.start();
        liveRef.current = { transcriber, tap: feed, timer: setInterval(() => transcriber.tick(), 700) };
        setLive(transcriber.snapshot());
        return;
      }
      const tap = new LivePcmTap((samples) => transcriber.push(samples));
      const timer = setInterval(() => transcriber.tick(), 700);
      liveRef.current = { transcriber, tap, timer };
      setLive(transcriber.snapshot());
      try {
        const stream = source.currentStream?.() ?? null;
        if (!stream) throw new Error('The recorded audio is not available for live transcription.');
        const ctx = source instanceof MixedAudioSource ? (source.graph()?.ctx ?? null) : null;
        await tap.start(stream, ctx);
      } catch (err) {
        clearInterval(timer);
        await tap.stop();
        transcriber.cancel();
        // Recording may have stopped meanwhile: only report on the live one.
        if (liveRef.current?.transcriber !== transcriber) return;
        liveRef.current = null;
        setLive({
          ...transcriber.snapshot(),
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [language],
  );

  /** Stop feeding live audio (before the capture sources stop). */
  const stopLive = useCallback(async (): Promise<LiveTranscriber | null> => {
    const current = liveRef.current;
    liveRef.current = null;
    setLive(null);
    if (!current) return null;
    clearInterval(current.timer);
    await settleWithin(current.tap.stop(), STOP_STEP_TIMEOUT_MS, undefined);
    return current.transcriber;
  }, []);

  const startRecording = useCallback(
    async (
      title: string,
      mode: RecordingMode,
      agenda: AgendaItem[] = [],
      extra: { calendarSource?: Meeting['calendarSource'] } = {},
    ) => {
      setRecordingError(null);
      // Storage estimate check (§19).
      const est = await estimateStorage().catch(() => ({}));
      if (isStorageLow(est)) {
        setStorageWarning('Storage is getting low. Recording may fail if space runs out.');
      } else setStorageWarning(null);

      const id = newMeetingId();
      const now = Date.now();
      const meeting: Meeting = {
        id,
        title:
          title.trim() ||
          `Meeting ${new Date(now).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`,
        mode,
        createdAt: now,
        startedAt: now,
        durationMs: 0,
        audioPath: `meetings/${id}`,
        mimeType: '',
        transcriptionStatus: 'not_started',
        unfinished: true,
      };
      const agendaItems = normalizeAgendaItems(agenda);
      if (agendaItems.length > 0) meeting.agenda = { items: agendaItems, updatedAt: now };
      if (extra.calendarSource) meeting.calendarSource = extra.calendarSource;
      // Settings → Recording: keep the computer awake while recording (best-effort).
      // The phone/web app always keeps the screen on: a locked phone may pause the mic.
      if (recordingPrefs().keepAwake || isWebBuild()) void keepAwake(true);
      const watch = (recorder: MediaRecorderAudioRecorder | NativeRecorder) =>
        recorder.onState((s) => {
          setRecordingState(s);
          // Surface storage failures instead of implying audio is safe (§19).
          if (s === 'ERROR') {
            setRecordingError(recorder.getError()?.message ?? 'Recording error');
            setRecordingErrorKind(recorder.getErrorKind());
          } else if (s === 'RECORDING' || s === 'PAUSED') {
            setRecordingError(null);
            setRecordingErrorKind(null);
          }
        });

      // Desktop: record in the shell (capture, mix, encode, write — nothing in
      // the webview to tear down at Stop). Falls back to the webview recorder
      // when the shell cannot open the inputs (e.g. system sound on macOS < 14.2).
      if (isDesktopApp() && nativeRecordingEnabled() && nativeSupportsMode(nativeDevicesRef.current, mode)) {
        const recorder = new NativeRecorder();
        const saveDisk = getPref('desktop-save-to-disk') !== 'false';
        const native: Meeting = { ...meeting, mimeType: NATIVE_MIME_TYPE };
        watch(recorder);
        activeIdRef.current = id;
        await saveMeeting(native);
        try {
          await recorder.start({
            meetingId: id,
            mode,
            startedAt: now,
            microphone: mode === 'device' ? undefined : getMicrophoneDevice()?.label,
            output: mode === 'speaker' ? undefined : getSystemOutput() || undefined,
            mirrorPath: saveDisk ? audioMirrorPath(native, NATIVE_MIME_TYPE) : undefined,
            live: getLiveEnabled() && !!liveChoiceRef.current,
          });
          recorderRef.current = recorder;
          liveMirrorRef.current = null;
          nativeMirrorRef.current = saveDisk;
          setActiveMeeting(native);
          setElapsedMs(0);
          startDiagnostics(id, mode, now, recorder);
          void startLive(id, recorder);
          go({ name: 'active' });
          await refresh();
          return;
        } catch (err) {
          console.warn('Native recording unavailable; recording in the webview instead.', err);
          activeIdRef.current = null;
          await deleteRecording(id).catch(() => undefined);
        }
      }
      // Mic + Device: the microphone and the device/system audio are mixed into
      // one track (one file, no Me/Others split). Every mode records flat.
      // Linux desktop records system sound via the sound server; elsewhere
      // the screen-share picker provides device audio.
      // Input/output chosen in Settings or on New Meeting (default otherwise).
      const micId = mode === 'device' ? undefined : await chosenMicrophoneId().catch(() => undefined);
      const mic = () => new MicrophoneAudioSource(micId);
      const deviceSource = () =>
        systemAudio?.available ? new SystemAudioSource(getSystemOutput()) : new DeviceAudioSource();
      const source =
        mode === 'speaker' ? mic() : mode === 'device' ? deviceSource() : new MixedAudioSource([mic(), deviceSource()]);
      const specs: TrackSpec[] = [{ track: '', source }];
      const recorder = new MediaRecorderAudioRecorder();
      recorderRef.current = recorder;
      nativeMirrorRef.current = false;
      // Desktop: append each chunk to the local folder as it is recorded, so
      // Stop does not copy the whole recording at once.
      const liveMirror =
        isDesktopApp() && getPref('desktop-save-to-disk') !== 'false' ? new LiveAudioMirror(meeting) : null;
      liveMirrorRef.current = liveMirror;
      if (liveMirror) recorder.onChunk((c) => liveMirror.push(c.track, c.mimeType, c.data));
      watch(recorder);
      activeIdRef.current = id;
      await saveMeeting(meeting);
      setActiveMeeting(meeting);
      setElapsedMs(0);
      try {
        await recorder.startTracks(specs, id, now);
        startDiagnostics(id, mode, now, source);
        void startLive(id, source);
        const meta = await getMeeting(id);
        if (meta) {
          const stored = await readMeta(id).catch(() => null);
          if (stored) {
            const withMime = {
              ...meta,
              mimeType: stored.mimeType,
              tracks: stored.tracks ?? meta.tracks,
            };
            await saveMeeting(withMime);
            setActiveMeeting(withMime);
          }
        }
        go({ name: 'active' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setRecordingError(msg);
        await stopLive().then((t) => t?.cancel());
        await stopDiagnostics();
        await deleteRecording(id).catch(() => undefined);
        const existing = await getMeeting(id).catch(() => undefined);
        if (existing) {
          await deleteMeetingRecord(id).catch(() => undefined);
        }
        setActiveMeeting(null);
        activeIdRef.current = null;
        liveMirrorRef.current = null;
        throw err;
      }
      await refresh();
    },
    [go, refresh, systemAudio, startDiagnostics, stopDiagnostics, startLive, stopLive],
  );

  const pauseRecording = useCallback(async () => {
    await recorderRef.current?.pause();
    liveRef.current?.tap.setPaused(true);
  }, []);

  const resumeRecording = useCallback(async () => {
    liveRef.current?.tap.setPaused(false);
    await recorderRef.current?.resume();
  }, []);

  const retrySaving = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder) return true;
    const ok = await recorder.retryPending();
    if (!ok) setRecordingError(recorder.getError()?.message ?? 'Audio could not be saved to disk.');
    return ok;
  }, []);

  // Best-effort mirror of a finished meeting to the desktop folder.
  const mirrorToDisk = useCallback(async (meeting: Meeting | null, audio?: MirrorAudio) => {
    if (!meeting || !isDesktopApp()) return;
    if (getPref('desktop-save-to-disk') === 'false') return;
    try {
      await mirrorMeetingToDisk(meeting, audio);
    } catch {
      // Non-fatal: OPFS/IndexedDB remain the source of truth.
    }
  }, []);

  const setSaveToDisk = useCallback((value: boolean) => {
    setSaveToDiskState(value);
    setPref('desktop-save-to-disk', value ? 'true' : 'false');
  }, []);

  const openStorageDir = useCallback(async () => {
    if (!isDesktopApp()) return;
    await openDesktopStorageDir();
  }, []);

  const importMeeting = useCallback(
    async (file: File) => {
      setRecordingError(null);
      const meeting = await importAudioFile(file);
      await refresh();
      go({ name: 'detail', id: meeting.id });
    },
    [go, refresh],
  );

  const saveGitlabConfig = useCallback(async (config: GitlabConfig) => {
    await setGitlabConfig(config);
    setGitlabConfigState(config);
  }, []);

  const uploadToGitlab = useCallback(
    async (meetingId: string): Promise<GitlabUploadResult> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      const segments = namedSegments(await getSegments(meetingId), meeting.speakerNames);
      logNetwork(gitlabConfig.url, `Uploaded the transcript of "${meeting.title}"`, `Transcript (${segments.length} lines)`);
      const result = await createGitlabClient(gitlabConfig).uploadMeeting(meeting, segments);
      const updated = await updateMeeting(meetingId, {
        gitlab: { url: result.url, target: result.target, uploadedAt: Date.now() },
      });
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return result;
    },
    [gitlabConfig],
  );

  const uploadSummaryToGitlab = useCallback(
    async (meetingId: string): Promise<GitlabUploadResult> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      logNetwork(gitlabConfig.url, `Posted the summary of "${meeting.title}"`, 'Summary only');
      const result = await createGitlabClient(gitlabConfig).uploadSummary(meeting);
      const updated = await updateMeeting(meetingId, {
        gitlabSummary: { url: result.url, target: result.target, uploadedAt: Date.now() },
      });
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return result;
    },
    [gitlabConfig],
  );

  /**
   * One GitLab issue per selected action item of the summary (`items` = the
   * action item lines). Created issues are kept on the meeting, also when a
   * later one fails (the error carries them as `created`).
   */
  const createGitlabActionIssues = useCallback(
    async (meetingId: string, items: string[], overrides?: Record<string, IssueOverride>, project?: string): Promise<ActionIssueResult[]> => {
      const target = (project || gitlabConfig.project).trim();
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      const wanted = actionItemsOf(meeting).filter((a) => items.includes(a.text));
      if (wanted.length === 0) throw new Error('Select at least one action item');
      const record = async (created: ActionIssueResult[]) => {
        if (created.length === 0) return;
        const now = Date.now();
        const updated = await updateMeeting(meetingId, (cur) => ({
          ...cur,
          gitlabActionIssues: [...(cur.gitlabActionIssues ?? []), ...created.map((c) => ({ ...c, createdAt: now }))],
        }));
        if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      };
      logNetwork(
        gitlabConfig.url,
        `Created ${wanted.length} issue${wanted.length === 1 ? '' : 's'} in ${target} from "${meeting.title}"`,
        `${wanted.length} title${wanted.length === 1 ? '' : 's'}, ${wanted.length} quote${wanted.length === 1 ? '' : 's'}`,
      );
      try {
        const segments = await getSegments(meetingId).catch(() => [] as TranscriptSegment[]);
        const created = await createGitlabClient({ ...gitlabConfig, project: target }).createActionItemIssues(meeting, wanted, { overrides, segments });
        await record(created);
        return created;
      } catch (err) {
        await record((err as { created?: ActionIssueResult[] }).created ?? []);
        throw err;
      }
    },
    [gitlabConfig],
  );

  const [issueStates, setIssueStates] = useState<AppState['issueStates']>({});
  const refreshIssueStates = useCallback(
    async (meetingId: string) => {
      const meeting = await getMeeting(meetingId);
      const issues = (meeting?.gitlabActionIssues ?? []).filter((i) => i.iid !== undefined);
      if (!meeting || issues.length === 0) return;
      logNetwork(gitlabConfig.url, `Refreshed issue status for "${meeting.title}"`, `${issues.length} issue numbers`);
      const byProject = new Map<string, number[]>();
      for (const i of issues) {
        const p = (i.project || gitlabConfig.project).trim();
        byProject.set(p, [...(byProject.get(p) ?? []), i.iid!]);
      }
      const client = createGitlabClient(gitlabConfig);
      const states: Record<string, 'opened' | 'closed'> = {};
      for (const [project, iids] of byProject) {
        const got = await client.issueStates(iids, project);
        for (const [iid, st] of Object.entries(got)) states[issueStateKey({ project, iid: Number(iid) }, gitlabConfig.project)] = st;
      }
      setIssueStates((cur) => ({ ...cur, [meetingId]: { at: Date.now(), states } }));
    },
    [gitlabConfig],
  );

  const postSummaryToWiki = useCallback(
    async (meetingId: string): Promise<GitlabUploadResult> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      logNetwork(gitlabConfig.url, `Posted the summary of "${meeting.title}" to the wiki`, 'Summary only');
      const result = await createGitlabClient(gitlabConfig).postSummaryToWiki(meeting);
      const updated = await updateMeeting(meetingId, {
        gitlabSummary: { url: result.url, target: 'wiki', uploadedAt: Date.now() },
      });
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return result;
    },
    [gitlabConfig],
  );

  const saveAgenda = useCallback(
    async (meetingId: string, items: AgendaItem[]): Promise<Meeting | undefined> => {
      const clean = normalizeAgendaItems(items);
      const updated = await updateMeeting(meetingId, (cur) => {
        const { agenda: _old, ...rest } = cur;
        return clean.length > 0 ? { ...rest, agenda: { items: clean, updatedAt: Date.now() } } : rest;
      });
      if (!updated) return undefined;
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      // The live recording keeps its own copy (stopRecording saves from it).
      setActiveMeeting((a) => (a && a.id === meetingId ? { ...a, agenda: updated.agenda } : a));
      if (!updated.unfinished) void mirrorToDisk(updated);
      await refresh();
      return updated;
    },
    [mirrorToDisk, refresh],
  );

  const uploadAgendaToGitlab = useCallback(
    async (meetingId: string): Promise<GitlabUploadResult> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      logNetwork(gitlabConfig.url, `Uploaded the agenda of "${meeting.title}"`, 'Agenda only');
      const result = await createGitlabClient(gitlabConfig).uploadAgenda(meeting);
      const updated = await updateMeeting(meetingId, {
        gitlabAgenda: { url: result.url, target: result.target, uploadedAt: Date.now() },
      });
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return result;
    },
    [gitlabConfig],
  );

  const saveLlmConfig = useCallback(async (config: LlmConfig) => {
    await setLlmConfig(config);
    setLlmConfigState(config);
  }, []);

  const saveRemoteAsrConfig = useCallback(async (config: RemoteAsrConfig) => {
    await setRemoteAsrConfig(config);
    setRemoteAsrConfigState(config);
  }, []);

  const saveCalendarConfig = useCallback(async (config: CalendarConfig) => {
    await setCalendarConfig(config);
    setCalendarConfigState(config);
  }, []);

  const switchCalendarProvider = useCallback(async (provider: CalendarProvider) => {
    const store = await setActiveCalendarProvider(provider);
    setCalendarConfigState(store.configs[store.activeProvider]);
  }, []);

  const fetchCalendarEvents = useCallback(
    async (start: Date, end: Date): Promise<ServerEvent[]> => {
      if (!isDesktopApp()) return [];
      logNetwork(calendarConfig.serverUrl || 'graph.microsoft.com', 'Listed calendar events', 'Account + date range');
      return fetchServerEvents(calendarConfig, start, end);
    },
    [calendarConfig],
  );

  const lastEventAtRef = useRef(0);
  const createCalendarEvent = useCallback(
    async (meetingId: string, draft: CalendarEventDraft, item?: string): Promise<CalendarCreateResult> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      // Strictly increasing: events created back to back keep distinct UIDs.
      const createdAt = Math.max(Date.now(), lastEventAtRef.current + 1);
      lastEventAtRef.current = createdAt;
      const uid = eventUid(meetingId, createdAt);
      // Settings → GitLab & calendar: "Add follow-ups to" another calendar of the account.
      const followup = calendarPrefs().followupCalendar.trim();
      const target = followup && calendarConfig.provider === 'caldav' ? { ...calendarConfig, calendarUrl: followup } : calendarConfig;
      const transport = buildTransport(target, draft, uid);
      logNetwork(calendarConfig.serverUrl || 'graph.microsoft.com', `Added "${draft.title}" to the calendar`, `Event title, time, description${draft.attendees?.length ? `, ${draft.attendees.length} invitee e-mail${draft.attendees.length === 1 ? '' : 's'}` : ''}`);
      await invokeDesktop<string>('native_calendar_create', { request: transport });
      const record = {
        uid,
        provider: calendarConfig.provider,
        title: draft.title,
        startIso: draft.startIso,
        createdAt,
        ...(item ? { item } : {}),
        ...(draft.attendees?.length ? { attendees: draft.attendees } : {}),
      };
      const updated = await updateMeeting(meetingId, (cur) => ({
        ...cur,
        calendarEvent: { provider: calendarConfig.provider, createdAt },
        calendarEvents: [...(cur.calendarEvents ?? []), record],
      }));
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return { provider: calendarConfig.provider };
    },
    [calendarConfig],
  );

  const summarizeMeeting = useCallback(
    async (meetingId: string): Promise<MeetingSummary> => {
      const meeting = await getMeeting(meetingId);
      if (!meeting) throw new Error('Meeting not found');
      if (meeting.transcriptionStatus !== 'completed') {
        throw new Error('Transcribe the meeting before summarizing it');
      }
      setSummarizing((cur) => ({ ...cur, [meetingId]: true }));
      let result: Awaited<ReturnType<ReturnType<typeof createLlmClient>['summarize']>>;
      try {
        const segments = namedSegments(await getSegments(meetingId), meeting.speakerNames);
        const markdown = segmentsToMarkdown(meeting.title, meeting.startedAt, segments);
        const client = createLlmClient(llmConfig);
        const where = summaryDestination(llmConfig);
        if (where) logNetwork(where, `Summarized "${meeting.title}"`, `Full transcript (${segments.length} lines)`);
        result = await client.summarize(meeting.title, markdown);
      } finally {
        setSummarizing((cur) => {
          const next = { ...cur };
          delete next[meetingId];
          return next;
        });
      }
      const summary: MeetingSummary = {
        text: result.summary,
        keyPoints: result.keyPoints,
        actionItems: result.actionItems,
        ...(result.decisions ? { decisions: result.decisions } : {}),
        ...(result.openQuestions ? { openQuestions: result.openQuestions } : {}),
        model: llmConfig.model.trim(),
        createdAt: Date.now(),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      };
      const updated = await updateMeeting(meetingId, { summary });
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return summary;
    },
    [llmConfig],
  );

  const saveSummary = useCallback(async (meetingId: string, summary: NonNullable<Meeting['summary']>) => {
    const updated = await updateMeeting(meetingId, { summary });
    if (updated) {
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      setMeetings((list) => list.map((x) => (x.id === meetingId ? updated : x)));
    }
  }, []);

  /**
   * After Stop: transcribe the utterances still queued, then save the live
   * text as the meeting's transcript (Meeting Detail shows the usual loader
   * meanwhile, and Re-transcribe redoes it from the whole recording). A live
   * run that failed or was cancelled leaves the meeting untranscribed.
   */
  const drainLive = useCallback(
    (meetingId: string, transcriber: LiveTranscriber) => {
      setTxStage((p) => ({ ...p, [meetingId]: 'transcribing' }));
      setTxProgress((p) => ({ ...p, [meetingId]: 0 }));
      const done = (async () => {
        try {
          const segments = await transcriber.finish((r) => setTxProgress((p) => ({ ...p, [meetingId]: r })));
          const failed = transcriber.snapshot().status === 'failed';
          if (!transcriber.wasCancelled && !failed && segments.length > 0) {
            await commitTranscript(meetingId, segments, {
              transcriptSource: { kind: 'live', model: transcriber.model, createdAt: Date.now() },
            });
          } else {
            await updateMeeting(meetingId, { transcriptionStatus: 'not_started' });
          }
        } catch {
          await updateMeeting(meetingId, { transcriptionStatus: 'not_started' }).catch(() => undefined);
        } finally {
          liveDrainRef.current.delete(meetingId);
          setTxProgress((p) => {
            const next = { ...p };
            delete next[meetingId];
            return next;
          });
          setTxStage((p) => {
            const next = { ...p };
            delete next[meetingId];
            return next;
          });
          await refresh().catch(() => undefined);
          const m = await getMeeting(meetingId).catch(() => undefined);
          setDetailMeeting((d) => (d && d.id === meetingId ? (m ?? null) : d));
          if (m) {
            const segs = await getSegments(meetingId).catch(() => [] as TranscriptSegment[]);
            setDetailSegments((cur) => (detailIdRef.current === meetingId ? segs : cur));
            if (m.transcriptionStatus === 'completed') void mirrorToDisk(m);
          }
        }
      })();
      liveDrainRef.current.set(meetingId, { transcriber, done });
    },
    [refresh, mirrorToDisk],
  );

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const meeting = activeMeeting;
    if (!recorder || !meeting || stoppingRef.current) return null;
    stoppingRef.current = true;
    // "Saving recording…" is painted before any teardown starts: if a step
    // blocks the page, the user still sees that Stop is working.
    setStopping(true);
    try {
      await nextPaint();
      return await finishStop(recorder, meeting);
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  }, [activeMeeting, go, refresh, mirrorToDisk, stopDiagnostics, stopLive, drainLive]);

  async function finishStop(recorder: MediaRecorderAudioRecorder | NativeRecorder, meeting: Meeting): Promise<Meeting> {
    const trace = new StopTrace();
    let diagnostics: Meeting['diagnostics'];
    let liveTranscriber: LiveTranscriber | null;
    let result: Awaited<ReturnType<MediaRecorderAudioRecorder['stop']>>;
    if (recorder instanceof NativeRecorder) {
      // Native: take the last live audio, then the shell stops and saves.
      liveTranscriber = await trace.time('live tap', stopLive);
      const stopped = await recorder.stop(trace);
      result = stopped;
      diagnostics = await trace.time('diagnostics', () => stopDiagnostics(stopped.diagnostics));
    } else {
      diagnostics = await trace.time('diagnostics', () => stopDiagnostics());
      await nextPaint();
      // Detach the live tap before the capture sources stop (WebKitGTK).
      liveTranscriber = await trace.time('live tap', stopLive);
      await nextPaint();
      result = await recorder.stop(trace);
    }
    const liveRun = liveTranscriber && liveTranscriber.snapshot().status !== 'failed' ? liveTranscriber : null;
    const endedAt = Date.now();
    const recordedTracks = result.tracks.filter(Boolean);
    const updated: Meeting = {
      ...meeting,
      endedAt,
      // Recorded time only: pauses are not part of the recording.
      durationMs: result.durationMs,
      mimeType: result.mimeType || meeting.mimeType,
      tracks: recordedTracks.length > 1 ? recordedTracks : undefined,
      unfinished: false,
      ...(result.unsavedChunks > 0 ? { unsavedChunks: result.unsavedChunks } : {}),
      ...(diagnostics ? { diagnostics } : {}),
      ...(liveRun ? { transcriptionStatus: 'processing' as const } : {}),
    };
    // Saved with the meeting and printed to the terminal: a slow Stop names its step.
    updated.stopTrace = { steps: [...trace.steps], totalMs: trace.totalMs() };
    await trace.time('save meeting', () => saveMeeting(updated));
    reportStopTrace(trace);
    activeIdRef.current = null;
    setRecordingError(null);
    setActiveMeeting(null);
    setElapsedMs(0);
    recorderRef.current = null;
    const liveMirror = liveMirrorRef.current;
    liveMirrorRef.current = null;
    const nativeMirror = recorder instanceof NativeRecorder && nativeMirrorRef.current && recorder.mirrorComplete();
    nativeMirrorRef.current = false;
    void keepAwake(false);
    // The recording is saved: open it right away — in the guided wrap-up
    // when it is on (Settings → After recording). Everything else (meeting
    // list, disk mirror, live transcript) finishes in the background.
    if (wrapPrefs().guide) {
      const wrapped = { ...updated, wrapUp: newWrapUp() };
      void updateMeeting(updated.id, { wrapUp: wrapped.wrapUp }).catch(() => undefined);
      go({ name: 'wrapup', id: updated.id });
    } else {
      go({ name: 'detail', id: updated.id });
    }
    void refresh().catch(() => undefined);
    // The audio is already on disk when the live mirror kept up; otherwise
    // copy it (in slices) from storage.
    void (async () => {
      const complete = nativeMirror || (liveMirror ? await liveMirror.finish().catch(() => false) : false);
      await mirrorToDisk(updated, complete ? 'skip' : 'copy');
    })();
    if (liveRun) drainLive(updated.id, liveRun);
    // Opt-in: start the whole-file transcription right away (never instead of
    // a live transcript, and only with a model installed or the server on).
    else if (autoTranscribeEnabled() && (installedCountRef.current > 0 || remoteActiveRef.current)) {
      void transcribeRef.current?.(updated.id).catch(() => undefined);
    }
    return updated;
  }

  const loadDetail = useCallback(async (id: string) => {
    detailIdRef.current = id;
    const meeting = await getMeeting(id);
    // A newer navigation won: never show this (slower) load's meeting.
    if (detailIdRef.current !== id) return;
    setDetailMeeting(meeting ?? null);
    if (!meeting) {
      setDetailSegments([]);
      setDetailTracks([]);
      return;
    }
    const segments = await getSegments(id);
    if (detailIdRef.current !== id) return;
    setDetailSegments(segments);
    // One player per track; two-way recordings expose "Me" and "Others".
    const tracks = await listTracks(id).catch(() => [] as string[]);
    setDetailTracks(
      tracks.map((track) => ({
        track,
        label: trackSpeakerLabel(track) ?? (track || 'Recording'),
        load: () => readRecordingBlob(id, meeting.mimeType, track),
      })),
    );
  }, []);

  const transcribe = useCallback(
    async (id: string, modelId?: string) => {
      setTxProgress((p) => ({ ...p, [id]: 0 }));
      setTxStage((p) => ({ ...p, [id]: 'loading-model' }));
      // Optimistic: flip the detail screen into the loader immediately.
      // (The DB row is updated by the service, but detailMeeting state isn't.)
      setDetailMeeting((d) =>
        d && d.id === id ? { ...d, transcriptionStatus: 'processing' } : d,
      );
      try {
        // The transcription server, when on, replaces the local model (an
        // explicit model id — the first-run download — still runs locally).
        if (!modelId && remoteAsrActive(remoteAsrConfig)) {
          const config = remoteAsrConfig;
          const title = (await getMeeting(id))?.title ?? 'a meeting';
          logNetwork(remoteAsrEndpoint(config), `Transcribed "${title}" on the transcription server`, 'Speech audio (16 kHz WAV pieces, no silence)');
          await txService.transcribe(id, remoteAsrLabel(config), () => new RemoteASREngine(config));
        } else {
          await txService.transcribe(id, modelId ?? modelMeta.modelId);
        }
      } finally {
        // Drop stale progress/stage so a later visit never shows a ghost loader.
        setTxProgress((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        setTxStage((p) => {
          const next = { ...p };
          delete next[id];
          return next;
        });
        await refresh();
        const m = await getMeeting(id);
        // Only the meeting on screen: a background run must not replace
        // another meeting the user opened meanwhile.
        if (m) setDetailMeeting((d) => (detailIdRef.current === id ? m : d));
        const segs = await getSegments(id);
        setDetailSegments((cur) => (detailIdRef.current === id ? segs : cur));
        void mirrorToDisk(m ?? null);
      }
    },
    [modelMeta.modelId, remoteAsrConfig, refresh, txService, mirrorToDisk],
  );

  const renameMeeting = useCallback(
    async (meetingId: string, title: string) => {
      const clean = title.trim() || 'Untitled meeting';
      const updated = await updateMeeting(meetingId, (cur) => ({ ...cur, title: clean }));
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      // Not mirrored: the disk folder is named after the title at recording time.
      await refresh();
    },
    [refresh],
  );

  const deleteMeeting = useCallback(
    async (id: string) => {
      // A transcription outliving the delete could write the meeting back.
      await txService.cancelAndWait(id);
      const drain = liveDrainRef.current.get(id);
      if (drain) {
        drain.transcriber.cancel();
        await drain.done;
      }
      await deleteMeetingEverywhere(id);
      setDetailMeeting((d) => (d && d.id === id ? null : d));
      await refresh();
    },
    [refresh, txService],
  );

  const cancelTranscription = useCallback(
    async (id: string) => {
      const drain = liveDrainRef.current.get(id);
      if (drain) {
        drain.transcriber.cancel();
        await drain.done;
      }
      await txService.cancel(id);
      await refresh();
    },
    [refresh, txService],
  );

  const downloadModel = useCallback(async (id?: string) => {
    const targetId = id ?? (await getModelMeta().catch(() => null))?.modelId ?? NATIVE_DEFAULT_MODEL;
    // Persisting the model state is best-effort: a storage problem must never
    // block the download itself.
    const persist = (m: ModelMeta) => setModelMeta(m).catch(() => undefined);
    let meta: ModelMeta = {
      modelId: targetId,
      state: 'downloading',
      progress: 0,
      updatedAt: Date.now(),
    };
    await persist(meta);
    setModelMetaState(meta);

    // Let the native backend fetch the model (voxtype/whisper.cpp), polling
    // the bytes written so the UI can show a real progress bar.
    setModelDownload({ name: targetId, received: 0, total: 0 });
    const poll = window.setInterval(() => {
      void nativeDownloadProgress(targetId)
        .then((p) => {
          setModelDownload({ name: targetId, received: p.received, total: p.total });
          if (p.total > 0) setModelMetaState((m) => ({ ...m, progress: Math.min(0.99, p.received / p.total) }));
        })
        .catch(() => undefined);
    }, 500);
    try {
      logNetwork('huggingface.co', `Downloaded ${meta.modelId}`, 'Nothing (download)');
      await nativeDownloadModel(meta.modelId);
      meta = { ...meta, state: 'ready', progress: 1 };
      await persist(meta);
      setModelMetaState(meta);
      await refreshNativeStatus();
    } catch (err) {
      meta = {
        ...meta,
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      await persist(meta);
      setModelMetaState(meta);
      throw err;
    } finally {
      window.clearInterval(poll);
      setModelDownload(null);
    }
  }, [refreshNativeStatus]);

  const recoverUnfinished = useCallback(
    async (id: string) => {
      const m = await getMeeting(id);
      if (!m) return;
      // Chunks already persisted incrementally; finalize from what exists.
      const tracks = await listTracks(id).catch(() => [] as string[]);
      const counts = await Promise.all(tracks.map((t) => listChunkNames(id, t)));
      if (!counts.some((names) => names.length > 0)) {
        await deleteRecording(id).catch(() => undefined);
        await deleteMeetingRecord(id).catch(() => undefined);
      } else {
        const durationMs = estimateDurationFromChunks(counts.map((n) => n.length));
        await saveMeeting({
          ...m,
          endedAt: m.startedAt + durationMs,
          durationMs,
          durationEstimated: true,
          unfinished: false,
        });
      }
      await refresh();
    },
    [refresh],
  );

  const resetDatabase = useCallback(async () => {
    await invokeDesktop<string>('native_reset_webview_database', { origin: window.location.origin });
  }, []);

  const discardUnfinished = useCallback(
    async (id: string) => {
      await deleteRecording(id).catch(() => undefined);
      await deleteMeetingRecord(id).catch(() => undefined);
      await refresh();
    },
    [refresh],
  );

  const selectModel = useCallback(
    async (id: string) => {
      const current = await getModelMeta();
      if (current.modelId === id || current.state === 'downloading') return;
      // Native models come pre-installed on disk, so selecting one is enough.
      const meta: ModelMeta = {
        modelId: id,
        state: 'ready',
        progress: 1,
        updatedAt: Date.now(),
      };
      await setModelMeta(meta);
      setModelMetaState(meta);
    },
    [],
  );

  const setLanguage = useCallback(
    async (id: string) => {
      languageChosenRef.current = true;
      setLanguageState(id);
      await setTranscriptionLanguage(id);
      setLanguageState(await getTranscriptionLanguage());
    },
    [],
  );

  const nativeModels = nativeStatus?.models ?? [];
  const firstRunModel = nativeStatus?.recommendedModel ?? NATIVE_DEFAULT_MODEL;

  const modelCatalog = useMemo<CatalogModel[]>(
    () => nativeCatalog(nativeModels),
    [nativeModels],
  );

  const installedModels = useMemo(
    () => modelCatalog.filter((m) => m.installed),
    [modelCatalog],
  );

  const liveOptions = useMemo(() => liveModelOptions(modelCatalog), [modelCatalog]);
  const liveChoice = useMemo(() => resolveLiveModel(liveModel, liveOptions), [liveModel, liveOptions]);
  liveChoiceRef.current = liveChoice;

  const setLiveTranscription = useCallback((enabled: boolean) => {
    setLiveEnabled(enabled);
    setLiveEnabledState(enabled);
  }, []);

  const setLiveModelChoice = useCallback((id: string) => {
    setLiveModel(id);
    setLiveModelState(id);
  }, []);

  /** Fetch a (small) model for live use, with progress; the main model stays selected. */
  const downloadLiveModel = useCallback(
    async (name: string) => {
      setLiveDownload({ name, received: 0, total: 0 });
      const poll = window.setInterval(() => {
        void nativeDownloadProgress(name)
          .then((p) => setLiveDownload({ name, received: p.received, total: p.total }))
          .catch(() => undefined);
      }, 500);
      try {
        logNetwork('huggingface.co', `Downloaded ${name}`, 'Nothing (download)');
        await nativeDownloadModel(name);
        await refreshNativeStatus();
      } finally {
        window.clearInterval(poll);
        setLiveDownload(null);
      }
    },
    [refreshNativeStatus],
  );

  // Keep the selected model in step with what is on disk (sidebar chip,
  // Meeting Detail picker). Only once the native probe has answered.
  useEffect(() => {
    if (!nativeStatus) return;
    const next = reconcileModelMeta(modelMeta, installedModels);
    if (!next) return;
    setModelMetaState(next);
    void setModelMeta(next).catch(() => undefined);
  }, [nativeStatus, installedModels, modelMeta]);

  transcribeRef.current = transcribe;
  installedCountRef.current = installedModels.length;
  remoteActiveRef.current = remoteAsrActive(remoteAsrConfig);

  const setupAndTranscribe = useCallback(
    async (id: string) => {
      if (installedModels.length > 0 || remoteAsrActive(remoteAsrConfig)) return transcribe(id);
      // The web / phone build has no local engine: only the server can transcribe.
      if (isWebBuild()) throw new Error(WEB_TRANSCRIPTION_HINT);
      // First transcription on a fresh install: fetch the recommended model
      // (with progress), then run — no trip to Settings.
      await downloadModel(firstRunModel);
      await transcribe(id, firstRunModel);
    },
    [installedModels, remoteAsrConfig, transcribe, downloadModel, firstRunModel],
  );


  // ---- moments, agenda progress, transcript edits, speakers ---------------

  const activeRef = useRef<Meeting | null>(null);
  activeRef.current = activeMeeting;

  const addMoment = useCallback(async (label = ''): Promise<Moment | null> => {
    const cur = activeRef.current;
    const recorder = recorderRef.current;
    if (!cur || !recorder) return null;
    const moment: Moment = { id: newMeetingId(), atMs: recorder.getElapsedMs(), label: label.trim() };
    const moments = [...(cur.moments ?? []), moment];
    setActiveMeeting((a) => (a && a.id === cur.id ? { ...a, moments } : a));
    await updateMeeting(cur.id, (m) => ({ ...m, moments: [...(m.moments ?? []), moment] })).catch(() => undefined);
    return moment;
  }, []);

  const labelMoment = useCallback(async (meetingId: string, momentId: string, label: string) => {
    const relabel = (list: Moment[] | undefined) =>
      (list ?? []).map((x) => (x.id === momentId ? { ...x, label: label.trim() } : x));
    setActiveMeeting((a) => (a && a.id === meetingId ? { ...a, moments: relabel(a.moments) } : a));
    const updated = await updateMeeting(meetingId, (m) => ({ ...m, moments: relabel(m.moments) }));
    if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
  }, []);

  const markAgenda = useCallback(async (itemId: string, what: 'start' | 'done' | 'undo') => {
    const cur = activeRef.current;
    const at = recorderRef.current?.getElapsedMs() ?? 0;
    if (!cur?.agenda) return;
    const items = cur.agenda.items.map((i) => {
      if (i.id === itemId) {
        if (what === 'start') return { ...i, startedMs: i.startedMs ?? at, doneMs: undefined };
        if (what === 'done') return { ...i, startedMs: i.startedMs ?? at, doneMs: at };
        const { startedMs: _s, doneMs: _d, ...rest } = i;
        return rest;
      }
      // Starting a topic finishes the one in progress.
      if (what === 'start' && i.startedMs !== undefined && i.doneMs === undefined) return { ...i, doneMs: at };
      return i;
    });
    const agenda = { items, updatedAt: Date.now() };
    setActiveMeeting((a) => (a && a.id === cur.id ? { ...a, agenda } : a));
    await updateMeeting(cur.id, { agenda }).catch(() => undefined);
  }, []);

  const editSegment = useCallback(async (segmentId: string, text: string) => {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const updated = await updateSegment(segmentId, { text: clean });
    if (!updated) return;
    setDetailSegments((cur) => cur.map((s) => (s.id === segmentId ? updated : s)));
    const m = await getMeeting(updated.meetingId).catch(() => undefined);
    if (m?.transcriptionStatus === 'completed') void mirrorToDisk(m);
  }, [mirrorToDisk]);

  const renameSpeaker = useCallback(async (meetingId: string, speaker: string, name: string) => {
    const updated = await updateMeeting(meetingId, (m) => {
      const names = { ...(m.speakerNames ?? {}) };
      if (name.trim()) names[speaker] = name.trim();
      else delete names[speaker];
      return { ...m, speakerNames: names };
    });
    if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
  }, []);

  const meetingParticipants = useCallback(
    (meetingId: string): Participant[] =>
      (detailMeeting?.id === meetingId ? detailMeeting : meetings.find((x) => x.id === meetingId))?.participants ?? [],
    [detailMeeting, meetings],
  );
  const setParticipants = useCallback(async (meetingId: string, people: Participant[]) => {
    const updated = await updateMeeting(meetingId, { participants: people });
    if (updated) {
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      setMeetings((list) => list.map((x) => (x.id === meetingId ? updated : x)));
    }
  }, []);
  const loadGitlabPeople = useCallback(
    async (from: { project: string } | { groupId: number; name: string }): Promise<Participant[]> => {
      logNetwork(gitlabConfig.url, `Loaded the members of ${'project' in from ? from.project : from.name}`, 'Nothing (read only)');
      const people = await createGitlabClient(gitlabConfig).listPeople('project' in from ? { project: from.project } : { groupId: from.groupId });
      return people.map((p) => ({ name: p.name, username: p.username, ...(p.email ? { email: p.email } : {}), source: 'gitlab' as const }));
    },
    [gitlabConfig],
  );

  const [diarizing, setDiarizing] = useState<Record<string, number>>({});
  const detectSpeakersFor = useCallback(async (meetingId: string, speakers = 0) => {
    setDiarizing((p) => ({ ...p, [meetingId]: 0 }));
    try {
      const updated = await detectSpeakers(meetingId, speakers, (r) =>
        setDiarizing((p) => (meetingId in p ? { ...p, [meetingId]: r } : p)),
      );
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      if (detailIdRef.current === meetingId) setDetailSegments(await getSegments(meetingId));
      if (updated) void mirrorToDisk(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const updated = await updateMeeting(meetingId, (m) => ({
        ...m,
        diarization: { at: Date.now(), speakers: m.diarization?.speakers ?? 0, error: msg },
      })).catch(() => undefined);
      if (updated) setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      throw err;
    } finally {
      setDiarizing((p) => {
        const next = { ...p };
        delete next[meetingId];
        return next;
      });
    }
  }, [mirrorToDisk]);

  const recordingLevels = useCallback((): Array<{ role: 'microphone' | 'device'; level: number }> => {
    const recorder = recorderRef.current;
    const mode = activeRef.current?.mode;
    if (recorder instanceof NativeRecorder) {
      const roles: Array<'microphone' | 'device'> = mode === 'device' ? ['device'] : mode === 'dual' ? ['microphone', 'device'] : ['microphone'];
      const lv = recorder.levels();
      return roles.map((role, i) => ({ role, level: Math.min(1, lv[i] ?? 0) }));
    }
    return diagRef.current?.collector.liveLevels() ?? [];
  }, []);

  // ---- wrap-up and exports ---------------------------------------------------

  const setWrapUp = useCallback(async (meetingId: string, change: (w: WrapUp) => WrapUp) => {
    const updated = await updateMeeting(meetingId, (m) => ({
      ...m,
      wrapUp: { ...change(m.wrapUp ?? newWrapUp()), updatedAt: Date.now() },
    }));
    if (updated) {
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      setMeetings((list) => list.map((x) => (x.id === meetingId ? updated : x)));
    }
    return updated;
  }, []);

  const recordExport = useCallback(async (meetingId: string, format: ExportFormat, path?: string) => {
    const updated = await updateMeeting(meetingId, (m) => ({
      ...m,
      exports: { ...(m.exports ?? {}), [format]: { at: Date.now(), ...(path ? { path } : {}) } },
    }));
    if (updated) {
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      setMeetings((list) => list.map((x) => (x.id === meetingId ? updated : x)));
    }
  }, []);

  // ---- storage ---------------------------------------------------------------

  const deleteAllMeetings = useCallback(async (): Promise<number> => {
    const all = await listMeetings();
    let n = 0;
    for (const m of all) {
      if (m.id === activeIdRef.current) continue;
      await txService.cancelAndWait(m.id);
      await deleteMeetingEverywhere(m.id);
      n += 1;
    }
    setDetailMeeting(null);
    await refresh();
    return n;
  }, [refresh, txService]);

  /**
   * Keep audio (Settings → Storage): "30 days" removes the audio of
   * transcribed meetings older than 30 days; "Until exported" removes it once
   * the audio was exported (Export step, or a complete local-files copy).
   * Transcripts always stay. `dryRun` only lists what would go.
   */
  const applyRetention = useCallback(async (dryRun = false): Promise<Meeting[]> => {
    const rule = keepAudio();
    if (rule === 'always') return [];
    const now = Date.now();
    const all = await listMeetings().catch(() => [] as Meeting[]);
    const due = all.filter(
      (m) =>
        !m.audioRemovedAt &&
        !m.unfinished &&
        m.id !== activeIdRef.current &&
        m.transcriptionStatus === 'completed' &&
        (rule === '30d' ? now - m.createdAt > 30 * 24 * 3600 * 1000 : !!m.exports?.audio),
    );
    if (dryRun) return due;
    for (const m of due) {
      await deleteRecording(m.id).catch(() => undefined);
      await updateMeeting(m.id, { audioRemovedAt: now }).catch(() => undefined);
    }
    if (due.length) await refresh();
    return due;
  }, [refresh]);

  // Apply the Keep audio rule once per launch (after the list loaded).
  useEffect(() => {
    const t = window.setTimeout(() => void applyRetention().catch(() => undefined), 8000);
    return () => window.clearTimeout(t);
  }, [applyRetention]);

  const value = useMemo<AppState>(
    () => ({
      route,
      go,
      meetings,
      refresh,
      recordingState,
      updateInfo,
      checkUpdates,
      recordingError,
      recordingErrorKind,
      activeMeeting,
      recordingIssues,
      storageWarning,
      startRecording,
      addMoment,
      labelMoment,
      markAgenda,
      editSegment,
      renameSpeaker,
      meetingParticipants,
      setParticipants,
      loadGitlabPeople,
      detectSpeakers: detectSpeakersFor,
      diarizing,
      setWrapUp,
      recordExport,
      deleteAllMeetings,
      applyRetention,
      recordingLevels,
      pauseRecording,
      resumeRecording,
      retrySaving,
      deleteMeeting,
      renameMeeting,
      stopRecording,
      stopping,
      nativeRecording: nativeDevices,
      detailMeeting,
      detailSegments,
      detailTracks,
      loadDetail,
      txProgress,
      txStage,
      summarizing,
      returnTo,
      transcribe,
      setupAndTranscribe,
      modelDownload,
      firstRunModel,
      cancelTranscription,
      modelMeta,
      downloadModel,
      selectModel,
      language,
      setLanguage,
      modelCatalog,
      installedModels,
      nativeStatus,
      nativeModels,
      refreshNativeStatus,
      saveToDisk,
      setSaveToDisk,
      storageDir,
      openStorageDir,
      importMeeting,
      gitlabConfig,
      createGitlabActionIssues,
      postSummaryToWiki,
      issueStates,
      refreshIssueStates,
      saveGitlabConfig,
      uploadToGitlab,
      uploadSummaryToGitlab,
      saveAgenda,
      uploadAgendaToGitlab,
      calendarConfig,
      saveCalendarConfig,
      switchCalendarProvider,
      fetchCalendarEvents,
      createCalendarEvent,
      llmConfig,
      saveLlmConfig,
      remoteAsrConfig,
      saveRemoteAsrConfig,
      summarizeMeeting,
      saveSummary,
      enableGpu,
      liveEnabled,
      setLiveTranscription,
      liveModel,
      setLiveModelChoice,
      liveOptions,
      liveChoice,
      liveDownload,
      downloadLiveModel,
      live,
      unfinished,
      recoverUnfinished,
      discardUnfinished,
      databaseError,
      resetDatabase,
      systemAudio,
    }),
    [
      route, go, meetings, refresh, recordingState, recordingError, recordingErrorKind, activeMeeting,
      recordingIssues, storageWarning, startRecording, addMoment, labelMoment, markAgenda, editSegment, renameSpeaker, meetingParticipants, setParticipants, loadGitlabPeople,
      detectSpeakersFor, diarizing, setWrapUp, recordExport, deleteAllMeetings, applyRetention, recordingLevels, pauseRecording, resumeRecording, retrySaving, deleteMeeting, renameMeeting,
      stopRecording, stopping, nativeDevices, detailMeeting, detailSegments, detailTracks, loadDetail,
      txProgress, txStage, summarizing, returnTo, transcribe, setupAndTranscribe, modelDownload, firstRunModel, cancelTranscription, modelMeta, downloadModel, selectModel, language, setLanguage, modelCatalog, installedModels,
      nativeStatus, nativeModels, refreshNativeStatus, enableGpu,
      liveEnabled, setLiveTranscription, liveModel, setLiveModelChoice, liveOptions, liveChoice,
      liveDownload, downloadLiveModel, live,
      saveToDisk, setSaveToDisk, storageDir, openStorageDir, importMeeting,
      gitlabConfig, saveGitlabConfig, uploadToGitlab, uploadSummaryToGitlab, createGitlabActionIssues, postSummaryToWiki, issueStates, refreshIssueStates, saveAgenda, uploadAgendaToGitlab,
      calendarConfig, saveCalendarConfig, switchCalendarProvider, fetchCalendarEvents, createCalendarEvent,
      updateInfo, checkUpdates,
      llmConfig, saveLlmConfig, remoteAsrConfig, saveRemoteAsrConfig, summarizeMeeting, saveSummary,
      unfinished, recoverUnfinished, discardUnfinished, databaseError, resetDatabase, systemAudio,
    ],
  );

  return (
    <Ctx.Provider value={value}>
      <ElapsedCtx.Provider value={elapsedMs}>{children}</ElapsedCtx.Provider>
    </Ctx.Provider>
  );
}

export { formatDuration };
