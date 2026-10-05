/**
 * Calendar auto-detection (desktop only):
 * 1. Thunderbird — Rust `native_calendar_thunderbird` returns the calendar
 *    and mail-server lines of each profile's prefs.js; parsed here. Offline.
 * 2. Server probe — Rust `native_calendar_probe` sends single requests to
 *    well-known paths on a host (CalDAV discovery, SOGo, Nextcloud, Zimbra,
 *    Kerio, Exchange EWS); with credentials, CalDAV calendars are listed via
 *    current-user-principal → calendar-home-set → PROPFIND Depth 1.
 * Nothing is created; passwords are never read from Thunderbird.
 */
import { invokeDesktop } from '../platform/desktop';
import type { CalendarProvider } from './calendar';
import { sogoCalendarUrl } from './calendar';

export type CalendarSystem = 'sogo' | 'nextcloud' | 'zimbra' | 'kerio' | 'exchange' | 'caldav';

export const CALENDAR_SYSTEM_LABELS: Record<CalendarSystem, string> = {
  sogo: 'SOGo',
  nextcloud: 'Nextcloud',
  zimbra: 'Zimbra',
  kerio: 'Kerio Connect',
  exchange: 'Exchange (EWS)',
  caldav: 'CalDAV',
};

export interface DetectedCalendar {
  source: 'thunderbird' | 'server';
  provider: CalendarProvider;
  system: CalendarSystem;
  name: string;
  /** Full collection (CalDAV) or Exchange.asmx (EWS) URL. */
  url: string;
  username: string;
  /** Thunderbird profile, or a note such as "sign in to list calendars". */
  detail?: string;
}

export interface ThunderbirdProfile {
  profile: string;
  lines: string[];
}

export interface MailAccount {
  host: string;
  username: string;
}

/* ------------------------------ Thunderbird ------------------------------ */

/** `user_pref("key", value);` → [key, value] (strings unescaped, others raw). */
export function parsePrefLine(line: string): [string, string] | null {
  const m = line.match(/^\s*user_pref\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(.*?)\s*\)\s*;?\s*$/);
  if (!m) return null;
  let value = m[2];
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.slice(1, -1);
    }
  }
  return [m[1], value];
}

/** Which calendar system a URL belongs to, by its path shape. */
export function systemFromUrl(url: string): CalendarSystem {
  const u = url.toLowerCase();
  if (u.includes('/sogo/')) return 'sogo';
  if (u.includes('/remote.php/')) return 'nextcloud';
  if (u.includes('/ews/exchange.asmx')) return 'exchange';
  if (/\/caldav(\/|$)/.test(u)) return 'kerio';
  if (/\/dav\/[^/]+\/calendar/i.test(url) || /\/dav\/[^/]+\/?$/.test(u)) return 'zimbra';
  return 'caldav';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Username embedded in common CalDAV paths (`/dav/<user>/`, `/calendars/<user>/`). */
function userFromPath(url: string): string {
  const m = url.match(/\/(?:dav|calendars|caldav)\/([^/]+)\//i);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** Thunderbird prefs → network calendars (CalDAV) + configured mail accounts. */
export function parseThunderbird(profiles: ThunderbirdProfile[]): {
  calendars: DetectedCalendar[];
  mailAccounts: MailAccount[];
} {
  const calendars: DetectedCalendar[] = [];
  const mailAccounts: MailAccount[] = [];
  for (const { profile, lines } of profiles) {
    const cals = new Map<string, Record<string, string>>();
    const servers = new Map<string, Record<string, string>>();
    for (const line of lines) {
      const kv = parsePrefLine(line);
      if (!kv) continue;
      const [key, value] = kv;
      let m = key.match(/^calendar\.registry\.([^.]+)\.(.+)$/);
      if (m) {
        const rec = cals.get(m[1]) ?? {};
        rec[m[2]] = value;
        cals.set(m[1], rec);
        continue;
      }
      m = key.match(/^mail\.server\.(server\d+)\.(hostname|userName|type)$/);
      if (m) {
        const rec = servers.get(m[1]) ?? {};
        rec[m[2]] = value;
        servers.set(m[1], rec);
      }
    }
    const accounts: MailAccount[] = [];
    for (const s of servers.values()) {
      if (!s.hostname || s.type === 'none' || s.hostname === 'Local Folders') continue;
      accounts.push({ host: s.hostname, username: s.userName ?? '' });
    }
    for (const c of cals.values()) {
      if (c.type !== 'caldav' || !/^https?:\/\//i.test(c.uri ?? '') || c.disabled === 'true') continue;
      const host = hostOf(c.uri);
      const username =
        c.username ||
        userFromPath(c.uri) ||
        accounts.find((a) => a.host.toLowerCase() === host)?.username ||
        '';
      const system = systemFromUrl(c.uri);
      calendars.push({
        source: 'thunderbird',
        provider: 'caldav',
        system,
        name: c.name || 'Calendar',
        url: c.uri,
        username,
        detail: `Thunderbird profile ${profile}`,
      });
    }
    for (const a of accounts) {
      if (!mailAccounts.some((x) => x.host === a.host && x.username === a.username)) mailAccounts.push(a);
    }
  }
  const unique = calendars.filter((c, i) => calendars.findIndex((x) => x.url === c.url) === i);
  return { calendars: unique, mailAccounts };
}

export async function scanThunderbird(): Promise<{ calendars: DetectedCalendar[]; mailAccounts: MailAccount[] }> {
  const profiles = await invokeDesktop<ThunderbirdProfile[]>('native_calendar_thunderbird');
  return parseThunderbird(profiles);
}

/* ------------------------------ server probe ----------------------------- */

export interface ProbeRequest {
  endpoint: string;
  method: 'PROPFIND' | 'GET' | 'POST';
  username?: string;
  password?: string;
  contentType?: string;
  body?: string;
  headers?: string[];
}

export interface ProbeResponse {
  status: number;
  location: string;
  wwwAuthenticate: string;
  dav: string;
  body: string;
}

export type Prober = (req: ProbeRequest) => Promise<ProbeResponse>;

export const nativeProber: Prober = async (request) => {
  return invokeDesktop<ProbeResponse>('native_calendar_probe', { request });
};

/** `mail.host.com`, `https://mail.host.com:8443/x` → `https://mail.host.com[:8443]`. */
export function originOf(hostOrUrl: string): string {
  const v = hostOrUrl.trim();
  if (!v) return '';
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`).origin;
  } catch {
    return '';
  }
}

interface Candidate {
  system: CalendarSystem;
  path: string;
  method: 'PROPFIND' | 'GET';
}

/** Well-known locations to try, most generic first. */
export function probeCandidates(username: string): Candidate[] {
  const user = encodeURIComponent(username.trim()).replace(/%40/g, '@');
  const out: Candidate[] = [{ system: 'caldav', path: '/.well-known/caldav', method: 'PROPFIND' }];
  if (user) out.push({ system: 'sogo', path: `/SOGo/dav/${user}/`, method: 'PROPFIND' });
  else out.push({ system: 'sogo', path: '/SOGo/dav/', method: 'PROPFIND' });
  out.push({ system: 'nextcloud', path: '/remote.php/dav/', method: 'PROPFIND' });
  if (user) out.push({ system: 'zimbra', path: `/dav/${user}/`, method: 'PROPFIND' });
  out.push({ system: 'kerio', path: '/caldav/', method: 'PROPFIND' });
  out.push({ system: 'exchange', path: '/EWS/Exchange.asmx', method: 'GET' });
  return out;
}

const PROP_PRINCIPAL =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>';
const PROP_HOME =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>';
const PROP_LIST =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:displayname/></d:prop></d:propfind>';

/** First `<href>` nested inside `<tag>` (any namespace prefix). */
export function hrefInside(xml: string, tag: string): string | null {
  const block = xml.match(new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i'));
  if (!block) return null;
  const href = block[1].match(/<(?:[\w-]+:)?href\b[^>]*>\s*([^<]+?)\s*<\/(?:[\w-]+:)?href>/i);
  return href ? decodeXml(href[1]) : null;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Calendar collections of a Depth-1 PROPFIND multistatus. */
export function parseCalendarCollections(xml: string): Array<{ href: string; name: string }> {
  const out: Array<{ href: string; name: string }> = [];
  const responses = xml.match(/<(?:[\w-]+:)?response\b[^>]*>[\s\S]*?<\/(?:[\w-]+:)?response>/gi) ?? [];
  for (const r of responses) {
    const rt = r.match(/<(?:[\w-]+:)?resourcetype\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i);
    if (!rt || !/<(?:[\w-]+:)?calendar\b[^>]*\/?>/i.test(rt[1])) continue;
    const href = r.match(/<(?:[\w-]+:)?href\b[^>]*>\s*([^<]+?)\s*<\/(?:[\w-]+:)?href>/i);
    if (!href) continue;
    const dn = r.match(/<(?:[\w-]+:)?displayname\b[^>]*>([^<]*)<\/(?:[\w-]+:)?displayname>/i);
    const h = decodeXml(href[1]);
    const fallback = decodeURIComponent(h.replace(/\/+$/, '').split('/').pop() ?? 'Calendar');
    out.push({ href: h, name: (dn && decodeXml(dn[1]).trim()) || fallback });
  }
  return out;
}

function resolve(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function propfind(url: string, body: string, depth: '0' | '1', username: string, password: string): ProbeRequest {
  return {
    endpoint: url,
    method: 'PROPFIND',
    username,
    password,
    contentType: 'text/xml; charset=utf-8',
    body,
    headers: [`Depth: ${depth}`],
  };
}

/** CalDAV discovery from any DAV URL on the server; [] when it cannot list. */
export async function listCaldavCalendars(
  startUrl: string,
  username: string,
  password: string,
  probe: Prober,
): Promise<Array<{ url: string; name: string }>> {
  const p1 = await probe(propfind(startUrl, PROP_PRINCIPAL, '0', username, password));
  if (p1.status !== 207) return [];
  const principal = hrefInside(p1.body, 'current-user-principal');
  const principalUrl = principal ? resolve(principal, startUrl) : startUrl;
  const p2 = await probe(propfind(principalUrl, PROP_HOME, '0', username, password));
  const home = p2.status === 207 ? hrefInside(p2.body, 'calendar-home-set') : null;
  const homeUrl = home ? resolve(home, principalUrl) : principalUrl;
  const p3 = await probe(propfind(homeUrl, PROP_LIST, '1', username, password));
  if (p3.status !== 207) return [];
  return parseCalendarCollections(p3.body).map((c) => ({ url: resolve(c.href, homeUrl), name: c.name }));
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Probe `host` for a calendar system. 207 (or 200 for EWS) = found;
 * 401 = found but needs a login. With a password, CalDAV calendars are listed.
 */
export async function detectFromServer(
  host: string,
  username: string,
  password: string,
  probe: Prober = nativeProber,
): Promise<DetectedCalendar[]> {
  const origin = originOf(host);
  if (!origin) throw new Error('Enter the server host, e.g. mail.host.com.');
  const user = username.trim();
  let lastError: string | null = null;
  for (const c of probeCandidates(user)) {
    let url = origin + c.path;
    let system = c.system;
    let res: ProbeResponse;
    try {
      res = await probe(
        c.method === 'GET'
          ? { endpoint: url, method: 'GET' }
          : propfind(url, PROP_PRINCIPAL, '0', user, password),
      );
      if (REDIRECT.has(res.status) && res.location) {
        url = resolve(res.location, url);
        if (originOf(url) !== origin) continue;
        system = c.system === 'caldav' ? systemFromUrl(url) : c.system;
        res = await probe(propfind(url, PROP_PRINCIPAL, '0', user, password));
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      // Host unreachable: no point trying other paths.
      if (/resolve|connect|timed out|Host did not answer/i.test(lastError)) break;
      continue;
    }
    if (system === 'exchange') {
      if (res.status === 200 || (res.status === 401 && /ntlm|negotiate|basic/i.test(res.wwwAuthenticate))) {
        return [{
          source: 'server', provider: 'ews', system, name: 'Exchange calendar', url, username: user,
          detail: 'Found Exchange Web Services',
        }];
      }
      continue;
    }
    const isDav = res.status === 207 || (res.status === 401 && (!!res.dav || /basic|digest|bearer/i.test(res.wwwAuthenticate)));
    if (!isDav) continue;
    if (res.status === 207 && password) {
      const list = await listCaldavCalendars(url, user, password, probe).catch(() => []);
      if (list.length) {
        return list.map((l) => ({
          source: 'server' as const, provider: 'caldav' as const,
          system: system === 'caldav' ? systemFromUrl(l.url) : system,
          name: l.name, url: l.url, username: user,
        }));
      }
    }
    const guess = system === 'sogo' && user ? sogoCalendarUrl(origin, user) : url;
    return [{
      source: 'server', provider: 'caldav', system,
      name: system === 'sogo' ? 'personal' : `${CALENDAR_SYSTEM_LABELS[system]} server`,
      url: guess, username: user,
      detail: res.status === 401
        ? 'Server found — enter your password and detect again to list calendars'
        : 'Server found — pick the calendar URL if this is not the one',
    }];
  }
  throw new Error(lastError ? `No calendar found on ${origin}: ${lastError}` : `No calendar service found on ${origin}.`);
}
