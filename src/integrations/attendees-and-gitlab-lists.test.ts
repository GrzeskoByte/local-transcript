import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildEwsCreateItem, buildGraphEvent, buildIcsEvent, parseAttendees } from './calendar';
import { DEFAULT_GITLAB_CONFIG, createGitlabClient } from './gitlab';

const draft = {
  title: 'Changelog review',
  startIso: '2026-11-03T09:00',
  endIso: '2026-11-03T09:30',
  description: 'From the release sync',
  location: '',
};

describe('calendar attendees', () => {
  it('parses typed lists, names with addresses and drops junk', () => {
    expect(parseAttendees('Anna <Anna@Example.com>; bob@ex.org, not-an-email,  bob@ex.org\nc@d.io')).toEqual([
      'anna@example.com',
      'bob@ex.org',
      'c@d.io',
    ]);
    expect(parseAttendees('')).toEqual([]);
  });

  it('.ics invites attendees with the account as organizer', () => {
    const ics = buildIcsEvent({ ...draft, attendees: ['anna@example.com'] }, 'uid-1', 'me@example.com').replace(/\r\n /g, '');
    expect(ics).toContain('ORGANIZER:mailto:me@example.com');
    expect(ics).toContain('ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:anna@example.com');
    const plain = buildIcsEvent(draft, 'uid-2', 'me@example.com');
    expect(plain).not.toContain('ATTENDEE');
    expect(plain).not.toContain('ORGANIZER');
  });

  it('Graph and EWS carry the attendees and EWS sends invitations', () => {
    const g = JSON.parse(buildGraphEvent({ ...draft, attendees: ['a@x.io', 'oops'] }));
    expect(g.attendees).toEqual([{ emailAddress: { address: 'a@x.io' }, type: 'required' }]);
    expect(JSON.parse(buildGraphEvent(draft)).attendees).toBeUndefined();
    const xml = buildEwsCreateItem({ ...draft, attendees: ['a@x.io'] });
    expect(xml).toContain('SendMeetingInvitations="SendToAllAndSaveCopy"');
    expect(xml).toContain('<t:RequiredAttendees><t:Attendee><t:Mailbox><t:EmailAddress>a@x.io</t:EmailAddress>');
    expect(buildEwsCreateItem(draft)).toContain('SendMeetingInvitations="SendToNone"');
  });
});

describe('GitLab projects, groups and people', () => {
  const base = { ...DEFAULT_GITLAB_CONFIG, url: 'https://git.example.com', project: 'team/app', token: 't' };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  afterEach(() => vi.unstubAllGlobals());

  it('lists only member projects and groups by default, everything when turned off', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      return json(url.includes('/groups?')
        ? [{ id: 4, full_path: 'team', full_name: 'Team' }]
        : [{ id: 9, path_with_namespace: 'team/app', name_with_namespace: 'Team / App', web_url: 'https://git.example.com/team/app' }]);
    });
    const client = createGitlabClient(base);
    expect(await client.listProjects({ search: 'ap' })).toEqual([
      { id: 9, path: 'team/app', name: 'Team / App', webUrl: 'https://git.example.com/team/app' },
    ]);
    expect(await client.listGroups()).toEqual([{ id: 4, path: 'team', name: 'Team' }]);
    await client.listProjects({ groupId: 4 });
    await createGitlabClient({ ...base, membersOnly: false }).listProjects();
    expect(urls[0]).toContain('/api/v4/projects?');
    expect(urls[0]).toContain('membership=true');
    expect(urls[0]).toContain('search=ap');
    expect(urls[1]).toContain('min_access_level=10');
    expect(urls[2]).toContain('/api/v4/groups/4/projects?');
    expect(urls[2]).toContain('include_subgroups=true');
    expect(urls[3]).not.toContain('membership=true');
  });

  it('loads members with public e-mails and skips bots and blocked users', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/members/all')) {
        return json([
          { id: 1, username: 'anna', name: 'Anna Nowak', state: 'active' },
          { id: 2, username: 'bob', name: 'Bob', state: 'active' },
          { id: 3, username: 'project_9_bot_x', name: 'Bot', state: 'active' },
          { id: 4, username: 'gone', name: 'Gone', state: 'blocked' },
        ]);
      }
      if (url.endsWith('/users/1')) return json({ public_email: 'anna@example.com' });
      return json({ public_email: '' });
    });
    const people = await createGitlabClient(base).listPeople({ groupId: 4 });
    expect(people).toEqual([
      { id: 1, username: 'anna', name: 'Anna Nowak', email: 'anna@example.com' },
      { id: 2, username: 'bob', name: 'Bob' },
    ]);
  });

  it('creates issues in another project and records which', async () => {
    const posted: string[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(url);
        return json({ iid: 7, web_url: 'https://git.example.com/ops/infra/-/issues/7' });
      }
      return json([]);
    });
    const meeting = { id: 'm1', title: 'Sync', createdAt: Date.now(), startedAt: Date.now() } as never;
    const created = await createGitlabClient({ ...base, project: 'ops/infra' }).createActionItemIssues(meeting, [
      { text: 'Bob: patch the VPN', task: 'patch the VPN', owner: 'Bob' },
    ]);
    expect(posted[0]).toContain('/projects/ops%2Finfra/issues');
    expect(created[0]).toMatchObject({ project: 'ops/infra', iid: 7 });
  });
});
