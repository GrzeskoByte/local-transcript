import { db } from '../storage/database';
import { effectiveServerUrl, type CalendarConfig, type ServerEvent } from './calendar';

/** Last successful fetch of one month, kept so the calendar view works offline. */
export interface CachedMonth {
  events: ServerEvent[];
  fetchedAt: number;
}

/** One cache entry per provider + server + account + month. */
export function calendarCacheKey(config: CalendarConfig, monthStart: Date): string {
  const month = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`;
  const server = effectiveServerUrl(config) || 'default';
  return `calendar-cache:${config.provider}:${config.username.trim()}@${server}:${month}`;
}

export async function readCachedMonth(config: CalendarConfig, monthStart: Date): Promise<CachedMonth | null> {
  try {
    const hit = await db.kvGet<CachedMonth>(calendarCacheKey(config, monthStart));
    return hit && Array.isArray(hit.events) ? hit : null;
  } catch {
    return null;
  }
}

export async function writeCachedMonth(
  config: CalendarConfig,
  monthStart: Date,
  events: ServerEvent[],
  fetchedAt: number = Date.now(),
): Promise<void> {
  try {
    await db.kvSet<CachedMonth>(calendarCacheKey(config, monthStart), { events, fetchedAt });
  } catch {
    /* cache is best-effort */
  }
}
