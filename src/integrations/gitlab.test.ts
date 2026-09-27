import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GITLAB_CONFIG,
  apiBase,
  createGitlabClient,
  encodeProject,
  meetingMarkdown,
  meetingPageTitle,
  slugify,
} from './gitlab';
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
