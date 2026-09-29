import { useApp } from './store.tsx';
import { Dashboard } from './screens/Dashboard.tsx';
import { NewMeeting } from './screens/NewMeeting.tsx';
import { ActiveMeeting } from './screens/ActiveMeeting.tsx';
import { MeetingDetail } from './screens/MeetingDetail.tsx';
import { Settings } from './screens/Settings.tsx';
import { CalendarView } from './screens/CalendarView.tsx';
import { GearIcon, CalendarIcon, ListIcon, LogoMark, MicIcon } from './components/icons.tsx';

function Shell(): React.JSX.Element {
  const { route, go, recordingState, modelMeta } = useApp();
  const recording = recordingState === 'RECORDING' || recordingState === 'PAUSED';
  const modelDot = modelMeta.state === 'ready' ? 'ready' : modelMeta.state === 'not_installed' ? '' : 'working';

  const nav = (
    <>
      <button
        className={`nav-item${route.name === 'dashboard' || route.name === 'detail' ? ' active' : ''}`}
        onClick={() => go({ name: 'dashboard' })}
      >
        <ListIcon />
        Meetings
      </button>
      <button
        className={`nav-item${route.name === 'new' ? ' active' : ''}`}
        onClick={() => go({ name: 'new' })}
      >
        <MicIcon size={18} />
        New recording
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
    </>
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <LogoMark />
          </span>
          <span>
            <span className="brand-name">Local Transcriber</span>
            <br />
            <span className="brand-sub">private · on-device</span>
          </span>
        </div>
        <nav className="nav">
          <div className="nav-label">Workspace</div>
          {nav}
        </nav>
        <div className="sidebar-footer">
          <div className="model-chip" title={modelMeta.modelId}>
            <span className={`model-dot ${modelDot}`} />
            {modelMeta.state === 'ready'
              ? 'Speech model ready'
              : modelMeta.state === 'downloading'
                ? `Model ${Math.round(modelMeta.progress * 100)}%`
                : `Model: ${modelMeta.state.replace('_', ' ')}`}
          </div>
          <div className="privacy-note">Recordings &amp; transcripts never leave this device.</div>
        </div>
      </aside>
      <div className="mobilebar">
        <span className="brand-mark" style={{ width: 28, height: 28 }}>
          <LogoMark />
        </span>
        <span className="brand-name">Local Transcriber</span>
        <nav>{nav}</nav>
      </div>
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
      </main>
    </div>
  );
}

export function App(): React.JSX.Element {
  return <Shell />;
}
