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

let session: ServerSession | null = null;
let version = 0;
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
  session = next;
  emit();
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
  session = null;
  if (typeof window !== 'undefined' && window.location && !window.location.hash.startsWith('#/invite/')) {
    window.location.hash = '#/signin';
  }
  if (hadSession) emit();
}
