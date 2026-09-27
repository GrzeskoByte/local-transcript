/**
 * Persistence for the GitLab settings. The token never leaves the device:
 * it is stored in the same IndexedDB kv store as the rest of the app settings.
 */

import { db } from '../storage/database';
import { DEFAULT_GITLAB_CONFIG, type GitlabConfig, type GitlabTarget } from './gitlab';

const GITLAB_CONFIG_KEY = 'gitlab-config';

const TARGETS: GitlabTarget[] = ['wiki', 'issue', 'file'];

/** Read the stored config, falling back to defaults field by field. */
export async function getGitlabConfig(): Promise<GitlabConfig> {
  const stored = await db.kvGet<Partial<GitlabConfig>>(GITLAB_CONFIG_KEY);
  if (!stored) return { ...DEFAULT_GITLAB_CONFIG };
  return {
    url: stored.url?.trim() || DEFAULT_GITLAB_CONFIG.url,
    project: stored.project?.trim() || '',
    token: stored.token ?? '',
    target: TARGETS.includes(stored.target as GitlabTarget)
      ? (stored.target as GitlabTarget)
      : DEFAULT_GITLAB_CONFIG.target,
    branch: stored.branch?.trim() || DEFAULT_GITLAB_CONFIG.branch,
  };
}

export async function setGitlabConfig(config: GitlabConfig): Promise<void> {
  await db.kvSet(GITLAB_CONFIG_KEY, config);
}
