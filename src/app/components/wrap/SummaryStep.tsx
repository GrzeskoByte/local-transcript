import { useState } from 'react';
import { useApp } from '../../store.tsx';
import type { Meeting } from '../../../domain/meeting';
import { actionItemsOf, parseActionItem } from '../../../domain/action-items';
import { eventFor, issueFor, issueStateKey, routesOf } from '../../../domain/wrapup';
import { claudeResumeCommand, llmConfigProblem } from '../../../integrations/llm';
import { summaryMarkdown } from '../../../integrations/gitlab';
import { validateCalendarConfig } from '../../../integrations/calendar';
import { wrapPrefs } from '../../preferences';
import { CopyButton } from '../CopyButton.tsx';
import { ConfirmButton } from '../ConfirmButton.tsx';
import { isDesktopApp, openExternalUrl } from '../../../platform/desktop';

export function gitlabReady(c: ReturnType<typeof useApp>['gitlabConfig']): boolean {
  return !!(c.url.trim() && c.project.trim() && c.token.trim());
}

/** Open a GitLab link in the system browser (the webview swallows target=_blank). */
export function openLink(e: React.MouseEvent, url: string): void {
  if (!isDesktopApp()) return;
  e.preventDefault();
  void openExternalUrl(url).catch(() => undefined);
}

/**
 * The summary, editable, and its action items with where each goes (GitLab,
 * the calendar, both or neither). Used by the wrap-up's "Review summary"
 * step and the meeting's Summary tab.
 */
export function SummaryStep({ m, onError }: { m: Meeting; onError: (e: string) => void }): React.JSX.Element {
  const { summarizeMeeting, summarizing, llmConfig, go, saveSummary, setWrapUp, gitlabConfig, calendarConfig, issueStates } = useApp();
  const gitlabIssueStates = issueStates[m.id]?.states;
  const [editing, setEditing] = useState(false);
  const busy = !!summarizing[m.id];
  const problem = llmConfigProblem(llmConfig);
  const s = m.summary;
  const items = actionItemsOf(m);
  const pretick = wrapPrefs().pretick;
  const routes = routesOf(m, pretick);
  const glReady = gitlabReady(gitlabConfig);
  const calReady = validateCalendarConfig(calendarConfig) === null;
  const stale = !!(s && m.transcriptSource && s.createdAt < m.transcriptSource.createdAt);

  const summarize = (): void => {
    summarizeMeeting(m.id).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
  };
  const toggle = (text: string, target: 'gitlab' | 'calendar'): void => {
    void setWrapUp(m.id, (w) => ({
      ...w,
      routes: { ...routes, ...w.routes, [text]: { ...(w.routes[text] ?? routes[text]!), [target]: !(w.routes[text] ?? routes[text]!)[target] } },
    }));
  };

  if (!s && !editing) {
    return (
      <div className="summary-empty">
        {m.transcriptionStatus !== 'completed' ? (
          <p className="muted">The summary is written from the transcript — transcribe first.</p>
        ) : problem ? (
          <>
            <p className="muted mt-0">
              {llmConfig.enabled === false ? 'Summaries are off.' : `No summary engine yet (${problem}).`} Write one yourself,
              or set up summaries.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                Write a summary
              </button>
              <button type="button" className="btn" onClick={() => go({ name: 'settings', tab: 'summaries' })}>
                Set up summaries
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted mt-0">
              Summarize with {llmConfig.model || 'your model'}: a TL;DR, key points and action items you can send to GitLab or
              the calendar.
            </p>
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={summarize}>
                {busy ? 'Summarizing…' : 'Summarize with LLM'}
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
                Write it yourself
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="summary-step">
      {editing ? (
        <SummaryEditor
          m={m}
          onCancel={() => setEditing(false)}
          onSave={(next) => {
            void saveSummary(m.id, next).then(() => setEditing(false));
          }}
        />
      ) : (
        s && (
          <>
            <div className="row wrap summary-tools">
              <span className="badge">{s.model || 'written by you'}</span>
              {s.reviewedAt && <span className="badge badge-ok">reviewed</span>}
              <span className="grow" />
              <CopyButton label="Copy summary" text={() => summaryMarkdown(m)} />
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing(true)}>
                ✎ Edit summary
              </button>
              {!problem && (
                <ConfirmButton
                  className="btn btn-sm"
                  prompt="Write a new summary? Your edits to this one are replaced."
                  confirmLabel="Yes, regenerate"
                  onConfirm={summarize}
                >
                  {busy ? 'Summarizing…' : 'Regenerate'}
                </ConfirmButton>
              )}
            </div>
            {stale && (
              <p className="muted small" role="note">
                Made from an earlier transcript — Regenerate to match the current one.
              </p>
            )}
            <div className="summary-view" title="Double-click to edit" onDoubleClick={() => setEditing(true)}>
            {s.text && <p className="pre-wrap summary-tldr">{s.text}</p>}
            {s.keyPoints.length > 0 && (
              <ul className="summary-points">
                {s.keyPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            )}
            {s.decisions?.length ? (
              <>
                <h4 className="sub-head">Decisions</h4>
                <ul className="summary-points">
                  {s.decisions.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {s.openQuestions?.length ? (
              <>
                <h4 className="sub-head">Open questions</h4>
                <ul className="summary-points">
                  {s.openQuestions.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </>
            ) : null}
            </div>
            {s.sessionId && (
              <p className="muted small">
                Ask follow-up questions in Claude Code: <code className="select-all">{claudeResumeCommand(s.sessionId)}</code>
              </p>
            )}
          </>
        )
      )}
      {items.length > 0 && !editing && (
        <section className="action-routes" aria-label="Action items">
          <h4 className="sub-head">Action items · send each to GitLab, the calendar, both, or neither</h4>
          <ul className="route-list">
            {items.map((a) => {
              const r = routes[a.text]!;
              const issue = issueFor(m, a.text);
              const ev = eventFor(m, a.text);
              const state = issue?.iid !== undefined ? gitlabIssueStates?.[issueStateKey(issue, gitlabConfig.project)] : undefined;
              return (
                <li key={a.text} className="route-row">
                  <div className="grow">
                    <strong>{a.task}</strong>
                    <small className="muted">
                      {' '}
                      {[a.owner, a.due].filter(Boolean).join(' · ') || 'no owner or date'}
                    </small>
                    <div className="route-tags">
                      {issue && (
                        <a className="item-tag" href={issue.url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, issue.url)}>
                          GitLab {issue.iid !== undefined ? `#${issue.iid}` : 'issue'}
                          {state ? ` · ${state === 'opened' ? 'open' : 'closed'}` : ''}
                        </a>
                      )}
                      {ev && <span className="item-tag">[x] calendar {ev.startIso.replace('T', ' ')}</span>}
                    </div>
                  </div>
                  <div className="route-toggles">
                    <button
                      type="button"
                      className="toggle"
                      aria-pressed={!!issue || r.gitlab}
                      disabled={!!issue}
                      title={glReady ? 'Create a GitLab issue for this' : 'GitLab is not set up yet (Settings → GitLab & calendar)'}
                      onClick={() => toggle(a.text, 'gitlab')}
                    >
                      {issue || r.gitlab ? '[x]' : '[ ]'} GitLab
                    </button>
                    <button
                      type="button"
                      className="toggle"
                      aria-pressed={!!ev || r.calendar}
                      disabled={!!ev}
                      title={calReady ? 'Add a calendar event for this' : 'The calendar is not set up yet (Settings → GitLab & calendar)'}
                      onClick={() => toggle(a.text, 'calendar')}
                    >
                      {ev || r.calendar ? '[x]' : '[ ]'} Calendar
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {(!glReady || !calReady) && (
            <p className="muted small mb-0">
              {!glReady && !calReady ? 'GitLab and the calendar are' : !glReady ? 'GitLab is' : 'The calendar is'} not set up
              yet —{' '}
              <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'integrations' })}>
                connect {!glReady && !calReady ? 'them' : 'it'}
              </button>{' '}
              to send action items there.
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/** One editable list: a row per item with remove, reorder and "+ Add"; Enter adds the next row. */
function ListEditor({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
}): React.JSX.Element {
  const set = (i: number, v: string): void => onChange(items.map((x, j) => (j === i ? v : x)));
  const focusRow = (i: number): void => {
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-list="${label}"][data-row="${i}"]`)?.focus());
  };
  return (
    <fieldset className="list-editor">
      <legend className="field-label">{label}</legend>
      {items.map((it, i) => (
        <div key={i} className="list-row">
          <span className="list-bullet" aria-hidden="true">•</span>
          <input
            className="input"
            aria-label={`${label} ${i + 1}`}
            data-list={label}
            data-row={i}
            value={it}
            placeholder={placeholder}
            onChange={(e) => set(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onChange([...items.slice(0, i + 1), '', ...items.slice(i + 1)]);
                focusRow(i + 1);
              } else if (e.key === 'Backspace' && !it && items.length > 0) {
                e.preventDefault();
                onChange(items.filter((_, j) => j !== i));
                focusRow(Math.max(0, i - 1));
              }
            }}
          />
          <button type="button" className="icon-btn" aria-label={`Move ${label} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(items.map((x, j) => (j === i - 1 ? items[i]! : j === i ? items[i - 1]! : x)))}>
            ↑
          </button>
          <button type="button" className="icon-btn" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          onChange([...items, '']);
          focusRow(items.length);
        }}
      >
        + Add {label.toLowerCase().replace(/s$/, '')}
      </button>
    </fieldset>
  );
}

interface ActionRow {
  owner: string;
  task: string;
  due: string;
}

const toRow = (text: string): ActionRow => {
  const a = parseActionItem(text);
  return { owner: a.owner ?? '', task: a.task, due: a.due ?? '' };
};
/** Back to the summary's "Owner: task (due)" line. */
export const fromRow = (r: ActionRow): string =>
  `${r.owner.trim() || 'Unassigned'}: ${r.task.trim()}${r.due.trim() ? ` (${r.due.trim()})` : ''}`;

function SummaryEditor({
  m,
  onSave,
  onCancel,
}: {
  m: Meeting;
  onSave: (s: NonNullable<Meeting['summary']>) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const s = m.summary;
  const { meetingParticipants } = useApp();
  const people = meetingParticipants(m.id);
  const [tldr, setTldr] = useState(s?.text ?? '');
  const [points, setPoints] = useState<string[]>(s?.keyPoints ?? []);
  const [decisions, setDecisions] = useState<string[]>(s?.decisions ?? []);
  const [actions, setActions] = useState<ActionRow[]>((s?.actionItems ?? []).map(toRow));
  const [questions, setQuestions] = useState<string[]>(s?.openQuestions ?? []);
  const clean = (xs: string[]): string[] => xs.map((x) => x.trim()).filter(Boolean);
  const setA = (i: number, patch: Partial<ActionRow>): void => setActions((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <form
      className="summary-editor"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          (e.currentTarget as HTMLFormElement).requestSubmit();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave({
          text: tldr.trim(),
          keyPoints: clean(points),
          decisions: clean(decisions),
          actionItems: actions.filter((a) => a.task.trim()).map(fromRow),
          openQuestions: clean(questions),
          model: s?.model ?? '',
          createdAt: s?.createdAt ?? Date.now(),
          reviewedAt: Date.now(),
          ...(s?.sessionId ? { sessionId: s.sessionId } : {}),
        });
      }}
    >
      <p className="muted small mt-0">Edit any line. Enter adds a row, Backspace on an empty row removes it, Ctrl+Enter saves, Esc cancels.</p>
      <label className="field-label mt-0" htmlFor="sum-tldr">
        TL;DR
      </label>
      <textarea id="sum-tldr" className="input" rows={2} value={tldr} onChange={(e) => setTldr(e.target.value)} placeholder="One or two sentences." />
      <ListEditor label="Key points" items={points} onChange={setPoints} placeholder="What was said or agreed" />
      <ListEditor label="Decisions" items={decisions} onChange={setDecisions} placeholder="What was decided" />
      <fieldset className="list-editor">
        <legend className="field-label">Action items</legend>
        {actions.length > 0 && (
          <div className="action-head" aria-hidden="true">
            <span>Owner</span>
            <span>Task</span>
            <span>Due</span>
          </div>
        )}
        <datalist id="sum-people">
          {people.map((p) => (
            <option key={p.username ?? p.name} value={p.name} />
          ))}
        </datalist>
        {actions.map((a, i) => (
          <div key={i} className="action-row">
            <input className="input" list="sum-people" aria-label={`Owner of action item ${i + 1}`} placeholder="Unassigned" value={a.owner} onChange={(e) => setA(i, { owner: e.target.value })} />
            <input className="input" aria-label={`Action item ${i + 1}`} placeholder="What needs doing" value={a.task} onChange={(e) => setA(i, { task: e.target.value })} />
            <input className="input" aria-label={`Due date of action item ${i + 1}`} placeholder="e.g. 2026-11-03 or Friday" value={a.due} onChange={(e) => setA(i, { due: e.target.value })} />
            <button type="button" className="icon-btn" aria-label={`Remove action item ${i + 1}`} onClick={() => setActions((xs) => xs.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <button type="button" className="link-btn" onClick={() => setActions((xs) => [...xs, { owner: '', task: '', due: '' }])}>
          + Add action item
        </button>
      </fieldset>
      <ListEditor label="Open questions" items={questions} onChange={setQuestions} placeholder="Still to be answered" />
      <div className="btn-row">
        <button type="submit" className="btn btn-primary">
          Save summary
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
