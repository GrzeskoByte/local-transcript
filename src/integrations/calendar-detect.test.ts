import { describe, expect, it } from 'vitest';
import {
  detectFromServer,
  hrefInside,
  listCaldavCalendars,
  parseCalendarCollections,
  parsePrefLine,
  parseThunderbird,
  systemFromUrl,
  type ProbeRequest,
  type ProbeResponse,
} from './calendar-detect';

const res = (status: number, extra: Partial<ProbeResponse> = {}): ProbeResponse => ({
  status, location: '', wwwAuthenticate: '', dav: '', body: '', ...extra,
});

describe('Thunderbird prefs', () => {
  it('parses string, bool and escaped values', () => {
    expect(parsePrefLine('user_pref("a.b", "x \\"y\\"");')).toEqual(['a.b', 'x "y"']);
    expect(parsePrefLine('user_pref("a.c", true);')).toEqual(['a.c', 'true']);
    expect(parsePrefLine('// comment')).toBeNull();
  });

  it('extracts enabled CalDAV calendars and mail accounts', () => {
    const { calendars, mailAccounts } = parseThunderbird([{
      profile: 'abc.default',
      lines: [
        'user_pref("calendar.registry.1.type", "caldav");',
        'user_pref("calendar.registry.1.uri", "https://mail.host.com/SOGo/dav/me@host.com/Calendar/personal/");',
        'user_pref("calendar.registry.1.name", "Personal");',
        'user_pref("calendar.registry.2.type", "storage");',
        'user_pref("calendar.registry.2.uri", "moz-storage-calendar://");',
        'user_pref("calendar.registry.3.type", "caldav");',
        'user_pref("calendar.registry.3.uri", "https://x.example/remote.php/dav/calendars/bob/work/");',
        'user_pref("calendar.registry.3.disabled", true);',
        'user_pref("mail.server.server1.hostname", "mail.host.com");',
        'user_pref("mail.server.server1.userName", "me@host.com");',
        'user_pref("mail.server.server1.type", "imap");',
        'user_pref("mail.server.server2.hostname", "Local Folders");',
        'user_pref("mail.server.server2.type", "none");',
      ],
    }]);
    expect(calendars).toHaveLength(1);
    expect(calendars[0]).toMatchObject({
      system: 'sogo', provider: 'caldav', name: 'Personal', username: 'me@host.com',
      url: 'https://mail.host.com/SOGo/dav/me@host.com/Calendar/personal/',
    });
    expect(mailAccounts).toEqual([{ host: 'mail.host.com', username: 'me@host.com' }]);
  });

  it('classifies URLs', () => {
    expect(systemFromUrl('https://h/remote.php/dav/calendars/u/x/')).toBe('nextcloud');
    expect(systemFromUrl('https://h/dav/u@h/Calendar')).toBe('zimbra');
    expect(systemFromUrl('https://h/caldav/')).toBe('kerio');
    expect(systemFromUrl('https://h/EWS/Exchange.asmx')).toBe('exchange');
    expect(systemFromUrl('https://h/cal/')).toBe('caldav');
  });
});

const PRINCIPAL = '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/SOGo/dav/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/SOGo/dav/me@host.com/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>';
const HOME = '<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:response><D:href>/SOGo/dav/me@host.com/</D:href><D:propstat><D:prop><C:calendar-home-set><D:href>/SOGo/dav/me@host.com/Calendar/</D:href></C:calendar-home-set></D:prop></D:propstat></D:response></D:multistatus>';
const LIST = `<multistatus xmlns="DAV:"><response><href>/SOGo/dav/me@host.com/Calendar/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
<response><href>/SOGo/dav/me@host.com/Calendar/personal/</href><propstat><prop><resourcetype><collection/><C:calendar xmlns:C="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname>Personal Calendar</displayname></prop></propstat></response>
<response><href>/SOGo/dav/me@host.com/Calendar/work%20team/</href><propstat><prop><resourcetype><collection/><cal:calendar xmlns:cal="urn:ietf:params:xml:ns:caldav"/></resourcetype><displayname/></prop></propstat></response></multistatus>`;

describe('CalDAV discovery parsing', () => {
  it('finds nested hrefs and calendar collections', () => {
    expect(hrefInside(PRINCIPAL, 'current-user-principal')).toBe('/SOGo/dav/me@host.com/');
    expect(hrefInside(HOME, 'calendar-home-set')).toBe('/SOGo/dav/me@host.com/Calendar/');
    expect(parseCalendarCollections(LIST)).toEqual([
      { href: '/SOGo/dav/me@host.com/Calendar/personal/', name: 'Personal Calendar' },
      { href: '/SOGo/dav/me@host.com/Calendar/work%20team/', name: 'work team' },
    ]);
  });

  it('walks principal → home → collections', async () => {
    const probe = async (r: ProbeRequest) => {
      if (r.body?.includes('current-user-principal')) return res(207, { body: PRINCIPAL });
      if (r.body?.includes('calendar-home-set')) return res(207, { body: HOME });
      return res(207, { body: LIST });
    };
    const list = await listCaldavCalendars('https://mail.host.com/SOGo/dav/', 'me@host.com', 'p', probe);
    expect(list.map((l) => l.url)).toEqual([
      'https://mail.host.com/SOGo/dav/me@host.com/Calendar/personal/',
      'https://mail.host.com/SOGo/dav/me@host.com/Calendar/work%20team/',
    ]);
  });
});

describe('detectFromServer', () => {
  it('follows .well-known to SOGo and suggests the personal calendar without a password', async () => {
    const seen: string[] = [];
    const probe = async (r: ProbeRequest) => {
      seen.push(r.endpoint);
      if (r.endpoint.endsWith('/.well-known/caldav')) return res(301, { location: '/SOGo/dav/' });
      return res(401, { wwwAuthenticate: 'Basic realm="SOGo"' });
    };
    const found = await detectFromServer('mail.host.com', 'me@host.com', '', probe);
    expect(seen).toEqual(['https://mail.host.com/.well-known/caldav', 'https://mail.host.com/SOGo/dav/']);
    expect(found).toEqual([expect.objectContaining({
      system: 'sogo', provider: 'caldav',
      url: 'https://mail.host.com/SOGo/dav/me@host.com/Calendar/personal/',
    })]);
    expect(found[0].detail).toMatch(/password/);
  });

  it('lists calendars when credentials work', async () => {
    const probe = async (r: ProbeRequest) => {
      if (r.endpoint.endsWith('/.well-known/caldav')) return res(301, { location: 'https://mail.host.com/SOGo/dav/' });
      if (r.body?.includes('calendar-home-set')) return res(207, { body: HOME });
      if (r.body?.includes('current-user-principal')) return res(207, { body: PRINCIPAL });
      return res(207, { body: LIST });
    };
    const found = await detectFromServer('https://mail.host.com', 'me@host.com', 'secret', probe);
    expect(found.map((f) => f.name)).toEqual(['Personal Calendar', 'work team']);
    expect(found.every((f) => f.system === 'sogo')).toBe(true);
  });

  it('falls through to Exchange', async () => {
    const probe = async (r: ProbeRequest) =>
      r.endpoint.endsWith('/EWS/Exchange.asmx') ? res(401, { wwwAuthenticate: 'NTLM' }) : res(404);
    const found = await detectFromServer('ex.corp', 'me', '', probe);
    expect(found[0]).toMatchObject({ provider: 'ews', system: 'exchange', url: 'https://ex.corp/EWS/Exchange.asmx' });
  });

  it('never follows a redirect to another host', async () => {
    const probe = async (r: ProbeRequest) =>
      r.endpoint.endsWith('/.well-known/caldav') ? res(302, { location: 'https://evil.example/dav/' }) : res(404);
    await expect(detectFromServer('mail.host.com', 'me', '', probe)).rejects.toThrow(/No calendar service/);
  });

  it('stops early when the host is unreachable', async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
      throw new Error('Could not resolve host: nope');
    };
    await expect(detectFromServer('nope', '', '', probe)).rejects.toThrow(/resolve/);
    expect(calls).toBe(1);
  });
});
