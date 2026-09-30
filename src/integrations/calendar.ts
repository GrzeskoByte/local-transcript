/**
 * Calendar integration: create events on a company calendar server from a
 * meeting summary. Three providers, one UI. Transport (curl) lives in Rust
 * (`src-tauri/src/calendar.rs`); everything here is pure and unit-tested.
 *
 * - CalDAV: PUT an .ics file to the user's calendar collection.
 * - Graph (Exchange Online): POST JSON to /me/events with a bearer token.
 * - EWS (on-prem Exchange): POST a CreateItem SOAP envelope (basic/NTLM).
 */

import { decodeXmlText, parseIcs, type IcsRange } from './ics';

export type CalendarProvider = 'caldav' | 'graph' | 'ews';

export const CALENDAR_PROVIDER_LABELS: Record<CalendarProvider, string> = {
  caldav: 'CalDAV (Zimbra, Nextcloud, Kerio…)',
  graph: 'Exchange Online (Microsoft Graph)',
  ews: 'On-prem Exchange (EWS)',
};

/** Short labels for pickers. */
export const CALENDAR_PROVIDERS: Array<{ id: CalendarProvider; label: string }> = [
  { id: 'caldav', label: 'CalDAV' },
  { id: 'graph', label: 'Graph' },
  { id: 'ews', label: 'EWS' },
];

export interface CalendarConfig {
  provider: CalendarProvider;
  /** Host + optional path, with or without scheme, e.g. `cal.company.example/dav/` or a full URL. */
  serverUrl: string;
  /** Scheme used when serverUrl has none. */
  protocol: 'http' | 'https';
  /** Port used when serverUrl has no scheme (blank = protocol default). */
  port: string;
  username: string;
  /** CalDAV/EWS password (or app password). */
  password: string;
  /** Graph bearer token (access token from Azure app registration). */
  token: string;
  /** CalDAV only: calendar collection URL when it differs from serverUrl. */
  calendarUrl: string;
  /** EWS only: use NTLM instead of basic auth. */
  useNtlm: boolean;
}

export const DEFAULT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export const DEFAULT_CALENDAR_CONFIG: CalendarConfig = {
  provider: 'caldav',
  serverUrl: '',
  protocol: 'https',
  port: '',
  username: '',
  password: '',
  token: '',
  calendarUrl: '',
  useNtlm: true,
};

/** User-confirmed event before it is sent to the server. ISO local datetimes. */
export interface CalendarEventDraft {
  title: string;
  startIso: string;
  endIso: string;
  description: string;
  location: string;
}

export interface CalendarCreateResult {
  provider: CalendarProvider;
}

/**
 * Compose a full URL from a host/path field: a value that already contains a
 * scheme is used as-is (backward compatible); otherwise
 * `protocol://host[:port][/path]`. Returns '' when the field is blank.
 */
export function composeUrl(raw: string, protocol: 'http' | 'https', port: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  const slash = value.indexOf('/');
  const host = (slash < 0 ? value : value.slice(0, slash)).trim().replace(/:+$/, '');
  const rest = slash < 0 ? '' : value.slice(slash);
  if (!host) return '';
  const p = port.trim();
  return `${protocol}://${host}${p ? `:${p}` : ''}${rest}`;
}

/** Effective server URL honoring the protocol/port fields. */
export function effectiveServerUrl(config: CalendarConfig): string {
  return (
    composeUrl(config.calendarUrl, config.protocol, config.port) ||
    composeUrl(config.serverUrl, config.protocol, config.port)
  ).replace(/\/+$/, '');
}

/** Which fields Settings must require per provider. */
export function validateCalendarConfig(config: CalendarConfig): string | null {
  if (config.port.trim() && !/^\d{1,5}$/.test(config.port.trim())) {
    return 'Port must be a number (1–65535).';
  }
  const url = effectiveServerUrl(config);
  if (!url) {
    if (config.provider === 'ews') return 'Exchange.asmx host is required for EWS.';
    if (config.provider !== 'graph') return 'Server address is required.';
  }
  if (url && !/^https?:\/\//i.test(url)) return 'Server address must be a valid host or http(s):// URL.';
  if (config.provider === 'caldav') {
    if (!config.username.trim()) return 'Username is required for CalDAV.';
    if (!config.password) return 'Password is required for CalDAV.';
  }
  if (config.provider === 'graph' && !config.token) {
    return 'Access token is required for Microsoft Graph.';
  }
  if (config.provider === 'ews') {
    if (!config.serverUrl.trim()) return 'Exchange.asmx URL is required for EWS.';
    if (!config.username.trim() || !config.password) {
      return 'Username and password are required for EWS.';
    }
  }
  return null;
}

/** `2026-09-28T09:00` from a Date (local time, no timezone suffix). */
export function toLocalIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Parse `2026-09-28T09:00` / `2026-09-28` back to a Date. */
export function fromLocalIso(iso: string): Date {
  return new Date(iso.length === 10 ? `${iso}T09:00` : iso);
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

/** First explicit date found in free text, else null. */
export function findDateInText(text: string, relativeTo: Date): Date | null {
  let m = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 9, 0);
  m = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], 9, 0);
  m = text.match(/(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (m) return new Date(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 9, 0);
  if (/\btomorrow\b/i.test(text)) {
    const d = new Date(relativeTo);
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d;
  }
  return null;
}

/**
 * Prefill an event draft: title from the summary's first heading/line,
 * day from the first explicit date in the summary (else the meeting day),
 * 1-hour slot at 09:00, description = title + key points.
 */
export function extractEventDraft(
  summaryText: string,
  keyPoints: string[],
  meetingTitle: string,
  meetingStartedAt: number,
): CalendarEventDraft {
  const lines = summaryText.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean);
  const title = lines[0]?.slice(0, 120) || meetingTitle || 'Follow-up meeting';
  const base = new Date(meetingStartedAt);
  const day = findDateInText(summaryText, base) ?? new Date(base);
  day.setHours(9, 0, 0, 0);
  const end = new Date(day.getTime() + 60 * 60 * 1000);
  const description = [title, ...keyPoints.map((k) => `• ${k}`)].join('\n');
  return { title, startIso: toLocalIso(day), endIso: toLocalIso(end), description, location: '' };
}

function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function icsFold(line: string): string {
  if (line.length <= 75) return line;
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`);
  return parts.join('\r\n');
}

/** Full .ics file for a CalDAV PUT. */
export function buildIcsEvent(draft: CalendarEventDraft, uid: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const dt = (iso: string) => iso.replace(/[-:]/g, '') + '00';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//local-transcribe//calendar//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${dt(draft.startIso)}`,
    `DTEND:${dt(draft.endIso)}`,
    `SUMMARY:${icsEscape(draft.title)}`,
    `DESCRIPTION:${icsEscape(draft.description)}`,
    ...(draft.location ? [`LOCATION:${icsEscape(draft.location)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n');
}

/** JSON body for POST /me/events (Microsoft Graph). */
export function buildGraphEvent(draft: CalendarEventDraft): string {
  return JSON.stringify({
    subject: draft.title,
    body: { contentType: 'text', content: draft.description },
    start: { dateTime: draft.startIso, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: draft.endIso, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    ...(draft.location ? { location: { displayName: draft.location } } : {}),
  });
}

/** SOAP envelope for EWS CreateItem (CalendarItem, no attendees). */
export function buildEwsCreateItem(draft: CalendarEventDraft): string {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ` +
    `xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">` +
    `<soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>` +
    `<soap:Body><m:CreateItem SendMeetingInvitations="SendToNone">` +
    `<m:SavedItemFolderId><t:DistinguishedFolderId Id="calendar"/></m:SavedItemFolderId>` +
    `<m:Items><t:CalendarItem>` +
    `<t:Subject>${esc(draft.title)}</t:Subject>` +
    `<t:Body BodyType="Text">${esc(draft.description)}</t:Body>` +
    `<t:Start>${esc(draft.startIso)}:00</t:Start>` +
    `<t:End>${esc(draft.endIso)}:00</t:End>` +
    (draft.location ? `<t:Location>${esc(draft.location)}</t:Location>` : '') +
    `</t:CalendarItem></m:Items></m:CreateItem></soap:Body></soap:Envelope>`;
}

/** Transport payload the Rust `native_calendar_create` command sends. */
export interface CalendarTransport {
  provider: CalendarProvider;
  endpoint: string;
  method: 'PUT' | 'POST' | 'PROPFIND' | 'GET' | 'REPORT';
  contentType: string;
  body: string;
  username: string;
  password: string;
  token: string;
  useNtlm: boolean;
  headers: string[];
}

/** NTLM applies to on-prem Exchange (EWS) only; CalDAV/Graph use Basic/Bearer. */
function ntlmFor(config: CalendarConfig): boolean {
  return config.provider === 'ews' && config.useNtlm;
}

function authOf(config: CalendarConfig): Pick<CalendarTransport, 'username' | 'password' | 'token' | 'useNtlm'> {
  return {
    username: config.username,
    password: config.password,
    token: config.token,
    useNtlm: ntlmFor(config),
  };
}

export function buildTransport(
  config: CalendarConfig,
  draft: CalendarEventDraft,
  uid: string,
): CalendarTransport {
  if (config.provider === 'caldav') {
    const base = effectiveServerUrl(config).replace(/\/+$/, '');
    return {
      provider: 'caldav',
      endpoint: `${base}/${uid}.ics`,
      method: 'PUT',
      contentType: 'text/calendar; charset=utf-8',
      body: buildIcsEvent(draft, uid),
      headers: [],
      ...authOf(config),
    };
  }
  if (config.provider === 'graph') {
    const raw = effectiveServerUrl(config);
    const base = (raw || DEFAULT_GRAPH_BASE).replace(/\/+$/, '');
    return {
      provider: 'graph',
      endpoint: `${base}/me/events`,
      method: 'POST',
      contentType: 'application/json',
      body: buildGraphEvent(draft),
      headers: [],
      ...authOf(config),
    };
  }
  return {
    provider: 'ews',
    endpoint: effectiveServerUrl(config),
    method: 'POST',
    contentType: 'text/xml; charset=utf-8',
    body: buildEwsCreateItem(draft),
    headers: ['SOAPAction: "http://schemas.microsoft.com/exchange/services/2006/messages/CreateItem"'],
    ...authOf(config),
  };
}

/** Probe payload for `native_calendar_test` (creates nothing). */
export interface CalendarTestTransport {
  provider: CalendarProvider;
  endpoint: string;
  username: string;
  password: string;
  token: string;
  useNtlm: boolean;
}

export function buildTestTransport(config: CalendarConfig): CalendarTestTransport {
  const auth = authOf(config);
  if (config.provider === 'graph') {
    const raw = effectiveServerUrl(config);
    const base = (raw || DEFAULT_GRAPH_BASE).replace(/\/+$/, '');
    return { provider: 'graph', endpoint: base, ...auth };
  }
  if (config.provider === 'ews') {
    return { provider: 'ews', endpoint: effectiveServerUrl(config), ...auth };
  }
  return { provider: 'caldav', endpoint: effectiveServerUrl(config), ...auth };
}

/** Event UID, unique per created event (a meeting can have several). */
export function eventUid(meetingId: string, createdAt: number = Date.now()): string {
  return `${meetingId}-${createdAt.toString(36)}@local-transcribe`;
}

/**
 * SOGo CalDAV collection URL from a host (or any URL on it) + login, e.g.
 * `mail.host.com` + `me@host.com` → `mail.host.com/SOGo/dav/me@host.com/Calendar/personal/`.
 * A scheme/port in `host` is kept; any path is replaced.
 */
export function sogoCalendarUrl(host: string, username: string, calendar = 'personal'): string {
  const h = host.trim();
  const user = username.trim();
  if (!h || !user) return '';
  const scheme = h.match(/^[a-z][a-z0-9+.-]*:\/\//i)?.[0] ?? '';
  const rest = h.slice(scheme.length);
  const authority = rest.split('/')[0];
  if (!authority) return '';
  const seg = (v: string) => encodeURIComponent(v).replace(/%40/g, '@');
  return `${scheme}${authority}/SOGo/dav/${seg(user)}/Calendar/${seg(calendar.trim() || 'personal')}/`;
}

/** Probe the configured server (creates nothing). Desktop only. */
export async function testCalendarConnection(config: CalendarConfig): Promise<string> {
  const err = validateCalendarConfig(config);
  if (err) throw new Error(err);
  const { invokeDesktop } = await import('../platform/desktop');
  return invokeDesktop<string>('native_calendar_test', { request: buildTestTransport(config) });
}

/* ------------------------------- fetching ------------------------------- */

/** One event shown in the in-app calendar view. Local ISO datetimes. */
export interface ServerEvent {
  id: string;
  title: string;
  startIso: string;
  endIso: string;
  location: string;
  provider: CalendarProvider;
  /** All-day event (start/end carry the date; time is a placeholder). */
  allDay?: boolean;
}

/** `Date` → UTC `20261005T090000Z` for CalDAV time-range filters. */
export function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/** `20261005T090000[Z]` / `20261005` → local `YYYY-MM-DDTHH:MM`. */
export function icsDateToLocalIso(value: string): string {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!m) return v;
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}T09:00`;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? '0')));
  // Zulu → local wall time; floating times are already local.
  return m[7] ? toLocalIso(d) : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/**
 * All VEVENTs of an .ics / calendar-data payload (see `ics.ts`). With a
 * range, recurring events are expanded into the occurrences inside it.
 */
export function parseIcsEvents(ics: string, provider: CalendarProvider, range?: IcsRange): ServerEvent[] {
  return parseIcs(ics, provider, range);
}

/** CalDAV multistatus REPORT response → events (one resource per calendar-data). */
export function parseCaldavReport(xml: string, range?: IcsRange): ServerEvent[] {
  const out: ServerEvent[] = [];
  const bodies = xml.match(/<(?:[\w-]+:)?calendar-data\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/gi) ?? [];
  for (const b of bodies) {
    const inner = b.replace(/^<(?:[\w-]+:)?calendar-data\b[^>]*>/i, '').replace(/<\/(?:[\w-]+:)?calendar-data>$/i, '');
    out.push(...parseIcs(decodeXmlText(inner), 'caldav', range));
  }
  return out;
}

/** Graph `{"value":[{subject,start:{dateTime},…}]}` → events. */
export function parseGraphEvents(payload: string): ServerEvent[] {
  let json: { value?: Array<{ id?: string; subject?: string; start?: { dateTime?: string }; end?: { dateTime?: string }; location?: { displayName?: string } }> };
  try {
    json = JSON.parse(payload);
  } catch {
    return [];
  }
  return (json.value ?? []).map((e, i) => ({
    id: `graph:${e.id ?? i}`,
    title: e.subject || '(no title)',
    startIso: (e.start?.dateTime ?? '').slice(0, 16),
    endIso: (e.end?.dateTime ?? e.start?.dateTime ?? '').slice(0, 16),
    location: e.location?.displayName ?? '',
    provider: 'graph' as CalendarProvider,
  })).filter((e) => e.startIso);
}

/** EWS FindItem response → events (Subject + Start/End/Location/ItemId). */
export function parseEwsFindItem(xml: string): ServerEvent[] {
  const out: ServerEvent[] = [];
  const items = xml.match(/<t:CalendarItem>[\s\S]*?<\/t:CalendarItem>/g) ?? [];
  for (const item of items) {
    const tag = (name: string): string => {
      const m = item.match(new RegExp(`<t:${name}>([\\s\\S]*?)<\\/t:${name}>`));
      return m ? m[1].trim() : '';
    };
    const start = tag('Start') || tag('DateTimeCreated');
    if (!start) continue;
    const idm = item.match(/<t:ItemId Id="([^"]+)"/);
    out.push({
      id: `ews:${idm ? idm[1] : out.length}`,
      title: tag('Subject') || '(no title)',
      startIso: start.replace(/:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, '').slice(0, 16),
      endIso: (tag('End') || start).replace(/:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/, '').slice(0, 16),
      location: tag('Location'),
      provider: 'ews',
    });
  }
  return out;
}

/** Dispatch raw server output to the right parser. */
export function parseFetchResponse(provider: CalendarProvider, payload: string, range?: IcsRange): ServerEvent[] {
  if (provider === 'graph') return parseGraphEvents(payload);
  if (provider === 'ews') return parseEwsFindItem(payload);
  return parseCaldavReport(payload, range);
}

/** REPORT body: all VEVENTs overlapping [start, end). */
export function buildCaldavReport(start: Date, end: Date): string {
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">` +
    `<d:prop><d:getetag/><c:calendar-data/></d:prop>` +
    `<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">` +
    `<c:time-range start="${toIcsUtc(start)}" end="${toIcsUtc(end)}"/>` +
    `</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
}

/** EWS FindItem with a CalendarView window. */
export function buildEwsFindItem(start: Date, end: Date): string {
  const fmt = (d: Date) => d.toISOString().split('.')[0];
  return `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ` +
    `xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">` +
    `<soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>` +
    `<soap:Body><m:FindItem Traversal="Shallow">` +
    `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>` +
    `<t:AdditionalProperties><t:FieldURI FieldURI="item:Subject"/>` +
    `<t:FieldURI FieldURI="calendar:Start"/><t:FieldURI FieldURI="calendar:End"/>` +
    `<t:FieldURI FieldURI="calendar:Location"/></t:AdditionalProperties></m:ItemShape>` +
    `<m:CalendarView StartDate="${fmt(start)}" EndDate="${fmt(end)}"/>` +
    `<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>` +
    `</m:FindItem></soap:Body></soap:Envelope>`;
}

/** Transport for `native_calendar_fetch`: list events in [start, end). */
export function buildFetchTransport(
  config: CalendarConfig,
  start: Date,
  end: Date,
): CalendarTransport {
  const auth = authOf(config);
  if (config.provider === 'graph') {
    const raw = effectiveServerUrl(config);
    const base = (raw || DEFAULT_GRAPH_BASE).replace(/\/+$/, '');
    const q = `startDateTime=${encodeURIComponent(start.toISOString())}` +
      `&endDateTime=${encodeURIComponent(end.toISOString())}&$top=100&$orderby=start/dateTime`;
    return {
      provider: 'graph', endpoint: `${base}/me/calendarview?${q}`,
      method: 'GET', contentType: 'application/json', body: '', headers: [], ...auth,
    };
  }
  if (config.provider === 'ews') {
    return {
      provider: 'ews', endpoint: effectiveServerUrl(config),
      method: 'POST', contentType: 'text/xml; charset=utf-8',
      body: buildEwsFindItem(start, end),
      headers: ['SOAPAction: "http://schemas.microsoft.com/exchange/services/2006/messages/FindItem"'],
      ...auth,
    };
  }
  return {
    provider: 'caldav', endpoint: effectiveServerUrl(config),
    method: 'REPORT', contentType: 'text/xml; charset=utf-8',
    body: buildCaldavReport(start, end), headers: ['Depth: 1'], ...auth,
  };
}

/** Fetch + parse server events in [start, end). Desktop only. */
export async function fetchServerEvents(
  config: CalendarConfig,
  start: Date,
  end: Date,
): Promise<ServerEvent[]> {
  const err = validateCalendarConfig(config);
  if (err) throw new Error(err);
  const { invokeDesktop } = await import('../platform/desktop');
  const raw = await invokeDesktop<string>('native_calendar_fetch', {
    request: buildFetchTransport(config, start, end),
  });
  return parseFetchResponse(config.provider, raw, { start, end });
}
