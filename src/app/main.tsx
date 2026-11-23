import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './store';
import { loadNativeSettings } from '../platform/native-settings';
import { isServerApp, loadServerSession } from '../platform/server';
import { ServerRoot } from './ServerRoot';
import { applyAppearance, loadAppearance } from './theme';
import '@fontsource/archivo-black/400.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import '@fontsource/jetbrains-mono/800.css';
import './styles.css';

const root = (): ReactDOM.Root => ReactDOM.createRoot(document.getElementById('root')!);

if (isServerApp()) {
  // Server edition: who is signed in decides everything (ServerRoot).
  applyAppearance(loadAppearance());
  void loadServerSession()
    .then(() => null)
    .catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
    .then((sessionError) => {
      root().render(
        <React.StrictMode>
          <ServerRoot sessionError={sessionError} />
        </React.StrictMode>,
      );
    });
} else {
  // Desktop settings live in a file (they survive updates); load them before
  // the first render so synchronous prefs read the right values.
  const settingsReady = Promise.race([
    loadNativeSettings(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);

  void settingsReady.then(() => {
    applyAppearance(loadAppearance());
    root().render(
      <React.StrictMode>
        <AppProvider>
          <App />
        </AppProvider>
      </React.StrictMode>,
    );
  });
}
