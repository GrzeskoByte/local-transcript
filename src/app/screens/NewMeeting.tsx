import { useRef, useState } from 'react';
import { useApp } from '../store.tsx';
import type { RecordingMode } from '../../domain/meeting.ts';
import { MicIcon, MonitorIcon, DualIcon } from '../components/icons.tsx';
import { AgendaEditor } from '../components/Agenda.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda.ts';
import {
  MediaAccessError,
  isSecureMediaContext,
  primeMicrophonePermission,
  type MediaAccessFailure,
} from '../../audio/permissions.ts';
import { macDeviceAudioLimit } from '../../audio/device-audio.ts';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';

export function NewMeeting(): React.JSX.Element {
  const { startRecording, importMeeting, storageWarning, go, systemAudio } = useApp();
  // Linux desktop: device audio comes straight from the sound server.
  const directSystemAudio = systemAudio?.available === true;
  const macLimit = directSystemAudio ? null : macDeviceAudioLimit();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<RecordingMode>('speaker');
  const [agenda, setAgenda] = useState<AgendaItem[] | null>(null);
  const [error, setError] = useState<MediaAccessFailure | string | null>(null);
  const [busy, setBusy] = useState(false);
  const [permBusy, setPermBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const secure = isSecureMediaContext();
  const usesMic = mode === 'speaker' || mode === 'dual';

  const start = (): void => {
    setBusy(true);
    setError(null);
    startRecording(title, mode, agenda ?? [])
      .catch((e: unknown) =>
        setError(
          e instanceof MediaAccessError
            ? e.failure
            : e instanceof Error
              ? e.message
              : String(e),
        ),
      )
      .finally(() => setBusy(false));
  };

  // Trigger the browser's permission prompt explicitly, on user request.
  const grantMicrophone = (): void => {
    setPermBusy(true);
    setError(null);
    primeMicrophonePermission()
      .then((failure) => {
        if (failure) setError(failure);
      })
      .finally(() => setPermBusy(false));
  };

  // Import an existing audio file as a meeting — no microphone involved.
  const importFile = (file: File): void => {
    setBusy(true);
    setError(null);
    importMeeting(file)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>New Meeting</h1>
          <p className="muted">Record first, transcribe later — everything stays on this device.</p>
        </div>
      </div>

      <section className="card" aria-label="Recording setup">
        <span className="field-label" style={{ marginTop: 0 }}>
          1 · What do you want to capture?
        </span>
        <div className="source-grid" role="group" aria-label="Recording source">
          <button
            type="button"
            className={`source-card${mode === 'speaker' ? ' selected' : ''}`}
            aria-pressed={mode === 'speaker'}
            onClick={() => setMode('speaker')}
          >
            <span className="icon">
              <MicIcon />
            </span>
            <strong>Speaker</strong>
            <small>Microphone — voices in the room. Choose this for in-person meetings.</small>
          </button>
          <button
            type="button"
            className={`source-card${mode === 'device' ? ' selected' : ''}`}
            aria-pressed={mode === 'device'}
            onClick={() => setMode('device')}
          >
            <span className="icon">
              <MonitorIcon />
            </span>
            <strong>Device Audio</strong>
            <small>
              {directSystemAudio
                ? 'Everything your computer plays — call audio, videos. Recorded directly, no screen sharing.'
                : 'Sound from a shared browser tab or window. Availability varies by OS & browser.'}
            </small>
          </button>
          <button
            type="button"
            className={`source-card${mode === 'dual' ? ' selected' : ''}`}
            aria-pressed={mode === 'dual'}
            onClick={() => setMode('dual')}
          >
            <span className="icon">
              <DualIcon />
            </span>
            <strong>Mic + Device</strong>
            <small>Your microphone and the call/system audio together, in one recording. Best for online meetings.</small>
          </button>
        </div>

        {macLimit && (mode === 'device' || mode === 'dual') && (
          <p className="warn" style={{ marginTop: 10, marginBottom: 0 }}>
            {macLimit}
          </p>
        )}

        {mode === 'dual' && (
          <>
            <p className="muted" style={{ marginTop: 10 }}>
              {directSystemAudio
                ? 'Records your microphone and everything your computer plays (e.g. the call), mixed into one recording.'
                : 'You will be asked to pick a screen or window to share — choose the meeting window (or the whole screen) and enable “Share audio”. Both are mixed into one recording.'}
            </p>
            <p className="warn" style={{ marginTop: 10, marginBottom: 0 }}>
              Wear headphones. On speakers your microphone records the call a second time, slightly delayed — the
              recording gets an echo and transcription suffers.
            </p>
          </>
        )}

        <AudioDevicePickers microphone={usesMic} systemOutput={mode !== 'speaker' && directSystemAudio} />

        {usesMic && (
          <p className="muted" style={{ marginTop: 10 }}>
            {secure ? (
              <>
                Your browser will ask for microphone access when you start.{' '}
                <button type="button" className="link-btn" disabled={permBusy} onClick={grantMicrophone}>
                  {permBusy ? 'Requesting…' : 'Grant microphone access now'}
                </button>
              </>
            ) : (
              'This page cannot request microphone access — open the app over https:// or on localhost.'
            )}
          </p>
        )}

        <label className="field-label" htmlFor="meeting-title">
          2 · Name it (optional)
        </label>
        <input
          id="meeting-title"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Weekly planning"
          maxLength={120}
        />

        <span className="field-label">3 · Agenda (optional)</span>
        {agenda === null ? (
          <button type="button" className="btn" onClick={() => setAgenda([newAgendaItem()])}>
            + Add agenda
          </button>
        ) : (
          <>
            <AgendaEditor items={agenda} onChange={setAgenda} />
            <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => setAgenda(null)}>
              Remove agenda
            </button>
          </>
        )}

        {!secure && (
          <p className="warn" style={{ marginBottom: 0 }} role="alert">
            Audio capture is unavailable on this page. Browsers block the microphone and screen
            audio on plain http:// — open the app over https:// or on localhost.
          </p>
        )}
        {storageWarning && <p className="warn" style={{ marginBottom: 0 }}>{storageWarning}</p>}

        {error && (
          <div className="error" role="alert" style={{ marginBottom: 0 }}>
            <strong>{typeof error === 'string' ? error : error.message}</strong>
            {typeof error !== 'string' && (
              <p className="muted small" style={{ margin: '6px 0 0', color: 'inherit' }}>
                {error.hint}
              </p>
            )}
            {typeof error !== 'string' && error.retryable && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                <button type="button" className="btn" disabled={busy} onClick={start}>
                  Try again
                </button>
                {usesMic && secure && (
                  <button
                    type="button"
                    className="link-btn"
                    disabled={permBusy}
                    onClick={grantMicrophone}
                  >
                    {permBusy ? 'Requesting…' : 'Grant microphone access'}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div className="btn-row">
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
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
          >
            ⬆ Import audio file
          </button>
        </div>

        <div className="btn-row">
          <button className="btn btn-primary btn-lg" disabled={busy || !secure} onClick={start}>
            {busy ? 'Starting…' : '● Start Recording'}
          </button>
          <button className="btn" onClick={() => go({ name: 'dashboard' })}>
            Cancel
          </button>
        </div>
      </section>
    </>
  );
}
