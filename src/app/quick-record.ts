/**
 * One-click recording (nav "● Record", Ctrl+N, "Record now" on a calendar
 * event, the start reminder): the default source, named after the calendar
 * meeting that is on (Settings → Recording), with its agenda. A failure
 * (e.g. the microphone is blocked) lands on Home, which shows it.
 */
import { useCallback, useSyncExternalStore } from 'react';
import { useApp } from './store.tsx';
import { defaultSource, recordingPrefs } from './preferences';
import { agendaFromEvent, eventNow, useUpcoming } from './upcoming';
import { MediaAccessError, type MediaAccessFailure } from '../audio/permissions';
import type { RecordingMode } from '../domain/meeting';
import type { ServerEvent } from '../integrations/calendar';

let lastError: MediaAccessFailure | string | null = null;
const listeners = new Set<() => void>();
export function setStartError(e: MediaAccessFailure | string | null): void {
  lastError = e;
  listeners.forEach((l) => l());
}
export function useStartError(): MediaAccessFailure | string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => lastError,
  );
}

export function errorOf(e: unknown): MediaAccessFailure | string {
  return e instanceof MediaAccessError ? e.failure : e instanceof Error ? e.message : String(e);
}

/** Recording settings an event implies: its title, agenda, and Call when it has a video link. */
export function fromEvent(e: ServerEvent & { hasCallLink?: boolean }, mode: RecordingMode) {
  return {
    title: e.title,
    mode: e.hasCallLink ? ('dual' as const) : mode,
    agenda: agendaFromEvent(e),
    calendarSource: { title: e.title, startIso: e.startIso, ...(e.location ? { location: e.location } : {}) },
  };
}

export function useQuickRecord(): (eventId?: string) => Promise<void> {
  const { startRecording, go } = useApp();
  const upcoming = useUpcoming();
  return useCallback(
    async (eventId?: string) => {
      setStartError(null);
      const ev = eventId ? upcoming.events.find((e) => e.id === eventId) : recordingPrefs().nameFromCalendar ? eventNow(upcoming.events) : null;
      const mode = defaultSource();
      const plan = ev ? fromEvent(ev, mode) : { title: '', mode, agenda: [], calendarSource: undefined };
      try {
        await startRecording(plan.title, plan.mode, plan.agenda, plan.calendarSource ? { calendarSource: plan.calendarSource } : {});
      } catch (e) {
        setStartError(errorOf(e));
        go({ name: 'home' });
      }
    },
    [startRecording, go, upcoming.events],
  );
}
