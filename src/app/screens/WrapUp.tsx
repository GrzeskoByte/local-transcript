import { useEffect, useRef, useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import type { WrapStepId } from '../../domain/meeting';
import { WRAP_STEP_LABELS, pendingTargets, wrapSteps } from '../../domain/wrapup';
import { formatClock } from '../../audio/player';
import { llmConfigProblem } from '../../integrations/llm';
import { CALENDAR_PROVIDER_LABELS, validateCalendarConfig } from '../../integrations/calendar';
import { SummaryStep, gitlabReady } from '../components/wrap/SummaryStep.tsx';
import { IssuesStep } from '../components/wrap/IssuesStep.tsx';
import { EventsStep } from '../components/wrap/EventsStep.tsx';
import { ExportStep } from '../components/wrap/ExportStep.tsx';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { enabledWrapSteps, usePrefsVersion, wrapPrefs } from '../preferences';
import { folderName } from '../../features/meetings/disk-sync';

/**
 * After Stop (DESIGN.md "After Stop — guided wrap-up"): Transcribe → Review
 * summary → GitLab issues → Calendar events → Export, one step at a time,
 * every step skippable. The same steps stay as tabs on the meeting, and Home
 * lists what is left.
 */
export function WrapUp({ id, step }: { id: string; step?: WrapStepId }): React.JSX.Element {
  const {
    detailMeeting, detailSegments, loadDetail, go, txProgress, txStage, setupAndTranscribe, installedModels, setWrapUp,
    summarizeMeeting, summarizing, llmConfig, gitlabConfig, calendarConfig, saveSummary, storageDir,
  } = useApp();
  usePrefsVersion();
  const [error, setError] = useState<string | null>(null);
  const autoSummarized = useRef(false);

  useEffect(() => {
    void loadDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const m = detailMeeting && detailMeeting.id === id ? detailMeeting : null;
  const prefs = wrapPrefs();
  const enabled = enabledWrapSteps(prefs);
  const progress = txProgress[id];
  const steps = m ? wrapSteps(m, enabled, { progress, pretick: prefs.pretick }) : [];
  const current: WrapStepId =
    step && steps.some((s) => s.id === step) ? step : (steps.find((s) => s.state === 'todo' || s.state === 'running')?.id ?? 'export');
  const index = steps.findIndex((s) => s.id === current);
  const goStep = (s: WrapStepId | undefined): void => {
    if (!s) return go({ name: 'detail', id });
    go({ name: 'wrapup', id, step: s });
  };
  const next = steps[index + 1]?.id;
  const prev = steps[index - 1]?.id;
  const mark = (s: WrapStepId, status: 'done' | 'skipped'): Promise<unknown> =>
    setWrapUp(id, (w) => ({ ...w, steps: { ...w.steps, [s]: status } }));

  // Entering "Review summary" with a summary engine set up: write it right away.
  useEffect(() => {
    if (!m || current !== 'summary' || m.summary || autoSummarized.current) return;
    if (m.transcriptionStatus !== 'completed' || llmConfigProblem(llmConfig) || summarizing[m.id]) return;
    autoSummarized.current = true;
    summarizeMeeting(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [m, current, llmConfig, summarizing, summarizeMeeting]);

  if (!m) return <p className="muted">Loading…</p>;
  const pending = pendingTargets(m, prefs.pretick);
  const busyTx = m.transcriptionStatus === 'processing' || txStage[id] !== undefined;
  const txDone = m.transcriptionStatus === 'completed';
  const issues = m.gitlabActionIssues ?? [];
  const events = m.calendarEvents ?? [];
  const marks = m.wrapUp?.steps ?? {};
  const log: Array<{ mark: string; text: string }> = [
    { mark: '[x]', text: `Recorded ${formatDuration(m.durationMs)}${m.mode === 'dual' ? ' · mic + system mixed' : ''}` },
  ];
  if (txDone) log.push({ mark: '[x]', text: `Transcribed · ${detailSegments.length} line${detailSegments.length === 1 ? '' : 's'}` });
  if (marks.summary === 'done' || m.summary?.reviewedAt) log.push({ mark: '[x]', text: 'Summary reviewed' });
  else if (marks.summary === 'skipped') log.push({ mark: '[–]', text: 'Summary skipped' });
  if (issues.length) {
    const nums = issues.map((i) => i.iid).filter((n): n is number => n !== undefined).sort((a, b) => a - b);
    log.push({ mark: '[x]', text: `${issues.length} GitLab issue${issues.length === 1 ? '' : 's'}${nums.length ? ` · #${nums[0]}${nums.length > 1 ? `–#${nums[nums.length - 1]}` : ''}` : ''}` });
  } else if (marks.gitlab === 'skipped') log.push({ mark: '[–]', text: 'GitLab skipped' });
  if (events.length) log.push({ mark: '[x]', text: `${events.length} calendar event${events.length === 1 ? '' : 's'}` });
  else if (marks.calendar === 'skipped') log.push({ mark: '[–]', text: 'Calendar skipped' });
  if (m.exports) log.push({ mark: '[x]', text: `${Object.keys(m.exports).length} file${Object.keys(m.exports).length === 1 ? '' : 's'} saved${m.gitlabSummary ? ' · wiki updated' : ''}` });
  else if (marks.export === 'skipped') log.push({ mark: '[–]', text: 'Export skipped' });
  const recent = detailSegments.slice(-3);
  const onError = (e: string): void => setError(e);

  return (
    <>
      <header className="page-head wrap-head">
        <div>
          <span className="saved-tag">[x] Saved · {formatDuration(m.durationMs)}</span>
          <h1>{m.title}</h1>
        </div>
        <button type="button" className="btn" onClick={() => go({ name: 'home' })}>
          Do the rest later
        </button>
      </header>

      <nav className="wrap-steps" aria-label="Wrap-up steps">
        {steps.map((s, i) => (
          <button
            key={s.id}
            type="button"
            className={`wrap-step ${s.id === current ? 'now' : s.state === 'done' ? 'done' : s.state === 'skipped' ? 'skipped' : 'next'}`}
            aria-current={s.id === current ? 'step' : undefined}
            onClick={() => goStep(s.id)}
          >
            <span className="wrap-n">{s.state === 'done' ? '✓' : s.state === 'skipped' ? '–' : i + 1}</span>
            <span className="wrap-name">{WRAP_STEP_LABELS[s.id]}</span>
            <span className="wrap-sub">{s.detail}</span>
          </button>
        ))}
      </nav>

      <div className="wrap-grid">
        <div className="wrap-main">
          {current === 'transcribe' && (
            <section className="card wrap-card" aria-label="Transcribing">
              <div className="card-title">
                <strong>1 · Transcribe</strong>
                {busyTx && <span className="muted">{Math.round((progress ?? 0) * 100)}%</span>}
              </div>
              <h2 className="wrap-h">{txDone ? 'Transcript ready.' : busyTx ? 'Turning speech into text…' : m.transcriptionStatus === 'failed' ? 'Transcription failed.' : 'Transcribe this meeting.'}</h2>
              <div className="row wrap">
                <span className="pill pill-completed">Audio saved</span>
                <span className={`pill ${txDone ? 'pill-completed' : busyTx ? 'pill-processing' : 'pill-idle'}`}>{txDone ? 'Transcribed' : busyTx ? 'Transcribing' : 'Not started'}</span>
              </div>
              {busyTx && <progress value={progress ?? 0} max={1} aria-label="Transcription progress" />}
              <ModelDownloadProgress />
              {m.transcriptionStatus === 'failed' && (
                <p className="muted">
                  {m.transcriptionError ? `Reason: ${m.transcriptionError}. ` : ''}Your original recording is still safe.
                </p>
              )}
              <p className="muted small">Runs in the background — you can leave this screen or start another recording.</p>
              {recent.length > 0 && (
                <ul className="transcript flat">
                  {recent.map((s) => (
                    <li key={s.id}>
                      <span className="ts">{formatClock(s.startMs / 1000)}</span>
                      {s.text}
                    </li>
                  ))}
                </ul>
              )}
              <div className="btn-row">
                {!txDone && !busyTx && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void setupAndTranscribe(id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
                  >
                    {m.transcriptionStatus === 'failed' ? 'Retry' : installedModels.length ? 'Transcribe' : 'Download model & transcribe'}
                  </button>
                )}
                {txDone && next && (
                  <button type="button" className="btn btn-primary" onClick={() => goStep(next)}>
                    {next === 'summary' ? 'Review summary' : WRAP_STEP_LABELS[next]} →
                  </button>
                )}
                {txDone && !next && (
                  <button type="button" className="btn btn-primary" onClick={() => go({ name: 'detail', id })}>
                    Open meeting →
                  </button>
                )}
              </div>
            </section>
          )}

          {current === 'summary' && (
            <section className="card wrap-card" aria-label="Summary and action items">
              <div className="card-title">
                <strong>{index + 1} · Review summary</strong>
                <span className="muted">{m.summary?.model || llmConfig.model || 'you'} · edit anything</span>
              </div>
              <h2 className="wrap-h">Decide what happens next.</h2>
              {summarizing[m.id] && (
                <div className="loader" role="status">
                  <div className="loader-head">
                    <span className="spinner" aria-hidden="true" />
                    <strong>Writing the summary…</strong>
                  </div>
                </div>
              )}
              <SummaryStep m={m} onError={onError} />
              <div className="btn-row wrap-nav">
                {prev && (
                  <button type="button" className="btn" onClick={() => goStep(prev)}>
                    ← Back
                  </button>
                )}
                <span className="grow" />
                {enabled.includes('export') && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void setWrapUp(id, (w) => ({
                        ...w,
                        steps: { ...w.steps, summary: w.steps.summary ?? 'skipped', gitlab: w.steps.gitlab ?? 'skipped', calendar: w.steps.calendar ?? 'skipped' },
                      })).then(() => goStep('export'))
                    }
                  >
                    Skip to export
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() =>
                    void (async () => {
                      if (m.summary && !m.summary.reviewedAt) await saveSummary(id, { ...m.summary, reviewedAt: Date.now() });
                      await mark('summary', m.summary ? 'done' : 'skipped');
                      goStep(next);
                    })()
                  }
                >
                  {next === 'gitlab'
                    ? `${pending.gitlab.length} to GitLab →`
                    : next === 'calendar'
                      ? `${pending.calendar.length} to calendar →`
                      : next
                        ? `${WRAP_STEP_LABELS[next]} →`
                        : 'Done →'}
                </button>
              </div>
            </section>
          )}

          {current === 'gitlab' && (
            <section className="card wrap-card" aria-label="GitLab issues">
              <div className="card-title">
                <strong>{index + 1} · GitLab issues</strong>
                {gitlabReady(gitlabConfig) && <span className="muted">{gitlabConfig.url.replace(/^https?:\/\//, '')} · {gitlabConfig.project}</span>}
              </div>
              <h2 className="wrap-h">
                {pending.gitlab.length
                  ? `${pending.gitlab.length} issue${pending.gitlab.length === 1 ? '' : 's'} to create.`
                  : issues.length
                    ? `${issues.length} issue${issues.length === 1 ? '' : 's'} created.`
                    : 'Nothing for GitLab.'}
              </h2>
              <IssuesStep m={m} onError={onError} onCreated={() => void mark('gitlab', 'done')} />
              <div className="btn-row wrap-nav">
                {prev && (
                  <button type="button" className="btn" onClick={() => goStep(prev)}>
                    ← Back
                  </button>
                )}
                <span className="grow" />
                {pending.gitlab.length > 0 ? (
                  <button type="button" className="btn" onClick={() => void mark('gitlab', 'skipped').then(() => goStep(next))}>
                    Skip
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => void mark('gitlab', issues.length ? 'done' : 'skipped').then(() => goStep(next))}>
                    {next === 'calendar' ? `${pending.calendar.length} to calendar →` : next ? `${WRAP_STEP_LABELS[next]} →` : 'Done →'}
                  </button>
                )}
              </div>
            </section>
          )}

          {current === 'calendar' && (
            <section className="card wrap-card" aria-label="Calendar events">
              <div className="card-title">
                <strong>{index + 1} · Calendar events</strong>
                {validateCalendarConfig(calendarConfig) === null && <span className="muted">Company calendar · {CALENDAR_PROVIDER_LABELS[calendarConfig.provider]}</span>}
              </div>
              <h2 className="wrap-h">
                {pending.calendar.length
                  ? `${pending.calendar.length} follow-up${pending.calendar.length === 1 ? '' : 's'} to add.`
                  : events.length
                    ? `${events.length} event${events.length === 1 ? '' : 's'} added.`
                    : 'Nothing for the calendar.'}
              </h2>
              <EventsStep m={m} onError={onError} onCreated={() => void mark('calendar', 'done')} />
              <div className="btn-row wrap-nav">
                {prev && (
                  <button type="button" className="btn" onClick={() => goStep(prev)}>
                    ← Back
                  </button>
                )}
                <span className="grow" />
                {pending.calendar.length > 0 ? (
                  <button type="button" className="btn" onClick={() => void mark('calendar', 'skipped').then(() => goStep(next))}>
                    Skip
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => void mark('calendar', events.length ? 'done' : 'skipped').then(() => goStep(next))}>
                    {next ? `${WRAP_STEP_LABELS[next]} →` : 'Done →'}
                  </button>
                )}
              </div>
            </section>
          )}

          {current === 'export' && (
            <section className="card wrap-card" aria-label="Export">
              <div className="card-title">
                <strong>{index + 1} · Export</strong>
                {storageDir && <span className="muted">{storageDir}/{folderName(m)}/</span>}
              </div>
              <h2 className="wrap-h">{m.exports ? 'Files saved.' : 'Save the files.'}</h2>
              <ExportStep m={m} onError={onError} onSaved={() => void mark('export', 'done')} />
              <div className="btn-row wrap-nav">
                {prev && (
                  <button type="button" className="btn" onClick={() => goStep(prev)}>
                    ← Back
                  </button>
                )}
                <span className="grow" />
                {!m.exports && (
                  <button type="button" className="btn" onClick={() => void mark('export', 'skipped').then(() => go({ name: 'detail', id }))}>
                    Skip
                  </button>
                )}
                <button type="button" className="btn btn-primary" onClick={() => go({ name: 'detail', id })}>
                  {m.exports ? 'All done — open meeting →' : 'Open meeting →'}
                </button>
              </div>
            </section>
          )}
        </div>

        <aside className="wrap-side">
          <section className="card" aria-label="Wrap-up so far">
            <div className="card-title">
              <strong>So far</strong>
            </div>
            <ul className="so-far">
              {log.map((l, i) => (
                <li key={i}>
                  <span className="mark">{l.mark}</span> {l.text}
                </li>
              ))}
            </ul>
          </section>
          <p className="muted small">
            Every step waits for you. Skip anything now — the meeting keeps the same steps as tabs, and Home lists what's left.
          </p>
        </aside>
      </div>

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}
