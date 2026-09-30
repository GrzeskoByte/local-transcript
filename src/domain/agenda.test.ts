import { describe, expect, it } from 'vitest';
import {
  agendaDocument,
  agendaToJSON,
  agendaToMarkdown,
  agendaToText,
  agendaTotalMinutes,
  normalizeAgendaItems,
  parseAgendaText,
} from './agenda';

describe('agenda', () => {
  it('parses pasted lists with durations and owners', () => {
    const items = parseAgendaText('1. Status update (10 min)\n- Roadmap @anna 15m\n\n* [ ] Q&A\n');
    expect(items.map((i) => [i.title, i.minutes, i.owner])).toEqual([
      ['Status update', 10, undefined],
      ['Roadmap', 15, 'anna'],
      ['Q&A', undefined, undefined],
    ]);
  });

  it('normalizes: trims and drops empty items and bad durations', () => {
    const out = normalizeAgendaItems([
      { id: 'a', title: '  Intro ', minutes: 0, owner: ' ', notes: ' hi ' },
      { id: 'b', title: '   ' },
    ]);
    expect(out).toEqual([{ id: 'a', title: 'Intro', notes: 'hi' }]);
  });

  const items = [
    { id: '1', title: 'Status', minutes: 10, owner: 'anna' },
    { id: '2', title: 'Risks', notes: 'Budget\nHiring' },
  ];

  it('formats markdown, text and json', () => {
    expect(agendaTotalMinutes(items)).toBe(10);
    const md = agendaToMarkdown(items);
    expect(md).toContain('## Agenda');
    expect(md).toContain('1. **Status** (@anna, 10 min)');
    expect(md).toContain('   Hiring');
    expect(md).toContain('_Planned: 10 min_');
    expect(agendaToText(items)).toContain('2. Risks\n   Budget');
    expect(agendaToJSON(items)[0]).toEqual({ title: 'Status', minutes: 10, owner: 'anna' });
    expect(agendaToMarkdown([])).toBe('');
  });

  it('builds a standalone document', () => {
    const doc = agendaDocument('Weekly', Date.UTC(2026, 8, 30), items);
    expect(doc.startsWith('# Agenda: Weekly (2026-09-30)\n\n1. **Status**')).toBe(true);
  });
});
