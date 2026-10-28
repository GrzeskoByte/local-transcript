/**
 * Web / phone build (PWA, `npm run build:web`): service worker, persistent
 * storage, the install prompt and the screen wake lock. Everything here is a
 * no-op in the desktop shell and in the regular (desktop-frontend) build.
 */
import { isDesktopApp } from './desktop';

/** True in the installable web build (`vite build --mode web`), never in the desktop shell. */
export function isWebBuild(): boolean {
  return import.meta.env.MODE === 'web' && !isDesktopApp();
}

/** Why Transcribe cannot run in the web build without a transcription server. */
export const WEB_TRANSCRIPTION_HINT =
  'On this device, transcription runs on your transcription server. Turn it on in Settings → Engine & models → Transcription server (the on-device engine is in the desktop app).';

/** Running as an installed app (home-screen icon) rather than in a browser tab. */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return standalone || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

/** iPhone / iPad Safari: no install prompt, the user adds the app from the Share menu. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
const notifyInstall = (): void => installListeners.forEach((fn) => fn());

/** Whether the browser offered its install prompt (Chrome / Edge / Android). */
export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export function onInstallChange(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/** Show the browser's install dialog; true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  deferredPrompt = null;
  notifyInstall();
  await event.prompt();
  return (await event.userChoice).outcome === 'accepted';
}

/**
 * Ask the browser not to evict this site's storage under pressure — the
 * recordings live in OPFS/IndexedDB. Installed apps are usually granted it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}

/** Register the service worker and the install-prompt listeners (web build only). */
export function setupWebApp(): void {
  if (!isWebBuild() || typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e as InstallPromptEvent;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notifyInstall();
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => undefined);
    });
  }
  if (isInstalledApp()) void requestPersistentStorage();
}

// ---- screen wake lock -------------------------------------------------------

interface WakeLockSentinelLike {
  release: () => Promise<void>;
}

let wakeLock: WakeLockSentinelLike | null = null;
let wantWakeLock = false;

async function acquire(): Promise<void> {
  const api = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockSentinelLike> } }).wakeLock;
  if (!api || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await api.request('screen');
  } catch {
    wakeLock = null;
  }
}

function onVisibility(): void {
  // The browser drops the lock when the page is hidden; take it back on return.
  if (wantWakeLock && document.visibilityState === 'visible') {
    wakeLock = null;
    void acquire();
  }
}

/**
 * Keep the phone's screen on while recording: a locked phone may pause the
 * microphone (iOS always does). Best-effort; false when unsupported.
 */
export async function screenWakeLock(on: boolean): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  wantWakeLock = on;
  if (on) {
    document.addEventListener('visibilitychange', onVisibility);
    await acquire();
    return wakeLock !== null;
  }
  document.removeEventListener('visibilitychange', onVisibility);
  const lock = wakeLock;
  wakeLock = null;
  await lock?.release().catch(() => undefined);
  return false;
}
