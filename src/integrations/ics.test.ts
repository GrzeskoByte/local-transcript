import { describe, expect, it } from 'vitest';

// Deterministic local zone for conversions (worker-local env).
process.env.TZ = 'Europe/Warsaw';

import { decodeXmlText, parseDuration, parseIcs } from './ics';
import { parseCaldavReport } from './calendar';

const october = { start: new Date(2026, 9, 1), end: new Date(2026, 10, 1) };
const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (...lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
const starts = (evs: { startIso: string }[]) => evs.map((e) => e.startIso).sort();

describe('decodeXmlText', () => {
  it('decodes numeric/named entities and CDATA', () => {
    expect(decodeXmlText('A&#13;\nB&#x0D;&amp;lt;&lt;')).toBe('A\r\nB\r&lt;<');
    expect(decodeXmlText('<![CDATA[BEGIN:VEVENT & <x>]]>')).toBe('BEGIN:VEVENT & <x>');
  });
});

describe('parseIcs', () => {
  it('reads a SOGo REPORT with &#13; line ends, TZID and a VTIMEZONE', () => {
    const ics = cal(
      'BEGIN:VTIMEZONE', 'TZID:Europe/Warsaw', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'END:STANDARD', 'END:VTIMEZONE',
      vevent('UID:abc', 'DTSTART;TZID=Europe/Warsaw:20261005T090000', 'DTEND;TZID=Europe/Warsaw:20261005T093000',
        'SUMMARY:Team sync\\, weekly', 'LOCATION;ALTREP="https://x.example/a:b":Room 1',
        'BEGIN:VALARM', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM'),
    ).replace(/\r\n/g, '&#13;\n');
    const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:propstat><D:prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">${ics}</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>`;
    const [e] = parseCaldavReport(xml, october);
    expect(e).toMatchObject({
      title: 'Team sync, weekly', location: 'Room 1',
      startIso: '2026-10-05T09:00', endIso: '2026-10-05T09:30',
    });
  });

  it('converts other time zones and UTC to local time', () => {
    const evs = parseIcs(cal(
      vevent('UID:ny', 'DTSTART;TZID=America/New_York:20261005T090000', 'DURATION:PT1H', 'SUMMARY:NY'),
      vevent('UID:z', 'DTSTART:20261006T070000Z', 'SUMMARY:UTC'),
      vevent('UID:win', 'DTSTART;TZID=W. Europe Standard Time:20261007T100000', 'SUMMARY:Windows TZ'),
    ), 'caldav', october);
    const by = Object.fromEntries(evs.map((e) => [e.title, e]));
    expect(by.NY.startIso).toBe('2026-10-05T15:00');
    expect(by.NY.endIso).toBe('2026-10-05T16:00');
    expect(by.UTC.startIso).toBe('2026-10-06T09:00');
    expect(by['Windows TZ'].startIso).toBe('2026-10-07T10:00'); // unknown TZID → floating
  });

  it('expands a weekly meeting that started months earlier, with EXDATE and overrides', () => {
    const evs = parseIcs(cal(
      vevent('UID:w', 'DTSTART;TZID=Europe/Warsaw:20260105T100000', 'DTEND;TZID=Europe/Warsaw:20260105T103000',
        'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Europe/Warsaw:20261007T100000', 'SUMMARY:Standup'),
      // Moved: Mon 12 Oct → Tue 13 Oct 11:00.
      vevent('UID:w', 'RECURRENCE-ID;TZID=Europe/Warsaw:20261012T100000',
        'DTSTART;TZID=Europe/Warsaw:20261013T110000', 'DTEND;TZID=Europe/Warsaw:20261013T113000', 'SUMMARY:Standup (moved)'),
      // Cancelled: Wed 21 Oct.
      vevent('UID:w', 'RECURRENCE-ID;TZID=Europe/Warsaw:20261021T100000', 'STATUS:CANCELLED',
        'DTSTART;TZID=Europe/Warsaw:20261021T100000', 'SUMMARY:Standup'),
    ), 'caldav', october);
    expect(starts(evs)).toEqual([
      '2026-10-05T10:00', '2026-10-13T11:00', '2026-10-14T10:00',
      '2026-10-19T10:00', '2026-10-26T10:00', '2026-10-28T10:00',
    ]);
    expect(new Set(evs.map((e) => e.id)).size).toBe(evs.length);
  });

  it('keeps wall time across the DST change', () => {
    const evs = parseIcs(cal(vevent('UID:d', 'DTSTART;TZID=Europe/Warsaw:20261019T090000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY')), 'caldav', october);
    expect(starts(evs)).toEqual(['2026-10-19T09:00', '2026-10-26T09:00']);
  });

  it('handles monthly BYDAY ordinals, BYMONTHDAY, daily COUNT/UNTIL and yearly', () => {
    const evs = parseIcs(cal(
      vevent('UID:m1', 'DTSTART:20260113T140000', 'RRULE:FREQ=MONTHLY;BYDAY=2TU', 'SUMMARY:2nd Tue'),
      vevent('UID:m2', 'DTSTART:20260130T160000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Last Fri'),
      vevent('UID:m3', 'DTSTART:20260131T080000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=-1', 'SUMMARY:Month end'),
      vevent('UID:c', 'DTSTART:20261028T080000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Count'),
      vevent('UID:u', 'DTSTART:20261001T080000', 'RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261006T235959Z', 'SUMMARY:Until'),
      vevent('UID:y', 'DTSTART;VALUE=DATE:20201015', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday'),
      // Starts in winter (CET), recurs in summer time (CEST): date must not shift.
      vevent('UID:a', 'DTSTART;VALUE=DATE:20260105', 'DTEND;VALUE=DATE:20260106', 'RRULE:FREQ=WEEKLY;BYDAY=MO', 'SUMMARY:All-day Mon'),
      vevent('UID:old', 'DTSTART:20260105T080000', 'RRULE:FREQ=WEEKLY;UNTIL=20260301T000000Z', 'SUMMARY:Ended'),
    ), 'caldav', october);
    const by = (t: string) => starts(evs.filter((e) => e.title === t));
    expect(by('2nd Tue')).toEqual(['2026-10-13T14:00']);
    expect(by('Last Fri')).toEqual(['2026-10-30T16:00']);
    expect(by('Month end')).toEqual(['2026-10-31T08:00']);
    expect(by('Count')).toEqual(['2026-10-28T08:00', '2026-10-29T08:00', '2026-10-30T08:00']);
    expect(by('Until')).toEqual(['2026-10-01T08:00', '2026-10-03T08:00', '2026-10-05T08:00']);
    expect(by('Ended')).toEqual([]);
    const [bday] = evs.filter((e) => e.title === 'Birthday');
    expect(bday).toMatchObject({ allDay: true, startIso: '2026-10-15T09:00' });
    expect(by('All-day Mon')).toEqual(['2026-10-05T09:00', '2026-10-12T09:00', '2026-10-19T09:00', '2026-10-26T09:00']);
  });

  it('drops events outside the range; without a range returns each VEVENT once', () => {
    const ics = cal(
      vevent('UID:in', 'DTSTART:20261010T090000', 'SUMMARY:In'),
      vevent('UID:out', 'DTSTART:20261110T090000', 'SUMMARY:Out'),
      vevent('UID:r', 'DTSTART:20260105T090000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Rec'),
    );
    expect(parseIcs(ics, 'caldav', october).filter((e) => e.title !== 'Rec').map((e) => e.title)).toEqual(['In']);
    expect(parseIcs(ics, 'caldav').map((e) => e.title)).toEqual(['In', 'Out', 'Rec']);
  });

  it('parses durations', () => {
    expect(parseDuration('PT1H30M')).toBe(5_400_000);
    expect(parseDuration('P1D')).toBe(86_400_000);
    expect(parseDuration('-PT15M')).toBe(-900_000);
  });
});
