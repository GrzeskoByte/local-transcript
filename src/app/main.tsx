import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AppProvider } from './store';
import { loadNativeSettings } from '../platform/native-settings';
import './styles.css';

// Desktop settings live in a file (they survive updates); load them before
// the first render so synchronous prefs read the right values.
const settingsReady = Promise.race([
  loadNativeSettings(),
  new Promise((resolve) => setTimeout(resolve, 2000)),
]);

void settingsReady.then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );
});
