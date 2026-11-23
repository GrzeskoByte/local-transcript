import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeDesktop, invokeDesktopRaw, hasNativeBackend, isDesktopApp } from './desktop';
import { serverInvoke, serverInvokeRaw, serverApi } from './server-bridge';
import {
  SessionChangedError,
  hasCapability,
  isServerApp,
  loadServerSession,
  serverSession,
  sessionGuard,
  setServerSession,
} from './server';

interface Call {
  url: string;
  init: RequestInit;
}

let calls: Call[];
let reply: (call: Call) => Response;
const hashes: string[] = [];

function install(serverMeta = true): void {
  calls = [];
  (globalThis as unknown as { document: unknown }).document = {
    querySelector: (sel: string) =>
      serverMeta && sel.includes('lt-edition') ? { getAttribute: () => 'server' } : null,
  };
  const win = {
    location: {
      get hash() {
        return hashes[hashes.length - 1] ?? '';
      },
      set hash(v: string) {
        hashes.push(v);
      },
    },
  };
  (globalThis as unknown as { window: unknown }).window = win;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url, init };
    calls.push(call);
    return reply(call);
  });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ME = { user: { id: 'u1', email: 'a@x.io', name: 'A', role: 'member', auth: 'local' }, csrf: 'tok123', capabilities: ['native_asr_status'] };

beforeEach(() => {
  hashes.length = 0;
  install();
  reply = () => json(null);
  setServerSession(ME as never);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  setServerSession(null);
});

describe('server edition detection', () => {
  it('reads the lt-edition meta tag, and is not the desktop app', () => {
    expect(isServerApp()).toBe(true);
    expect(isDesktopApp()).toBe(false);
    expect(hasNativeBackend()).toBe(true);
    install(false);
    expect(isServerApp()).toBe(false);
    expect(hasNativeBackend()).toBe(false);
  });

  it('loads the session and its capabilities from /api/me', async () => {
    setServerSession(null);
    reply = () => json(ME);
    expect((await loadServerSession())?.csrf).toBe('tok123');
    expect(hasCapability('native_asr_status')).toBe(true);
    expect(hasCapability('native_recorder_start')).toBe(false);
  });

  it('resolves null on 401 without throwing', async () => {
    setServerSession(null);
    reply = () => json({ error: 'no session' }, 401);
    expect(await loadServerSession()).toBeNull();
  });
});

describe('invoke over HTTP', () => {
  it('POSTs the args as JSON with the CSRF header and cookies', async () => {
    reply = () => json({ available: true });
    const out = await invokeDesktop<{ available: boolean }>('native_asr_status', { a: 1 });
    expect(out).toEqual({ available: true });
    const { url, init } = calls[0]!;
    expect(url).toBe('/api/invoke/native_asr_status');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['X-LT-CSRF']).toBe('tok123');
    expect(init.body).toBe('{"a":1}');
  });

  it('turns a null reply (a command returning ()) into null', async () => {
    reply = () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    expect(await serverInvoke('native_settings_set', { key: 'a', value: 1 })).toBeNull();
  });

  it('returns binary replies as an ArrayBuffer', async () => {
    reply = () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
    const buf = await invokeDesktop<ArrayBuffer>('native_recording_read', { meetingId: 'm', track: '' });
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
  });

  it('sends raw bodies as octet-stream with the x-* headers', async () => {
    reply = () => json('line');
    await invokeDesktopRaw('native_diarize_run', new Uint8Array([9, 8]), { 'x-num-speakers': '2' });
    const { init } = calls[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['x-num-speakers']).toBe('2');
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['X-LT-CSRF']).toBe('tok123');
    expect(init.body).toEqual(new Uint8Array([9, 8]));
  });

  it('throws {error} as a plain Error message (like Tauri string errors)', async () => {
    reply = () => json({ error: 'Quota exceeded' }, 400);
    await expect(serverInvoke('native_recording_write', {})).rejects.toThrow('Quota exceeded');
    reply = () => json({ error: 'not supported here' }, 404);
    await expect(serverInvoke('native_recorder_start', {})).rejects.toThrow('not supported here');
  });

  it('on 401 forgets the session and goes to the sign-in screen', async () => {
    reply = () => json({ error: 'expired' }, 401);
    await expect(serverInvoke('native_asr_status')).rejects.toThrow(/session/i);
    expect(serverSession()).toBeNull();
    expect(hashes).toContain('#/signin');
  });
});

describe('account API', () => {
  it('adds the CSRF header to state-changing calls only', async () => {
    reply = () => json([]);
    await serverApi('GET', '/api/me/sessions');
    await serverApi('DELETE', '/api/me/sessions/abc');
    expect((calls[0]!.init.headers as Record<string, string>)['X-LT-CSRF']).toBeUndefined();
    expect((calls[1]!.init.headers as Record<string, string>)['X-LT-CSRF']).toBe('tok123');
  });

  it('sign-in (auth: false) reports a 401 as an error and keeps the session handling out of it', async () => {
    setServerSession(null);
    reply = () => json({ error: 'Wrong e-mail or password.' }, 401);
    await expect(serverApi('POST', '/api/auth/login', { email: 'a', password: 'b' }, { auth: false })).rejects.toThrow(
      'Wrong e-mail or password.',
    );
    expect(hashes).toHaveLength(0);
  });

  it('keeps raw bytes of serverInvokeRaw intact', async () => {
    reply = () => json(null);
    const bytes = new Uint8Array([0, 255, 7]);
    await serverInvokeRaw('native_export_file', bytes);
    expect(calls[0]!.init.body).toBe(bytes);
  });
});

describe('calls are bound to the session they started under', () => {
  const ME_B = { ...ME, user: { ...ME.user, id: 'u2', email: 'b@x.io' }, csrf: 'tokB' };

  it('sends nothing without a session', async () => {
    setServerSession(null);
    await expect(serverInvoke('native_recording_write', {})).rejects.toThrow(/session/i);
    await expect(serverInvokeRaw('native_export_file', new Uint8Array([1]))).rejects.toThrow(/session/i);
    expect(calls).toHaveLength(0);
  });

  it('discards an answer that arrives after the account changed', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    reply = () => json({ ok: true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      await gate;
      return reply({ url, init });
    });
    const pending = serverInvoke('native_recording_write', { request: { meetingId: 'a' } });
    setServerSession(ME_B as never); // signed in as someone else meanwhile
    release();
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    // and the new account's session is untouched by the old call
    expect(serverSession()?.user.id).toBe('u2');
  });

  it('a late 401 of the old account cannot end the new one', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      await gate;
      return json({ error: 'expired' }, 401);
    });
    const pending = serverInvoke('native_asr_status');
    setServerSession(ME_B as never);
    release();
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
    expect(serverSession()?.user.id).toBe('u2');
  });

  it('sessionGuard throws once the account changed or the session ended', () => {
    const same = sessionGuard();
    expect(() => same()).not.toThrow();
    setServerSession(ME as never); // same user re-loaded (/api/me refresh): still the same session
    expect(() => same()).not.toThrow();
    setServerSession(ME_B as never);
    expect(() => same()).toThrow(SessionChangedError);

    const other = sessionGuard();
    setServerSession(null);
    expect(() => other()).toThrow(SessionChangedError);
    setServerSession(ME_B as never); // signing in again as the same user is a new session
    expect(() => other()).toThrow(SessionChangedError);
  });

  it('a 401 reloads the page so nothing of the old session stays in memory', async () => {
    let reloads = 0;
    (window as unknown as { location: { reload: () => void } }).location.reload = () => void reloads++;
    reply = () => json({ error: 'expired' }, 401);
    await expect(serverInvoke('native_asr_status')).rejects.toThrow();
    expect(reloads).toBe(1);
  });
});
