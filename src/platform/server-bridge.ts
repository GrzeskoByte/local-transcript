/**
 * Transport for the server edition: `POST /api/invoke/<cmd>` stands in for
 * Tauri's `invoke` (same command names, camelCase args, string errors), and
 * `serverApi` talks to the account endpoints (`/api/me`, `/api/admin/*`, …).
 * Cookie auth + the `X-LT-CSRF` header on every state-changing request.
 */
import { SessionChangedError, serverSession, sessionEpoch, sessionLost } from './server';

const CSRF_HEADER = 'X-LT-CSRF';

async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.clone().json();
    if (typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string') {
      return (body as { error: string }).error;
    }
  } catch {
    /* not JSON */
  }
  const text = await res.text().catch(() => '');
  return text.trim() || `The server answered ${res.status}.`;
}

/**
 * Bind an authenticated call to the session it starts under: nothing is sent
 * without one, and an answer that arrives after the account changed is
 * discarded, so a chunk or an import of account A can never land in B's data.
 */
function bind(): () => void {
  const epoch = sessionEpoch();
  if (serverSession() === null) throw new Error('Your session has ended. Sign in again.');
  return () => {
    if (sessionEpoch() !== epoch) throw new SessionChangedError();
  };
}

/** Throw the server's `{error}` (Tauri-style: a plain message). A 401 ends the session. */
async function checked(res: Response): Promise<Response> {
  if (res.ok) return res;
  if (res.status === 401) {
    sessionLost();
    throw new Error('Your session has ended. Sign in again.');
  }
  throw new Error(await errorMessage(res));
}

async function reply<T>(res: Response): Promise<T> {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('application/octet-stream')) return (await res.arrayBuffer()) as T;
  if (res.status === 204) return null as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function csrfHeaders(): Record<string, string> {
  const csrf = serverSession()?.csrf;
  return csrf ? { [CSRF_HEADER]: csrf } : {};
}

/** Call a per-user command (the Tauri `invoke` equivalent). */
export async function serverInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const same = bind();
  const res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...csrfHeaders() },
    body: JSON.stringify(args ?? {}),
  });
  same();
  return reply<T>(await checked(res));
}

/** Call a raw-body command: bytes as the body, parameters as `x-*` headers. */
export async function serverInvokeRaw<T>(
  cmd: string,
  body: Uint8Array,
  headers: Record<string, string> = {},
): Promise<T> {
  const same = bind();
  const res = await fetch(`/api/invoke/${encodeURIComponent(cmd)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { ...headers, 'content-type': 'application/octet-stream', ...csrfHeaders() },
    body: body as unknown as BodyInit,
  });
  same();
  return reply<T>(await checked(res));
}

/**
 * JSON call to an account/admin endpoint. `body` is sent as JSON. With
 * `auth: false` (sign-in, invite accept) a 401 is the answer, not a lost
 * session, and no CSRF header is needed.
 */
export async function serverApi<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options: { auth?: boolean } = {},
): Promise<T> {
  const authed = options.auth !== false;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'GET' || !authed ? {} : csrfHeaders()),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!authed) {
    if (!res.ok) throw new Error(await errorMessage(res));
    return reply<T>(res);
  }
  return reply<T>(await checked(res));
}

/** Download a file from the server (`/api/me/export`) as a Blob. */
export async function serverDownload(path: string): Promise<Blob> {
  const res = await checked(await fetch(path, { credentials: 'same-origin' }));
  return res.blob();
}
