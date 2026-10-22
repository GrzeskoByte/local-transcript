import { useState } from 'react';
import { createGitlabClient, type GitlabConfig, type GitlabGroup, type GitlabProject } from '../../integrations/gitlab';
import { logNetwork } from '../../platform/network-log';

/**
 * Pick a GitLab project from the ones the token can see: optionally within
 * one group, filtered by name. With `membersOnly` (Settings, default on) only
 * projects and groups the user belongs to are listed. Nothing is fetched
 * until "Load" is clicked.
 */
export function GitlabProjectPicker({
  config,
  value,
  onChange,
  label = 'Project',
  onGroup,
}: {
  config: GitlabConfig;
  value: string;
  onChange: (path: string) => void;
  label?: string;
  /** Called with the chosen group (or null for "all"), e.g. to load its members. */
  onGroup?: (group: GitlabGroup | null) => void;
}): React.JSX.Element {
  const [groups, setGroups] = useState<GitlabGroup[] | null>(null);
  const [projects, setProjects] = useState<GitlabProject[] | null>(null);
  const [group, setGroup] = useState<number | ''>('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = !!(config.url.trim() && config.token.trim());

  const load = async (groupId: number | '' = group, q = search): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const client = createGitlabClient(config);
      logNetwork(config.url, 'Listed GitLab projects and groups', 'Nothing (read only)');
      if (groups === null) setGroups(await client.listGroups());
      setProjects(await client.listProjects({ search: q, ...(groupId === '' ? {} : { groupId }) }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!ready) return <p className="muted small mb-0">Enter the instance URL and a token to list your projects.</p>;

  if (projects === null) {
    return (
      <div className="row wrap mt-2">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void load()}>
          {busy ? 'Loading…' : config.membersOnly === false ? 'Load projects & groups' : 'Load my projects & groups'}
        </button>
        {error && (
          <span className="warn small" role="alert">
            {error}
          </span>
        )}
      </div>
    );
  }

  const options = value && !projects.some((p) => p.path === value) ? [{ id: -1, path: value, name: value, webUrl: '' }, ...projects] : projects;
  return (
    <div className="gl-picker" role="group" aria-label={`${label} picker`}>
      <label>
        Group
        <select
          className="input"
          aria-label="GitLab group"
          value={group}
          onChange={(e) => {
            const id = e.target.value === '' ? '' : Number(e.target.value);
            setGroup(id);
            onGroup?.(id === '' ? null : (groups?.find((g) => g.id === id) ?? null));
            void load(id);
          }}
        >
          <option value="">{config.membersOnly === false ? 'All visible projects' : 'All my projects'}</option>
          {(groups ?? []).map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter
        <input
          className="input"
          aria-label="Filter projects"
          value={search}
          placeholder="name…"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void load(group, search);
            }
          }}
        />
      </label>
      <label>
        {label}
        <select className="input" aria-label={`GitLab ${label.toLowerCase()}`} value={value} onChange={(e) => onChange(e.target.value)}>
          {!value && <option value="">Choose…</option>}
          {options.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <span className="muted small">
        {busy ? 'Loading…' : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
        {error ? ` · ${error}` : ''}
      </span>
    </div>
  );
}
