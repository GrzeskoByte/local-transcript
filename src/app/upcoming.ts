/**
 * "Coming up" (Home) and the reminder to record when a meeting starts: the
 * next events of the configured company calendar, fetched when the app opens
 * and every 10 minutes while it runs (only with a calendar set up and
 * Settings → GitLab & calendar → "Show what's coming up on Home" on).
 */
import { useEffect, useState } from 'react';
import { validateCalendarConfig, withCallLink, type ServerEvent } from '../integrations/calendar';
import { isDesktopApp } from '../platform/desktop';
import { useApp } from './store.tsx';
import { calendarPrefs, usePrefsVersion } from './preferences';
import { parseAgendaText, type AgendaItem } from '../domain/agenda';

const REFRESH_MS = 10 * 60 * 1000;

export interface Upcoming {
  events: Array<ServerEvent & { hasCallLink: boolean }>;
  error: string | null;
  loaded: boolean;
}

let cache: Upcoming = { events: [], error: null, loaded: false };
const listeners = new Set<(u: Upcoming) => void>();
function publish(u: Upcoming): void {
  cache = u;
  listeners.forEach((l) => l(u));
}

/** Events from now (or still running) to 36 h ahead, soonest first. */
export function useUpcoming(): Upcoming {
  const { calendarConfig, fetchCalendarEvents } = useApp();
  usePrefsVersion();
  const enabled = isDesktopApp() && calendarPrefs().comingUp && validateCalendarConfig(calendarConfig) === null;
  const [state, setState] = useState(cache);
  useEffect(() => {
    listeners.add(setState);
    return () => void listeners.delete(setState);
  }, []);
  useEffect(() => {
    if (!enabled) {
      publish({ events: [], error: null, loaded: true });
      return;
    }
    let stopped = false;
    const load = async () => {
      const now = new Date();
      try {
        const evs = await fetchCalendarEvents(new Date(now.getTime() - 2 * 3600_000), new Date(now.getTime() + 36 * 3600_000));
        if (stopped) return;
        const soon = evs
          .filter((e) => !e.allDay && new Date(e.endIso).getTime() > now.getTime())
          .sort((a, b) => a.startIso.localeCompare(b.startIso))
          .map(withCallLink);
        publish({ events: soon, error: null, loaded: true });
      } catch (e) {
        if (!stopped) publish({ ...cache, error: e instanceof Error ? e.message : String(e), loaded: true });
      }
    };
    void load();
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [enabled, calendarConfig, fetchCalendarEvents]);
  return state;
}

/** "today · in 38 min", "tomorrow 09:30", "now". */
export function whenLabel(startIso: string, endIso: string, now = new Date()): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (start <= now && end > now) return 'now';
  const mins = Math.round((start.getTime() - now.getTime()) / 60000);
  const sameDay = start.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toDateString() === start.toDateString();
  const time = start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay && mins < 60) return `today · in ${mins} min`;
  if (sameDay) return `today · ${time}`;
  if (tomorrow) return `tomorrow · ${time}`;
  return start.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The event running now (or starting within 5 minutes), for "Name from the calendar". */
export function eventNow(events: ServerEvent[], now = new Date()): ServerEvent | null {
  return (
    events.find((e) => {
      const s = new Date(e.startIso).getTime() - 5 * 60_000;
      return s <= now.getTime() && new Date(e.endIso).getTime() > now.getTime();
    }) ?? null
  );
}

/** The event's description as agenda items ("Use event agendas"). */
export function agendaFromEvent(e: ServerEvent): AgendaItem[] {
  if (!calendarPrefs().useAgendas || !e.description) return [];
  return parseAgendaText(e.description).slice(0, 20);
}
