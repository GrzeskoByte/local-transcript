/**
 * GitLab integration: publish transcripts to a project as a wiki page, an
 * issue, or a repository file.
 *
 * There is no backend of our own: the GitLab project *is* the shared team
 * space, so access control is whatever GitLab grants the member. The personal
 * access token lives only in this device's IndexedDB (see `gitlab-store.ts`)
 * and is sent straight to the configured instance.
 */

import { bytesToBase64 } from '../asr/wav';
import { segmentsToMarkdown } from '../domain/transcript';
import type { Meeting } from '../domain/meeting';
import type { TranscriptSegment } from '../domain/transcript';

export type GitlabTarget = 'wiki' | 'issue' | 'file';

export interface GitlabConfig {
  /** Instance base URL, e.g. https://gitlab.com or a self-hosted host. */
  url: string;
  /** Project path, e.g. "my-group/my-project". */
  project: string;
  /** Personal access token with `api` scope. */
  token: string;
  target: GitlabTarget;
  /** Branch used for the `file` target. */
  branch: string;
}

export const DEFAULT_GITLAB_CONFIG: GitlabConfig = {
  url: 'https://gitlab.com',
  project: '',
  token: '',
  target: 'wiki',
  branch: 'main',
};

export const GITLAB_TARGET_LABELS: Record<GitlabTarget, string> = {
  wiki: 'Wiki page',
  issue: 'Issue',
  file: 'Repository file',
};

export interface GitlabUploadResult {
  url: string;
  target: GitlabTarget;
}

/** `https://host/` → `https://host/api/v4` (idempotent). */
export function apiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api/v4') ? trimmed : `${trimmed}/api/v4`;
}

/** GitLab wants the project path URL-encoded (`group%2Fproject`). */
export function encodeProject(project: string): string {
  return encodeURIComponent(project.trim());
}

/** Filesystem-safe slug for wiki/file targets. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\w\s-]+/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'meeting';
}

export function meetingPageTitle(meeting: Meeting): string {
  const date = new Date(meeting.startedAt).toISOString().slice(0, 10);
  return `Meeting: ${meeting.title || 'Untitled'} (${date})`;
}

/** Markdown body published to GitLab (transcript + a small metadata header). */
export function meetingMarkdown(meeting: Meeting, segments: TranscriptSegment[]): string {
  const header = [
    `> Imported from Local Transcribe · mode: ${meeting.mode} · duration: ${Math.round(
      (meeting.durationMs || 0) / 1000,
    )}s`,
    '',
  ].join('\n');
  return `${header}${segmentsToMarkdown(meeting.title, meeting.startedAt, segments)}`;
}

export class GitlabClient {
  constructor(private readonly config: GitlabConfig) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${apiBase(this.config.url)}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'PRIVATE-TOKEN': this.config.token,
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `GitLab ${response.status}${response.statusText ? ` ${response.statusText}` : ''}: ${
          body.slice(0, 200) || 'request failed'
        }`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Verify the token and that the project is reachable. */
  async testConnection(): Promise<{ username: string; project: string }> {
    const user = await this.request<{ username: string }>('/user');
    const project = await this.request<{ path_with_namespace: string }>(
      `/projects/${encodeProject(this.config.project)}`,
    );
    return { username: user.username, project: project.path_with_namespace };
  }

  async uploadMeeting(
    meeting: Meeting,
    segments: TranscriptSegment[],
  ): Promise<GitlabUploadResult> {
    const title = meetingPageTitle(meeting);
    const content = meetingMarkdown(meeting, segments);
    switch (this.config.target) {
      case 'wiki':
        return this.uploadWiki(title, content);
      case 'issue':
        return this.uploadIssue(title, content);
      case 'file':
        return this.uploadFile(title, content);
    }
  }

  private async uploadWiki(title: string, content: string): Promise<GitlabUploadResult> {
    const project = encodeProject(this.config.project);
    const slug = slugify(title);
    try {
      const page = await this.request<{ web_url: string }>(`/projects/${project}/wikis`, {
        method: 'POST',
        body: JSON.stringify({ title, content, format: 'markdown' }),
      });
      return { url: page.web_url, target: 'wiki' };
    } catch {
      // Already exists → update the page instead.
      const page = await this.request<{ web_url: string }>(
        `/projects/${project}/wikis/${encodeURIComponent(slug)}`,
        { method: 'PUT', body: JSON.stringify({ title, content, format: 'markdown' }) },
      );
      return { url: page.web_url, target: 'wiki' };
    }
  }

  private async uploadIssue(title: string, content: string): Promise<GitlabUploadResult> {
    const issue = await this.request<{ web_url: string }>(
      `/projects/${encodeProject(this.config.project)}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({ title, description: content, labels: 'local-transcribe' }),
      },
    );
    return { url: issue.web_url, target: 'issue' };
  }

  private async uploadFile(title: string, content: string): Promise<GitlabUploadResult> {
    const project = encodeProject(this.config.project);
    const path = `meetings/${slugify(title)}.md`;
    const file = await this.request<{ web_url?: string }>(
      `/projects/${project}/repository/files/${encodeURIComponent(path)}`,
      {
        method: 'POST',
        body: JSON.stringify({
          branch: this.config.branch || 'main',
          content: bytesToBase64(new TextEncoder().encode(content)),
          encoding: 'base64',
          commit_message: `Add transcript: ${title}`,
        }),
      },
    );
    return {
      url: file.web_url ?? `${apiBase(this.config.url).replace('/api/v4', '')}/${this.config.project}/-/blob/${this.config.branch}/${path}`,
      target: 'file',
    };
  }
}

/** Convenience factory that validates the config first. */
export function createGitlabClient(config: GitlabConfig): GitlabClient {
  const missing = (['url', 'project', 'token'] as const).filter((key) => !config[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`GitLab settings incomplete: ${missing.join(', ')}`);
  }
  return new GitlabClient(config);
}
