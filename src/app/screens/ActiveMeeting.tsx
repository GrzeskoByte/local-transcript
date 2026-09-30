import { useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import { modeLabel } from '../../domain/meeting';
import { CheckIcon } from '../components/icons.tsx';
import { AgendaList } from '../components/Agenda.tsx';

export function ActiveMeeting(): React.JSX.Element {
  const {
    activeMeeting, elapsedMs, recordingState, recordingError, recordingErrorKind,
    pauseRecording, resumeRecording, retrySaving, stopRecording,
  } = useApp();
  const [retrying, setRetrying] = useState(false);

  if (!activeMeeting) return <p className="muted">No active recording.</p>;
  const paused = recordingState === 'PAUSED';
  // Storage failed: never claim the audio is safe while chunks are unsaved (§19).
  const failing = recordingState === 'ERROR';
  // A lost source (unplugged mic, stopped screen share) cannot be retried.
  const sourceLost = failing && recordingErrorKind === 'source';

  return (
    <>
      <section className="rec-hero" aria-label="Recording in progress">
        <div className="src">{modeLabel(activeMeeting.mode)}</div>
        <h1>{activeMeeting.title}</h1>
        <div className={`rec-orb${paused ? ' paused' : ''}`} aria-hidden="true" />
        <div className="timer" aria-label="Elapsed time">
          {formatDuration(elapsedMs)}
        </div>
        <div className="rec-state">
          {sourceLost ? 'Audio source lost' : failing ? 'Recording — not saving' : paused ? 'Paused' : 'Recording'}
        </div>
        {sourceLost ? (
          <div className="rec-alert" role="alert">
            <strong>Recording interrupted.</strong>
            <p>
              {recordingError ?? 'The audio source stopped.'} Everything recorded until then is saved —
              stop now to keep it, then start a new recording if the meeting continues.
            </p>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => void stopRecording()}>
                Stop &amp; keep what was saved
              </button>
            </div>
          </div>
        ) : failing ? (
          <div className="rec-alert" role="alert">
            <strong>Some audio could not be saved to disk.</strong>
            <p>
              {recordingError ?? 'Storage write failed.'} Unsaved audio is held in memory. Free up space,
              then retry — or stop now to keep everything that was saved.
            </p>
            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  void retrySaving().finally(() => setRetrying(false));
                }}
              >
                {retrying ? 'Retrying…' : 'Retry saving'}
              </button>
              <button className="btn btn-ghostlight" onClick={() => void stopRecording()}>
                Stop &amp; keep what was saved
              </button>
            </div>
          </div>
        ) : (
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
        )}
        {!failing && (
          <div className="saved-note">
            <CheckIcon /> Audio chunks are being saved on this device
          </div>
        )}
      </section>
      {activeMeeting.agenda?.items.length ? (
        <section className="card" aria-label="Meeting agenda">
          <strong>Agenda</strong>
          <AgendaList items={activeMeeting.agenda.items} />
        </section>
      ) : null}
      <p className="muted" style={{ textAlign: 'center' }}>
        You can leave this screen — recording continues. Transcribe after stopping.
      </p>
    </>
  );
}
