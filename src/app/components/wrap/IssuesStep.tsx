import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../store.tsx';
import type { Meeting } from '../../../domain/meeting';
import { pendingTargets } from '../../../domain/wrapup';
import { createGitlabClient, type IssueOverride } from '../../../integrations/gitlab';
import { wrapPrefs } from '../../preferences';
import { gitlabReady, openLink } from './SummaryStep.tsx';

/**
 * GitLab issues from the action items routed there: editable title, the
 * assignee (matched by name by default) and labels, then one click creates
 * them. Shows the issues already made with their open/closed state.
 */
export function IssuesStep({
  m,
  onError,
  onCreated,
  showCreated = true,
}: {
  m: Meeting;
  onError: (e: string) => void;
  onCreated?: () => void;
  showCreated?: boolean;
}): React.JSX.Element {
  const { gitlabConfig, createGitlabActionIssues, go, issueStates, refreshIssueStates } = useApp();
  const ready = gitlabReady(gitlabConfig);
  const pending = pendingTargets(m, wrapPrefs().pretick).gitlab;
  const [overrides, setOverrides] = useState<Record<string, IssueOverride>>({});
  const [members, setMembers] = useState<Array<{ id: number; username: string; name: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const created = m.gitlabActionIssues ?? [];
  const states = issueStates[m.id];
  const defaultLabels = gitlabConfig.labels ?? 'local-transcribe, action-item';

  useEffect(() => {
    if (!ready || pending.length === 0) return;
    let stop = false;
    createGitlabClient(gitlabConfig)
      .listMembers()
      .then((list) => !stop && setMembers(list))
      .catch(() => !stop && setMembers([]));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, gitlabConfig, pending.length > 0]);

  const memberFor = useMemo(
    () => (owner?: string) => {
      if (!owner || !members) return undefined;
      const n = owner.trim().toLowerCase();
      const hit = members.filter((x) => x.username.toLowerCase() === n || x.name.toLowerCase() === n || x.name.toLowerCase().split(' ')[0] === n);
      return hit.length === 1 ? hit[0] : undefined;
    },
    [members],
  );

  if (!ready) {
    return (
      <p className="muted">
        GitLab is not connected yet.{' '}
        <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'integrations' })}>
          Connect GitLab
        </button>{' '}
        to turn action items into issues.
      </p>
    );
  }

  const setO = (text: string, patch: IssueOverride): void => setOverrides((o) => ({ ...o, [text]: { ...o[text], ...patch } }));

  return (
    <div className="issues-step">
      {pending.length > 0 ? (
        <>
          <div className="draft-table" role="table" aria-label="Issues to create">
            <div className="draft-head" role="row">
              <span role="columnheader">Title</span>
              <span role="columnheader">Assignee</span>
              <span role="columnheader">Label</span>
            </div>
            {pending.map((a) => {
              const o = overrides[a.text] ?? {};
              const guess = memberFor(a.owner);
              return (
                <div key={a.text} className="draft-row" role="row">
                  <input
                    className="input"
                    aria-label="Issue title"
                    value={o.title ?? a.task}
                    onChange={(e) => setO(a.text, { title: e.target.value })}
                  />
                  <select
                    className="input"
                    aria-label="Assignee"
                    value={o.assigneeId === undefined ? 'auto' : String(o.assigneeId)}
                    onChange={(e) => setO(a.text, { assigneeId: e.target.value === 'auto' ? undefined : Number(e.target.value) })}
                  >
                    <option value="auto">
                      {a.owner ? (guess ? `${guess.name} (@${guess.username})` : `${a.owner} (match by name)`) : 'Nobody'}
                    </option>
                    <option value="0">Nobody</option>
                    {(members ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} (@{x.username})
                      </option>
                    ))}
                  </select>
                  <input
                    className="input"
                    aria-label="Label"
                    value={o.labels ?? defaultLabels}
                    onChange={(e) => setO(a.text, { labels: e.target.value })}
                  />
                </div>
              );
            })}
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                createGitlabActionIssues(m.id, pending.map((a) => a.text), overrides)
                  .then(() => {
                    setOverrides({});
                    onCreated?.();
                  })
                  .catch((e: unknown) => {
                    const n = (e as { created?: unknown[] }).created?.length ?? 0;
                    onError(`${n ? `Created ${n} issue${n === 1 ? '' : 's'}, then: ` : ''}${e instanceof Error ? e.message : String(e)}`);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Creating issues…' : `Create ${pending.length} issue${pending.length === 1 ? '' : 's'}`}
            </button>
            <span className="muted small self-center">in {gitlabConfig.project}</span>
          </div>
        </>
      ) : (
        <p className="muted mt-0">
          {created.length ? 'Every action item routed to GitLab has an issue.' : 'No action items are routed to GitLab — tick GitLab next to an item in the summary.'}
        </p>
      )}
      {showCreated && created.length > 0 && (
        <>
          <div className="row between wrap mt-4">
            <h4 className="sub-head mb-0">Issues from this meeting</h4>
            <span className="row">
              <span className="muted small">
                {states ? `status refreshed ${Math.max(0, Math.round((Date.now() - states.at) / 60000))} min ago` : 'status not checked yet'}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={refreshing}
                onClick={() => {
                  setRefreshing(true);
                  refreshIssueStates(m.id)
                    .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setRefreshing(false));
                }}
              >
                {refreshing ? 'Refreshing…' : 'Refresh status'}
              </button>
            </span>
          </div>
          <ul className="issue-list" aria-label="Created issues">
            {created.map((i) => {
              const st = i.iid !== undefined ? states?.states[i.iid] : undefined;
              return (
                <li key={i.url} className="issue-row">
                  <a className="issue-num" href={i.url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, i.url)}>
                    {i.iid !== undefined ? `#${i.iid}` : 'Issue'}
                  </a>
                  <span className="grow">
                    {i.item}
                    {i.assignee && <small className="muted"> · @{i.assignee}</small>}
                  </span>
                  <span className={`pill ${st === 'closed' ? 'pill-completed' : ''}`}>{st === 'closed' ? 'closed' : st === 'opened' ? 'open' : 'created'}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}
