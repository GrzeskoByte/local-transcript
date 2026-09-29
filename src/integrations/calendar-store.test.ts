import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../storage/database', () => {
  const mem = new Map<string, unknown>();
  return {
    db: {
      kvGet: async (key: string) => mem.get(key),
      kvSet: async (key: string, value: unknown) => {
        mem.set(key, value);
      },
      kvDelete: async (key: string) => {
        mem.delete(key);
      },
      __clear: () => mem.clear(),
    },
  };
});

import { db } from '../storage/database';
import {
  defaultCalendarStore,
  getCalendarConfig,
  getCalendarStore,
  saveProviderConfig,
  setActiveCalendarProvider,
  setCalendarConfig,
} from './calendar-store';
import { DEFAULT_CALENDAR_CONFIG } from './calendar';

beforeEach(async () => {
  await (db as unknown as { __clear: () => void }).__clear();
});

describe('calendar store', () => {
  it('defaults to an empty per-provider store', async () => {
    const store = await getCalendarStore();
    expect(store.activeProvider).toBe('caldav');
    expect(store.configs.graph).toMatchObject({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph' });
  });

  it('migrates the legacy single-config shape', async () => {
    await db.kvSet('calendar-config', {
      ...DEFAULT_CALENDAR_CONFIG,
      provider: 'ews',
      serverUrl: 'mail.example',
      username: 'u',
    });
    const store = await getCalendarStore();
    expect(store.activeProvider).toBe('ews');
    expect(store.configs.ews.serverUrl).toBe('mail.example');
    expect(store.configs.caldav.serverUrl).toBe('');
  });

  it('saves per-provider configs without switching', async () => {
    await setCalendarConfig({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph', token: 't' });
    await saveProviderConfig({ ...DEFAULT_CALENDAR_CONFIG, provider: 'caldav', serverUrl: 'cal.example' });
    expect((await getCalendarConfig()).provider).toBe('graph');
    const switched = await setActiveCalendarProvider('caldav');
    expect(switched.configs.caldav.serverUrl).toBe('cal.example');
    expect((await getCalendarConfig()).provider).toBe('caldav');
  });

  it('defaultCalendarStore is independent per call', () => {
    expect(defaultCalendarStore().configs).not.toBe(defaultCalendarStore().configs);
  });
});
