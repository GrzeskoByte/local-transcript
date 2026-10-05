/**
 * Desktop (Tauri) detection + invoke bridge.
 *
 * Uses Tauri v2's internal `invoke` so the frontend needs no
 * `@tauri-apps/api` dependency: outside the Tauri webview
 * `__TAURI_INTERNALS__` is absent and every helper degrades safely.
 */
interface TauriInternals {
  invoke: <T>(
    cmd: string,
    args?: Record<string, unknown> | Uint8Array,
    options?: { headers?: Record<string, string> },
  ) => Promise<T>;
}

function internals(): TauriInternals | null {
  if (typeof window === 'undefined') return null;
  const t = (window as unknown as { __TAURI_INTERNALS__?: Partial<TauriInternals> })
    .__TAURI_INTERNALS__;
  return t && typeof t.invoke === 'function' ? (t as TauriInternals) : null;
}

/** True only inside the Tauri desktop shell. */
export function isDesktopApp(): boolean {
  return internals() !== null;
}

/** Call a Rust command. Throws when not running in the desktop shell. */
export async function invokeDesktop<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const t = internals();
  if (!t) throw new Error('Not running in the desktop app');
  return t.invoke<T>(cmd, args);
}

/**
 * Call a Rust command with a binary payload (sent as the raw request body,
 * no JSON/base64), plus string `headers` for its parameters.
 */
export async function invokeDesktopRaw<T>(
  cmd: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<T> {
  const t = internals();
  if (!t) throw new Error('Not running in the desktop app');
  return t.invoke<T>(cmd, body, { headers });
}

/**
 * Open an http(s) link in the system browser. The Tauri webview swallows
 * `target="_blank"` clicks, so external anchors must call this on click
 * (and `preventDefault`) when running in the desktop shell.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await invokeDesktop<void>('native_open_url', { url });
}
