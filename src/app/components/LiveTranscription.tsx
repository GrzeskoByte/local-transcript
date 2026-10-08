import { useState } from 'react';
import { useApp } from '../store.tsx';
import { autoTranscribeEnabled, setAutoTranscribeEnabled } from '../auto-transcribe';

const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

/** Settings → Models: turn live transcription on and pick its model. */
export function LiveTranscriptionSettings(): React.JSX.Element {
  const {
    liveEnabled, setLiveTranscription, liveModel, setLiveModelChoice, liveOptions, liveChoice,
    liveDownload, downloadLiveModel, recordingState,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const selected = liveOptions.find((o) => o.id === liveModel) ?? liveChoice ?? liveOptions[0] ?? null;
  const recording = recordingState !== 'IDLE' && recordingState !== 'COMPLETED';

  const download = (name: string): void => {
    setError(null);
    downloadLiveModel(name).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="card" aria-label="Live transcription">
      <div className="model-title">
        <strong>Live transcription</strong>
        {liveEnabled && liveChoice && <span className="badge badge-ok">On</span>}
      </div>
      <div className="muted">
        Shows the transcript while you record, using the built-in whisper.cpp engine on this computer — no audio or
        text leaves it. The text is saved as the meeting&apos;s transcript when you stop; Re-transcribe on the meeting
        redoes it from the whole recording with your main model.
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={liveEnabled}
          onChange={(e) => setLiveTranscription(e.target.checked)}
        />
        Transcribe while recording
      </label>
      <label className="field-label" htmlFor="live-model">
        Live model
      </label>
      {liveOptions.length > 0 ? (
        <select
          id="live-model"
          className="input"
          aria-label="Live transcription model"
          value={selected?.id ?? ''}
          onChange={(e) => setLiveModelChoice(e.target.value)}
        >
          {liveOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label} — {o.detail}
            </option>
          ))}
        </select>
      ) : (
        <select id="live-model" className="input" aria-label="Live transcription model" disabled>
          <option>No model available yet</option>
        </select>
      )}
      <p className="muted mb-0">
        A small model (base or small) keeps up in real time on a CPU; large models give better text but may fall
        behind, and the rest is finished after you stop.
      </p>
      {selected && !selected.ready && (
        <div className="mt-3">
          {liveDownload ? (
            <div className="loader" role="status" aria-label="Live model download">
              <div className="loader-head">
                <span className="spinner" aria-hidden="true" />
                <strong>Downloading {liveDownload.name}…</strong>
                {liveDownload.total > 0 && (
                  <span className="muted">
                    {mb(liveDownload.received)} of {mb(liveDownload.total)}
                  </span>
                )}
              </div>
              {liveDownload.total > 0 ? (
                <progress value={liveDownload.received} max={liveDownload.total} />
              ) : (
                <progress />
              )}
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => download(selected.id)}>
              Download {selected.label}
            </button>
          )}
        </div>
      )}
      {liveChoice && selected && liveChoice.id !== selected.id && (
        <p className="muted mb-0">
          Until {selected.label} is downloaded, live transcription uses {liveChoice.label}.
        </p>
      )}
      {liveEnabled && !liveChoice && (
        <p className="warn mt-2 mb-0">Download a speech model to see text while recording.</p>
      )}
      {recording && <p className="muted small mb-0">Changes apply to the next recording.</p>}
      {error && (
        <p className="warn mt-2 mb-0" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

/** New Meeting: the same switch, with the model it will use. */
export function LiveTranscriptionToggle(): React.JSX.Element | null {
  const { liveEnabled, setLiveTranscription, liveChoice, go, nativeStatus } = useApp();
  if (!nativeStatus) return null;
  return (
    <div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={liveEnabled}
          onChange={(e) => setLiveTranscription(e.target.checked)}
        />
        Transcribe live while recording{liveChoice ? ` (${liveChoice.label})` : ''}
      </label>
      {liveEnabled && !liveChoice && (
        <p className="warn mt-2 mb-0">
          No live model yet —{' '}
          <button className="link-btn" onClick={() => go({ name: 'settings', tab: 'models' })}>
            download one in Settings
          </button>
          . The recording works without it.
        </p>
      )}
    </div>
  );
}

/** Settings → Models: transcribe every recording right after Stop (opt-in). */
export function AutoTranscribeSettings(): React.JSX.Element {
  const { installedModels, go } = useApp();
  const [on, setOn] = useState(autoTranscribeEnabled);
  return (
    <section className="card" aria-label="Transcribe after recording">
      <div className="model-title">
        <strong>Transcribe after recording</strong>
        {on && <span className="badge badge-ok">On</span>}
      </div>
      <div className="muted">
        Starts the transcription as soon as you press Stop, with your main model, so the transcript is ready when you
        open the meeting. Recordings with a live transcript keep it. Off by default.
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setAutoTranscribeEnabled(e.target.checked);
            setOn(e.target.checked);
          }}
        />
        Transcribe automatically after Stop
      </label>
      {on && installedModels.length === 0 && (
        <p className="muted small mb-0">
          No speech model is installed yet, so nothing will run.{' '}
          <button type="button" className="link-btn" onClick={() => go({ name: 'dashboard' })}>
            Set up transcription
          </button>
        </p>
      )}
    </section>
  );
}
