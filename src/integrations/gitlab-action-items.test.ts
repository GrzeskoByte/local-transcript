import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITLAB_CONFIG,
  actionItemIssue,
  actionItemsOf,
  createGitlabClient,
  parseActionItem,
  parseDueDate,
} from './gitlab';
import type { Meeting } from '../domain/meeting';

const meeting: Meeting = {
  id: 'm1',
  title: 'Weekly sync',
  mode: 'speaker',
  createdAt: 0,
  startedAt: Date.UTC(2026, 9, 8, 9, 0, 0),
  durationMs: 60_000,
  audioPath: '',
  mimeType: 'audio/ogg;codecs=opus',
  transcriptionStatus: 'completed',
  summary: {
    text: 'We planned the release.',
    keyPoints: ['Release on Friday'],
    actionItems: ['Anna: send the release notes (2026-10-20)', 'Unassigned: book the demo room', 'None'],
    model: 'test',
    createdAt: 0,
  },
};

describe('action items', () => {
  const now = new Date(2026, 9, 8);

  it('split "Owner: task (due)" and drop unassigned owners', () => {
    expect(parseActionItem('Anna: send the release notes (2026-10-20)', now)).toEqual({
      text: 'Anna: send the release notes (2026-10-20)',
      task: 'send the release notes',
      owner: 'Anna',
      due: '2026-10-20',
      dueDate: '2026-10-20',
    });
    expect(parseActionItem('Unassigned: book the demo room', now)).toEqual({
      text: 'Unassigned: book the demo room',
      task: 'book the demo room',
    });
    expect(parseActionItem('- **Bob**: fix login (Friday)', now)).toMatchObject({
      task: 'fix login',
      owner: 'Bob',
      due: 'Friday',
    });
    expect(parseActionItem('Review the budget', now)).toEqual({ text: 'Review the budget', task: 'Review the budget' });
  });

  it('read calendar dates only', () => {
    expect(parseDueDate('2026-11-3', now)).toBe('2026-11-03');
    expect(parseDueDate('20.10.2026', now)).toBe('2026-10-20');
    expect(parseDueDate('Oct 20', now)).toBe('2026-10-20');
    expect(parseDueDate('3 March', now)).toBe('2027-03-03');
    expect(parseDueDate('Friday', now)).toBeUndefined();
    expect(parseDueDate('next week', now)).toBeUndefined();
  });

  it('skip "None" and build the issue from the meeting', () => {
    const items = actionItemsOf(meeting);
    expect(items.map((i) => i.task)).toEqual(['send the release notes', 'book the demo room']);
    const issue = actionItemIssue(meeting, items[0]!);
    expect(issue.title).toBe('send the release notes');
    expect(issue.description).toContain('**Owner:** Anna');
    expect(issue.description).toContain('**Due:** 2026-10-20');
    expect(issue.description).toContain('From the meeting **Weekly sync** (2026-10-08)');
    expect(issue.description).toContain('> We planned the release.');
  });
});

describe('createActionItemIssues', () => {
  afterEach(() => vi.unstubAllGlobals());
  const config = { ...DEFAULT_GITLAB_CONFIG, url: 'https://git.example.com', project: 'team/app', token: 't' };

  it('creates one issue per item, assigning a matching member and the due date', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/members/all')) {
          return new Response(JSON.stringify([{ id: 7, username: 'anna', name: 'Anna' }]), { status: 200 });
        }
        posted.push(JSON.parse(String(init?.body)));
        const iid = posted.length;
        return new Response(JSON.stringify({ iid, web_url: `https://git.example.com/team/app/-/issues/${iid}` }), {
          status: 201,
        });
      }),
    );
    const created = await createGitlabClient(config).createActionItemIssues(meeting, actionItemsOf(meeting));
    expect(created).toEqual([
      {
        item: 'Anna: send the release notes (2026-10-20)',
        url: 'https://git.example.com/team/app/-/issues/1',
        iid: 1,
        assignee: 'anna',
      },
      { item: 'Unassigned: book the demo room', url: 'https://git.example.com/team/app/-/issues/2', iid: 2 },
    ]);
    expect(posted[0]).toMatchObject({
      title: 'send the release notes',
      labels: 'local-transcribe,action-item',
      due_date: '2026-10-20',
      assignee_ids: [7],
    });
    expect(posted[1]).not.toHaveProperty('assignee_ids');
    expect(posted[1]).not.toHaveProperty('due_date');
  });

  it('keeps what was created when a later issue fails', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/members/all')) return new Response('[]', { status: 200 });
        calls++;
        return calls === 1
          ? new Response(JSON.stringify({ iid: 1, web_url: 'u1' }), { status: 201 })
          : new Response('forbidden', { status: 403 });
      }),
    );
    const err = (await createGitlabClient(config)
      .createActionItemIssues(meeting, actionItemsOf(meeting))
      .then(() => new Error('expected a failure'))
      .catch((e: unknown) => e)) as Error & { created?: unknown[] };
    expect(err.message).toContain('GitLab 403');
    expect(err.created).toEqual([{ item: 'Anna: send the release notes (2026-10-20)', url: 'u1', iid: 1 }]);
  });
});
