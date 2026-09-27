import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Meeting, RecordingMode, RecordingState } from '../domain/meeting';
import { DUAL_TRACKS, formatDuration, newMeetingId } from '../domain/meeting';
import { DeviceAudioSource } from '../audio/device-audio';
import { MicrophoneAudioSource } from '../audio/microphone';
import { MediaRecorderAudioRecorder } from '../audio/recorder';
import type { TrackSpec } from '../audio/recorder';
import { TranscriptionService } from '../asr/transcription-service';
import {
  DEFAULT_NATIVE_LANGUAGE,
  NATIVE_DEFAULT_MODEL,
  getModelMeta,
  setModelMeta,
  getTranscriptionLanguage,
  setTranscriptionLanguage,
} from '../asr/model-manager';
import type { ModelMeta } from '../asr/model-manager';
import { nativeCatalog } from '../asr/model-tiers';
import type { CatalogModel } from '../asr/model-tiers';
import { findUnfinishedMeetings, getMeeting, listMeetings, saveMeeting } from '../storage/meetings';
import { getSegments } from '../storage/transcripts';
import type { TranscriptSegment } from '../domain/transcript';
import type { TranscriptionStage } from '../asr/engine';
import { deleteRecording, estimateStorage, isStorageLow, listTracks, readRecordingBlob } from '../storage/recordings';
import { trackSpeakerLabel } from '../domain/meeting';
import { isDesktopApp } from '../platform/desktop';
import { nativeDownloadModel, nativeEnableGpu, nativeStatus as fetchNativeStatus } from '../asr/native-engine';
import type { NativeAsrStatus, NativeModelInfo } from '../asr/native-types';
import { desktopStorageDir, openDesktopStorageDir } from '../platform/desktop-storage';
import { mirrorMeetingToDisk } from '../features/meetings/disk-sync';
import { importAudioFile } from '../features/meetings/import-audio';
import { createGitlabClient, DEFAULT_GITLAB_CONFIG } from '../integrations/gitlab';
import type { GitlabConfig, GitlabUploadResult } from '../integrations/gitlab';
import { getGitlabConfig, setGitlabConfig } from '../integrations/gitlab-store';

export type Route =
  | { name: 'dashboard' }
  | { name: 'new' }
  | { name: 'active' }
  | { name: 'detail'; id: string }
  | { name: 'settings' };

/** One playable track of a recording (single-track recordings have track ''). */
export interface AudioTrackView {
  track: string;
  label: string;
  url: string;
}

interface AppState {
  route: Route;
  go: (r: Route) => void;
  meetings: Meeting[];
  refresh: () => Promise<void>;
  // recording session
  recordingState: RecordingState;
  recordingError: string | null;
  activeMeeting: Meeting | null;
  elapsedMs: number;
  storageWarning: string | null;
  startRecording: (title: string, mode: RecordingMode) => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  stopRecording: () => Promise<Meeting | null>;
  // detail
  detailMeeting: Meeting | null;
  detailSegments: TranscriptSegment[];
  detailTracks: AudioTrackView[];
  loadDetail: (id: string) => Promise<void>;
  // transcription
  txProgress: Record<string, number>;
  txStage: Record<string, TranscriptionStage>;
  transcribe: (id: string) => Promise<void>;
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
  /** Enable GPU acceleration via the desktop backend (desktop only). */
  enableGpu: () => Promise<void>;
  // recovery
  unfinished: Meeting[];
  recoverUnfinished: (id: string) => Promise<void>;
  discardUnfinished: (id: string) => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [route, setRoute] = useState<Route>({ name: 'dashboard' });
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [recordingState, setRecordingState] = useState<RecordingState>('IDLE');
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);
  const [detailSegments, setDetailSegments] = useState<TranscriptSegment[]>([]);
  const [detailTracks, setDetailTracks] = useState<AudioTrackView[]>([]);
  const [txProgress, setTxProgress] = useState<Record<string, number>>({});
  const [txStage, setTxStage] = useState<Record<string, TranscriptionStage>>({});
  const [modelMeta, setModelMetaState] = useState<ModelMeta>({
    modelId: NATIVE_DEFAULT_MODEL,
    state: 'not_installed',
    progress: 0,
    updatedAt: Date.now(),
  });
  const [language, setLanguageState] = useState<string>(DEFAULT_NATIVE_LANGUAGE);
  const [nativeStatus, setNativeStatusState] = useState<NativeAsrStatus | null>(null);
  // Desktop-only: mirror finished meetings to a user-visible folder.
  const [saveToDisk, setSaveToDiskState] = useState<boolean>(() => {
    try {
      return localStorage.getItem('desktop-save-to-disk') !== 'false';
    } catch {
      return true;
    }
  });
  const [storageDir, setStorageDir] = useState<string | null>(null);
  const [gitlabConfig, setGitlabConfigState] = useState<GitlabConfig>(DEFAULT_GITLAB_CONFIG);
  const [unfinished, setUnfinished] = useState<Meeting[]>([]);
  const recorderRef = useRef<MediaRecorderAudioRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setMeetings(await listMeetings());
    setUnfinished(await findUnfinishedMeetings());
  }, []);

  // Resolve the desktop storage folder once, for the Settings card.
  useEffect(() => {
    if (!isDesktopApp()) return;
    void desktopStorageDir().then(setStorageDir).catch(() => undefined);
  }, []);

  useEffect(() => {
    void refresh();
    // Hash routing so navigation survives reloads.
    const sync = () => {
      const h = window.location.hash;
      if (h.startsWith('#/meeting/')) setRoute({ name: 'detail', id: decodeURIComponent(h.slice(10)) });
      else if (h === '#/new') setRoute({ name: 'new' });
      else if (h === '#/active') setRoute({ name: 'active' });
      else if (h === '#/settings') setRoute({ name: 'settings' });
      else setRoute({ name: 'dashboard' });
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [refresh]);

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
    void getTranscriptionLanguage().then(setLanguageState).catch(() => undefined);
    void getGitlabConfig().then(setGitlabConfigState).catch(() => undefined);
  }, []);

  const go = useCallback((r: Route) => {
    if (r.name === 'dashboard') window.location.hash = '#/';
    else if (r.name === 'new') window.location.hash = '#/new';
    else if (r.name === 'active') window.location.hash = '#/active';
    else if (r.name === 'settings') window.location.hash = '#/settings';
    else window.location.hash = `#/meeting/${encodeURIComponent(r.id)}`;
    setRoute(r);
  }, []);

  useEffect(() => {
    if (recordingState === 'RECORDING' && activeMeeting) {
      timerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - activeMeeting.startedAt);
      }, 500);
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

  const startRecording = useCallback(
    async (title: string, mode: RecordingMode) => {
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
        title: title.trim() || 'Untitled meeting',
        mode,
        createdAt: now,
        startedAt: now,
        durationMs: 0,
        audioPath: `meetings/${id}`,
        mimeType: '',
        tracks: mode === 'dual' ? [...DUAL_TRACKS] : undefined,
        transcriptionStatus: 'not_started',
        unfinished: true,
      };
      // Two-way: capture the microphone and the device/system audio as separate
      // tracks at the same time (the Zoom case). Single-source modes stay flat.
      const specs: TrackSpec[] =
        mode === 'speaker'
          ? [{ track: '', source: new MicrophoneAudioSource() }]
          : mode === 'device'
            ? [{ track: '', source: new DeviceAudioSource() }]
            : [
                { track: 'microphone', source: new MicrophoneAudioSource() },
                { track: 'device', source: new DeviceAudioSource() },
              ];
      const recorder = new MediaRecorderAudioRecorder();
      recorderRef.current = recorder;
      recorder.onState((s) => setRecordingState(s));
      await saveMeeting(meeting);
      setActiveMeeting(meeting);
      setElapsedMs(0);
      try {
        await recorder.startTracks(specs, id, now);
        const meta = await getMeeting(id);
        if (meta) {
          const { readMeta } = await import('../storage/recordings');
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
        await deleteRecording(id).catch(() => undefined);
        const existing = await getMeeting(id).catch(() => undefined);
        if (existing) {
          const { deleteMeetingRecord } = await import('../storage/meetings');
          await deleteMeetingRecord(id).catch(() => undefined);
        }
        setActiveMeeting(null);
        throw err;
      }
      await refresh();
    },
    [go, refresh],
  );

  const pauseRecording = useCallback(async () => {
    await recorderRef.current?.pause();
  }, []);

  const resumeRecording = useCallback(async () => {
    await recorderRef.current?.resume();
  }, []);

  // Best-effort mirror of a finished meeting to the desktop folder.
  const mirrorToDisk = useCallback(async (meeting: Meeting | null) => {
    if (!meeting || !isDesktopApp()) return;
    try {
      if (localStorage.getItem('desktop-save-to-disk') === 'false') return;
    } catch {
      // No localStorage available: mirror anyway.
    }
    try {
      await mirrorMeetingToDisk(meeting);
    } catch {
      // Non-fatal: OPFS/IndexedDB remain the source of truth.
    }
  }, []);

  const setSaveToDisk = useCallback((value: boolean) => {
    setSaveToDiskState(value);
    try {
      localStorage.setItem('desktop-save-to-disk', value ? 'true' : 'false');
    } catch {
      // Preference stays in memory only.
    }
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
      const segments = await getSegments(meetingId);
      const result = await createGitlabClient(gitlabConfig).uploadMeeting(meeting, segments);
      const updated: Meeting = {
        ...meeting,
        gitlab: { url: result.url, target: result.target, uploadedAt: Date.now() },
      };
      await saveMeeting(updated);
      setDetailMeeting((d) => (d && d.id === meetingId ? updated : d));
      return result;
    },
    [gitlabConfig],
  );

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    const meeting = activeMeeting;
    if (!recorder || !meeting) return null;
    const result = await recorder.stop();
    const endedAt = Date.now();
    const recordedTracks = result.tracks.filter(Boolean);
    const updated: Meeting = {
      ...meeting,
      endedAt,
      durationMs: endedAt - meeting.startedAt,
      mimeType: result.mimeType || meeting.mimeType,
      tracks: recordedTracks.length > 1 ? recordedTracks : undefined,
      unfinished: false,
    };
    await saveMeeting(updated);
    setActiveMeeting(null);
    setElapsedMs(0);
    recorderRef.current = null;
    await refresh();
    void mirrorToDisk(updated);
    go({ name: 'detail', id: updated.id });
    return updated;
  }, [activeMeeting, go, refresh, mirrorToDisk]);

  const loadDetail = useCallback(async (id: string) => {
    const meeting = await getMeeting(id);
    setDetailMeeting(meeting ?? null);
    if (!meeting) {
      setDetailSegments([]);
      setDetailTracks((prev) => {
        prev.forEach((t) => URL.revokeObjectURL(t.url));
        return [];
      });
      return;
    }
    setDetailSegments(await getSegments(id));
    // One player per track; two-way recordings expose "Me" and "Others".
    const tracks = await listTracks(id).catch(() => [] as string[]);
    const views: AudioTrackView[] = [];
    for (const track of tracks) {
      const blob = await readRecordingBlob(id, meeting.mimeType, track).catch(() => null);
      if (!blob) continue;
      views.push({
        track,
        label: trackSpeakerLabel(track) ?? (track || 'Recording'),
        url: URL.createObjectURL(blob),
      });
    }
    setDetailTracks((prev) => {
      prev.forEach((t) => URL.revokeObjectURL(t.url));
      return views;
    });
  }, []);

  const transcribe = useCallback(
    async (id: string) => {
      setTxProgress((p) => ({ ...p, [id]: 0 }));
      setTxStage((p) => ({ ...p, [id]: 'loading-model' }));
      // Optimistic: flip the detail screen into the loader immediately.
      // (The DB row is updated by the service, but detailMeeting state isn't.)
      setDetailMeeting((d) =>
        d && d.id === id ? { ...d, transcriptionStatus: 'processing' } : d,
      );
      try {
        await txService.transcribe(id, modelMeta.modelId);
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
        if (m) setDetailMeeting(m);
        setDetailSegments(await getSegments(id));
        void mirrorToDisk(m ?? null);
      }
    },
    [modelMeta.modelId, refresh, txService, mirrorToDisk],
  );

  const cancelTranscription = useCallback(
    async (id: string) => {
      await txService.cancel(id);
      await refresh();
    },
    [refresh, txService],
  );

  const downloadModel = useCallback(async (id?: string) => {
    const targetId = id ?? (await getModelMeta()).modelId;
    let meta: ModelMeta = {
      modelId: targetId,
      state: 'downloading',
      progress: 0,
      updatedAt: Date.now(),
    };
    await setModelMeta(meta);
    setModelMetaState(meta);

    // Let the native backend fetch the model (voxtype/whisper.cpp).
    try {
      await nativeDownloadModel(meta.modelId);
      meta = { ...meta, state: 'ready', progress: 1 };
      await setModelMeta(meta);
      setModelMetaState(meta);
      await refreshNativeStatus();
    } catch (err) {
      meta = {
        ...meta,
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      await setModelMeta(meta);
      setModelMetaState(meta);
      throw err;
    }
  }, [refreshNativeStatus]);

  const recoverUnfinished = useCallback(
    async (id: string) => {
      const m = await getMeeting(id);
      if (!m) return;
      // Chunks already persisted incrementally; finalize from what exists.
      const { listChunkNames } = await import('../storage/recordings');
      const tracks = await listTracks(id).catch(() => [] as string[]);
      const counts = await Promise.all(tracks.map((t) => listChunkNames(id, t)));
      if (!counts.some((names) => names.length > 0)) {
        await deleteRecording(id).catch(() => undefined);
        const { deleteMeetingRecord } = await import('../storage/meetings');
        await deleteMeetingRecord(id).catch(() => undefined);
      } else {
        const endedAt = Date.now();
        await saveMeeting({ ...m, endedAt, durationMs: endedAt - m.startedAt, unfinished: false });
      }
      await refresh();
    },
    [refresh],
  );

  const discardUnfinished = useCallback(
    async (id: string) => {
      const { deleteMeetingRecord } = await import('../storage/meetings');
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
      await setTranscriptionLanguage(id);
      setLanguageState(await getTranscriptionLanguage());
    },
    [],
  );

  const nativeModels = nativeStatus?.models ?? [];

  const modelCatalog = useMemo<CatalogModel[]>(
    () => nativeCatalog(nativeModels),
    [nativeModels],
  );

  const installedModels = useMemo(
    () => modelCatalog.filter((m) => m.installed),
    [modelCatalog],
  );

  const value = useMemo<AppState>(
    () => ({
      route,
      go,
      meetings,
      refresh,
      recordingState,
      recordingError,
      activeMeeting,
      elapsedMs,
      storageWarning,
      startRecording,
      pauseRecording,
      resumeRecording,
      stopRecording,
      detailMeeting,
      detailSegments,
      detailTracks,
      loadDetail,
      txProgress,
      txStage,
      transcribe,
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
      saveGitlabConfig,
      uploadToGitlab,
      enableGpu,
      unfinished,
      recoverUnfinished,
      discardUnfinished,
    }),
    [
      route, go, meetings, refresh, recordingState, recordingError, activeMeeting,
      elapsedMs, storageWarning, startRecording, pauseRecording, resumeRecording,
      stopRecording, detailMeeting, detailSegments, detailTracks, loadDetail,
      txProgress, txStage, transcribe, cancelTranscription, modelMeta, downloadModel, selectModel, language, setLanguage, modelCatalog, installedModels,
      nativeStatus, nativeModels, refreshNativeStatus, enableGpu,
      saveToDisk, setSaveToDisk, storageDir, openStorageDir, importMeeting,
      gitlabConfig, saveGitlabConfig, uploadToGitlab,
      unfinished, recoverUnfinished, discardUnfinished,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export { formatDuration };
