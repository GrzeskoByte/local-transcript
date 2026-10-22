import { useEffect, useState } from 'react';
import { useApp } from '../../store.tsx';
import type { Meeting } from '../../../domain/meeting';
import { pendingTargets } from '../../../domain/wrapup';
import {
  actionItemEventDraft,
  extractEventDraft,
  validateCalendarConfig,
  CALENDAR_PROVIDER_LABELS,
  type CalendarEventDraft,
} from '../../../integrations/calendar';
import { wrapPrefs } from '../../preferences';
import { folderName } from '../../../features/meetings/disk-sync';

interface Draft {
  item: string;
  title: string;
  date: string;
  time: string;
  description: string;
}

function toDraft(item: string, d: CalendarEventDraft): Draft {
  return { item, title: d.title, date: d.startIso.slice(0, 10), time: d.startIso.slice(11, 16), description: d.description };
}

function fromDraft(d: Draft, location = ''): CalendarEventDraft {
  const start = new Date(`${d.date}T${d.time || '10:00'}`);
  const end = new Date(start.getTime() + 30 * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
  return { title: d.title, startIso: iso(start), endIso: iso(end), description: d.description, location };
}

/**
 * Calendar events from the action items routed there (one 30-minute event
 * each; title, date and time editable). Each event's description carries
 * the meeting summary and where its transcript is. Plus a custom event.
 */
export function EventsStep({
  m,
  onError,
  onCreated,
  showCreated = true,
}: {
  m: Meeting;
  onError: (e: string) => void;
  onCreated?: () => void;
  showCreated?: boolean;
}): React.JSX.Element {
  const { calendarConfig, createCalendarEvent, go, storageDir } = useApp();
  const ready = validateCalendarConfig(calendarConfig) === null;
  const pending = pendingTargets(m, wrapPrefs().pretick).calendar;
  const transcriptNote = storageDir ? `\n\nTranscript: ${storageDir}/${folderName(m)}/transcript.md` : '';
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [custom, setCustom] = useState<CalendarEventDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const key = pending.map((a) => a.text).join('\n');

  useEffect(() => {
    // Keep the user's edits to drafts that are still pending; add new ones.
    setDrafts((cur) =>
      pending.map(
        (a) =>
          cur.find((d) => d.item === a.text) ??
          toDraft(a.text, { ...actionItemEventDraft(m, a), description: actionItemEventDraft(m, a).description + transcriptNote }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, m.id]);

  if (!ready) {
    return (
      <p className="muted">
        No company calendar is connected.{' '}
        <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'integrations' })}>
          Set up the calendar
        </button>{' '}
        to add follow-ups.
      </p>
    );
  }

  const edit = (i: number, patch: Partial<Draft>): void => setDrafts((ds) => ds.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const createAll = async (): Promise<void> => {
    setBusy(true);
    const done = new Set<string>();
    let made = 0;
    try {
      for (const d of drafts) {
        await createCalendarEvent(m.id, fromDraft(d), d.item);
        done.add(d.item);
        made += 1;
      }
      onCreated?.();
    } catch (e) {
      setDrafts((ds) => ds.filter((d) => !done.has(d.item)));
      onError(`${made ? `Added ${made} event${made === 1 ? '' : 's'}, then: ` : ''}${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="events-step">
      {drafts.length > 0 ? (
        <>
          <div className="draft-table events" role="table" aria-label="Events to add">
            <div className="draft-head" role="row">
              <span role="columnheader">Event</span>
              <span role="columnheader">Date</span>
              <span role="columnheader">Time</span>
            </div>
            {drafts.map((d, i) => (
              <div key={d.item} className="draft-row" role="row">
                <input className="input" aria-label="Event title" value={d.title} onChange={(e) => edit(i, { title: e.target.value })} />
                <input className="input" type="date" aria-label="Date" value={d.date} onChange={(e) => edit(i, { date: e.target.value })} />
                <input className="input" type="time" aria-label="Time" value={d.time} onChange={(e) => edit(i, { time: e.target.value })} />
              </div>
            ))}
          </div>
          <p className="muted small">Each event gets the meeting summary and where its transcript is, in the description.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-primary" disabled={busy || drafts.some((d) => !d.title.trim() || !d.date)} onClick={() => void createAll()}>
              {busy ? 'Adding…' : `Add ${drafts.length} event${drafts.length === 1 ? '' : 's'}`}
            </button>
            <span className="muted small self-center">to {CALENDAR_PROVIDER_LABELS[calendarConfig.provider]}</span>
          </div>
        </>
      ) : (
        <p className="muted mt-0">
          {(m.calendarEvents?.length ?? 0) > 0
            ? 'Every action item routed to the calendar has an event.'
            : 'No action items are routed to the calendar — tick Calendar next to an item in the summary.'}
        </p>
      )}

      {showCreated && (m.calendarEvents?.length ?? 0) > 0 && (
        <>
          <h4 className="sub-head">Events from this meeting</h4>
          <ul className="issue-list" aria-label="Created calendar events">
            {m.calendarEvents!.map((ev) => (
              <li key={ev.uid} className="issue-row">
                <span className="grow">
                  <strong>{ev.title}</strong>
                  <small className="muted"> · {new Date(ev.startIso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small>
                </span>
                <span className="pill pill-completed">added</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {custom ? (
        <fieldset className="event-draft" aria-label="Custom event">
          <legend className="field-label">Custom event</legend>
          <input className="input" aria-label="Event title" value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} />
          <div className="row-selects">
            <label>
              Starts
              <input className="input" type="datetime-local" aria-label="Event start" value={custom.startIso} onChange={(e) => setCustom({ ...custom, startIso: e.target.value })} />
            </label>
            <label>
              Ends
              <input className="input" type="datetime-local" aria-label="Event end" value={custom.endIso} onChange={(e) => setCustom({ ...custom, endIso: e.target.value })} />
            </label>
          </div>
          <textarea className="input" aria-label="Event description" rows={4} value={custom.description} onChange={(e) => setCustom({ ...custom, description: e.target.value })} />
          <input className="input mt-2" aria-label="Location" placeholder="Room, link… (optional)" value={custom.location} onChange={(e) => setCustom({ ...custom, location: e.target.value })} />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !custom.title.trim()}
              onClick={() => {
                setBusy(true);
                createCalendarEvent(m.id, custom)
                  .then(() => setCustom(null))
                  .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Adding…' : 'Approve & add'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setCustom(null)}>
              Discard
            </button>
          </div>
        </fieldset>
      ) : (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              const d = extractEventDraft(m.summary?.text ?? '', m.summary?.keyPoints ?? [], m.title, m.startedAt);
              setCustom({ ...d, description: d.description + transcriptNote });
            }}
          >
            + Custom event
          </button>
        </div>
      )}
    </div>
  );
}
