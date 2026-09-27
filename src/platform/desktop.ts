/**
 * Desktop (Tauri) detection + invoke bridge.
 *
 * Uses Tauri v2's internal `invoke` so the frontend needs no
 * `@tauri-apps/api` dependency: outside the Tauri webview
 * `__TAURI_INTERNALS__` is absent and every helper degrades safely.
 */
interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
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
