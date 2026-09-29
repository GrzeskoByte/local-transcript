import { describe, expect, it, vi } from 'vitest';

vi.mock('../storage/database', () => {
  const mem = new Map<string, unknown>();
  return {
    db: {
      kvGet: async (key: string) => mem.get(key),
      kvSet: async (key: string, value: unknown) => {
        mem.set(key, value);
      },
    },
  };
});

import { DEFAULT_CALENDAR_CONFIG, type ServerEvent } from './calendar';
import { calendarCacheKey, readCachedMonth, writeCachedMonth } from './calendar-cache';

const sogo = {
  ...DEFAULT_CALENDAR_CONFIG,
  serverUrl: 'mail.host.com/SOGo/dav/me/Calendar/personal/',
  username: 'me',
  password: 'p',
};
const ev: ServerEvent = {
  id: 'caldav:1', title: 'Standup', startIso: '2026-10-05T09:00', endIso: '2026-10-05T09:15',
  location: '', provider: 'caldav',
};

describe('calendar cache', () => {
  it('keys by provider, account, server and month', () => {
    const k = calendarCacheKey(sogo, new Date(2026, 9, 1));
    expect(k).toBe('calendar-cache:caldav:me@https://mail.host.com/SOGo/dav/me/Calendar/personal:2026-10');
    expect(calendarCacheKey({ ...sogo, username: 'other' }, new Date(2026, 9, 1))).not.toBe(k);
    expect(calendarCacheKey(sogo, new Date(2026, 10, 1))).not.toBe(k);
  });
  it('round-trips a month and misses other months', async () => {
    await writeCachedMonth(sogo, new Date(2026, 9, 1), [ev], 123);
    expect(await readCachedMonth(sogo, new Date(2026, 9, 1))).toEqual({ events: [ev], fetchedAt: 123 });
    expect(await readCachedMonth(sogo, new Date(2026, 8, 1))).toBeNull();
  });
});
