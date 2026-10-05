import { useState } from 'react';
import { useApp } from '../store.tsx';
import { WHISTLE_DOWNLOAD_MB, WHISTLE_MODEL } from '../../asr/live';

const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

/** Settings → Models: turn live transcription on and pick its model. */
export function LiveTranscriptionSettings(): React.JSX.Element {
  const {
    liveEnabled, setLiveTranscription, liveModel, setLiveModelChoice, liveOptions, liveChoice,
    whistle, whistleDownload, downloadWhistleModel, recordingState,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const selected = liveOptions.find((o) => o.id === liveModel) ?? liveChoice ?? liveOptions[0] ?? null;
  const needsWhistle = selected?.id === WHISTLE_MODEL && !selected.ready;
  const recording = recordingState !== 'IDLE' && recordingState !== 'COMPLETED';

  const download = (): void => {
    setError(null);
    downloadWhistleModel().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <section className="card" aria-label="Live transcription">
      <div className="model-title">
        <strong>Live transcription</strong>
        {liveEnabled && liveChoice && <span className="badge badge-ok">On</span>}
      </div>
      <div className="muted">
        Shows the transcript while you record. The text is saved as the meeting&apos;s transcript when you stop;
        Re-transcribe on the meeting redoes it from the whole recording with the model selected below in Models.
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
        Whistle is a 17 MB speech model by Cactus Compute (Apache-2.0) that runs on the CPU and keeps up in real time,
        in English, German, French, Spanish, Italian, Dutch and Polish. Accuracy is close to Whisper base — a quick
        preview, not a replacement for the larger models.
      </p>
      {whistle && !whistle.supported && (
        <p className="muted mb-0">
          Whistle has no build for this computer (Intel Macs). Use an installed model for live text instead — a small
          one (base or small) keeps up best.
        </p>
      )}
      {needsWhistle && (
        <div className="mt-3">
          {whistleDownload ? (
            <div className="loader" role="status" aria-label="Whistle download">
              <div className="loader-head">
                <span className="spinner" aria-hidden="true" />
                <strong>Downloading Whistle…</strong>
                {whistleDownload.total > 0 && (
                  <span className="muted">
                    {mb(whistleDownload.received)} of {mb(whistleDownload.total)}
                  </span>
                )}
              </div>
              {whistleDownload.total > 0 ? (
                <progress value={whistleDownload.received} max={whistleDownload.total} />
              ) : (
                <progress />
              )}
            </div>
          ) : (
            <button className="btn btn-primary" onClick={download}>
              Download Whistle (~{WHISTLE_DOWNLOAD_MB} MB)
            </button>
          )}
        </div>
      )}
      {liveEnabled && !liveChoice && (
        <p className="warn mt-2 mb-0">Download Whistle or a speech model to see text while recording.</p>
      )}
      {liveChoice && selected && liveChoice.id !== selected.id && (
        <p className="muted mb-0">
          Until {selected.label} is downloaded, live transcription uses {liveChoice.label}.
        </p>
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
  const name = liveChoice ? (liveChoice.id === WHISTLE_MODEL ? 'Whistle' : liveChoice.label) : null;
  return (
    <div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={liveEnabled}
          onChange={(e) => setLiveTranscription(e.target.checked)}
        />
        Transcribe live while recording{name ? ` (${name})` : ''}
      </label>
      {liveEnabled && !liveChoice && (
        <p className="warn mt-2 mb-0">
          No live model yet —{' '}
          <button className="link-btn" onClick={() => go({ name: 'settings', tab: 'models' })}>
            download Whistle in Settings
          </button>
          . The recording works without it.
        </p>
      )}
    </div>
  );
}
