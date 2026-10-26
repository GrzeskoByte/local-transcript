import { useEffect, useState } from 'react';
import { useApp } from '../store.tsx';
import {
  RemoteAsrClient,
  REMOTE_ASR_DEFAULT_PATH,
  remoteAsrConfigProblem,
  remoteAsrEndpoint,
} from '../../integrations/remote-asr';

/** Settings → Models: transcribe on the user's Open WebUI server instead of this computer. */
export function RemoteTranscriptionSettings(): React.JSX.Element {
  const { remoteAsrConfig, saveRemoteAsrConfig } = useApp();
  const [draft, setDraft] = useState(remoteAsrConfig);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The stored config loads after first render.
  useEffect(() => setDraft(remoteAsrConfig), [remoteAsrConfig]);

  const problem = remoteAsrConfigProblem(draft);
  const on = remoteAsrConfig.enabled && remoteAsrConfigProblem(remoteAsrConfig) === null;

  const run = (work: () => Promise<string>): void => {
    setBusy(true);
    setMessage(null);
    work()
      .then(setMessage)
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" aria-label="Transcription server">
      <div className="model-title">
        <strong>Transcription server (Open WebUI)</strong>
        {on && <span className="badge badge-ok">On</span>}
      </div>
      <div className="muted">
        Optional: transcribe recordings on your own Open WebUI server instead of this computer. When it is on,
        Transcribe sends the recording&apos;s speech (16 kHz WAV pieces, silence left out) to that server — it
        leaves this device. Live transcription still runs locally.
      </div>
      <label className="check-row">
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
        />
        Use the transcription server
      </label>
      <label className="field-label" htmlFor="remote-asr-url">Server address</label>
      <input
        id="remote-asr-url"
        className="input"
        value={draft.baseUrl}
        onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
        placeholder="https://chat.example.com"
        inputMode="url"
        autoComplete="off"
      />
      <label className="field-label" htmlFor="remote-asr-path">Endpoint path</label>
      <input
        id="remote-asr-path"
        className="input"
        value={draft.path}
        onChange={(e) => setDraft({ ...draft, path: e.target.value })}
        placeholder={REMOTE_ASR_DEFAULT_PATH}
      />
      <label className="field-label" htmlFor="remote-asr-key">API key</label>
      <input
        id="remote-asr-key"
        className="input"
        type="password"
        value={draft.apiKey}
        onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
        placeholder="Open WebUI → Settings → Account → API keys"
        autoComplete="off"
      />
      <label className="field-label" htmlFor="remote-asr-model">Model (optional)</label>
      <input
        id="remote-asr-model"
        className="input"
        value={draft.model}
        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
        placeholder="Leave empty to use the server's speech-to-text setting"
      />
      <p className="muted small mb-0" aria-label="Transcription endpoint">
        {problem ?? `Requests go to ${remoteAsrEndpoint(draft)}`}
      </p>
      {message && <p className="muted small mb-0" role="status">{message}</p>}
      <div className="btn-row">
        <button
          className="btn btn-primary"
          disabled={busy || (draft.enabled && problem !== null)}
          onClick={() =>
            run(async () => {
              await saveRemoteAsrConfig({ ...draft, baseUrl: draft.baseUrl.trim(), path: draft.path.trim() || REMOTE_ASR_DEFAULT_PATH });
              return draft.enabled
                ? 'Saved. Transcribe now uses the transcription server.'
                : 'Saved. Transcription runs on this computer.';
            })
          }
        >
          {busy ? 'Working…' : 'Save server settings'}
        </button>
        <button
          className="btn"
          disabled={busy || problem !== null}
          onClick={() =>
            run(async () => {
              await new RemoteAsrClient(draft).testConnection();
              return 'Transcription server answered.';
            })
          }
        >
          Test connection
        </button>
      </div>
    </section>
  );
}
