import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { pwa } from './scripts/pwa.mjs';
import pkg from './package.json';

// `--mode web` (npm run build:web) is the installable web / phone build (PWA);
// every other mode is the desktop shell's frontend, unchanged.
export default defineConfig({
  plugins: [react(), pwa({ version: pkg.version })],
  worker: { format: 'es' },
});
