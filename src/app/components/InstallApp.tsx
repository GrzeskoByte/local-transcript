import { useEffect, useState } from 'react';
import {
  canPromptInstall,
  isInstalledApp,
  isIos,
  onInstallChange,
  promptInstall,
  requestPersistentStorage,
} from '../../platform/pwa';

/** Settings → App on the web / phone build: install to the home screen, keep recordings from eviction. */
export function InstallAppCard({ onTranscription }: { onTranscription: () => void }): React.JSX.Element {
  const [installed, setInstalled] = useState(isInstalledApp);
  const [promptable, setPromptable] = useState(canPromptInstall);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  useEffect(
    () =>
      onInstallChange(() => {
        setPromptable(canPromptInstall());
        setInstalled(isInstalledApp());
      }),
    [],
  );
  useEffect(() => {
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(false));
  }, []);

  return (
    <section className="card" aria-label="Install on this device">
      <div className="card-title">
        <strong>Install on this device</strong>
      </div>
      <div className="set-row">
        <span className="grow">
          <b>{installed ? '[x] Installed' : 'Home-screen app'}</b>{' '}
          <small className="muted">
            {installed
              ? 'Opens like an app and starts without a connection.'
              : promptable
                ? 'Adds Local Transcribe to your home screen; it then starts without a connection.'
                : isIos()
                  ? 'In Safari tap Share ↑, then Add to Home Screen.'
                  : "Use your browser's menu: Install app, or Add to Home screen."}
          </small>
        </span>
        {!installed && promptable && (
          <button type="button" className="btn btn-sm" onClick={() => void promptInstall().then(() => setInstalled(isInstalledApp()))}>
            Install app
          </button>
        )}
      </div>
      <div className="set-row">
        <span className="grow">
          <b>{persisted ? '[x] Recordings kept' : 'Keep recordings'}</b>{' '}
          <small className="muted">
            {persisted
              ? 'The browser will not clear this app’s storage to free space.'
              : 'Asks the browser not to clear recordings when the phone runs low on space.'}
          </small>
        </span>
        {!persisted && (
          <button type="button" className="btn btn-sm" onClick={() => void requestPersistentStorage().then(setPersisted)}>
            Keep recordings
          </button>
        )}
      </div>
      <div className="set-row">
        <span className="grow">
          <b>Transcription</b>{' '}
          <small className="muted">
            Recording works on this device. Transcribing needs your transcription server — the on-device engine is in the desktop app.
          </small>
        </span>
        <button type="button" className="btn btn-sm" onClick={onTranscription}>
          Set up server
        </button>
      </div>
    </section>
  );
}
