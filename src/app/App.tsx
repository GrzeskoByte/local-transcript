import { useApp, ElapsedClock } from './store.tsx';
import { modelChipLabel } from '../asr/model-manager';
import { Dashboard } from './screens/Dashboard.tsx';
import { NewMeeting } from './screens/NewMeeting.tsx';
import { ActiveMeeting } from './screens/ActiveMeeting.tsx';
import { MeetingDetail } from './screens/MeetingDetail.tsx';
import { Settings } from './screens/Settings.tsx';
import { CalendarView } from './screens/CalendarView.tsx';
import { GearIcon, CalendarIcon, ListIcon, LogoMark } from './components/icons.tsx';

// Layout per DESIGN.md: black page frame → top banner (wordmark, phone-callout,
// sticker) → white icon-label rail + content column → footer band.
function Shell(): React.JSX.Element {
  const { route, go, recordingState, modelMeta, updateInfo } = useApp();
  const recording = recordingState === 'RECORDING' || recordingState === 'PAUSED';
  const modelDot = modelMeta.state === 'ready' ? 'ready' : modelMeta.state === 'downloading' ? 'working' : '';

  return (
    <div className="layout">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => go({ name: 'dashboard' })}>
          <span className="brand-mark">
            <LogoMark />
          </span>
          <span className="brand-text">
            <span className="brand-name">Local Transcriber</span>
            <span className="brand-sub">Record now. Transcribe later. On this computer.</span>
          </span>
        </button>
        <div className="topbar-right">
          {recording ? (
            <button
              type="button"
              className={`phone-callout live${recordingState === 'PAUSED' ? ' paused' : ''}`}
              title="Open the recording in progress"
              onClick={() => go({ name: 'active' })}
            >
              <span className="rec-lamp" aria-hidden="true" />
              {recordingState === 'PAUSED' ? 'PAUSED' : 'REC'} <ElapsedClock />
            </button>
          ) : (
            <span className="phone-callout">ON-DEVICE</span>
          )}
          <button type="button" className="sticker sticker-cta" onClick={() => go({ name: 'new' })}>
            New recording
          </button>
        </div>
      </header>

      <div className="frame-body">
        <aside className="sidebar">
          <nav className="nav" aria-label="Main">
            <button
              className={`nav-item${route.name === 'dashboard' || route.name === 'detail' ? ' active' : ''}`}
              onClick={() => go({ name: 'dashboard' })}
            >
              <ListIcon />
              Meetings
            </button>
            {recording && (
              <button
                className={`nav-item${route.name === 'active' ? ' active' : ''}`}
                onClick={() => go({ name: 'active' })}
              >
                <span className="live-dot" />
                Recording…
              </button>
            )}
            <button
              className={`nav-item${route.name === 'calendar' ? ' active' : ''}`}
              onClick={() => go({ name: 'calendar' })}
            >
              <CalendarIcon />
              Calendar
            </button>
            <button
              className={`nav-item${route.name === 'settings' ? ' active' : ''}`}
              onClick={() => go({ name: 'settings' })}
            >
              <GearIcon />
              Settings
            </button>
          </nav>
          <div className="sidebar-footer">
            {updateInfo?.available && (
              <button
                type="button"
                className="update-chip"
                onClick={() => go({ name: 'settings', tab: 'app' })}
              >
                Update available · v{updateInfo.version}
              </button>
            )}
            <button
              type="button"
              className="model-chip"
              title={`${modelMeta.modelId} (${modelMeta.state.replace('_', ' ')}): open model settings`}
              onClick={() => go({ name: 'settings' })}
            >
              <span className={`model-dot ${modelDot}`} />
              {modelChipLabel(modelMeta)}
            </button>
            <div className="seal" role="img" aria-label="Local speech engine">
              <span className="seal-big">LOCAL</span>
              <span className="seal-small">speech engine</span>
            </div>
          </div>
        </aside>

        <main className="main">
          <div className="container">
            {route.name === 'new' ? (
              <NewMeeting />
            ) : route.name === 'active' ? (
              <ActiveMeeting />
            ) : route.name === 'detail' ? (
              <MeetingDetail id={route.id} />
            ) : route.name === 'settings' ? (
              <Settings />
            ) : route.name === 'calendar' ? (
              <CalendarView />
            ) : (
              <Dashboard />
            )}
          </div>
          <footer className="footer-band">
            Recordings &amp; transcripts never leave this device unless you upload them.
          </footer>
        </main>
      </div>
    </div>
  );
}

export function App(): React.JSX.Element {
  return <Shell />;
}
