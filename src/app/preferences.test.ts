import { beforeAll, describe, expect, it } from 'vitest';
import { enabledWrapSteps, exportBaseName, setWrapPrefs, wrapPrefs } from './preferences';
import { bindingOf, keyParts } from './shortcuts';
import { hostOf, logNetwork, networkLog } from '../platform/network-log';

// Node has no localStorage: a tiny in-memory one for the prefs.
beforeAll(() => {
  const data = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
});

describe('preferences', () => {
  it('names export files from the pattern', () => {
    const at = new Date(2026, 9, 21, 9, 47).getTime();
    expect(exportBaseName('{date}-{title}', 'Q4 roadmap sync — design!', at)).toBe('2026-10-21-q4-roadmap-sync-design');
    expect(exportBaseName('{title}_{time}', 'Über/Plan', at)).toBe('uber-plan_0947');
    expect(exportBaseName('', '', at)).toBe('2026-10-21-meeting');
  });

  it('keeps Transcribe first and only the steps that are on', () => {
    setWrapPrefs({ steps: { summary: true, gitlab: false, calendar: true, export: true } });
    expect(enabledWrapSteps()).toEqual(['transcribe', 'summary', 'calendar', 'export']);
    expect(wrapPrefs().guide).toBe(true);
  });
});

describe('shortcuts', () => {
  it('turns key presses into bindings', () => {
    const k = (key: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
      bindingOf({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });
    expect(k('n', { ctrlKey: true })).toBe('Ctrl+N');
    expect(k('n', { metaKey: true })).toBe('Ctrl+N');
    expect(k(' ')).toBe('Space');
    expect(k('Shift', { shiftKey: true })).toBeNull();
    expect(keyParts('ArrowLeft')).toEqual(['←']);
  });
});

describe('network log', () => {
  it('records connections with their host, newest first', () => {
    logNetwork('https://gitlab.example.org/api/v4/projects', 'Created 3 issues', '3 titles', 1000);
    logNetwork('huggingface.co', 'Downloaded base', 'Nothing (download)', 2000);
    const log = networkLog(3000);
    expect(log.slice(0, 2).map((e) => e.host)).toEqual(['huggingface.co', 'gitlab.example.org']);
    expect(networkLog(31 * 24 * 3600 * 1000 + 3000)).toEqual([]);
    expect(hostOf('not a url/x')).toBe('not a url');
  });
});
