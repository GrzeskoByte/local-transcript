import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, ElapsedClock } from './store.tsx';
import { modelChipLabel } from '../asr/model-manager';
import { Home } from './screens/Home.tsx';
import { Library } from './screens/Library.tsx';
import { RecordingRoom } from './screens/RecordingRoom.tsx';
import { MeetingScreen } from './screens/MeetingScreen.tsx';
import { WrapUp } from './screens/WrapUp.tsx';
import { Settings } from './screens/Settings.tsx';
import { Setup } from './screens/Setup.tsx';
import { ThemeQuick } from './components/ThemeQuick.tsx';
import { isTypingTarget, keyParts, matches, shortcuts, subscribeShortcuts } from './shortcuts';
import { useQuickRecord } from './quick-record';
import { remindToRecord, usePrefsVersion } from './preferences';
import { useUpcoming } from './upcoming';

/** Keys as <kbd> chips ("Ctrl N"). */
export function Keys({ binding }: { binding: string }): React.JSX.Element {
  return <kbd>{keyParts(binding).join(' ')}</kbd>;
}

export function useShortcuts(): ReturnType<typeof shortcuts> {
  const raw = useSyncExternalStore(subscribeShortcuts, () => JSON.stringify(shortcuts()));
  return useMemo(() => JSON.parse(raw) as ReturnType<typeof shortcuts>, [raw]);
}

// Layout per DESIGN.md (Halftone Window): dotted desk → nav window (wordmark,
// Home / Library / Settings, background-run cells, model status, theme, REC /
// Record) → content → footer. Setup is full-screen; the recording room is ink.
function Shell(): React.JSX.Element {
  const {
    route, go, recordingState, modelMeta, updateInfo, txStage, txProgress, meetings, pauseRecording, resumeRecording,
    addMoment,
  } = useApp();
  const keys = useShortcuts();
  const quickRecord = useQuickRecord();
  usePrefsVersion();
  const live = recordingState === 'RECORDING' || recordingState === 'PAUSED';

  // Global keys (Settings → App & updates lets the user rebind them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = isTypingTarget(e.target);
      if (matches(e, keys.record)) {
        e.preventDefault();
        if (live) go({ name: 'active' });
        else void quickRecord();
        return;
      }
      if (matches(e, keys.search) && route.name !== 'detail') {
        e.preventDefault();
        if (route.name !== 'library') go({ name: 'library' });
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('#library-search')?.focus());
        return;
      }
      if (typing || route.name !== 'active') return;
      if (matches(e, keys.pause)) {
        e.preventDefault();
        if (recordingState === 'RECORDING') void pauseRecording();
        else if (recordingState === 'PAUSED') void resumeRecording();
      } else if (matches(e, keys.moment) && live) {
        e.preventDefault();
        void addMoment().then(() =>
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.moment-label:last-of-type')?.focus()),
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, route.name, recordingState, pauseRecording, resumeRecording, addMoment, keys, live, quickRecord]);

  // Transcriptions run in the background: show them in the nav window, and
  // say when one finishes while the user is elsewhere.
  const running = Object.keys(txStage);
  const titleOf = (id: string): string => meetings.find((m) => m.id === id)?.title ?? 'Meeting';
  const [finished, setFinished] = useState<{ id: string; ok: boolean } | null>(null);
  const prevRunning = useRef<string[]>([]);
  /** Runs that ended; reported once the meeting list shows their outcome. */
  const ended = useRef<string[]>([]);
  useEffect(() => {
    ended.current.push(...prevRunning.current.filter((id) => !running.includes(id)));
    prevRunning.current = running;
    for (const id of [...ended.current]) {
      const meeting = meetings.find((m) => m.id === id);
      if (meeting?.transcriptionStatus === 'processing') continue; // list not refreshed yet
      ended.current = ended.current.filter((x) => x !== id);
      const status = meeting?.transcriptionStatus;
      // Cancelled runs (back to not_started) and deleted meetings need no notice.
      if (status !== 'completed' && status !== 'failed') continue;
      if ((route.name === 'detail' || route.name === 'wrapup') && route.id === id) continue;
      setFinished({ id, ok: status === 'completed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.join(','), meetings]);

  // Remind to record when a calendar meeting starts (Home → Coming up).
  const upcoming = useUpcoming();
  const [reminder, setReminder] = useState<{ id: string; title: string } | null>(null);
  const reminded = useRef(new Set<string>());
  useEffect(() => {
    if (!remindToRecord() || upcoming.events.length === 0) return;
    const check = (): void => {
      if (live) return;
      const now = Date.now();
      const due = upcoming.events.find((e) => {
        const s = new Date(e.startIso).getTime();
        return !reminded.current.has(e.id) && s <= now + 60_000 && s > now - 5 * 60_000;
      });
      if (due) {
        reminded.current.add(due.id);
        setReminder({ id: due.id, title: due.title });
      }
    };
    check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, [upcoming.events, live]);

  const modelReady = modelMeta.state === 'ready' ? 'ready' : modelMeta.state === 'downloading' ? 'working' : '';
  const onHome = route.name === 'home';
  const onLibrary = route.name === 'library' || route.name === 'detail' || route.name === 'wrapup';

  if (route.name === 'setup') return <Setup step={route.step ?? 1} />;

  return (
    <div className={`layout${route.name === 'active' ? ' is-room' : ''}`}>
      <nav className="topbar" aria-label="Main">
        <button type="button" className="brand" title="Home" onClick={() => go({ name: 'home' })}>
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">local-transcriber</span>
        </button>
        <button type="button" className={`navlink${onHome ? ' active' : ''}`} aria-current={onHome ? 'page' : undefined} onClick={() => go({ name: 'home' })}>
          Home
        </button>
        <button
          type="button"
          className={`navlink${onLibrary ? ' active' : ''}`}
          aria-current={onLibrary ? 'page' : undefined}
          onClick={() => go({ name: 'library' })}
        >
          Library
        </button>
        <button
          type="button"
          className={`navlink${route.name === 'settings' ? ' active' : ''}`}
          aria-current={route.name === 'settings' ? 'page' : undefined}
          onClick={() => go({ name: 'settings' })}
        >
          Settings
        </button>
        <span className="topbar-fill" aria-hidden="true" />
        {running.map((id) => (
          <button
            key={id}
            type="button"
            className="cell busy-chip"
            title={`Open ${titleOf(id)}`}
            onClick={() => go({ name: 'detail', id })}
          >
            {txStage[id] === 'queued' ? 'Queued' : `Transcribing ${Math.round((txProgress[id] ?? 0) * 100)}%`} · {titleOf(id)}
          </button>
        ))}
        {updateInfo?.available && (
          <button type="button" className="cell update-chip" onClick={() => go({ name: 'settings', tab: 'app' })}>
            Update available · v{updateInfo.version}
          </button>
        )}
        <button
          type="button"
          className={`cell model-chip ${modelReady}`}
          title={`${modelMeta.modelId} (${modelMeta.state.replace('_', ' ')}): open model settings`}
          onClick={() => go({ name: 'settings', tab: 'models' })}
        >
          {modelChipLabel(modelMeta)}
        </button>
        <ThemeQuick />
        {live ? (
          <button
            type="button"
            className={`cell live${recordingState === 'PAUSED' ? ' paused' : ''}`}
            title="Open the recording in progress"
            onClick={() => go({ name: 'active' })}
          >
            <span className="lamp" aria-hidden="true" />
            {recordingState === 'PAUSED' ? 'PAUSED' : 'REC'} <ElapsedClock />
          </button>
        ) : (
          <button type="button" className="cell record" title="Start recording" onClick={() => void quickRecord()}>
            ● Record <Keys binding={keys.record} />
          </button>
        )}
      </nav>

      <main className="main">
        <div className={`container${route.name === 'home' || route.name === 'library' || route.name === 'detail' || route.name === 'active' || route.name === 'settings' || route.name === 'wrapup' ? ' wide' : ''}`}>
          {route.name === 'active' ? (
            <RecordingRoom />
          ) : route.name === 'detail' ? (
            <MeetingScreen id={route.id} query={route.q} tab={route.tab} />
          ) : route.name === 'wrapup' ? (
            <WrapUp id={route.id} step={route.step} />
          ) : route.name === 'settings' ? (
            <Settings />
          ) : route.name === 'library' ? (
            <Library view={route.view ?? 'list'} initialQuery={route.q} />
          ) : (
            <Home />
          )}
        </div>
        {finished && (
          <div className="notice-toast" role="status">
            <span>
              {finished.ok ? 'Transcript ready' : 'Transcription failed'}: {titleOf(finished.id)}
            </span>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                go({ name: 'detail', id: finished.id });
                setFinished(null);
              }}
            >
              Open
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setFinished(null)}>
              Dismiss
            </button>
          </div>
        )}
        {reminder && !finished && (
          <div className="notice-toast" role="status" aria-label="Meeting starting">
            <span>{reminder.title} starts now.</span>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setReminder(null);
                void quickRecord(reminder.id);
              }}
            >
              ● Record
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setReminder(null)}>
              Dismiss
            </button>
          </div>
        )}
      </main>
      <footer className="footer-band">Your recording and transcript stay on this device. Nothing leaves it unless you upload it.</footer>
    </div>
  );
}

export function App(): React.JSX.Element {
  return <Shell />;
}

/** Shared by screens that need to wait for a click before a long action. */
export function useBusy(): [string | null, (what: string, work: () => Promise<unknown>) => void, string | null, (e: string | null) => void] {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback((what: string, work: () => Promise<unknown>) => {
    setBusy(what);
    setError(null);
    work()
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }, []);
  return [busy, run, error, setError];
}
