/**
 * Summary action items ("Owner: task (due)", the summary prompt's format),
 * shared by the GitLab issue and calendar event flows.
 */

import type { Meeting } from './meeting';

/** One summary action item ("Owner: task (due)"), split into its parts. */
export interface ActionItem {
  /** The line as the summary has it. */
  text: string;
  task: string;
  /** Named owner; absent for "Unassigned". */
  owner?: string;
  /** Due as written ("Friday", "2026-10-20"). */
  due?: string;
  /** `due` as YYYY-MM-DD when it is a calendar date (GitLab's `due_date`). */
  dueDate?: string;
}

const UNASSIGNED = /^(unassigned|none|nobody|tbd|n\/a|-)$/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** A written due date as YYYY-MM-DD, when it names a calendar day. */
export function parseDueDate(due: string, now = new Date()): string | undefined {
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = due.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`;
  const eu = due.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (eu) return `${eu[3]}-${pad(Number(eu[2]))}-${pad(Number(eu[1]))}`;
  const named = due.toLowerCase().match(/\b(\d{1,2})\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{4}))?|\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?/);
  if (named) {
    const day = Number(named[1] ?? named[5]);
    const month = MONTHS.indexOf((named[2] ?? named[4])!);
    if (month < 0 || day < 1 || day > 31) return undefined;
    let year = Number(named[3] ?? named[6] ?? now.getFullYear());
    // "Oct 3" said in December means next year.
    if (!(named[3] ?? named[6]) && new Date(year, month, day) < new Date(now.getFullYear(), now.getMonth(), now.getDate()))
      year += 1;
    return `${year}-${pad(month + 1)}-${pad(day)}`;
  }
  return undefined;
}

/** Split "Owner: task (due)" (the summary prompt's format); tolerant of plain tasks. */
export function parseActionItem(text: string, now = new Date()): ActionItem {
  let rest = text.trim().replace(/^[-*•☐]\s*/, '').replace(/^\[ ?\]\s*/, '');
  let owner: string | undefined;
  const colon = rest.match(/^([^:]{1,60}):\s+(.+)$/);
  if (colon) {
    owner = colon[1]!.replace(/\*\*/g, '').trim();
    rest = colon[2]!.trim();
  }
  let due: string | undefined;
  const paren = rest.match(/^(.*\S)\s*\(([^()]+)\)\s*\.?$/);
  if (paren) {
    rest = paren[1]!;
    due = paren[2]!.replace(/^due:?\s*/i, '').trim();
  }
  const task = rest.replace(/\.$/, '').trim() || text.trim();
  return {
    text,
    task,
    ...(owner && !UNASSIGNED.test(owner) ? { owner } : {}),
    ...(due ? { due } : {}),
    ...(due && parseDueDate(due, now) ? { dueDate: parseDueDate(due, now) } : {}),
  };
}

/** Action items worth an issue or event (the summary may say "None"). */
export function actionItemsOf(meeting: Meeting): ActionItem[] {
  return (meeting.summary?.actionItems ?? [])
    .filter((a) => a.trim() && !/^(none|n\/a|-)\.?$/i.test(a.trim()))
    .map((a) => parseActionItem(a));
}
