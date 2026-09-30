/**
 * Meeting agenda: planned topics, written before or after the recording.
 * Pure data + formatters; it travels with the meeting into exports, the disk
 * mirror and GitLab.
 */

export interface AgendaItem {
  id: string;
  title: string;
  /** Planned time for the topic, in minutes. */
  minutes?: number;
  /** Who leads the topic. */
  owner?: string;
  notes?: string;
}

export interface MeetingAgenda {
  items: AgendaItem[];
  updatedAt: number;
}

export function newAgendaItem(title = ''): AgendaItem {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return { id, title };
}

/** Trim fields, drop untitled items and non-positive durations. */
export function normalizeAgendaItems(items: AgendaItem[]): AgendaItem[] {
  return items
    .map((i) => {
      const minutes = i.minutes !== undefined && Number.isFinite(i.minutes) && i.minutes > 0 ? Math.round(i.minutes) : undefined;
      const owner = i.owner?.trim() || undefined;
      const notes = i.notes?.trim() || undefined;
      return {
        id: i.id,
        title: i.title.trim(),
        ...(minutes !== undefined ? { minutes } : {}),
        ...(owner ? { owner } : {}),
        ...(notes ? { notes } : {}),
      };
    })
    .filter((i) => i.title.length > 0);
}

/**
 * Turn pasted text into items: one topic per line, list markers stripped,
 * "(10 min)" / "- 10m" parsed as the duration and "@name" as the owner.
 */
export function parseAgendaText(text: string): AgendaItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[[ xX]?\])?\s*/, '').trim())
    .filter(Boolean)
    .map((line) => {
      let rest = line;
      let minutes: number | undefined;
      const dur = rest.match(/[\s(–—-]*\(?(\d{1,3})\s*(?:min|mins|minutes|m)\)?\s*$/i);
      if (dur) {
        minutes = Number(dur[1]);
        rest = rest.slice(0, dur.index).trim();
      }
      let owner: string | undefined;
      const who = rest.match(/\s@([\p{L}\p{N}._-]+)\s*$/u);
      if (who) {
        owner = who[1];
        rest = rest.slice(0, who.index).trim();
      }
      return { ...newAgendaItem(rest), ...(minutes ? { minutes } : {}), ...(owner ? { owner } : {}) };
    })
    .filter((i) => i.title.length > 0);
}

export function agendaTotalMinutes(items: AgendaItem[]): number {
  return items.reduce((sum, i) => sum + (i.minutes ?? 0), 0);
}

function itemSuffix(i: AgendaItem): string {
  const parts = [i.owner ? `@${i.owner}` : '', i.minutes ? `${i.minutes} min` : ''].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** Markdown section; `level` is the heading depth of "Agenda". */
export function agendaToMarkdown(items: AgendaItem[], level = 2): string {
  if (items.length === 0) return '';
  const total = agendaTotalMinutes(items);
  const lines = [`${'#'.repeat(level)} Agenda`, ''];
  items.forEach((i, n) => {
    lines.push(`${n + 1}. **${i.title}**${itemSuffix(i)}`);
    if (i.notes) for (const l of i.notes.split(/\r?\n/)) lines.push(`   ${l}`);
  });
  if (total > 0) lines.push('', `_Planned: ${total} min_`);
  return lines.join('\n') + '\n';
}

export function agendaToText(items: AgendaItem[]): string {
  if (items.length === 0) return '';
  const lines = ['Agenda:'];
  items.forEach((i, n) => {
    lines.push(`${n + 1}. ${i.title}${itemSuffix(i)}`);
    if (i.notes) for (const l of i.notes.split(/\r?\n/)) lines.push(`   ${l}`);
  });
  const total = agendaTotalMinutes(items);
  if (total > 0) lines.push(`Planned: ${total} min`);
  return lines.join('\n') + '\n';
}

/** Standalone agenda document (export / GitLab / disk mirror). */
export function agendaDocument(title: string, startedAt: number, items: AgendaItem[]): string {
  const date = new Date(startedAt).toISOString().slice(0, 10);
  return `# Agenda: ${title || 'Untitled'} (${date})\n\n${agendaToMarkdown(items, 2).replace(/^## Agenda\n\n/, '')}`;
}

/** JSON shape used in exports: stable keys, no internal ids. */
export function agendaToJSON(items: AgendaItem[]): { title: string; minutes?: number; owner?: string; notes?: string }[] {
  return items.map(({ id: _id, ...rest }) => rest);
}
