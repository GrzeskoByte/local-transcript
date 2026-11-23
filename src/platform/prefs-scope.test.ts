import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getPref, setPref } from './prefs';
import { clearNetworkLog, logNetwork, networkLog } from './network-log';
import { keepAudio, setKeepAudio } from '../app/preferences';
import { resetNativeSettingsCache } from './native-settings';
import { setServerSession } from './server';

const data = new Map<string, string>();
const as = (id: string) =>
  setServerSession({ user: { id, email: `${id}@x`, name: id, role: 'member', auth: 'local' }, csrf: 'c', capabilities: [] });

beforeEach(() => {
  data.clear();
  (globalThis as unknown as { document: unknown }).document = {
    querySelector: () => ({ getAttribute: () => 'server' }),
  };
  (globalThis as unknown as { window: unknown }).window = { location: { hash: '' } };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  resetNativeSettingsCache();
});
afterEach(() => {
  setServerSession(null);
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('server mode: browser prefs are scoped to the signed-in account', () => {
  it('keys localStorage by user id', () => {
    as('alice');
    setPref('theme', 'dark');
    expect([...data.keys()]).toEqual(['u:alice:theme']);
    expect(getPref('theme')).toBe('dark');
  });

  it("user B never sees user A's network log or keep-audio rule", () => {
    as('alice');
    logNetwork('https://gitlab.example', 'Created 3 issues from "Secret board meeting"', '3 titles');
    setKeepAudio('30d');
    expect(networkLog()).toHaveLength(1);
    expect(keepAudio()).toBe('30d');

    as('bob');
    expect(networkLog()).toEqual([]);
    expect(keepAudio()).toBe('always');
    logNetwork('https://other.example', 'Bob only', 'nothing');
    expect(networkLog().map((e) => e.why)).toEqual(['Bob only']);

    as('alice');
    expect(networkLog().map((e) => e.host)).toEqual(['gitlab.example']);
    expect(keepAudio()).toBe('30d');
    clearNetworkLog();
    as('bob');
    expect(networkLog()).toHaveLength(1);
  });

  it('never reads or migrates unscoped (desktop / earlier account) values', () => {
    data.set('keep-audio', '30d');
    data.set('network-log', JSON.stringify([{ at: Date.now(), host: 'leak.example', why: 'old', sent: 'x' }]));
    as('carol');
    expect(keepAudio()).toBe('always');
    expect(networkLog()).toEqual([]);
    expect(getPref('keep-audio')).toBeNull();
  });

  it('reads and writes nothing while nobody is signed in', () => {
    setServerSession(null);
    setPref('theme', 'dark');
    expect(data.size).toBe(0);
    expect(getPref('theme')).toBeNull();
  });
});

describe('outside the server edition keys stay as they were', () => {
  it('uses the plain key', () => {
    (globalThis as unknown as { document: unknown }).document = { querySelector: () => null };
    setPref('theme', 'dark');
    expect([...data.keys()]).toEqual(['theme']);
  });
});
