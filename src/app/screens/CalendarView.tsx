import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { CALENDAR_PROVIDERS, type CalendarProvider, type ServerEvent } from '../../integrations/calendar';
import { readCachedMonth, writeCachedMonth } from '../../integrations/calendar-cache';
import { isDesktopApp } from '../../platform/desktop';

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthRange(year: number, month: number): { start: Date; end: Date } {
  return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function CalendarView(): React.JSX.Element {
  const { meetings, go, calendarConfig, switchCalendarProvider, fetchCalendarEvents } = useApp();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [selected, setSelected] = useState<string>(dayKey(now));
  const [serverEvents, setServerEvents] = useState<ServerEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const { start, end } = useMemo(() => monthRange(year, month), [year, month]);
  const monthKey = `${year}-${month}`;

  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let live = false;
    const config = calendarConfig;
    setLoading(true);
    setFetchError(null);
    setCachedAt(null);
    setServerEvents([]);
    // Show the last fetched copy right away; the live fetch replaces it.
    void readCachedMonth(config, start).then((hit) => {
      if (cancelled || live || !hit) return;
      setServerEvents(hit.events);
      setCachedAt(hit.fetchedAt);
    });
    void fetchCalendarEvents(start, end)
      .then((events) => {
        if (cancelled) return;
        live = true;
        setServerEvents(events);
        setCachedAt(null);
        if (isDesktopApp()) void writeCachedMonth(config, start, events);
      })
      .catch(async (e) => {
        if (cancelled) return;
        live = true;
        const hit = await readCachedMonth(config, start);
        if (cancelled) return;
        setServerEvents(hit?.events ?? []);
        setCachedAt(hit?.fetchedAt ?? null);
        setFetchError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthKey, calendarConfig, reload]);

  const localByDay = useMemo(() => {
    const map = new Map<string, typeof meetings>();
    for (const m of meetings) {
      const k = dayKey(new Date(m.startedAt));
      const list = map.get(k) ?? [];
      list.push(m);
      map.set(k, list);
    }
    return map;
  }, [meetings]);

  const serverByDay = useMemo(() => {
    const map = new Map<string, ServerEvent[]>();
    for (const e of serverEvents) {
      const k = e.startIso.slice(0, 10);
      const list = map.get(k) ?? [];
      list.push(e);
      map.set(k, list);
    }
    return map;
  }, [serverEvents]);

  const cells = useMemo(() => {
    // Monday-first grid.
    const first = (start.getDay() + 6) % 7;
    const days = new Date(year, month + 1, 0).getDate();
    const out: Array<{ date: Date; inMonth: boolean }> = [];
    for (let i = first - 1; i >= 0; i--) out.push({ date: new Date(year, month, -i), inMonth: false });
    for (let d = 1; d <= days; d++) out.push({ date: new Date(year, month, d), inMonth: true });
    while (out.length % 7 !== 0) {
      const last = out[out.length - 1].date;
      out.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), inMonth: false });
    }
    return out;
  }, [year, month, start]);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  const switchProvider = (p: CalendarProvider) => {
    void switchCalendarProvider(p).catch(() => undefined);
  };

  const selectedMeetings = localByDay.get(selected) ?? [];
  const selectedEvents = serverByDay.get(selected) ?? [];

  return (
    <div>
      <div className="page-head">
        <h1>Calendar</h1>
        <div className="row">
          <label className="muted" htmlFor="cal-provider">Provider</label>
          <select
            id="cal-provider"
            className="input"
            style={{ width: 'auto' }}
            aria-label="Calendar provider"
            value={calendarConfig.provider}
            onChange={(e) => switchProvider(e.target.value as CalendarProvider)}
          >
            {CALENDAR_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
      </div>

      <section className="card" aria-label="Month calendar">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="row">
            <button className="btn" type="button" onClick={() => shift(-1)} aria-label="Previous month">‹</button>
            <button
              className="btn"
              type="button"
              onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); setSelected(dayKey(now)); }}
            >
              Today
            </button>
            <button className="btn" type="button" onClick={() => shift(1)} aria-label="Next month">›</button>
            <button
              className="btn"
              type="button"
              disabled={loading}
              onClick={() => setReload((n) => n + 1)}
              aria-label="Refresh server events"
            >
              Refresh
            </button>
          </div>
          <strong>{MONTHS[month]} {year}</strong>
        </div>
        {loading && <p className="muted">Loading server events…</p>}
        {fetchError && <p className="warn" role="alert">{fetchError}</p>}
        {cachedAt !== null && (
          <p className="muted small" role="status">
            {fetchError ? 'Offline — showing' : 'Showing'} events saved on this device at{' '}
            {new Date(cachedAt).toLocaleString()}.
          </p>
        )}
        <div className="cal-grid" role="grid" aria-label={`${MONTHS[month]} ${year}`}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
            <div key={d} className="cal-dow">{d}</div>
          ))}
          {cells.map(({ date, inMonth }) => {
            const k = dayKey(date);
            const hasLocal = (localByDay.get(k)?.length ?? 0) > 0;
            const hasServer = (serverByDay.get(k)?.length ?? 0) > 0;
            return (
              <button
                key={k + String(inMonth)}
                type="button"
                role="gridcell"
                aria-selected={selected === k}
                className={`cal-day${inMonth ? '' : ' out'}${selected === k ? ' selected' : ''}${k === dayKey(now) ? ' today' : ''}`}
                onClick={() => setSelected(k)}
              >
                <span className="cal-num">{date.getDate()}</span>
                <span className="cal-dots">
                  {hasLocal && <span className="cal-dot local" title="Recorded meeting" />}
                  {hasServer && <span className="cal-dot server" title="Server event" />}
                </span>
              </button>
            );
          })}
        </div>
        <p className="muted small">
          <span className="cal-dot local" /> recorded meeting
          {' · '}
          <span className="cal-dot server" /> {CALENDAR_PROVIDERS.find((p) => p.id === calendarConfig.provider)?.label} event
        </p>
      </section>

      <section className="card" aria-label="Selected day">
        <div className="model-title"><strong>{selected}</strong></div>
        {selectedMeetings.length === 0 && selectedEvents.length === 0 && (
          <p className="muted">Nothing on this day.</p>
        )}
        {selectedMeetings.length > 0 && (
          <>
            <p className="muted small">Recorded meetings</p>
            <ul className="model-list">
              {selectedMeetings.map((m) => (
                <li key={m.id} className="model-row">
                  <div className="model-main">
                    <span className="model-name">{m.title || 'Untitled meeting'}</span>
                  </div>
                  <div className="model-actions">
                    <button className="btn" type="button" onClick={() => go({ name: 'detail', id: m.id })}>Open</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {selectedEvents.length > 0 && (
          <>
            <p className="muted small">Server events</p>
            <ul className="model-list">
              {selectedEvents.map((e) => (
                <li key={e.id} className="model-row">
                  <div className="model-main">
                    <span className="model-name">{e.title}</span>
                    <span className="muted small">
                      {e.startIso.slice(11) || e.startIso}{e.location ? ` · ${e.location}` : ''}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
