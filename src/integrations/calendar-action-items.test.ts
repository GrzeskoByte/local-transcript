import { describe, expect, it } from 'vitest';
import { actionItemEventDraft, nextWorkingDay } from './calendar';
import { parseActionItem } from '../domain/action-items';
import type { Meeting } from '../domain/meeting';

// Thursday 8 Oct 2026, 14:00 local.
const meeting = {
  id: 'm1',
  title: 'Weekly sync',
  startedAt: new Date(2026, 9, 8, 14, 0).getTime(),
  summary: { text: 'We planned the release.', keyPoints: [], model: 'llama', createdAt: 0 },
} as unknown as Meeting;

describe('nextWorkingDay', () => {
  it('skips the weekend', () => {
    expect(nextWorkingDay(new Date(2026, 9, 8)).getDate()).toBe(9); // Thu → Fri
    expect(nextWorkingDay(new Date(2026, 9, 9)).getDate()).toBe(12); // Fri → Mon
    expect(nextWorkingDay(new Date(2026, 9, 10)).getDate()).toBe(12); // Sat → Mon
  });
});

describe('actionItemEventDraft', () => {
  it('puts an item with a calendar due date on that day at 09:00 for 30 minutes', () => {
    const draft = actionItemEventDraft(meeting, parseActionItem('Anna: send the release notes (2026-10-20)'));
    expect(draft).toMatchObject({ title: 'send the release notes', startIso: '2026-10-20T09:00', endIso: '2026-10-20T09:30' });
    expect(draft.description).toContain('Owner: Anna');
    expect(draft.description).toContain('Due: 2026-10-20');
    expect(draft.description).toContain('From the meeting "Weekly sync" (2026-10-08).');
    expect(draft.description).toContain('We planned the release.');
  });

  it('puts an item without a date on the next working day at 10:00', () => {
    const draft = actionItemEventDraft(meeting, parseActionItem('Bob: update the changelog (Friday)'));
    expect(draft.startIso).toBe('2026-10-09T10:00');
    expect(draft.endIso).toBe('2026-10-09T10:30');
    expect(draft.description).toContain('Due: Friday');
  });

  it('keeps unassigned items ownerless and long tasks short', () => {
    const draft = actionItemEventDraft(meeting, parseActionItem(`Unassigned: ${'x'.repeat(200)}`));
    expect(draft.title).toHaveLength(120);
    expect(draft.description).not.toContain('Owner:');
  });
});
