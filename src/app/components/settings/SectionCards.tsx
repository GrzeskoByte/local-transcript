import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../store.tsx';
import type { ExportFormat, RecordingMode } from '../../../domain/meeting';
import {
  calendarPrefs,
  defaultSource,
  exportBaseName,
  exportPrefs,
  keepAudio,
  recordingPrefs,
  setCalendarPrefs,
  setDefaultSource,
  setExportPrefs,
  setKeepAudio,
  setRecordingPrefs,
  setWrapPrefs,
  usePrefsVersion,
  wrapPrefs,
  type KeepAudio,
} from '../../preferences';
import { LevelBars, useLevelMonitor } from '../LevelMeter.tsx';
import { getMicrophoneDevice } from '../../../audio/devices';
import { playbackContext } from '../../../audio/player';
import { isDesktopApp } from '../../../platform/desktop';
import {
  appLogs,
  diarizeStatus,
  formatBytes,
  pickFolder,
  setStorageDir,
  storageUsage,
  systemInfo,
  type StorageUsage,
} from '../../../platform/system';
import { clearNetworkLog, networkLog } from '../../../platform/network-log';
import { describeNativeRuntime } from '../../../asr/model-manager';
import { getTestReleases, setTestReleases } from '../../../platform/updater';
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  bindingOf,
  resetShortcuts,
  setShortcut,
  type ShortcutId,
} from '../../shortcuts';
import { Keys, useShortcuts } from '../../App.tsx';
import { CALENDAR_PROVIDER_LABELS, validateCalendarConfig } from '../../../integrations/calendar';
import {
  DEFAULT_EXTRACT,
  LLM_PRESETS,
  LLM_PRESET_LABELS,
  createLlmClient,
  summaryDestination,
  type LlmConfig,
  type LlmPreset,
  type SummaryExtract,
} from '../../../integrations/llm';
import type { GitlabConfig } from '../../../integrations/gitlab';
import { getSegments } from '../../../storage/transcripts';
import { namedSegments } from '../../../domain/speakers';
import { segmentsToMarkdown } from '../../../domain/transcript';
import { logNetwork } from '../../../platform/network-log';

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="set-row">
      <span className="grow">
        <b>{label}</b>
        {hint && <small className="muted"> {hint}</small>}
      </span>
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

// ---- Engine & models -------------------------------------------------------

/** Engine · ready / GPU / language rows + speaker detection, and the storage summary. */
export function EngineOverview(): React.JSX.Element {
  const { nativeStatus, go } = useApp();
  const [diarize, setDiarize] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  useEffect(() => {
    void diarizeStatus().then((s) => setDiarize(s.available));
    if (isDesktopApp()) void storageUsage().then(setUsage).catch(() => undefined);
  }, []);
  const total = usage ? usage.audioBytes + usage.modelBytes + usage.textBytes : 0;
  return (
    <div className="settings-pair">
      <section className="card" aria-label="Engine">
        <div className="card-title">
          <strong>Engine · {nativeStatus?.available ? 'ready' : nativeStatus ? 'not found' : 'checking…'}</strong>
        </div>
        <div className="set-row">
          <span className="mark">{nativeStatus?.available ? '[x]' : '[ ]'}</span>
          <span className="grow">
            <b>{nativeStatus?.backend === 'voxtype' ? 'voxtype' : 'whisper.cpp'}</b>
            <br />
            <small className="muted" aria-label="Acceleration">
              {describeNativeRuntime(nativeStatus)}
            </small>
          </span>
        </div>
        <div className="set-row">
          <span className="mark">{diarize ? '[x]' : '[ ]'}</span>
          <span className="grow">
            <b>Speaker detection</b>
            <br />
            <small className="muted">
              {diarize === null
                ? 'checking…'
                : diarize
                  ? 'Bundled (sherpa-onnx), runs on this computer · "Detect speakers" on a transcript'
                  : 'Not in this build — release builds include it'}
            </small>
          </span>
        </div>
      </section>
      {isDesktopApp() && (
        <section className="card" aria-label="Storage">
          <div className="card-title">
            <strong>Storage</strong>
          </div>
          <div className="stat">{usage ? formatBytes(total) : '…'}</div>
          {usage && <StorageBar usage={usage} />}
          <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'storage' })}>
            Storage &amp; privacy →
          </button>
        </section>
      )}
    </div>
  );
}

function StorageBar({ usage }: { usage: StorageUsage }): React.JSX.Element {
  const total = Math.max(1, usage.audioBytes + usage.modelBytes + usage.textBytes);
  return (
    <>
      <div
        className="usage-bar"
        role="img"
        aria-label={`Audio ${formatBytes(usage.audioBytes)}, models ${formatBytes(usage.modelBytes)}, text ${formatBytes(usage.textBytes)}`}
      >
        <span className="u-audio" style={{ width: `${(usage.audioBytes / total) * 100}%` }} />
        <span className="u-models" style={{ width: `${(usage.modelBytes / total) * 100}%` }} />
      </div>
      <div className="usage-legend small">
        <span>■ Audio {formatBytes(usage.audioBytes)}</span>
        <span>
          <span className="u-models-key">■</span> Models {formatBytes(usage.modelBytes)}
        </span>
        <span>□ Text {formatBytes(usage.textBytes)}</span>
      </div>
    </>
  );
}

// ---- Recording & devices ---------------------------------------------------

const SOURCES: Array<[RecordingMode, string]> = [
  ['speaker', 'Room mic'],
  ['device', 'This computer'],
  ['dual', 'Call'],
];

export function RecordingCards(): React.JSX.Element {
  usePrefsVersion();
  const prefs = recordingPrefs();
  const source = defaultSource();
  const { nativeRecording, systemAudio } = useApp();
  const mic = getMicrophoneDevice()?.label ?? '';
  const { levels } = useLevelMonitor([{ role: 'microphone', device: mic }]);
  const systemOk = !!nativeRecording?.systemAudio || !!systemAudio?.available;
  const [tone, setTone] = useState(false);
  const playTone = (): void => {
    const ctx = playbackContext();
    void ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    setTone(true);
    osc.start();
    setTimeout(() => {
      osc.stop();
      osc.disconnect();
      gain.disconnect();
      setTone(false);
    }, 1000);
  };
  const os = /Mac/i.test(navigator.userAgent) ? 'mac' : /Win/i.test(navigator.userAgent) ? 'win' : 'linux';
  return (
    <>
      <section className="card" aria-label="New recordings">
        <div className="card-title">
          <strong>New recordings start with</strong>
        </div>
        <div className="set-row">
          <span className="grow">
            <b>Default source</b> <small className="muted">Preselected on Home. Calendar meetings with a video link start as Call.</small>
          </span>
          <span className="seg-control" role="radiogroup" aria-label="Default source">
            {SOURCES.map(([m, l]) => (
              <label key={m} className={source === m ? 'on' : undefined}>
                <input type="radio" name="default-src" checked={source === m} onChange={() => setDefaultSource(m)} />
                {l}
              </label>
            ))}
          </span>
        </div>
        <Toggle
          label="Name from the calendar"
          hint="Use the event title when a meeting is on now."
          checked={prefs.nameFromCalendar}
          onChange={(v) => setRecordingPrefs({ nameFromCalendar: v })}
        />
      </section>
      <section className="card" aria-label="Microphone level">
        <div className="card-title">
          <strong>Microphone · {mic || 'system default'}</strong>
        </div>
        <LevelBars level={levels[0] ?? 0} label="Microphone level" />
        <p className="small muted mb-0">
          {(levels[0] ?? 0) > 0.97 ? 'Too loud — lower the input volume.' : (levels[0] ?? 0) > 0.02 ? 'Level good.' : 'Say something.'} Aim for
          black; pink means clipping.
        </p>
      </section>
      <section className="card" aria-label="Computer audio">
        <div className="card-title">
          <strong>Computer audio {systemOk ? '[x] working' : '[ ] via screen share'}</strong>
        </div>
        <p className="muted mt-0">
          {os === 'mac'
            ? 'System audio tap (macOS 14.2+). Records what the computer plays — no screen capture.'
            : os === 'win'
              ? 'WASAPI loopback. Records what the computer plays — no screen capture.'
              : 'PipeWire / PulseAudio monitor of the output. Records what the computer plays — no screen capture.'}
        </p>
        <div className="btn-row mt-0">
          <button type="button" className="btn btn-sm" disabled={tone} onClick={playTone}>
            {tone ? 'Playing…' : 'Play test sound'}
          </button>
        </div>
      </section>
      <section className="card" aria-label="While recording">
        <div className="card-title">
          <strong>While recording</strong>
        </div>
        <Toggle
          label="Consent reminder for calls"
          hint="A line appears when a call recording starts."
          checked={prefs.consentReminder}
          onChange={(v) => setRecordingPrefs({ consentReminder: v })}
        />
        <Toggle
          label="Warn about audio problems"
          hint="Silence, clipping, or a device that disconnects."
          checked={prefs.audioWarnings}
          onChange={(v) => setRecordingPrefs({ audioWarnings: v })}
        />
        <Toggle
          label="Keep recording if the lid closes"
          hint="Stops sleep while a recording runs (on power)."
          checked={prefs.keepAwake}
          onChange={(v) => setRecordingPrefs({ keepAwake: v })}
        />
      </section>
    </>
  );
}

// ---- After recording -------------------------------------------------------

const STEP_DEFS: Array<{ id: 'transcribe' | 'summary' | 'gitlab' | 'calendar' | 'export'; name: string; desc: string }> = [
  { id: 'transcribe', name: 'Transcribe', desc: 'Starts the moment you press stop. Always first — everything else needs the text.' },
  { id: 'summary', name: 'Review summary', desc: 'Read the summary and choose what each action item becomes.' },
  { id: 'gitlab', name: 'GitLab issues', desc: 'Turn picked action items into issues.' },
  { id: 'calendar', name: 'Calendar events', desc: 'Add follow-ups with a date to the company calendar.' },
  { id: 'export', name: 'Export', desc: 'Save files and, if you like, post the summary to the wiki.' },
];

export function AfterRecordingCards(): React.JSX.Element {
  usePrefsVersion();
  const w = wrapPrefs();
  const ex = exportPrefs();
  const on = (id: (typeof STEP_DEFS)[number]['id']) => id === 'transcribe' || w.steps[id];
  const chain = STEP_DEFS.filter((s) => on(s.id));
  const preview = exportBaseName(ex.fileName, 'Q4 roadmap sync', new Date().getTime());
  return (
    <>
      <section className="card" aria-label="Wrap-up steps">
        <div className="card-title">
          <strong>Wrap-up steps · {chain.length} of 5 on</strong>
        </div>
        <Toggle label="Guide me through the wrap-up after Stop" hint="One step at a time, each skippable." checked={w.guide} onChange={(v) => setWrapPrefs({ guide: v })} />
        <div className="chain-line" aria-label="What happens after stop">
          After stop:{' '}
          {chain.map((s, i) => (
            <span key={s.id}>
              <span className="pill">{s.name}</span>
              {i < chain.length - 1 ? ' → ' : ''}
            </span>
          ))}
        </div>
        {STEP_DEFS.map((s, i) => (
          <label key={s.id} className={`set-row${on(s.id) ? '' : ' off'}`}>
            <span className="wrap-n">{i + 1}</span>
            <span className="grow">
              <b>{s.name}</b> <small className="muted">{s.desc}</small>
            </span>
            <input
              type="checkbox"
              aria-label={s.name}
              checked={on(s.id)}
              disabled={s.id === 'transcribe'}
              onChange={(e) => s.id !== 'transcribe' && setWrapPrefs({ steps: { ...w.steps, [s.id]: e.target.checked } })}
            />
          </label>
        ))}
      </section>
      <section className="card" aria-label="Wrap-up behaviour">
        <div className="card-title">
          <strong>If you leave part-way</strong>
        </div>
        <Toggle label="List unfinished steps on Home" hint='Under "Waiting for you", with one click back into the step.' checked={w.homeList} onChange={(v) => setWrapPrefs({ homeList: v })} />
        <Toggle label="Show a banner in the meeting" hint='"2 calendar events were skipped — add them now?"' checked={w.banner} onChange={(v) => setWrapPrefs({ banner: v })} />
        <Toggle label="Pre-tick action items" hint="Owner + date found → GitLab. A date and time → calendar." checked={w.pretick} onChange={(v) => setWrapPrefs({ pretick: v })} />
      </section>
      <section className="card" aria-label="Export defaults">
        <div className="card-title">
          <strong>Export defaults</strong>
        </div>
        <div className="set-row">
          <span className="grow">
            <b>Formats</b> <small className="muted">Preselected in the export step.</small>
          </span>
          <span className="row wrap">
            {(['md', 'txt', 'json', 'audio'] as ExportFormat[]).map((f) => (
              <button
                key={f}
                type="button"
                className="toggle"
                aria-pressed={ex.formats[f]}
                onClick={() => setExportPrefs({ formats: { ...ex.formats, [f]: !ex.formats[f] } })}
              >
                {ex.formats[f] ? '[x]' : '[ ]'} {f === 'md' ? 'Markdown' : f === 'audio' ? 'Audio' : f.toUpperCase()}
              </button>
            ))}
          </span>
        </div>
        <label className="set-row">
          <span className="grow">
            <b>File names</b>{' '}
            <small className="muted">
              Preview: <code>{preview}.md</code> · {'{date}'} {'{time}'} {'{title}'}
            </small>
          </span>
          <input className="input input-sm" aria-label="File name pattern" value={ex.fileName} onChange={(e) => setExportPrefs({ fileName: e.target.value })} />
        </label>
        <Toggle label="Post the summary to the GitLab wiki" hint="Preselected in the export step when GitLab is connected." checked={ex.wiki} onChange={(v) => setExportPrefs({ wiki: v })} />
      </section>
    </>
  );
}

// ---- GitLab & calendar extras ----------------------------------------------

export function CalendarExtras(): React.JSX.Element | null {
  usePrefsVersion();
  const { calendarConfig } = useApp();
  const p = calendarPrefs();
  if (validateCalendarConfig(calendarConfig) !== null) return null;
  return (
    <section className="card" aria-label="Calendar on Home">
      <div className="card-title">
        <strong>Calendar · {CALENDAR_PROVIDER_LABELS[calendarConfig.provider]} · connected</strong>
      </div>
      <label className="set-row">
        <span className="grow">
          <b>Add follow-ups to</b> <small className="muted">A calendar collection URL of this account; empty = the one above.</small>
        </span>
        <input
          className="input"
          aria-label="Add follow-ups to"
          placeholder={calendarConfig.calendarUrl || calendarConfig.serverUrl}
          value={p.followupCalendar}
          onChange={(e) => setCalendarPrefs({ followupCalendar: e.target.value })}
        />
      </label>
      <Toggle label="Show what's coming up on Home" hint="Next meeting, with a reminder to record." checked={p.comingUp} onChange={(v) => setCalendarPrefs({ comingUp: v })} />
      <Toggle label="Use event agendas" hint="Attach the event's agenda (its description) to the recording." checked={p.useAgendas} onChange={(v) => setCalendarPrefs({ useAgendas: v })} />
    </section>
  );
}

// ---- Storage & privacy -----------------------------------------------------

export function StorageCards(): React.JSX.Element {
  usePrefsVersion();
  const { meetings, saveToDisk, setSaveToDisk, storageDir, openStorageDir, applyRetention, deleteAllMeetings } = useApp();
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<typeof meetings | null>(null);
  const [typed, setTyped] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const keep = keepAudio();
  const reload = (): void => {
    if (isDesktopApp()) void storageUsage().then(setUsage).catch(() => undefined);
  };
  useEffect(reload, [storageDir]);
  const exportedAudio = useMemo(() => meetings.filter((m) => !!m.exports?.audio && !m.audioRemovedAt), [meetings]);
  const log = networkLog();
  const total = usage ? usage.audioBytes + usage.modelBytes + usage.textBytes : 0;

  return (
    <>
      <section className="card" aria-label="On this disk">
        <div className="card-title">
          <strong>On this disk</strong>
        </div>
        {isDesktopApp() ? (
          <>
            <div className="row wrap">
              <span className="stat">{usage ? formatBytes(total) : '…'}</span>
              <span className="muted">
                {meetings.length} meeting{meetings.length === 1 ? '' : 's'}
                {usage?.freeBytes ? ` · ${formatBytes(usage.freeBytes)} free` : ''}
              </span>
            </div>
            {usage && <StorageBar usage={usage} />}
            <code className="block mt-3">{storageDir ?? 'Locating the local files folder…'}</code>
            <div className="btn-row">
              <button type="button" className="btn btn-sm" onClick={() => void openStorageDir()}>
                Show in folder
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() =>
                  void pickFolder('Move the meeting files to…')
                    .then(async (p) => {
                      if (!p) return;
                      setBusy(true);
                      const dir = await setStorageDir(p, true);
                      setMessage(`Meeting files now live in ${dir}. Restart the app to use it everywhere.`);
                      reload();
                    })
                    .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
                    .finally(() => setBusy(false))
                }
              >
                Move…
              </button>
            </div>
          </>
        ) : (
          <p className="muted mb-0">Meetings are stored in this browser's private storage.</p>
        )}
        {message && (
          <p className="muted small mb-0" role="status">
            {message}
          </p>
        )}
      </section>

      <section className="card" aria-label="Keeping things">
        <div className="card-title">
          <strong>Keeping things</strong>
        </div>
        <div className="set-row">
          <span className="grow">
            <b>Keep audio after transcribing</b> <small className="muted">Transcripts are always kept.</small>
          </span>
          <span className="seg-control" role="radiogroup" aria-label="Keep audio">
            {(
              [
                ['always', 'Always'],
                ['30d', '30 days'],
                ['exported', 'Until exported'],
              ] as Array<[KeepAudio, string]>
            ).map(([v, l]) => (
              <label key={v} className={keep === v ? 'on' : undefined}>
                <input
                  type="radio"
                  name="keep-audio"
                  checked={keep === v}
                  onChange={() => {
                    if (v === 'always') return setKeepAudio(v);
                    // Ask once, showing what would go now.
                    setKeepAudio(v);
                    void applyRetention(true).then((due) => {
                      if (due.length === 0) return setMessage(null);
                      setReview(due);
                    });
                  }}
                />
                {l}
              </label>
            ))}
          </span>
        </div>
        {review && (
          <div className="warn" role="alert">
            <strong>
              This removes the audio of {review.length} meeting{review.length === 1 ? '' : 's'} now:
            </strong>{' '}
            {review.slice(0, 5).map((m) => m.title).join(', ')}
            {review.length > 5 ? '…' : ''}. Their transcripts stay.
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={() =>
                  void applyRetention().then((done) => {
                    setReview(null);
                    setMessage(`Removed the audio of ${done.length} meeting${done.length === 1 ? '' : 's'}.`);
                    reload();
                  })
                }
              >
                Remove it now
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setKeepAudio('always');
                  setReview(null);
                }}
              >
                Keep everything
              </button>
            </div>
          </div>
        )}
        {isDesktopApp() && (
          <Toggle label="Mirror to Documents" hint="A plain copy of each finished meeting." checked={saveToDisk} onChange={setSaveToDisk} />
        )}
        <div className="set-row">
          <span className="grow">
            <b>Free up space</b>{' '}
            <small className="muted">
              {exportedAudio.length
                ? `Audio of ${exportedAudio.length} meeting${exportedAudio.length === 1 ? '' : 's'} already exported.`
                : 'Nothing exported yet — nothing to free.'}
            </small>
          </span>
          <button type="button" className="btn btn-sm" disabled={exportedAudio.length === 0} onClick={() => setReview(exportedAudio)}>
            Review…
          </button>
        </div>
      </section>

      <section className="card" aria-label="Network activity">
        <div className="card-title">
          <strong>Network activity · last 30 days</strong>
          <span className="badge badge-ok">[x] no analytics, ever</span>
        </div>
        <p className="muted mt-0">
          The app has no telemetry or crash reporting — there is nothing to switch off. These are the only connections it made,
          each one started by you.
        </p>
        {log.length === 0 ? (
          <p className="muted mb-0">No connections yet.</p>
        ) : (
          <div className="table-scroll">
            <table className="meetings-table">
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Where</th>
                  <th scope="col">Why</th>
                  <th scope="col">Sent</th>
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 50).map((e, i) => (
                  <tr key={i}>
                    <td className="nowrap">{new Date(e.at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>{e.host}</td>
                    <td>{e.why}</td>
                    <td>{e.sent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.length > 0 && (
          <div className="btn-row">
            <button type="button" className="btn btn-sm" onClick={() => (clearNetworkLog(), setMessage('Network log cleared.'))}>
              Clear the log
            </button>
          </div>
        )}
      </section>

      <section className="card danger-zone" aria-label="Delete everything">
        <div className="model-title">
          <strong>Delete everything</strong>
        </div>
        <div className="set-row">
          <span className="grow">
            <b>Remove all {meetings.length} meetings</b>{' '}
            <small className="muted">Audio, transcripts and summaries on this computer. Issues and events already created stay where they are.</small>
          </span>
          {!confirmAll && (
            <button type="button" className="btn btn-danger btn-sm" disabled={meetings.length === 0} onClick={() => setConfirmAll(true)}>
              Delete all…
            </button>
          )}
        </div>
        {confirmAll && (
          <div className="row wrap">
            <label className="small" htmlFor="delete-all-confirm">
              Type DELETE to confirm
            </label>
            <input id="delete-all-confirm" className="input input-sm" value={typed} onChange={(e) => setTyped(e.target.value)} />
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={typed !== 'DELETE' || busy}
              onClick={() => {
                setBusy(true);
                deleteAllMeetings()
                  .then((n) => setMessage(`Deleted ${n} meeting${n === 1 ? '' : 's'}.`))
                  .finally(() => {
                    setBusy(false);
                    setConfirmAll(false);
                    setTyped('');
                    reload();
                  });
              }}
            >
              {busy ? 'Deleting…' : 'Delete everything'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
          </div>
        )}
      </section>
    </>
  );
}

// ---- App & updates ---------------------------------------------------------

export function AppCards(): React.JSX.Element {
  const { go, nativeStatus, recordingState } = useApp();
  const keys = useShortcuts();
  const [testReleases, setTest] = useState(getTestReleases);
  const [message, setMessage] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [binding, setBinding] = useState<ShortcutId | null>(null);
  const [version, setVersion] = useState<string>('');
  useEffect(() => {
    if (isDesktopApp()) void systemInfo().then((i) => setVersion(i.appVersion)).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!binding) return;
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') return setBinding(null);
      const b = bindingOf(e);
      if (!b) return;
      setShortcut(binding, b);
      setBinding(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [binding]);

  const copyDiagnostics = async (): Promise<void> => {
    const info = isDesktopApp() ? await systemInfo().catch(() => null) : null;
    const lines = [
      `Local Transcriber ${info?.appVersion ?? ''}`,
      `OS: ${info ? `${info.os} ${info.osVersion} ${info.arch}` : navigator.userAgent}`,
      info ? `CPUs ${info.cpus} · memory ${formatBytes(info.memoryBytes)} · free ${formatBytes(info.freeDiskBytes)}` : '',
      `Engine: ${describeNativeRuntime(nativeStatus)}`,
      `Recording state: ${recordingState}`,
      '',
      'Last log lines:',
      ...(isDesktopApp() ? (await appLogs().catch(() => [])).slice(-40) : []),
    ].filter((l) => l !== undefined);
    await navigator.clipboard?.writeText(lines.join('\n'));
    setMessage('Diagnostics copied — versions, devices and the last errors; no audio or text.');
  };

  return (
    <>
      <section className="card" aria-label="Setup and diagnostics">
        <div className="card-title">
          <strong>Setup &amp; diagnostics</strong>
        </div>
        <Toggle
          label="Include test releases"
          hint="Earlier features, more bugs. Checks use the canary channel."
          checked={testReleases}
          onChange={(v) => {
            setTestReleases(v);
            setTest(v);
          }}
        />
        <div className="set-row">
          <span className="grow">
            <b>Run setup again</b> <small className="muted">Microphone, calls, model, files.</small>
          </span>
          <button type="button" className="btn btn-sm" onClick={() => go({ name: 'setup', step: 1 })}>
            Open setup
          </button>
        </div>
        <div className="set-row">
          <span className="grow">
            <b>Something wrong?</b> <small className="muted">Copies versions, devices and the last errors — no audio or text.</small>
          </span>
          <span className="row">
            <button type="button" className="btn btn-sm" onClick={() => void copyDiagnostics()}>
              Copy diagnostics
            </button>
            {isDesktopApp() && (
              <button type="button" className="btn btn-sm" onClick={() => void appLogs().then(setLogs).catch(() => setLogs([]))}>
                Logs
              </button>
            )}
          </span>
        </div>
        {message && (
          <p className="muted small mb-0" role="status">
            {message}
          </p>
        )}
        {logs && (
          <pre className="log-box" aria-label="App log">
            {logs.length ? logs.slice(-200).join('\n') : 'Nothing logged yet.'}
          </pre>
        )}
      </section>
      <section className="card" aria-label="Keyboard shortcuts">
        <div className="card-title">
          <strong>Keyboard shortcuts</strong>
          <span className="collapse-actions">
            <button type="button" className="btn btn-sm" onClick={resetShortcuts}>
              Reset
            </button>
          </span>
        </div>
        <table className="kbd-table">
          <tbody>
            {(Object.keys(DEFAULT_SHORTCUTS) as ShortcutId[]).map((id) => (
              <tr key={id}>
                <td>{SHORTCUT_LABELS[id]}</td>
                <td>
                  <button type="button" className="key-btn" aria-label={`Change: ${SHORTCUT_LABELS[id]}`} onClick={() => setBinding(id)}>
                    {binding === id ? 'Press a key…' : <Keys binding={keys[id]} />}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small mb-0">Click a key to change it. Esc cancels.</p>
      </section>
      <p className="muted small about">
        local-transcriber {version} · Tauri 2 · whisper.cpp · sherpa-onnx · MIT licence ·{' '}
        <a href="https://github.com/GrzeskoByte/local-transcript" target="_blank" rel="noreferrer">
          Open-source notices
        </a>
      </p>
    </>
  );
}

// ---- Summaries -------------------------------------------------------------

type SummaryMode = 'local' | 'claude' | 'opencode' | 'remote' | 'off';

function modeOf(c: LlmConfig): SummaryMode {
  if (c.enabled === false) return 'off';
  if (c.preset === 'ollama') return 'local';
  if (c.preset === 'claude' || c.preset === 'anthropic') return 'claude';
  if (c.preset === 'opencode') return 'opencode';
  return 'remote';
}

const MODES: Array<[SummaryMode, string, string]> = [
  ['local', 'On this computer', 'Ollama. Nothing leaves the machine.'],
  ['claude', 'Claude', 'Claude Code with your login, or an API key.'],
  ['opencode', 'OpenCode', 'Any provider OpenCode is set up for.'],
  ['remote', 'Other server', 'An OpenAI-compatible API or Open WebUI.'],
  ['off', 'Off', 'No summaries; the wrap-up skips the step.'],
];

const PRESET_FOR: Record<Exclude<SummaryMode, 'off'>, LlmPreset> = {
  local: 'ollama',
  claude: 'claude',
  opencode: 'opencode',
  remote: 'openai',
};

/** Mode picker shown above the provider form. */
export function SummaryModePicker({
  draft,
  setDraft,
}: {
  draft: LlmConfig;
  setDraft: (c: LlmConfig) => void;
}): React.JSX.Element {
  const mode = modeOf(draft);
  const leaves = summaryDestination(draft);
  const acked = !!draft.acknowledged?.[draft.preset];
  return (
    <section className="card" aria-label="Where summaries are made">
      <div className="card-title">
        <strong>Where summaries are made</strong>
      </div>
      <div className="mode-grid" role="radiogroup" aria-label="Summary mode">
        {MODES.map(([m, label, hint]) => (
          <label key={m} className={`mode${mode === m ? ' on' : ''}`}>
            <input
              type="radio"
              name="summary-mode"
              checked={mode === m}
              onChange={() => {
                if (m === 'off') return setDraft({ ...draft, enabled: false });
                const preset = mode === m ? draft.preset : PRESET_FOR[m];
                const d = LLM_PRESETS[preset];
                setDraft({
                  ...draft,
                  enabled: true,
                  preset,
                  baseUrl: preset === draft.preset ? draft.baseUrl : d.baseUrl || draft.baseUrl,
                  model: preset === draft.preset ? draft.model : d.model || draft.model,
                });
              }}
            />
            <b>{label}</b>
            <small>{hint}</small>
          </label>
        ))}
      </div>
      {mode === 'claude' && (
        <div className="seg-control mt-3" role="radiogroup" aria-label="Claude via">
          {(
            [
              ['claude', 'Claude Code CLI'],
              ['anthropic', 'API key'],
            ] as Array<[LlmPreset, string]>
          ).map(([p, l]) => (
            <label key={p} className={draft.preset === p ? 'on' : undefined}>
              <input
                type="radio"
                name="claude-via"
                checked={draft.preset === p}
                onChange={() => setDraft({ ...draft, preset: p, baseUrl: LLM_PRESETS[p].baseUrl, model: LLM_PRESETS[p].model })}
              />
              {l}
            </label>
          ))}
        </div>
      )}
      {mode === 'remote' && (
        <div className="seg-control mt-3" role="radiogroup" aria-label="Server type">
          {(['openai', 'openwebui', 'custom'] as LlmPreset[]).map((p) => (
            <label key={p} className={draft.preset === p ? 'on' : undefined}>
              <input
                type="radio"
                name="remote-type"
                checked={draft.preset === p}
                onChange={() =>
                  setDraft({ ...draft, preset: p, baseUrl: LLM_PRESETS[p].baseUrl || draft.baseUrl, model: LLM_PRESETS[p].model || draft.model })
                }
              />
              {LLM_PRESET_LABELS[p]}
            </label>
          ))}
        </div>
      )}
      {mode !== 'off' && leaves && (
        <label className="warn check-row mt-3">
          <input
            type="checkbox"
            checked={acked}
            onChange={(e) => setDraft({ ...draft, acknowledged: { ...draft.acknowledged, [draft.preset]: e.target.checked } })}
          />
          I understand the full transcript is sent to {leaves} each time I summarize.
        </label>
      )}
      {mode !== 'off' && !leaves && <p className="muted small mb-0">[x] Transcripts stay on this computer.</p>}
    </section>
  );
}

/** True when saving needs the "leaves this computer" acknowledgement first. */
export function needsAcknowledgement(c: LlmConfig): boolean {
  return c.enabled !== false && !!summaryDestination(c) && !c.acknowledged?.[c.preset];
}

const EXTRACT_LABELS: Array<[keyof SummaryExtract, string]> = [
  ['summary', 'Summary · 3–5 bullets'],
  ['decisions', 'Decisions'],
  ['actions', 'Action items with owner and date'],
  ['questions', 'Open questions'],
];

/** What the summary contains, its language and extra instructions, and a dry run. */
export function SummaryContent({
  draft,
  setDraft,
}: {
  draft: LlmConfig;
  setDraft: (c: LlmConfig) => void;
}): React.JSX.Element | null {
  const { meetings } = useApp();
  const [test, setTest] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });
  const x = { ...DEFAULT_EXTRACT, ...(draft.extract ?? {}) };
  if (draft.enabled === false) return null;
  const last = meetings.filter((m) => m.transcriptionStatus === 'completed').sort((a, b) => b.startedAt - a.startedAt)[0];
  const runTest = async (): Promise<void> => {
    if (!last) return;
    setTest({ busy: true, text: null });
    try {
      const segments = namedSegments(await getSegments(last.id), last.speakerNames);
      const where = summaryDestination(draft);
      if (where) logNetwork(where, `Test summary of "${last.title}"`, `Full transcript (${segments.length} lines)`);
      const r = await createLlmClient(draft).summarize(last.title, segmentsToMarkdown(last.title, last.startedAt, segments));
      const lines = [
        r.summary,
        ...r.keyPoints.map((k) => `• ${k}`),
        ...(r.decisions ?? []).map((d) => `Decision: ${d}`),
        ...(r.actionItems ?? []).map((a) => `→ ${a}`),
        ...(r.openQuestions ?? []).map((q) => `? ${q}`),
      ];
      setTest({ busy: false, text: lines.join('\n') });
    } catch (e) {
      setTest({ busy: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <section className="card" aria-label="What a summary contains">
      <div className="card-title">
        <strong>What a summary contains</strong>
      </div>
      {EXTRACT_LABELS.map(([k, label]) => (
        <Toggle key={k} label={label} checked={x[k]} onChange={(v) => setDraft({ ...draft, extract: { ...x, [k]: v } })} />
      ))}
      <label className="set-row">
        <span className="grow">
          <b>Language</b> <small className="muted">“Same as the meeting” follows the transcript.</small>
        </span>
        <select
          className="input input-sm"
          aria-label="Summary language"
          value={draft.language ?? 'meeting'}
          onChange={(e) => setDraft({ ...draft, language: e.target.value })}
        >
          <option value="meeting">Same as the meeting</option>
          {['English', 'Polish', 'German', 'French', 'Spanish', 'Italian', 'Dutch', 'Portuguese', 'Ukrainian'].map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label" htmlFor="llm-instructions">
        Extra instructions
      </label>
      <textarea
        id="llm-instructions"
        className="input"
        rows={3}
        value={draft.instructions ?? ''}
        placeholder="e.g. Our team names: Platform, Mobile. Write owners as first names."
        onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
      />
      <div className="btn-row">
        <button type="button" className="btn btn-sm" onClick={() => setDraft({ ...draft, extract: DEFAULT_EXTRACT, language: 'meeting', instructions: '' })}>
          Reset
        </button>
        <button type="button" className="btn btn-sm" disabled={!last || test.busy || needsAcknowledgement(draft)} onClick={() => void runTest()}>
          {test.busy ? 'Summarizing…' : last ? `Test on "${last.title}"` : 'Test on the last meeting'}
        </button>
      </div>
      <p className="muted small mb-0">The test is not saved; it uses the settings on this page, saved or not.</p>
      {test.text && (
        <pre className="log-box" aria-label="Test summary">
          {test.text}
        </pre>
      )}
    </section>
  );
}

/** Issue + wiki options for the GitLab card. */
export function GitlabExtras({
  draft,
  setDraft,
}: {
  draft: GitlabConfig;
  setDraft: (c: GitlabConfig) => void;
}): React.JSX.Element {
  return (
    <div className="mt-3">
      <label className="field-label" htmlFor="gitlab-labels">
        Labels on new issues
      </label>
      <input
        id="gitlab-labels"
        className="input"
        value={draft.labels ?? 'local-transcribe,action-item'}
        onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
        placeholder="local-transcribe,action-item"
      />
      <Toggle
        label="Assign by name"
        hint="When the owner's name matches exactly one project member."
        checked={draft.assignByName !== false}
        onChange={(v) => setDraft({ ...draft, assignByName: v })}
      />
      <Toggle
        label="Link back to the moment"
        hint="Quote the transcript line, with its time, in the issue."
        checked={draft.linkBack !== false}
        onChange={(v) => setDraft({ ...draft, linkBack: v })}
      />
      <Toggle
        label="Post summaries to the wiki"
        hint="Meetings/<date>-<title>, from the export step."
        checked={draft.wikiSummaries !== false}
        onChange={(v) => setDraft({ ...draft, wikiSummaries: v })}
      />
    </div>
  );
}
