/**
 * iCalendar (RFC 5545) reading for the calendar view: VEVENTs → ServerEvent,
 * with the parts real servers (SOGo, Nextcloud, Zimbra…) rely on:
 * - XML-escaped / CDATA calendar-data (SOGo sends CR as `&#13;`),
 * - TZID / UTC / floating / all-day (VALUE=DATE) times → local wall time,
 * - recurring events (RRULE: DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
 *   COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH, WKST), EXDATE and
 *   RECURRENCE-ID overrides, expanded into the requested window,
 * - STATUS:CANCELLED events/occurrences are skipped.
 * CalDAV time-range queries return a recurring event's *master*, whose
 * DTSTART may be months earlier, so without expansion weekly meetings vanish.
 */
import type { CalendarProvider, ServerEvent } from './calendar';

export interface IcsRange {
  start: Date;
  end: Date;
}

/** Decode calendar-data text taken from an XML response (CDATA or entities). */
export function decodeXmlText(inner: string): string {
  const cdata = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) return cdata[1];
  return inner
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function unfold(text: string): string {
  return text.replace(/\r?\n[ \t]/g, '');
}

interface Prop {
  value: string;
  params: Record<string, string>;
}

/** Every `NAME[;params]:value` line of a component (params may be quoted). */
function props(lines: string[], name: string): Prop[] {
  const out: Prop[] = [];
  const upper = name.toUpperCase();
  for (const line of lines) {
    const head = line.slice(0, upper.length).toUpperCase();
    const next = line[upper.length];
    if (head !== upper || (next !== ':' && next !== ';')) continue;
    let i = upper.length;
    let quoted = false;
    for (; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (c === ':' && !quoted) break;
    }
    const params: Record<string, string> = {};
    for (const p of line.slice(upper.length + 1, i).split(';')) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ value: line.slice(i + 1).trim(), params });
  }
  return out;
}

function prop(lines: string[], name: string): Prop | null {
  return props(lines, name)[0] ?? null;
}

/** TEXT value unescape (`\,` `\;` `\\` `\n`), newlines flattened for display. */
export function icsText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c)).trim();
}

/* ------------------------------ time values ------------------------------ */

/** Calendar wall time (no zone). */
interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

type Zone = { kind: 'utc' } | { kind: 'tz'; tzid: string } | { kind: 'floating' };

interface IcsTime {
  wall: Wall;
  zone: Zone;
  allDay: boolean;
}

function parseTime(p: Prop): IcsTime | null {
  const m = p.value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return null;
  const wall = { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
  const allDay = !m[4] || p.params.VALUE === 'DATE';
  const zone: Zone = m[7]
    ? { kind: 'utc' }
    : p.params.TZID && !allDay
      ? { kind: 'tz', tzid: p.params.TZID }
      : { kind: 'floating' };
  return { wall, zone, allDay };
}

/** Wall time as a pure calendar number (for ordering / arithmetic only). */
function wallMs(w: Wall): number {
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

function wallFromMs(ms: number): Wall {
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

function addDays(w: Wall, n: number): Wall {
  return wallFromMs(Date.UTC(w.y, w.mo - 1, w.d + n, w.h, w.mi, w.s));
}

function weekday(w: Wall): number {
  return new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tzid: string): Intl.DateTimeFormat | null {
  if (!formatters.has(tzid)) {
    try {
      formatters.set(tzid, new Intl.DateTimeFormat('en-US', {
        timeZone: tzid, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }));
    } catch {
      formatters.set(tzid, null); // unknown / Windows-style TZID → treat as floating
    }
  }
  return formatters.get(tzid) ?? null;
}

/** Offset (ms) of `tzid` from UTC at instant `utcMs`. */
function tzOffset(fmt: Intl.DateTimeFormat, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = +p.value;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}

/** Wall time in `zone` → instant (ms since epoch). */
function toInstant(w: Wall, zone: Zone): number {
  if (zone.kind === 'utc') return wallMs(w);
  if (zone.kind === 'tz') {
    const fmt = formatterFor(zone.tzid);
    if (fmt) {
      const guess = wallMs(w);
      const first = guess - tzOffset(fmt, guess);
      return guess - tzOffset(fmt, first);
    }
  }
  return new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).getTime();
}

function localIso(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dateIso(w: Wall): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${p(w.mo)}-${p(w.d)}`;
}

/** ISO 8601 duration (`P1D`, `PT1H30M`, `-PT15M`) → ms. */
export function parseDuration(value: string): number {
  const m = value.trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  const ms = ((+(m[2] ?? 0) * 7 + +(m[3] ?? 0)) * 86400 + +(m[4] ?? 0) * 3600 + +(m[5] ?? 0) * 60 + +(m[6] ?? 0)) * 1000;
  return m[1] === '-' ? -ms : ms;
}

/* ------------------------------ recurrence ------------------------------ */

const WEEKDAYS: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  until: number | null;
  byday: Array<{ n: number; wd: number }>;
  bymonthday: number[];
  bymonth: number[];
  wkst: number;
}

export function parseRule(value: string, zone: Zone): Rule | null {
  const parts: Record<string, string> = {};
  for (const kv of value.split(';')) {
    const eq = kv.indexOf('=');
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).toUpperCase();
  }
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null;
  let until: number | null = null;
  if (parts.UNTIL) {
    const t = parseTime({ value: parts.UNTIL, params: {} });
    if (t) until = t.allDay ? toInstant({ ...t.wall, h: 23, mi: 59, s: 59 }, zone) : toInstant(t.wall, t.zone.kind === 'utc' ? t.zone : zone);
  }
  const byday = (parts.BYDAY ?? '').split(',').filter(Boolean).flatMap((s) => {
    const m = s.match(/^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/);
    return m ? [{ n: m[1] ? +m[1] : 0, wd: WEEKDAYS[m[2]] }] : [];
  });
  const nums = (s?: string) => (s ?? '').split(',').filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n !== 0);
  return {
    freq,
    interval: Math.max(1, +(parts.INTERVAL ?? 1) || 1),
    count: parts.COUNT ? Math.max(0, +parts.COUNT) : null,
    until,
    byday,
    bymonthday: nums(parts.BYMONTHDAY),
    bymonth: nums(parts.BYMONTH),
    wkst: WEEKDAYS[parts.WKST ?? 'MO'] ?? 1,
  };
}

/** Days of month (y, mo) matching BYDAY (`2TU`, `-1FR`, `MO`). */
function monthDaysByDay(y: number, mo: number, byday: Rule['byday']): number[] {
  const len = daysInMonth(y, mo);
  const out: number[] = [];
  for (const { n, wd } of byday) {
    const matches: number[] = [];
    for (let d = 1; d <= len; d++) if (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() === wd) matches.push(d);
    if (n === 0) out.push(...matches);
    else {
      const pick = n > 0 ? matches[n - 1] : matches[matches.length + n];
      if (pick) out.push(pick);
    }
  }
  return out;
}

function monthDays(y: number, mo: number, rule: Rule, w0: Wall): number[] {
  const len = daysInMonth(y, mo);
  let days: number[];
  if (rule.bymonthday.length) days = rule.bymonthday.map((d) => (d > 0 ? d : len + d + 1));
  else if (rule.byday.length) days = monthDaysByDay(y, mo, rule.byday);
  else days = [w0.d];
  if (rule.bymonthday.length && rule.byday.length) {
    const allowed = new Set(rule.byday.map((b) => b.wd));
    days = days.filter((d) => allowed.has(new Date(Date.UTC(y, mo - 1, d)).getUTCDay()));
  }
  return [...new Set(days)].filter((d) => d >= 1 && d <= len).sort((a, b) => a - b);
}

/** Candidate occurrence starts (wall time, ascending, starting at DTSTART). */
function* occurrences(w0: Wall, rule: Rule): Generator<Wall> {
  const at = (y: number, mo: number, d: number): Wall => ({ y, mo, d, h: w0.h, mi: w0.mi, s: w0.s });
  const start = wallMs(w0);
  yield w0; // DTSTART is always the first instance
  for (let k = 0; k < 100_000; k++) {
    let batch: Wall[] = [];
    if (rule.freq === 'DAILY') {
      batch = [addDays(w0, k * rule.interval)];
      if (rule.byday.length) batch = batch.filter((w) => rule.byday.some((b) => b.wd === weekday(w)));
      if (rule.bymonth.length) batch = batch.filter((w) => rule.bymonth.includes(w.mo));
    } else if (rule.freq === 'WEEKLY') {
      const weekStart = addDays(w0, -((weekday(w0) - rule.wkst + 7) % 7) + 7 * k * rule.interval);
      const wds = rule.byday.length ? rule.byday.map((b) => b.wd) : [weekday(w0)];
      batch = [...new Set(wds)]
        .map((wd) => (wd - rule.wkst + 7) % 7)
        .sort((a, b) => a - b)
        .map((off) => addDays(weekStart, off));
    } else if (rule.freq === 'MONTHLY') {
      const idx = w0.mo - 1 + k * rule.interval;
      const y = w0.y + Math.floor(idx / 12);
      const mo = (idx % 12) + 1;
      if (!rule.bymonth.length || rule.bymonth.includes(mo)) batch = monthDays(y, mo, rule, w0).map((d) => at(y, mo, d));
    } else {
      const y = w0.y + k * rule.interval;
      const months = rule.bymonth.length ? [...rule.bymonth].sort((a, b) => a - b) : [w0.mo];
      for (const mo of months) {
        const days = rule.byday.length || rule.bymonthday.length ? monthDays(y, mo, rule, w0) : [w0.d];
        batch.push(...days.filter((d) => d <= daysInMonth(y, mo)).map((d) => at(y, mo, d)));
      }
    }
    for (const w of batch) if (wallMs(w) > start) yield w;
  }
}

/* ------------------------------- parsing -------------------------------- */

interface VEvent {
  lines: string[];
  uid: string;
  start: IcsTime;
  durationMs: number;
  recurrenceId: number | null;
  cancelled: boolean;
}

function readEvent(body: string): VEvent | null {
  const lines = unfold(body.replace(/BEGIN:VALARM[\s\S]*?END:VALARM/gi, '')).split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
  const dtstart = prop(lines, 'DTSTART');
  const start = dtstart ? parseTime(dtstart) : null;
  if (!start) return null;
  const startMs = toInstant(start.wall, start.zone);
  const dtend = prop(lines, 'DTEND');
  const end = dtend ? parseTime(dtend) : null;
  const duration = prop(lines, 'DURATION');
  const durationMs = end
    ? Math.max(0, toInstant(end.wall, end.zone) - startMs)
    : duration
      ? parseDuration(duration.value)
      : start.allDay ? 86_400_000 : 0;
  const rid = prop(lines, 'RECURRENCE-ID');
  const ridTime = rid ? parseTime(rid) : null;
  return {
    lines,
    uid: prop(lines, 'UID')?.value ?? '',
    start,
    durationMs,
    recurrenceId: ridTime ? toInstant(ridTime.wall, ridTime.zone) : null,
    cancelled: (prop(lines, 'STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  };
}

/** `wall` = the occurrence's wall time (all-day dates come from it, not from the instant). */
function toServerEvent(ev: VEvent, provider: CalendarProvider, startMs: number, wall: Wall, occurrence: boolean): ServerEvent {
  const title = icsText(prop(ev.lines, 'SUMMARY')?.value ?? '') || '(no title)';
  const location = icsText(prop(ev.lines, 'LOCATION')?.value ?? '');
  const base = ev.uid || `${startMs}`;
  if (ev.start.allDay) {
    const day = dateIso(wall);
    return {
      id: `${provider}:${base}${occurrence ? `:${day}` : ''}`,
      title, location, provider, allDay: true,
      startIso: `${day}T09:00`,
      endIso: `${day}T09:00`,
    };
  }
  return {
    id: `${provider}:${base}${occurrence ? `:${startMs}` : ''}`,
    title, location, provider,
    startIso: localIso(startMs),
    endIso: localIso(startMs + ev.durationMs),
  };
}

function overlaps(startMs: number, durationMs: number, range: IcsRange): boolean {
  const s = range.start.getTime();
  const e = range.end.getTime();
  return durationMs > 0 ? startMs < e && startMs + durationMs > s : startMs >= s && startMs < e;
}

/**
 * All events of an .ics payload. With `range`, recurring events are expanded
 * into the occurrences overlapping it (and everything is filtered to it);
 * without, each VEVENT is returned once at its DTSTART.
 */
export function parseIcs(ics: string, provider: CalendarProvider, range?: IcsRange): ServerEvent[] {
  const events = ics
    .split(/BEGIN:VEVENT/i)
    .slice(1)
    .map((block) => readEvent(block.split(/END:VEVENT/i)[0]))
    .filter((e): e is VEvent => e !== null);
  const overridden = new Set(
    events.filter((e) => e.recurrenceId !== null).map((e) => `${e.uid}|${e.recurrenceId}`),
  );
  const out: ServerEvent[] = [];
  for (const ev of events) {
    if (ev.cancelled) continue;
    const startMs = toInstant(ev.start.wall, ev.start.zone);
    const rrule = ev.recurrenceId === null ? prop(ev.lines, 'RRULE') : null;
    const rule = rrule && range ? parseRule(rrule.value, ev.start.zone) : null;
    if (!rule || !range) {
      if (!range || overlaps(startMs, ev.durationMs, range)) out.push(toServerEvent(ev, provider, startMs, ev.start.wall, false));
      continue;
    }
    const exdates = new Set<number>();
    for (const ex of props(ev.lines, 'EXDATE')) {
      for (const v of ex.value.split(',')) {
        const t = parseTime({ value: v.trim(), params: ex.params });
        if (t) exdates.add(t.allDay ? toInstant({ ...t.wall, h: ev.start.wall.h, mi: ev.start.wall.mi, s: ev.start.wall.s }, ev.start.zone) : toInstant(t.wall, t.zone));
      }
    }
    const rangeEnd = range.end.getTime();
    let n = 0;
    for (const w of occurrences(ev.start.wall, rule)) {
      const occ = toInstant(w, ev.start.zone);
      if (rule.until !== null && occ > rule.until) break;
      if (rule.count !== null && n >= rule.count) break;
      n++;
      if (occ >= rangeEnd) break;
      if (exdates.has(occ) || overridden.has(`${ev.uid}|${occ}`)) continue;
      if (overlaps(occ, ev.durationMs, range)) out.push(toServerEvent(ev, provider, occ, w, true));
    }
  }
  return out;
}
