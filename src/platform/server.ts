/**
 * Server edition (Docker): detection, session and capabilities.
 *
 * `lt-server` serves the same bundle with `<meta name="lt-edition"
 * content="server">` in `index.html`. In that mode there is no Tauri shell:
 * `invokeDesktop` is routed to `POST /api/invoke/<cmd>` (see
 * `server-bridge.ts`), the session cookie is HttpOnly and the CSRF token comes
 * from `GET /api/me`. See docs/SERVER.md.
 */

export interface ServerUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  auth: 'local' | 'oidc';
}

export interface ServerSession {
  user: ServerUser;
  csrf: string;
  capabilities: string[];
}

/** True when `index.html` carries the server-edition meta tag. */
export function isServerApp(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('meta[name="lt-edition"]')?.getAttribute('content') === 'server';
}

/**
 * Where data lives, for copy: "this server" in the server edition (the
 * browser only shows it), else `this <kind>` (the desktop app keeps it local).
 */
export function thisPlace(kind: 'device' | 'computer' = 'device'): string {
  return isServerApp() ? 'this server' : `this ${kind}`;
}

/**
 * Device Audio in the browser is the sound of a shared tab or window — never
 * "system sound" (the server edition cannot capture that).
 */
export function deviceSoundLabel(): string {
  return isServerApp() ? 'shared tab sound' : 'system sound';
}

let session: ServerSession | null = null;
let version = 0;
/** Bumps whenever the signed-in account changes or the session ends. */
let epoch = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  for (const l of listeners) l();
}

/** The signed-in session, or null (not loaded yet / signed out / expired). */
export function serverSession(): ServerSession | null {
  return session;
}

export function setServerSession(next: ServerSession | null): void {
  if ((next?.user.id ?? null) !== (session?.user.id ?? null)) epoch++;
  session = next;
  emit();
}

/** The session a call or an operation started under (changes with the account). */
export function sessionEpoch(): number {
  return epoch;
}

/** Work started under one account must not continue under another. */
export class SessionChangedError extends Error {
  constructor() {
    super('The session changed (signed out or another account). Nothing was sent.');
    this.name = 'SessionChangedError';
  }
}

/**
 * Capture the current session; the returned function throws
 * `SessionChangedError` once it no longer matches. Long operations (a
 * recording, an import) call it before every write to the server.
 */
export function sessionGuard(): () => void {
  const started = epoch;
  return () => {
    if (!isServerApp()) return;
    if (epoch !== started || session === null) throw new SessionChangedError();
  };
}

/** Test hook. */
export function resetServerSessionForTests(): void {
  session = null;
  epoch = 0;
}

/** `useSyncExternalStore` hooks: changes whenever the session changes. */
export function subscribeServerSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function serverSessionVersion(): number {
  return version;
}

export function isServerAdmin(): boolean {
  return session?.user.role === 'admin';
}

/**
 * Models and GPU settings are shared by every account on a server: only an
 * admin installs them. Always true outside the server edition.
 */
export function canManageModels(): boolean {
  return !isServerApp() || isServerAdmin();
}

/** Whether the server lists `cmd` in its capabilities (`/api/me`). */
export function hasCapability(cmd: string): boolean {
  return session?.capabilities.includes(cmd) === true;
}

function isSession(value: unknown): value is ServerSession {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<ServerSession>;
  return (
    typeof v.csrf === 'string' &&
    typeof v.user === 'object' &&
    v.user !== null &&
    typeof v.user.email === 'string' &&
    Array.isArray(v.capabilities)
  );
}

/**
 * Ask the server who is signed in (`GET /api/me`). Resolves the session, or
 * null when nobody is (401). Other failures reject (server unreachable).
 */
export async function loadServerSession(): Promise<ServerSession | null> {
  const res = await fetch('/api/me', { credentials: 'same-origin', headers: { accept: 'application/json' } });
  if (res.status === 401) {
    setServerSession(null);
    return null;
  }
  if (!res.ok) throw new Error(`The server answered ${res.status} to /api/me.`);
  const body: unknown = await res.json();
  if (!isSession(body)) throw new Error('The server sent an unreadable session.');
  setServerSession(body);
  return body;
}

/**
 * The session is gone (a 401 from any call): forget it and show the sign-in
 * screen. The invite screen is the only other page that needs no session.
 */
export function sessionLost(): void {
  const hadSession = session !== null;
  if (hadSession) epoch++;
  session = null;
  if (typeof window !== 'undefined' && window.location && !window.location.hash.startsWith('#/invite/')) {
    window.location.hash = '#/signin';
  }
  if (hadSession) {
    emit();
    // A clean page: whatever the old account left in memory (a recorder that
    // still holds the microphone, caches) must not outlive its session.
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') window.location.reload();
  }
}
