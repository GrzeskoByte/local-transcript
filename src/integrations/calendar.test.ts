import { describe, expect, it } from 'vitest';
import {
  buildCaldavReport,
  buildEwsCreateItem,
  buildEwsFindItem,
  buildFetchTransport,
  buildGraphEvent,
  buildIcsEvent,
  buildTestTransport,
  buildTransport,
  composeUrl,
  DEFAULT_CALENDAR_CONFIG,
  eventUid,
  extractEventDraft,
  findDateInText,
  fromLocalIso,
  icsDateToLocalIso,
  parseCaldavReport,
  parseEwsFindItem,
  parseGraphEvents,
  sogoCalendarUrl,
  parseIcsEvents,
  toIcsUtc,
  toLocalIso,
  validateCalendarConfig,
  type CalendarConfig,
} from './calendar';

describe('validateCalendarConfig', () => {
  it('requires a server URL except for Graph with default base', () => {
    expect(validateCalendarConfig(DEFAULT_CALENDAR_CONFIG)).toBe('Server address is required.');
  });
  it('rejects non-http URLs', () => {
    const c: CalendarConfig = { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'ftp://x', username: 'u', password: 'p' };
    expect(validateCalendarConfig(c)).toMatch(/http/);
  });
  it('requires CalDAV credentials', () => {
    const c: CalendarConfig = { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'https://cal.example/dav/', password: 'p' };
    expect(validateCalendarConfig(c)).toMatch(/Username/);
  });
  it('accepts a complete CalDAV config', () => {
    const c: CalendarConfig = { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'https://cal.example/dav/', username: 'u', password: 'p' };
    expect(validateCalendarConfig(c)).toBeNull();
  });
  it('requires a Graph token', () => {
    expect(validateCalendarConfig({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph' })).toMatch(/token/);
  });
  it('requires EWS url + credentials', () => {
    const c: CalendarConfig = { ...DEFAULT_CALENDAR_CONFIG, provider: 'ews', username: 'u', password: 'p' };
    expect(validateCalendarConfig(c)).toMatch(/Exchange\.asmx/);
  });
});

describe('findDateInText', () => {
  const rel = new Date(2026, 8, 27, 12, 0); // Sep 27 2026
  it('parses ISO dates', () => {
    expect(findDateInText('due 2026-10-05 please', rel)?.getDate()).toBe(5);
  });
  it('parses dotted dates', () => {
    expect(findDateInText('am 05.10.2026', rel)?.getMonth()).toBe(9);
  });
  it('parses month names', () => {
    expect(findDateInText('on 5 October 2026', rel)?.getMonth()).toBe(9);
  });
  it('resolves tomorrow relative to the meeting', () => {
    expect(findDateInText('follow up tomorrow', rel)?.getDate()).toBe(28);
  });
  it('returns null when no date', () => {
    expect(findDateInText('no dates here', rel)).toBeNull();
  });
});

describe('extractEventDraft', () => {
  it('uses the summary heading and meeting day by default', () => {
    const d = extractEventDraft('# Sprint review\nSome notes', [], 'Weekly', new Date(2026, 8, 27, 15, 30).getTime());
    expect(d.title).toBe('Sprint review');
    expect(d.startIso).toBe('2026-09-27T09:00');
    expect(d.endIso).toBe('2026-09-27T10:00');
  });
  it('prefers an explicit date from the summary', () => {
    const d = extractEventDraft('Retrospective\nNext session 2026-10-05', [], 'Weekly', new Date(2026, 8, 27).getTime());
    expect(d.startIso).toBe('2026-10-05T09:00');
  });
  it('falls back to the meeting title', () => {
    const d = extractEventDraft('', [], 'Weekly sync', new Date(2026, 8, 27).getTime());
    expect(d.title).toBe('Weekly sync');
  });
});

describe('builders', () => {
  const draft = {
    title: 'Sprint review',
    startIso: '2026-10-05T09:00',
    endIso: '2026-10-05T10:00',
    description: '• Ship it',
    location: 'Room 3',
  };
  it('builds a folded .ics event', () => {
    const ics = buildIcsEvent(draft, 'uid-1@local-transcribe');
    expect(ics).toContain('BEGIN:VEVENT');
    expect(ics).toContain('UID:uid-1@local-transcribe');
    expect(ics).toContain('DTSTART:20261005T090000');
    expect(ics).toContain('SUMMARY:Sprint review');
    expect(ics).toContain('LOCATION:Room 3');
  });
  it('builds a Graph event', () => {
    const g = JSON.parse(buildGraphEvent(draft));
    expect(g.subject).toBe('Sprint review');
    expect(g.start.dateTime).toBe('2026-10-05T09:00');
  });
  it('builds an EWS envelope and escapes XML', () => {
    const xml = buildEwsCreateItem({ ...draft, title: 'A & <B>' });
    expect(xml).toContain('<m:CreateItem');
    expect(xml).toContain('A &amp; &lt;B&gt;');
  });
  it('buildTransport targets per provider', () => {
    const caldav = buildTransport(
      { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'https://cal.example/dav/', username: 'u', password: 'p' },
      draft, 'uid-9',
    );
    expect(caldav.method).toBe('PUT');
    expect(caldav.endpoint).toBe('https://cal.example/dav/uid-9.ics');
    expect(caldav.username).toBe('u');
    const graph = buildTransport({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph', token: 't' }, draft, 'u');
    expect(graph.endpoint).toBe('https://graph.microsoft.com/v1.0/me/events');
    expect(graph.token).toBe('t');
    const ews = buildTransport(
      { ...DEFAULT_CALENDAR_CONFIG, provider: 'ews', serverUrl: 'https://mail.example/EWS/Exchange.asmx', username: 'u', password: 'p' },
      draft, 'u',
    );
    expect(ews.contentType).toMatch(/text\/xml/);
    expect(ews.useNtlm).toBe(true);
    expect(ews.headers[0]).toMatch(/CreateItem/);
  });
  it('buildTestTransport picks probe endpoints', () => {
    expect(
      buildTestTransport({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph', token: 't' }).endpoint,
    ).toBe('https://graph.microsoft.com/v1.0');
    expect(
      buildTestTransport({ ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'https://cal.example/dav/', username: 'u', password: 'p' }).endpoint,
    ).toBe('https://cal.example/dav');
    expect(eventUid('abc123', 36)).toBe('abc123-10@local-transcribe');
    expect(eventUid('abc123', 1)).not.toBe(eventUid('abc123', 2));
  });
});

describe('iso helpers', () => {
  it('round-trips local datetimes', () => {
    expect(fromLocalIso(toLocalIso(new Date(2026, 8, 27, 9, 5)))).toEqual(new Date(2026, 8, 27, 9, 5));
  });
  it('converts floating and date-only ics values', () => {
    expect(icsDateToLocalIso('20261005T090000')).toBe('2026-10-05T09:00');
    expect(icsDateToLocalIso('20261005')).toBe('2026-10-05T09:00');
  });
  it('formats UTC range bounds', () => {
    expect(toIcsUtc(new Date(Date.UTC(2026, 9, 5, 9, 0)))).toBe('20261005T090000Z');
  });
});

describe('fetch builders + parsers', () => {
  const start = new Date(Date.UTC(2026, 9, 1));
  const end = new Date(Date.UTC(2026, 10, 1));
  it('builds a CalDAV REPORT with a time range', () => {
    const body = buildCaldavReport(start, end);
    expect(body).toContain('calendar-query');
    expect(body).toContain('20261001T000000Z');
    const t = buildFetchTransport(
      { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'cal.example/dav/', protocol: 'https', port: '', username: 'u', password: 'p' },
      start, end,
    );
    expect(t.method).toBe('REPORT');
    expect(t.endpoint).toBe('https://cal.example/dav');
    expect(t.headers).toContain('Depth: 1');
  });
  it('builds a Graph calendarview GET', () => {
    const t = buildFetchTransport({ ...DEFAULT_CALENDAR_CONFIG, provider: 'graph', token: 't' }, start, end);
    expect(t.method).toBe('GET');
    expect(t.endpoint).toMatch(/\/me\/calendarview\?/);
  });
  it('builds an EWS FindItem with a CalendarView', () => {
    const body = buildEwsFindItem(start, end);
    expect(body).toContain('FindItem');
    expect(body).toContain('CalendarView');
  });
  it('parses ics events incl. folded lines', () => {
    const ics = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nDTSTART:20261005T090000\r\nDTEND:20261005T100000\r\nSUMMARY:Long ti\r\n tle here\r\nLOCATION:Room\\, 3\r\nEND:VEVENT\r\nEND:VCALENDAR';
    const [e] = parseIcsEvents(ics, 'caldav');
    expect(e.title).toBe('Long title here');
    expect(e.location).toBe('Room, 3');
    expect(e.startIso).toBe('2026-10-05T09:00');
  });
  it('parses a CalDAV multistatus report', () => {
    const xml = '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>' +
      '<cal:calendar-data xmlns:cal="urn:ietf:params:xml:ns:caldav">BEGIN:VEVENT\nUID:7\nDTSTART:20261005T090000\nSUMMARY:Standup\nEND:VEVENT</cal:calendar-data>' +
      '</d:prop></d:propstat></d:response></d:multistatus>';
    const [e] = parseCaldavReport(xml);
    expect(e.title).toBe('Standup');
    expect(e.provider).toBe('caldav');
  });
  it('parses Graph event JSON', () => {
    const [e] = parseGraphEvents(JSON.stringify({ value: [{ id: 'a', subject: 'Review', start: { dateTime: '2026-10-05T09:00:00' }, end: { dateTime: '2026-10-05T10:00:00' }, location: { displayName: 'Teams' } }] }));
    expect(e.title).toBe('Review');
    expect(e.location).toBe('Teams');
    expect(e.startIso).toBe('2026-10-05T09:00');
  });
  it('parses EWS FindItem XML', () => {
    const xml = '<m:FindItemResponseMessages xmlns:m="x" xmlns:t="y"><m:FindItemResponseMessage ResponseClass="Success">' +
      '<m:RootFolder><t:Items><t:CalendarItem><t:ItemId Id="abc"/><t:Subject>Planning</t:Subject>' +
      '<t:Start>2026-10-05T09:00:00</t:Start><t:End>2026-10-05T10:00:00</t:End><t:Location>Room 1</t:Location>' +
      '</t:CalendarItem></t:Items></m:RootFolder></m:FindItemResponseMessage></m:FindItemResponseMessages>';
    const [e] = parseEwsFindItem(xml);
    expect(e.title).toBe('Planning');
    expect(e.id).toBe('ews:abc');
  });
});

describe('composeUrl', () => {
  it('passes full URLs through untouched', () => {
    expect(composeUrl('https://cal.example:8443/dav/', 'http', '1234')).toBe('https://cal.example:8443/dav/');
  });
  it('composes protocol + host + port + path', () => {
    expect(composeUrl('cal.example/dav/x/', 'https', '8443')).toBe('https://cal.example:8443/dav/x/');
  });
  it('omits the port when blank', () => {
    expect(composeUrl('cal.example', 'http', '')).toBe('http://cal.example');
  });
  it('returns empty for blank input', () => {
    expect(composeUrl('   ', 'https', '443')).toBe('');
  });
  it('applies to transports', () => {
    const t = buildTransport(
      { ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'cal.example/dav/', protocol: 'https', port: '8443', username: 'u', password: 'p' },
      { title: 'T', startIso: '2026-10-05T09:00', endIso: '2026-10-05T10:00', description: '', location: '' },
      'uid-1',
    );
    expect(t.endpoint).toBe('https://cal.example:8443/dav/uid-1.ics');
  });
  it('rejects a non-numeric port', () => {
    expect(validateCalendarConfig({ ...DEFAULT_CALENDAR_CONFIG, serverUrl: 'cal.example', port: 'abc', username: 'u', password: 'p' })).toMatch(/Port/);
  });
});

describe('sogoCalendarUrl', () => {
  it('builds the default personal calendar path', () => {
    expect(sogoCalendarUrl('mail.host.com', 'me@host.com')).toBe(
      'mail.host.com/SOGo/dav/me@host.com/Calendar/personal/',
    );
  });
  it('keeps scheme/port, replaces any path, encodes names', () => {
    expect(sogoCalendarUrl('https://mail.host.com:8443/SOGo/', 'j doe', 'work')).toBe(
      'https://mail.host.com:8443/SOGo/dav/j%20doe/Calendar/work/',
    );
  });
  it('returns empty without host or user', () => {
    expect(sogoCalendarUrl('', 'me')).toBe('');
    expect(sogoCalendarUrl('mail.host.com', ' ')).toBe('');
  });
  it('composes into a valid CalDAV endpoint', () => {
    const serverUrl = sogoCalendarUrl('mail.host.com', 'me@host.com');
    const t = buildTransport(
      { ...DEFAULT_CALENDAR_CONFIG, serverUrl, username: 'me@host.com', password: 'p' },
      { title: 'x', startIso: '2026-10-01T09:00', endIso: '2026-10-01T10:00', description: '', location: '' },
      'u1@local-transcribe',
    );
    expect(t.endpoint).toBe('https://mail.host.com/SOGo/dav/me@host.com/Calendar/personal/u1@local-transcribe.ics');
  });
});
