import { useEffect, useRef, useState } from 'react';
import { useApp, ElapsedClock } from './store.tsx';
import { modelChipLabel } from '../asr/model-manager';
import { Dashboard } from './screens/Dashboard.tsx';
import { NewMeeting } from './screens/NewMeeting.tsx';
import { ActiveMeeting } from './screens/ActiveMeeting.tsx';
import { MeetingDetail } from './screens/MeetingDetail.tsx';
import { Settings } from './screens/Settings.tsx';
import { CalendarView } from './screens/CalendarView.tsx';

// Layout per DESIGN.md (Halftone Window): dotted desk → nav window (wordmark,
// sections, background-run cells, model status, REC / Record) → content → footer.
function Shell(): React.JSX.Element {
  const {
    route, go, recordingState, modelMeta, updateInfo, txStage, txProgress, meetings, pauseRecording, resumeRecording,
  } = useApp();
  // Global keys: Ctrl/Cmd+N = new meeting (or back to the running one); P = pause/resume while recording.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
      const live = recordingState === 'RECORDING' || recordingState === 'PAUSED';
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        go({ name: live ? 'active' : 'new' });
        return;
      }
      if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'p' && route.name === 'active') {
        if (recordingState === 'RECORDING') void pauseRecording();
        else if (recordingState === 'PAUSED') void resumeRecording();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, route.name, recordingState, pauseRecording, resumeRecording]);
  // Transcriptions run in the background: show them in the rail, and say
  // when one finishes while the user is elsewhere.
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
      if (route.name === 'detail' && route.id === id) continue;
      setFinished({ id, ok: status === 'completed' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running.join(','), meetings]);

  const recording = recordingState === 'RECORDING' || recordingState === 'PAUSED';
  const modelDot = modelMeta.state === 'ready' ? 'ready' : modelMeta.state === 'downloading' ? 'working' : '';

  const navTo = (name: 'dashboard' | 'calendar' | 'settings'): void => go({ name });
  const onMeetings = route.name === 'dashboard' || route.name === 'detail';

  return (
    <div className="layout">
      <nav className="topbar" aria-label="Main">
        <button type="button" className="brand" title="Meetings" onClick={() => navTo('dashboard')}>
          <span className="dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="brand-name">local-transcriber</span>
        </button>
        <button type="button" className={`navlink${onMeetings ? ' active' : ''}`} onClick={() => navTo('dashboard')}>
          Meetings
        </button>
        <button
          type="button"
          className={`navlink${route.name === 'calendar' ? ' active' : ''}`}
          onClick={() => navTo('calendar')}
        >
          Calendar
        </button>
        <button
          type="button"
          className={`navlink${route.name === 'settings' ? ' active' : ''}`}
          onClick={() => navTo('settings')}
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
            {txStage[id] === 'queued'
              ? 'Queued'
              : `Transcribing ${Math.round((txProgress[id] ?? 0) * 100)}%`}{' '}
            · {titleOf(id)}
          </button>
        ))}
        {updateInfo?.available && (
          <button type="button" className="cell update-chip" onClick={() => go({ name: 'settings', tab: 'app' })}>
            Update available · v{updateInfo.version}
          </button>
        )}
        <button
          type="button"
          className={`cell model-chip ${modelDot}`}
          title={`${modelMeta.modelId} (${modelMeta.state.replace('_', ' ')}): open model settings`}
          onClick={() => go({ name: 'settings', tab: 'models' })}
        >
          {modelChipLabel(modelMeta)}
        </button>
        {recording ? (
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
          <button type="button" className="cell record" title="New meeting (Ctrl+N)" onClick={() => go({ name: 'new' })}>
            ● Record <kbd>Ctrl N</kbd>
          </button>
        )}
      </nav>

      <main className="main">
        <div className="container">
          {route.name === 'new' ? (
            <NewMeeting />
          ) : route.name === 'active' ? (
            <ActiveMeeting />
          ) : route.name === 'detail' ? (
            <MeetingDetail id={route.id} query={route.q} />
          ) : route.name === 'settings' ? (
            <Settings />
          ) : route.name === 'calendar' ? (
            <CalendarView />
          ) : (
            <Dashboard />
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
      </main>
      <footer className="footer-band">
        Recordings &amp; transcripts never leave this device unless you upload them.
      </footer>
    </div>
  );
}

export function App(): React.JSX.Element {
  return <Shell />;
}
