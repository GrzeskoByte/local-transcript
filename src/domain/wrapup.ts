/**
 * Guided wrap-up after Stop (Transcribe → Summary → GitLab → Calendar →
 * Export). Pure: what each step's state is, where each action item goes by
 * default, and what is left to do (Home "Waiting for you", the meeting's
 * unfinished-steps banner). The steps themselves live on `Meeting.wrapUp`.
 */
import { actionItemsOf, type ActionItem } from './action-items';
import type { Meeting, WrapStepId, WrapUp } from './meeting';

export const WRAP_STEPS: WrapStepId[] = ['transcribe', 'summary', 'gitlab', 'calendar', 'export'];

export const WRAP_STEP_LABELS: Record<WrapStepId, string> = {
  transcribe: 'Transcribe',
  summary: 'Summary',
  gitlab: 'GitLab',
  calendar: 'Calendar',
  export: 'Export',
};

export type WrapState = 'done' | 'skipped' | 'running' | 'todo';

export interface WrapStepView {
  id: WrapStepId;
  state: WrapState;
  /** Short status under the step name ("62%", "3 to create", "saved"). */
  detail: string;
}

/** Where an action item goes when nobody chose yet (Settings: Pre-tick action items). */
export function defaultRoute(item: ActionItem, pretick = true): { gitlab: boolean; calendar: boolean } {
  if (!pretick) return { gitlab: false, calendar: false };
  const timed = !!item.due && /\b\d{1,2}[:.]\d{2}\b/.test(item.due);
  return { gitlab: !!item.owner && !!item.due, calendar: timed };
}

/** The route of every action item: chosen ones as saved, the rest by default. */
export function routesOf(m: Meeting, pretick = true): Record<string, { gitlab: boolean; calendar: boolean }> {
  const out: Record<string, { gitlab: boolean; calendar: boolean }> = {};
  for (const a of actionItemsOf(m)) out[a.text] = m.wrapUp?.routes[a.text] ?? defaultRoute(a, pretick);
  return out;
}

export function issueFor(m: Meeting, item: string) {
  return m.gitlabActionIssues?.find((i) => i.item === item);
}

export function eventFor(m: Meeting, item: string) {
  return m.calendarEvents?.find((e) => e.item === item);
}

/** Items routed to GitLab / the calendar that still have no issue / event. */
export function pendingTargets(m: Meeting, pretick = true): { gitlab: ActionItem[]; calendar: ActionItem[] } {
  const routes = routesOf(m, pretick);
  const items = actionItemsOf(m);
  return {
    gitlab: items.filter((a) => routes[a.text]?.gitlab && !issueFor(m, a.text)),
    calendar: items.filter((a) => routes[a.text]?.calendar && !eventFor(m, a.text)),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Each enabled step's state; `progress` = running transcription (0..1). */
export function wrapSteps(
  m: Meeting,
  enabled: WrapStepId[],
  opts: { progress?: number; pretick?: boolean } = {},
): WrapStepView[] {
  const marks = m.wrapUp?.steps ?? {};
  const pending = pendingTargets(m, opts.pretick);
  const routes = routesOf(m, opts.pretick);
  const toGitlab = Object.values(routes).filter((r) => r.gitlab).length;
  const toCal = Object.values(routes).filter((r) => r.calendar).length;
  const issues = m.gitlabActionIssues?.length ?? 0;
  const events = m.calendarEvents?.length ?? 0;
  return WRAP_STEPS.filter((s) => s === 'transcribe' || enabled.includes(s)).map((id): WrapStepView => {
    switch (id) {
      case 'transcribe': {
        if (m.transcriptionStatus === 'completed') return { id, state: 'done', detail: 'done' };
        if (m.transcriptionStatus === 'processing' || opts.progress !== undefined)
          return { id, state: 'running', detail: `${Math.round((opts.progress ?? 0) * 100)}%` };
        if (m.transcriptionStatus === 'failed') return { id, state: 'todo', detail: 'failed' };
        return { id, state: 'todo', detail: 'not started' };
      }
      case 'summary': {
        if (marks.summary) return { id, state: marks.summary, detail: marks.summary === 'done' ? 'reviewed' : 'skipped' };
        return { id, state: 'todo', detail: m.summary ? plural(actionItemsOf(m).length, 'action') : 'to write' };
      }
      case 'gitlab': {
        if (marks.gitlab === 'skipped') return { id, state: 'skipped', detail: 'skipped' };
        if (marks.gitlab === 'done' || (toGitlab > 0 && pending.gitlab.length === 0))
          return { id, state: 'done', detail: `${plural(issues, 'issue')} created` };
        return { id, state: 'todo', detail: `${pending.gitlab.length} to create` };
      }
      case 'calendar': {
        if (marks.calendar === 'skipped') return { id, state: 'skipped', detail: 'skipped' };
        if (marks.calendar === 'done' || (toCal > 0 && pending.calendar.length === 0))
          return { id, state: 'done', detail: `${plural(events, 'event')} added` };
        return { id, state: 'todo', detail: `${pending.calendar.length} to add` };
      }
      case 'export': {
        if (marks.export) return { id, state: marks.export, detail: marks.export === 'done' ? 'saved' : 'skipped' };
        const saved = Object.keys(m.exports ?? {}).length;
        return { id, state: 'todo', detail: saved ? plural(saved, 'file') : 'files & wiki' };
      }
    }
  });
}

/**
 * What is left after the user left the wrap-up part-way: skipped or open
 * GitLab/calendar items. Null when nothing is left or the user said "Not needed".
 */
export function wrapLeftover(m: Meeting, enabled: WrapStepId[], pretick = true): string | null {
  if (!m.wrapUp || m.wrapUp.dismissed || m.transcriptionStatus !== 'completed') return null;
  const pending = pendingTargets(m, pretick);
  const parts: string[] = [];
  const marks = m.wrapUp.steps;
  if (enabled.includes('gitlab') && marks.gitlab !== 'done' && pending.gitlab.length > 0)
    parts.push(`${plural(pending.gitlab.length, 'GitLab issue')} ${marks.gitlab === 'skipped' ? 'skipped' : 'not created'}`);
  if (enabled.includes('calendar') && marks.calendar !== 'done' && pending.calendar.length > 0)
    parts.push(`${plural(pending.calendar.length, 'calendar event')} ${marks.calendar === 'skipped' ? 'skipped' : 'not added'}`);
  if (enabled.includes('summary') && !marks.summary && !m.summary) parts.push('summary not written');
  if (enabled.includes('export') && !marks.export && !m.exports) parts.push('not exported');
  return parts.length ? parts.join(' · ') : null;
}

/** The first step still to do (where "Continue wrap-up" leads). */
export function nextWrapStep(m: Meeting, enabled: WrapStepId[], pretick = true): WrapStepId | null {
  return wrapSteps(m, enabled, { pretick }).find((s) => s.state === 'todo' || s.state === 'running')?.id ?? null;
}

/** A fresh wrap-up record (set when the guided flow opens after Stop). */
export function newWrapUp(now = Date.now()): WrapUp {
  return { steps: {}, routes: {}, updatedAt: now };
}
