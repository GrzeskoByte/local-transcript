import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import type { RecordingMode } from '../../domain/meeting';
import { macDeviceAudioLimit } from '../../audio/device-audio';
import { getMicrophoneDevice } from '../../audio/devices';
import { isSecureMediaContext, primeMicrophonePermission } from '../../audio/permissions';
import { nativeRecordingEnabled } from '../../audio/native-recorder';
import { AgendaEditor } from '../components/Agenda.tsx';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';
import { LiveTranscriptionToggle } from '../components/LiveTranscription.tsx';
import { LevelBars, useLevelMonitor } from '../components/LevelMeter.tsx';
import { MeetingRow } from '../components/MeetingRow.tsx';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda';
import { describeNativeRuntime } from '../../asr/model-manager';
import { isDesktopApp } from '../../platform/desktop';
import { getPref, setPref } from '../../platform/prefs';
import { Keys, useShortcuts } from '../App.tsx';
import { errorOf, fromEvent, setStartError, useStartError } from '../quick-record';
import {
  defaultSource,
  enabledWrapSteps,
  recordingPrefs,
  remindToRecord,
  setRemindToRecord,
  setupDone,
  usePrefsVersion,
  wrapPrefs,
} from '../preferences';
import { eventNow, useUpcoming, whenLabel } from '../upcoming';
import { nextWrapStep, wrapLeftover, WRAP_STEP_LABELS } from '../../domain/wrapup';
import { validateCalendarConfig } from '../../integrations/calendar';
import { FirstRun } from './Setup.tsx';
import { remoteAsrActive } from '../../integrations/remote-asr';

const SOURCES: Array<{ mode: RecordingMode; name: string; blurb: string }> = [
  { mode: 'speaker', name: 'Room mic', blurb: 'Voices in the room. For in-person meetings.' },
  { mode: 'device', name: 'This computer', blurb: 'Everything it plays. No screen sharing.' },
  { mode: 'dual', name: 'Call', blurb: 'Your mic + the call, mixed. For Zoom, Meet, Teams.' },
];

/** When each transcription was first seen running (for "about N min left"). */
const runStarted = new Map<string, { at: number; ratio: number }>();

export function Home(): React.JSX.Element {
  const app = useApp();
  const {
    meetings, go, startRecording, importMeeting, storageWarning, systemAudio, nativeRecording, txProgress, txStage,
    setupAndTranscribe, installedModels, nativeStatus, modelDownload, firstRunModel, downloadModel, modelMeta,
    unfinished, recoverUnfinished, discardUnfinished, databaseError, resetDatabase, calendarConfig, recordingState,
    remoteAsrConfig,
  } = app;
  usePrefsVersion();
  const keys = useShortcuts();
  const upcoming = useUpcoming();
  const startError = useStartError();
  const directSystemAudio =
    systemAudio?.available === true || (nativeRecording?.systemAudio === true && nativeRecordingEnabled());
  const macLimit = directSystemAudio ? null : macDeviceAudioLimit();

  const [mode, setModeState] = useState<RecordingMode>(defaultSource);
  const setMode = (m: RecordingMode): void => {
    setModeState(m);
    setPref('last-recording-mode', m);
  };
  const now = eventNow(upcoming.events);
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  // "Name from the calendar": the meeting on now names the recording.
  useEffect(() => {
    if (!titleTouched && now && recordingPrefs().nameFromCalendar) setTitle(now.title);
  }, [now?.id, titleTouched]); // eslint-disable-line react-hooks/exhaustive-deps
  const [agenda, setAgenda] = useState<AgendaItem[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [permBusy, setPermBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const secure = isSecureMediaContext();
  const usesMic = mode === 'speaker' || mode === 'dual';
  const micLabel = getMicrophoneDevice()?.label || 'Default microphone';
  const recording = recordingState === 'RECORDING' || recordingState === 'PAUSED';
  const meter = useLevelMonitor(usesMic ? [{ role: 'microphone', device: getMicrophoneDevice()?.label ?? '' }] : [], usesMic && !recording && secure);

  if (isDesktopApp() && !setupDone() && meetings.length === 0 && !getPref('setup-skipped')) return <FirstRun />;

  const start = (): void => {
    setBusy(true);
    setStartError(null);
    const fromCal = now && title.trim() === now.title ? fromEvent(now, mode) : null;
    startRecording(
      title,
      fromCal?.mode ?? mode,
      agenda ?? fromCal?.agenda ?? [],
      fromCal ? { calendarSource: fromCal.calendarSource } : {},
    )
      .catch((e: unknown) => setStartError(errorOf(e)))
      .finally(() => setBusy(false));
  };

  const importFile = (file: File): void => {
    setImporting(true);
    setStartError(null);
    importMeeting(file)
      .catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)))
      .finally(() => setImporting(false));
  };

  const grantMicrophone = (): void => {
    setPermBusy(true);
    setStartError(null);
    primeMicrophonePermission()
      .then((failure) => failure && setStartError(failure))
      .finally(() => setPermBusy(false));
  };

  return (
    <>
      {databaseError && <DatabaseBanner message={databaseError} reset={resetDatabase} />}
      {unfinished.length > 0 && (
        <RecoveryBanner unfinished={unfinished} recover={recoverUnfinished} discard={discardUnfinished} />
      )}

      <div className="home-grid">
        <section className="record-hero" aria-label="Start a recording">
          <div>
            <h1 className="hero-title">Record now.</h1>
            <p className="hero-lede">
              Transcribe later. Audio and text stay on this computer until you choose to share them.
            </p>
          </div>
          <fieldset className="source-pick">
            <legend>1 · What should it hear?</legend>
            <div className="source-grid" role="radiogroup" aria-label="Recording source">
              {SOURCES.map((s) => (
                <label key={s.mode} className={`source-card${mode === s.mode ? ' selected' : ''}`}>
                  <span className="source-head">
                    {s.name}
                    <input
                      type="radio"
                      name="source"
                      value={s.mode}
                      checked={mode === s.mode}
                      onChange={() => setMode(s.mode)}
                    />
                  </span>
                  <small>{s.mode === 'device' && !directSystemAudio ? 'Sound from a shared tab or window.' : s.blurb}</small>
                </label>
              ))}
            </div>
          </fieldset>
          {macLimit && mode !== 'speaker' && <p className="warn mb-0">{macLimit}</p>}
          {mode === 'dual' && (
            <p className="warn mb-0">
              Wear headphones. On speakers your microphone records the call a second time, slightly delayed.
            </p>
          )}
          {mode === 'dual' && recordingPrefs().consentReminder && (
            <p className="consent-line mb-0" role="note">
              Tell everyone on the call they are being recorded — many places require their consent.
            </p>
          )}
          <div className="hero-fields">
            <div>
              <label className="field-label" htmlFor="meeting-title">
                2 · Name it (optional)
              </label>
              <input
                id="meeting-title"
                className="input"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  setTitleTouched(true);
                }}
                placeholder="e.g. Weekly planning"
                maxLength={120}
              />
            </div>
            {usesMic && (
              <div>
                <span className="field-label">Mic level · {micLabel}</span>
                <LevelBars level={meter.levels[0] ?? 0} label="Input level" />
              </div>
            )}
          </div>
          <button type="button" className="link-btn self-start" aria-expanded={more} onClick={() => setMore((v) => !v)}>
            {more ? 'Fewer options' : 'Devices, agenda & live draft…'}
          </button>
          {more && (
            <div className="hero-more">
              <AudioDevicePickers microphone={usesMic} systemOutput={mode !== 'speaker' && directSystemAudio} />
              <span className="field-label">3 · Agenda (optional)</span>
              {agenda === null ? (
                <button type="button" className="btn" onClick={() => setAgenda([newAgendaItem()])}>
                  + Add agenda
                </button>
              ) : (
                <>
                  <AgendaEditor items={agenda} onChange={setAgenda} />
                  <button type="button" className="link-btn mt-2" onClick={() => setAgenda(null)}>
                    Remove agenda
                  </button>
                </>
              )}
              <LiveTranscriptionToggle />
            </div>
          )}
          {!secure && (
            <p className="warn mb-0" role="alert">
              Audio capture is unavailable on this page — open the app over https:// or on localhost.
            </p>
          )}
          {storageWarning && <p className="warn mb-0">{storageWarning}</p>}
          {startError && (
            <div className="start-error" role="alert">
              <strong>{typeof startError === 'string' ? startError : startError.message}</strong>
              {typeof startError !== 'string' && <p className="small mt-1 mb-0">{startError.hint}</p>}
              {typeof startError !== 'string' && startError.retryable && (
                <div className="btn-row mt-2">
                  <button type="button" className="btn" disabled={busy} onClick={start}>
                    Try again
                  </button>
                  {usesMic && secure && (
                    <button type="button" className="link-btn" disabled={permBusy} onClick={grantMicrophone}>
                      {permBusy ? 'Requesting…' : 'Grant microphone access'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-hero"
              disabled={busy || importing || !secure || recording}
              onClick={start}
            >
              {busy ? 'Starting…' : '● Start recording'} <Keys binding={keys.record} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,.m4a,.mp4"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) importFile(file);
              }}
            />
            <button type="button" className="btn btn-lg-plain" disabled={busy || importing} onClick={() => fileInputRef.current?.click()}>
              {importing ? 'Importing…' : '↑ Import audio file'}
            </button>
            <span className="small">No speech model needed to record.</span>
          </div>
        </section>

        <div className="home-side">
          {!modelMeta.state.startsWith('ready') && !remoteAsrActive(remoteAsrConfig) && nativeStatus?.available && installedModels.length === 0 && (
            <section className="cta-red" aria-label="Local speech model">
              <span className="cta-title">Set up on-device transcription</span>
              <div>One click downloads the speech model ({firstRunModel}) once. Recording already works without it.</div>
              <p className="mt-2 mb-0 small" aria-label="Acceleration">
                {describeNativeRuntime(nativeStatus)}
              </p>
              {modelDownload ? (
                <div className="mt-3">
                  <ModelDownloadProgress />
                </div>
              ) : (
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={() => {
                      setSetupError(null);
                      downloadModel(firstRunModel).catch((e: unknown) => setSetupError(e instanceof Error ? e.message : String(e)));
                    }}
                  >
                    Set up transcription
                  </button>
                  <button className="btn" onClick={() => go({ name: 'settings', tab: 'models' })}>
                    Choose another model
                  </button>
                </div>
              )}
              {setupError && <p className="warn mt-3 mb-0">{setupError}</p>}
            </section>
          )}
          {nativeStatus && !nativeStatus.available && (
            <section className="card" aria-label="Local speech model">
              <strong>Transcription engine not found</strong>
              <p className="muted mb-0">{describeNativeRuntime(nativeStatus)} Recording works without it.</p>
            </section>
          )}
          <WaitingForYou
            txProgress={txProgress}
            txStage={txStage}
            transcribe={(id) => void setupAndTranscribe(id).catch(() => undefined)}
          />
          {isDesktopApp() && (
            <section className="card" aria-label="Coming up">
              <div className="card-title">
                <strong>Coming up · from your calendar</strong>
              </div>
              {validateCalendarConfig(calendarConfig) !== null ? (
                <p className="muted mb-0">
                  Connect your company calendar to see your next meeting here and record it in one click.{' '}
                  <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'integrations' })}>
                    Connect the calendar
                  </button>
                </p>
              ) : upcoming.events.length === 0 ? (
                <p className="muted mb-0">{upcoming.error ? `Could not load the calendar: ${upcoming.error}` : upcoming.loaded ? 'Nothing in the next 36 hours.' : 'Loading…'}</p>
              ) : (
                <ul className="event-list">
                  {upcoming.events.slice(0, 3).map((e) => (
                    <li key={e.id}>
                      <button
                        type="button"
                        className="evrec"
                        aria-label={`Start recording ${e.title}, ${whenLabel(e.startIso, e.endIso)}`}
                        disabled={recording}
                        onClick={() => {
                          const plan = fromEvent(e, mode);
                          setStartError(null);
                          startRecording(plan.title, plan.mode, plan.agenda, { calendarSource: plan.calendarSource }).catch((err: unknown) =>
                            setStartError(errorOf(err)),
                          );
                        }}
                      >
                        <span className="evtime">
                          <span className="evclock">
                            {new Date(e.startIso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <span className="evwhen">{whenLabel(e.startIso, e.endIso)}</span>
                        </span>
                        <span className="evbody">
                          <span className="evtitle">{e.title}</span>
                          <span className="small muted">
                            {[e.location, e.hasCallLink ? 'video call' : '', e.description ? 'agenda attached' : ''].filter(Boolean).join(' · ') || 'In person'}
                          </span>
                          <span className="evgo">
                            ● Record now <span aria-hidden="true">→</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="card-foot">
                <label className="check-row mt-0">
                  <input type="checkbox" checked={remindToRecord()} onChange={(e) => setRemindToRecord(e.target.checked)} />
                  Remind me to record when it starts
                </label>
              </div>
            </section>
          )}
        </div>
      </div>

      <section className="recent" aria-label="Recent meetings">
        <div className="list-head">
          <h2>Recent</h2>
          {meetings.length > 0 && (
            <button type="button" className="link-btn" onClick={() => go({ name: 'library' })}>
              All {meetings.length} meeting{meetings.length === 1 ? '' : 's'} in the library →
            </button>
          )}
        </div>
        {meetings.length === 0 ? (
          <div className="card empty">
            <h3>No meetings yet</h3>
            <p className="muted">Record your first meeting above — you can transcribe it later, fully offline.</p>
          </div>
        ) : (
          <ul className="meeting-list">
            {meetings.slice(0, 3).map((m) => (
              <li key={m.id}>
                <MeetingRow m={m} progress={txProgress[m.id]} onOpen={() => go({ name: 'detail', id: m.id })} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** Transcriptions running, meetings not transcribed yet, wrap-ups left half-way. */
function WaitingForYou({
  txProgress,
  txStage,
  transcribe,
}: {
  txProgress: Record<string, number>;
  txStage: Record<string, string>;
  transcribe: (id: string) => void;
}): React.JSX.Element | null {
  const { meetings, go, modelMeta } = useApp();
  const prefs = wrapPrefs();
  const enabled = enabledWrapSteps(prefs);
  const runningIds = Object.keys(txStage);
  const running = runningIds.map((id) => meetings.find((m) => m.id === id)).filter((m): m is NonNullable<typeof m> => !!m);
  const untranscribed = meetings.filter(
    (m) => m.transcriptionStatus === 'not_started' && !runningIds.includes(m.id) && !m.unfinished && !m.audioRemovedAt,
  );
  const leftovers = prefs.homeList
    ? meetings
        .map((m) => ({ m, left: wrapLeftover(m, enabled, prefs.pretick) }))
        .filter((x): x is { m: (typeof meetings)[number]; left: string } => !!x.left)
    : [];
  const total = running.length + untranscribed.length + leftovers.length;
  const now = Date.now();
  useEffect(() => {
    for (const id of runningIds) if (!runStarted.has(id)) runStarted.set(id, { at: Date.now(), ratio: txProgress[id] ?? 0 });
    for (const id of [...runStarted.keys()]) if (!runningIds.includes(id)) runStarted.delete(id);
  });
  if (total === 0) return null;
  const eta = (id: string): string => {
    const r = txProgress[id] ?? 0;
    const s = runStarted.get(id);
    if (!s || r - s.ratio < 0.03) return 'you can keep working';
    const left = ((now - s.at) / (r - s.ratio)) * (1 - r);
    const min = Math.max(1, Math.round(left / 60000));
    return `about ${min} min left · you can keep working`;
  };
  return (
    <section className="card lift waiting" aria-label="Waiting for you">
      <div className="card-title">
        <strong>Waiting for you · {total}</strong>
      </div>
      {running.map((m) => (
        <div key={m.id} className="wait-row running">
          <div className="row between">
            <strong>Transcribing · {m.title}</strong>
            <span>{Math.round((txProgress[m.id] ?? 0) * 100)}%</span>
          </div>
          <progress value={txProgress[m.id] ?? 0} max={1} aria-label={`Transcribing ${m.title}`} />
          <div className="small muted">
            {modelMeta.modelId} · {txStage[m.id] === 'queued' ? 'queued' : eta(m.id)}
          </div>
        </div>
      ))}
      {leftovers.slice(0, 4).map(({ m, left }) => {
        const next = nextWrapStep(m, enabled, prefs.pretick);
        return (
          <div key={`w-${m.id}`} className="wait-row">
            <div className="grow">
              <div className="wait-title">{m.title}</div>
              <div className="small muted">Wrap-up: {left}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => go({ name: 'wrapup', id: m.id, ...(next ? { step: next } : {}) })}>
              {next ? WRAP_STEP_LABELS[next] : 'Continue'} →
            </button>
          </div>
        );
      })}
      {untranscribed.slice(0, 4).map((m) => (
        <div key={m.id} className="wait-row">
          <div className="grow">
            <button type="button" className="wait-title link-plain" onClick={() => go({ name: 'detail', id: m.id })}>
              {m.title}
            </button>
            <div className="small muted">
              {new Date(m.createdAt).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ·{' '}
              {formatDuration(m.durationMs)}
            </div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => transcribe(m.id)}>
            Transcribe
          </button>
        </div>
      ))}
    </section>
  );
}

function RecoveryBanner({
  unfinished,
  recover,
  discard,
}: {
  unfinished: ReturnType<typeof useApp>['unfinished'];
  recover: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
}): React.JSX.Element {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <section className="banner" aria-label="Unfinished recording">
      <strong>An unfinished recording was found.</strong>
      {unfinished.map((m) => (
        <div key={m.id} className="mt-2">
          <div className="muted">
            Started {new Date(m.startedAt).toLocaleString()} · approximately {formatDuration(m.durationMs)} saved
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => void recover(m.id)}>
              Recover Recording
            </button>
            {confirm === m.id ? (
              <>
                <button
                  className="btn btn-danger"
                  onClick={() => {
                    setConfirm(null);
                    void discard(m.id);
                  }}
                >
                  Yes, delete this audio
                </button>
                <button className="btn" onClick={() => setConfirm(null)}>
                  Keep it
                </button>
              </>
            ) : (
              <button className="btn btn-danger" onClick={() => setConfirm(m.id)}>
                Delete
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}

function DatabaseBanner({ message, reset }: { message: string; reset: () => Promise<void> }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'confirm' | 'working'>('idle');
  const [error, setError] = useState<string | null>(null);
  const desktop = useMemo(() => isDesktopApp(), []);
  return (
    <section className="banner" role="alert" aria-label="Database problem">
      <strong>Your meetings list could not be loaded.</strong>
      <p className="muted mt-2">
        {message} This usually means the app data was written by a different build of the app (for example a newer
        system WebKit than the one inside the AppImage). Your settings are kept separately and are safe, and finished
        meetings are also saved in your Local Transcribe documents folder.
      </p>
      {desktop && (
        <div className="btn-row">
          {state === 'confirm' ? (
            <>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setState('working');
                  setError(null);
                  reset().catch((err: unknown) => {
                    setError(err instanceof Error ? err.message : String(err));
                    setState('idle');
                  });
                }}
              >
                Move old database aside &amp; restart
              </button>
              <button className="btn" onClick={() => setState('idle')}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn" disabled={state === 'working'} onClick={() => setState('confirm')}>
              {state === 'working' ? 'Restarting…' : 'Start with a fresh database'}
            </button>
          )}
        </div>
      )}
      {state === 'confirm' && (
        <p className="muted mt-2">
          The unreadable database is moved to a backup folder (not deleted) and the app restarts with an empty meetings
          list.
        </p>
      )}
      {error && <p className="error mt-2">{error}</p>}
    </section>
  );
}
