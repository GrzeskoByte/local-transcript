import { db } from '../storage/database';
import {
  DEFAULT_CALENDAR_CONFIG,
  type CalendarConfig,
  type CalendarProvider,
} from './calendar';

const KEY = 'calendar-config';

/** One saved config per provider + which one the calendar view shows. */
export interface CalendarStoreShape {
  activeProvider: CalendarProvider;
  configs: Record<CalendarProvider, CalendarConfig>;
}

function configFor(provider: CalendarProvider): CalendarConfig {
  return { ...DEFAULT_CALENDAR_CONFIG, provider };
}

export function defaultCalendarStore(): CalendarStoreShape {
  return {
    activeProvider: 'caldav',
    configs: { caldav: configFor('caldav'), graph: configFor('graph'), ews: configFor('ews') },
  };
}

function isProvider(p: unknown): p is CalendarProvider {
  return p === 'caldav' || p === 'graph' || p === 'ews';
}

/** Load the store, migrating the legacy single-config shape. */
export async function getCalendarStore(): Promise<CalendarStoreShape> {
  const stored = await db.kvGet<unknown>(KEY);
  if (!stored) return defaultCalendarStore();
  let raw: unknown = stored;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return defaultCalendarStore();
    }
  }
  if (!raw) return defaultCalendarStore();
  try {
    const parsed = raw as Partial<CalendarStoreShape> & Partial<CalendarConfig>;
    if (parsed.configs && typeof parsed.configs === 'object') {
      const base = defaultCalendarStore();
      for (const p of ['caldav', 'graph', 'ews'] as const) {
        const c = (parsed.configs as Record<string, unknown>)[p];
        if (c && typeof c === 'object') base.configs[p] = { ...configFor(p), ...(c as Partial<CalendarConfig>), provider: p };
      }
      base.activeProvider = isProvider(parsed.activeProvider) ? parsed.activeProvider : 'caldav';
      return base;
    }
    // Legacy: the whole value was one CalendarConfig.
    if (isProvider((parsed as Partial<CalendarConfig>).provider)) {
      const legacy = parsed as unknown as CalendarConfig;
      const base = defaultCalendarStore();
      base.configs[legacy.provider] = { ...configFor(legacy.provider), ...legacy };
      base.activeProvider = legacy.provider;
      return base;
    }
  } catch {
    /* fall through */
  }
  return defaultCalendarStore();
}

/** Active provider's config (what the view and create/test use). */
export async function getCalendarConfig(): Promise<CalendarConfig> {
  const store = await getCalendarStore();
  return store.configs[store.activeProvider];
}

/** Persist one provider's config (does not switch the active provider). */
export async function saveProviderConfig(config: CalendarConfig): Promise<CalendarStoreShape> {
  const store = await getCalendarStore();
  store.configs[config.provider] = { ...config };
  await db.kvSet(KEY, JSON.stringify(store));
  return store;
}

/** Switch which provider the calendar view shows. */
export async function setActiveCalendarProvider(provider: CalendarProvider): Promise<CalendarStoreShape> {
  const store = await getCalendarStore();
  store.activeProvider = provider;
  await db.kvSet(KEY, JSON.stringify(store));
  return store;
}

/** Legacy helper: save one config and make it active. */
export async function setCalendarConfig(config: CalendarConfig): Promise<void> {
  const store = await getCalendarStore();
  store.configs[config.provider] = { ...config };
  store.activeProvider = config.provider;
  await db.kvSet(KEY, JSON.stringify(store));
}
