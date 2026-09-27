import { useApp, formatDuration } from '../store.tsx';
import { modeLabel } from '../../domain/meeting';
import { CheckIcon } from '../components/icons.tsx';

export function ActiveMeeting(): React.JSX.Element {
  const { activeMeeting, elapsedMs, recordingState, recordingError, pauseRecording, resumeRecording, stopRecording } =
    useApp();

  if (!activeMeeting) return <p className="muted">No active recording.</p>;
  const paused = recordingState === 'PAUSED';

  return (
    <>
      <section className="rec-hero" aria-label="Recording in progress">
        <div className="src">{modeLabel(activeMeeting.mode)}</div>
        <h1>{activeMeeting.title}</h1>
        <div className={`rec-orb${paused ? ' paused' : ''}`} aria-hidden="true" />
        <div className="timer" aria-label="Elapsed time">
          {formatDuration(elapsedMs)}
        </div>
        <div className="rec-state">{paused ? 'Paused' : 'Recording'}</div>
        {recordingError && <p className="error">{recordingError}</p>}
        <div className="btn-row">
          {paused ? (
            <button className="btn-ghostlight btn" onClick={() => void resumeRecording()}>
              Resume
            </button>
          ) : (
            <button className="btn-ghostlight btn" onClick={() => void pauseRecording()}>
              Pause
            </button>
          )}
          <button
            className="btn btn-stop"
            onClick={() => {
              if (window.confirm('Stop and save this recording?')) void stopRecording();
            }}
          >
            ■ Stop &amp; save
          </button>
        </div>
        <div className="saved-note">
          <CheckIcon /> Audio chunks are being saved on this device
        </div>
      </section>
      <p className="muted" style={{ textAlign: 'center' }}>
        You can leave this screen — recording continues. Transcribe after stopping.
      </p>
    </>
  );
}
