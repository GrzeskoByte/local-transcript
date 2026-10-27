import { describe, expect, it } from 'vitest';
import type { Meeting } from './meeting';
import { defaultRoute, nextWrapStep, pendingTargets, wrapLeftover, wrapSteps } from './wrapup';
import { parseActionItem } from './action-items';
import { assignSpeakers, parseDiarizationOutput, speakerName, speakersOf } from './speakers';
import type { TranscriptSegment } from './transcript';

const base: Meeting = {
  id: 'm1',
  title: 'Q4 sync',
  mode: 'dual',
  createdAt: 0,
  startedAt: 0,
  durationMs: 60_000,
  audioPath: 'meetings/m1',
  mimeType: 'audio/ogg',
  transcriptionStatus: 'completed',
  summary: {
    text: 'Launch moves.',
    keyPoints: [],
    actionItems: [
      'Santi: Update permission prompt copy (Fri Oct 23)',
      'Greg: Confirm consent wording with legal (Mon Oct 26 10:00)',
      'Unassigned: Think about it',
    ],
    model: 'x',
    createdAt: 1,
  },
};
const ALL = ['transcribe', 'summary', 'gitlab', 'calendar', 'export'] as const;

describe('wrap-up', () => {
  it('pre-ticks owner + date for GitLab and a time for the calendar', () => {
    expect(defaultRoute(parseActionItem('Santi: Update copy (Fri Oct 23)'))).toEqual({ gitlab: true, calendar: false });
    expect(defaultRoute(parseActionItem('Greg: Confirm (Mon Oct 26 10:00)'))).toEqual({ gitlab: true, calendar: true });
    expect(defaultRoute(parseActionItem('Think about it'))).toEqual({ gitlab: false, calendar: false });
    expect(defaultRoute(parseActionItem('Greg: Confirm (Mon Oct 26 10:00)'), false)).toEqual({ gitlab: false, calendar: false });
  });

  it('counts what is left per target', () => {
    const p = pendingTargets(base);
    expect(p.gitlab.map((a) => a.owner)).toEqual(['Santi', 'Greg']);
    expect(p.calendar.map((a) => a.owner)).toEqual(['Greg']);
    const withIssue: Meeting = {
      ...base,
      gitlabActionIssues: [{ item: base.summary!.actionItems![0]!, url: 'u', iid: 214, createdAt: 2 }],
    };
    expect(pendingTargets(withIssue).gitlab.map((a) => a.owner)).toEqual(['Greg']);
  });

  it('shows each step state and the next one', () => {
    const steps = wrapSteps({ ...base, wrapUp: { steps: { summary: 'done' }, routes: {}, updatedAt: 1 } }, [...ALL]);
    expect(steps.map((s) => `${s.id}:${s.state}`)).toEqual([
      'transcribe:done',
      'summary:done',
      'gitlab:todo',
      'calendar:todo',
      'export:todo',
    ]);
    expect(steps[2]!.detail).toBe('2 to create');
    expect(nextWrapStep({ ...base, wrapUp: { steps: { summary: 'done' }, routes: {}, updatedAt: 1 } }, [...ALL])).toBe('gitlab');
    const running = wrapSteps({ ...base, transcriptionStatus: 'processing' }, ['transcribe'], { progress: 0.62 });
    expect(running[0]).toEqual({ id: 'transcribe', state: 'running', detail: '62%' });
  });

  it('describes leftovers until dismissed', () => {
    const left: Meeting = { ...base, wrapUp: { steps: { summary: 'done', calendar: 'skipped' }, routes: {}, updatedAt: 1 } };
    expect(wrapLeftover(left, [...ALL])).toBe('2 GitLab issues not created · 1 calendar event skipped · not exported');
    expect(wrapLeftover({ ...left, wrapUp: { ...left.wrapUp!, dismissed: true } }, [...ALL])).toBeNull();
    expect(wrapLeftover(base, [...ALL])).toBeNull();
  });
});

describe('speakers', () => {
  const seg = (id: string, a: number, b: number): TranscriptSegment => ({
    id,
    meetingId: 'm1',
    sequence: Number(id),
    startMs: a * 1000,
    endMs: b * 1000,
    text: id,
  });

  it('parses the engine output and assigns the most-overlapping speaker', () => {
    const turns = parseDiarizationOutput('Started\n0.6 -- 6.8 speaker_00\n7.0 -- 10.6 speaker_01\nDuration : 56 s\n');
    expect(turns).toEqual([
      { start: 0.6, end: 6.8, speaker: 'speaker_00' },
      { start: 7, end: 10.6, speaker: 'speaker_01' },
    ]);
    const out = assignSpeakers([seg('1', 0, 5), seg('2', 6, 10), seg('3', 20, 21)], turns);
    expect(out.map((s) => s.speaker)).toEqual(['speaker_00', 'speaker_01', 'speaker_01']);
    expect(speakersOf(out)).toEqual(['speaker_00', 'speaker_01']);
  });

  it('names speakers', () => {
    expect(speakerName('speaker_00', undefined)).toBe('Speaker 1');
    expect(speakerName('speaker_01', { speaker_01: 'Greg' })).toBe('Greg');
    expect(speakerName('Me', undefined)).toBe('Me');
  });
});
