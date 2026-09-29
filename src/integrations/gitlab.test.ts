import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_GITLAB_CONFIG,
  apiBase,
  createGitlabClient,
  encodeProject,
  instanceRoot,
  meetingFolder,
  meetingMarkdown,
  meetingPageTitle,
  parseProjectUrl,
  slugify,
  summaryMarkdown,
} from './gitlab';
import type { GitlabConfig } from './gitlab';
import type { Meeting } from '../domain/meeting';

const meeting: Meeting = {
  id: 'abc12345-0000-4000-8000-000000000000',
  title: 'Weekly / planning: Q3',
  mode: 'file',
  createdAt: 0,
  startedAt: Date.UTC(2026, 0, 2, 10, 0, 0),
  endedAt: Date.UTC(2026, 0, 2, 10, 30, 0),
  durationMs: 1_800_000,
  audioPath: '',
  mimeType: 'audio/webm',
  transcriptionStatus: 'completed',
};

describe('apiBase', () => {
  it('normalises trailing slashes and appends /api/v4', () => {
    expect(apiBase('https://gitlab.com')).toBe('https://gitlab.com/api/v4');
    expect(apiBase('https://gitlab.com/')).toBe('https://gitlab.com/api/v4');
    expect(apiBase('https://git.example.com/gitlab')).toBe(
      'https://git.example.com/gitlab/api/v4',
    );
  });

  it('is idempotent when /api/v4 is already present', () => {
    expect(apiBase('https://gitlab.com/api/v4')).toBe('https://gitlab.com/api/v4');
  });
});

describe('encodeProject', () => {
  it('url-encodes the namespace separator', () => {
    expect(encodeProject('my-group/my-project')).toBe('my-group%2Fmy-project');
  });
});

describe('parseProjectUrl', () => {
  it('keeps a bare path and no instance', () => {
    expect(parseProjectUrl('my-group/my-project')).toEqual({
      url: null,
      project: 'my-group/my-project',
    });
  });

  it('splits a full self-hosted URL into instance + path', () => {
    expect(parseProjectUrl('https://git.example.com/my-group/my-project')).toEqual({
      url: 'https://git.example.com',
      project: 'my-group/my-project',
    });
  });

  it('strips UI suffixes, .git and trailing slashes', () => {
    expect(parseProjectUrl('https://git.example.com/g/p/-/wikis/home/')).toEqual({
      url: 'https://git.example.com',
      project: 'g/p',
    });
    expect(parseProjectUrl('https://git.example.com/g/p.git')).toEqual({
      url: 'https://git.example.com',
      project: 'g/p',
    });
  });

  it('accepts a scheme-less host', () => {
    expect(parseProjectUrl('git.example.com/g/p')).toEqual({
      url: 'https://git.example.com',
      project: 'g/p',
    });
  });

  it('keeps the full path when the instance itself has a subpath', () => {
    // Relative-URL roots (https://host/gitlab/…) cannot be split reliably:
    // set the Instance URL field manually for those and use a bare path here.
    expect(parseProjectUrl('https://git.example.com/gitlab/g/p')).toEqual({
      url: 'https://git.example.com',
      project: 'gitlab/g/p',
    });
  });
});

describe('slugify', () => {
  it('produces a filesystem-safe slug', () => {
    expect(slugify('Weekly / planning: Q3')).toBe('weekly-planning-q3');
    expect(slugify('---')).toBe('meeting');
  });
});

describe('meetingPageTitle', () => {
  it('includes the title and ISO date', () => {
    expect(meetingPageTitle(meeting)).toBe('Meeting: Weekly / planning: Q3 (2026-01-02)');
  });
});

describe('meetingMarkdown', () => {
  it('prepends a metadata banner to the transcript markdown', () => {
    const md = meetingMarkdown(meeting, [
      { id: 's1', meetingId: meeting.id, sequence: 0, startMs: 0, endMs: 1000, text: 'Hello team.' },
    ]);
    expect(md).toContain('Imported from Local Transcribe');
    expect(md).toContain('mode: file');
    expect(md).toContain('duration: 1800s');
    expect(md).toContain('Hello team.');
  });
});

describe('createGitlabClient', () => {
  it('rejects incomplete configuration', () => {
    expect(() => createGitlabClient(DEFAULT_GITLAB_CONFIG)).toThrow(/incomplete/i);
  });

  it('constructs once url/project/token are present', () => {
    expect(() =>
      createGitlabClient({ ...DEFAULT_GITLAB_CONFIG, project: 'g/p', token: 't' }),
    ).not.toThrow();
  });
});

describe('instanceRoot', () => {
  it('strips /api/v4 but keeps subdirectory instances', () => {
    expect(instanceRoot('https://gitlab.com')).toBe('https://gitlab.com');
    expect(instanceRoot('https://git.example.com/gitlab/')).toBe('https://git.example.com/gitlab');
  });
});

describe('uploadMeeting URL construction', () => {
  const base: GitlabConfig = {
    url: 'https://git.example.com',
    project: 'g/p',
    token: 't',
    target: 'wiki',
    branch: 'main',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  afterEach(() => vi.unstubAllGlobals());

  it('builds the wiki URL from the response slug (the API returns no web_url)', async () => {
    vi.stubGlobal(
      'fetch',
      async () => json({ content: '…', format: 'markdown', slug: 'meeting-x', title: 't' }, 201),
    );
    const r = await createGitlabClient(base).uploadMeeting(meeting, []);
    expect(r).toEqual({ url: 'https://git.example.com/g/p/-/wikis/meeting-x', target: 'wiki' });
  });

  it('updates the wiki page when creation reports it already exists', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      if (calls === 1) return new Response('exists', { status: 400 });
      return json({ content: '…', format: 'markdown', slug: 'meeting-x', title: 't' });
    });
    const r = await createGitlabClient(base).uploadMeeting(meeting, []);
    expect(calls).toBe(2);
    expect(r.url).toBe('https://git.example.com/g/p/-/wikis/meeting-x');
  });

  it('falls back to the issue iid when web_url is absent', async () => {
    vi.stubGlobal('fetch', async () => json({ iid: 42 }));
    const r = await createGitlabClient({ ...base, target: 'issue' }).uploadMeeting(meeting, []);
    expect(r).toEqual({ url: 'https://git.example.com/g/p/-/issues/42', target: 'issue' });
  });

  it('builds the file URL inside the per-meeting folder', async () => {
    vi.stubGlobal('fetch', async () => json({ file_path: 'meetings/weekly-planning-q3-000000/transcript.md', branch: 'main' }, 201));
    const r = await createGitlabClient({ ...base, target: 'file' }).uploadMeeting(meeting, []);
    expect(r).toEqual({
      url: 'https://git.example.com/g/p/-/blob/main/meetings/weekly-planning-q3-000000/transcript.md',
      target: 'file',
    });
  });

  it('updates the file when the path already exists', async () => {
    const methods: string[] = [];
    vi.stubGlobal('fetch', async (_u: unknown, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET');
      if (methods.length === 1) return new Response('exists', { status: 400 });
      return json({ file_path: 'meetings/weekly-planning-q3-000000/transcript.md', branch: 'main' });
    });
    const r = await createGitlabClient({ ...base, target: 'file' }).uploadMeeting(meeting, []);
    expect(methods).toEqual(['POST', 'PUT']);
    expect(r.url).toContain('/transcript.md');
  });

  it('never returns an undefined URL for any target', async () => {
    vi.stubGlobal('fetch', async () => json({}));
    for (const target of ['wiki', 'issue', 'file'] as const) {
      const r = await createGitlabClient({ ...base, target }).uploadMeeting(meeting, []);
      expect(typeof r.url).toBe('string');
    }
  });
});

describe('per-meeting folders and summary upload', () => {
  const base: GitlabConfig = {
    url: 'https://git.example.com',
    project: 'g/p',
    token: 't',
    target: 'file',
    branch: 'main',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  afterEach(() => vi.unstubAllGlobals());

  const summarized: Meeting = {
    ...meeting,
    summary: {
      text: 'They agreed to ship.',
      keyPoints: ['Ship on Friday', 'Anna owns docs'],
      model: 'opencode/x',
      createdAt: Date.UTC(2026, 0, 2, 12, 0, 0),
    },
  };

  it('derives a stable folder from title plus id suffix', () => {
    expect(meetingFolder(meeting)).toBe('meetings/weekly-planning-q3-000000');
    expect(meetingFolder({ ...meeting, id: 'other-id-9' })).not.toBe(meetingFolder(meeting));
  });

  it('renders summary markdown with text, bullets and model', () => {
    const md = summaryMarkdown(summarized);
    expect(md).toContain('# Summary: Weekly / planning: Q3');
    expect(md).toContain('They agreed to ship.');
    expect(md).toContain('- Ship on Friday');
    expect(md).toContain('opencode/x');
  });

  it('refuses summary upload without a summary', async () => {
    await expect(createGitlabClient(base).uploadSummary(meeting)).rejects.toThrow(/summarize/i);
  });

  it('refuses summary upload for the issue target', async () => {
    await expect(
      createGitlabClient({ ...base, target: 'issue' }).uploadSummary(summarized),
    ).rejects.toThrow(/wiki page or repository file/i);
  });

  it('writes summary.md into the meeting folder', async () => {
    let seenUrl = '';
    vi.stubGlobal('fetch', async (u: string) => {
      seenUrl = u;
      return json({ file_path: 'meetings/weekly-planning-q3-000000/summary.md', branch: 'main' }, 201);
    });
    const r = await createGitlabClient(base).uploadSummary(summarized);
    expect(seenUrl).toContain(
      '/repository/files/meetings%2Fweekly-planning-q3-000000%2Fsummary.md',
    );
    expect(r).toEqual({
      url: 'https://git.example.com/g/p/-/blob/main/meetings/weekly-planning-q3-000000/summary.md',
      target: 'file',
    });
  });
});
