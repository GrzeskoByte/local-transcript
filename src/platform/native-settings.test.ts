import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadNativeSettings, resetNativeSettingsCache } from './native-settings';
import { getPref, setPref } from './prefs';
import { db } from '../storage/database';

/** Fake desktop shell with an in-memory settings file. */
function installShell(file: Record<string, unknown> | null): { file: Record<string, unknown> | null; calls: string[] } {
  const state = { file, calls: [] as string[] };
  (globalThis as unknown as { window: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: { key: string; value: unknown }) => {
        state.calls.push(cmd);
        if (cmd === 'native_settings_load') return state.file ? { ...state.file } : null;
        if (cmd === 'native_settings_set' && state.file && args) {
          state.file[args.key] = args.value;
          return null;
        }
        return null;
      },
    },
  };
  return state;
}

beforeEach(() => resetNativeSettingsCache());
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  resetNativeSettingsCache();
});

describe('desktop settings file', () => {
  it('serves kv settings from the file without touching IndexedDB', async () => {
    // No indexedDB in this environment: any IDB access would throw.
    installShell({ 'asr-language-desktop': 'pl' });
    expect(await db.kvGet('asr-language-desktop')).toBe('pl');
    await db.kvSet('gitlab-config', { url: 'https://gitlab.example' });
    expect(await db.kvGet('gitlab-config')).toEqual({ url: 'https://gitlab.example' });
  });

  it('persists writes to the file and survives a reload (new cache)', async () => {
    const shell = installShell({});
    await db.kvSet('asr-model-meta-desktop', { modelId: 'large-v3-turbo', state: 'ready' });
    resetNativeSettingsCache();
    expect(await db.kvGet('asr-model-meta-desktop')).toEqual({ modelId: 'large-v3-turbo', state: 'ready' });
    expect(shell.file).toHaveProperty('asr-model-meta-desktop');
  });

  it('keeps a tombstone on delete so nothing is migrated back', async () => {
    const shell = installShell({ 'llm-config': { model: 'x' } });
    await db.kvDelete('llm-config');
    expect(shell.file?.['llm-config']).toBeNull();
    expect(await db.kvGet('llm-config')).toBeUndefined();
  });

  it('is unavailable when the shell has no settings command (older mocks, browser)', async () => {
    installShell(null);
    expect(await loadNativeSettings()).toBeNull();
    await expect(db.kvGet('asr-language-desktop')).rejects.toThrow();
  });

  it('prefs read the file once it is loaded and write through to it', async () => {
    const shell = installShell({ 'update-auto-check': 'false' });
    await loadNativeSettings();
    expect(getPref('update-auto-check')).toBe('false');
    setPref('desktop-save-to-disk', 'false');
    await new Promise((r) => setTimeout(r, 0));
    expect(shell.file?.['desktop-save-to-disk']).toBe('false');
    expect(getPref('desktop-save-to-disk')).toBe('false');
  });
});
