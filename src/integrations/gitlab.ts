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

/** Instance root without the /api/v4 suffix, e.g. https://git.example.com. */
export function instanceRoot(url: string): string {
  return apiBase(url).replace(/\/api\/v4$/, '');
}

/**
 * Split a "project path" field that may be a bare path (`group/project`) or a
 * full project URL (`https://git.example.com/group/project`, possibly with a
 * `/-/…` suffix or `.git`). Returns the instance origin (or null when the
 * input carries none — keep the configured instance then) plus the path.
 */
export function parseProjectUrl(input: string): { url: string | null; project: string } {
  const trimmed = input.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : null;
  const bareHost = !withScheme && /^[^/\s]+\.[^/\s]+(\/\S*)?$/.test(trimmed) ? trimmed : null;
  const absolute = withScheme ?? (bareHost ? `https://${bareHost}` : null);
  if (!absolute) return { url: null, project: trimmed };
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return { url: null, project: trimmed };
  }
  // Drop GitLab UI suffixes: /-/wikis, /-/issues, /-/blob/…, and a .git suffix.
  let path = parsed.pathname.replace(/\/-\/.*$/, '').replace(/\.git$/, '').replace(/^\/+|\/+$/g, '');
  if (!path) return { url: parsed.origin, project: '' };
  return { url: parsed.origin, project: path };
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

/** Per-meeting repository folder: `meetings/<title-slug>-<id suffix>/`. */
export function meetingFolder(meeting: Meeting): string {
  const suffix = meeting.id.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase() || 'meeting';
  return `meetings/${slugify(meeting.title || 'meeting')}-${suffix}`;
}

/** Markdown body for the summary upload. Throws when there is no summary yet. */
export function summaryMarkdown(meeting: Meeting): string {
  const summary = meeting.summary;
  if (!summary) throw new Error('Summarize the meeting before uploading its summary');
  const date = new Date(summary.createdAt).toISOString().slice(0, 10);
  return [
    `# Summary: ${meeting.title || 'Untitled'}`,
    '',
    summary.text,
    '',
    '## Key points',
    '',
    ...summary.keyPoints.map((p) => `- ${p}`),
    '',
    `> Summarized with ${summary.model} on ${date}`,
  ].join('\n');
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
        return this.uploadFile(meeting, content);
    }
  }

  /**
   * Upload the meeting summary next to the transcript: `summary.md` in the
   * meeting's folder (`file`), or a companion wiki page. Issues have no
   * folder, so that target is rejected with a clear message.
   */
  async uploadSummary(meeting: Meeting): Promise<GitlabUploadResult> {
    const content = summaryMarkdown(meeting);
    const title = meetingPageTitle(meeting);
    switch (this.config.target) {
      case 'file':
        return this.uploadFile(meeting, content, 'summary.md', `Add summary: ${title}`);
      case 'wiki':
        return this.uploadWiki(`${title} — Summary`, content);
      case 'issue':
        throw new Error('Summary upload needs the Wiki page or Repository file target');
    }
  }

  /** Wiki page URL — the API never returns one, so build it from the slug. */
  private wikiUrl(slug: string): string {
    const project = this.config.project.trim().replace(/^\/+|\/+$/g, '');
    return `${instanceRoot(this.config.url)}/${project}/-/wikis/${encodeURIComponent(slug)}`;
  }

  private async uploadWiki(title: string, content: string): Promise<GitlabUploadResult> {
    const project = encodeProject(this.config.project);
    const slug = slugify(title);
    const saved = (page: { slug?: string }): GitlabUploadResult => ({
      url: this.wikiUrl(page.slug || slug),
      target: 'wiki',
    });
    try {
      const page = await this.request<{ slug?: string }>(`/projects/${project}/wikis`, {
        method: 'POST',
        body: JSON.stringify({ title, content, format: 'markdown' }),
      });
      return saved(page);
    } catch {
      // Already exists → update the page instead.
      const page = await this.request<{ slug?: string }>(
        `/projects/${project}/wikis/${encodeURIComponent(slug)}`,
        { method: 'PUT', body: JSON.stringify({ title, content, format: 'markdown' }) },
      );
      return saved(page);
    }
  }

  private async uploadIssue(title: string, content: string): Promise<GitlabUploadResult> {
    const project = this.config.project.trim().replace(/^\/+|\/+$/g, '');
    const issue = await this.request<{ web_url?: string; iid?: number }>(
      `/projects/${encodeProject(this.config.project)}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({ title, description: content, labels: 'local-transcribe' }),
      },
    );
    return {
      url: issue.web_url ?? `${instanceRoot(this.config.url)}/${project}/-/issues/${issue.iid}`,
      target: 'issue',
    };
  }

  /** Create-or-update a repository file; POST fails when the path exists. */
  private async upsertFile(
    path: string,
    content: string,
    commitMessage: string,
  ): Promise<{ web_url?: string; file_path?: string }> {
    const project = encodeProject(this.config.project);
    const branch = this.config.branch || 'main';
    const encoded = encodeURIComponent(path);
    const body = JSON.stringify({
      branch,
      content: bytesToBase64(new TextEncoder().encode(content)),
      encoding: 'base64',
      commit_message: commitMessage,
    });
    try {
      return await this.request<{ web_url?: string; file_path?: string }>(
        `/projects/${project}/repository/files/${encoded}`,
        { method: 'POST', body },
      );
    } catch {
      // Already exists → update the file instead.
      return await this.request<{ web_url?: string; file_path?: string }>(
        `/projects/${project}/repository/files/${encoded}`,
        { method: 'PUT', body },
      );
    }
  }

  private fileUrl(filePath: string, webUrl: string | undefined): string {
    const branch = this.config.branch || 'main';
    const basePath = this.config.project.trim().replace(/^\/+|\/+$/g, '');
    return webUrl ?? `${instanceRoot(this.config.url)}/${basePath}/-/blob/${branch}/${filePath}`;
  }

  private async uploadFile(
    meeting: Meeting,
    content: string,
    name = 'transcript.md',
    commitPrefix = '',
  ): Promise<GitlabUploadResult> {
    const title = meetingPageTitle(meeting);
    const path = `${meetingFolder(meeting)}/${name}`;
    const file = await this.upsertFile(path, content, `${commitPrefix || 'Add transcript:'} ${title}`);
    return { url: this.fileUrl(file.file_path ?? path, file.web_url), target: 'file' };
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
