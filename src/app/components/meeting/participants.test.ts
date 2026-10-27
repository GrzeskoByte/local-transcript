import { describe, expect, it } from 'vitest';
import { mergePeople } from './Participants.tsx';
import { ownerEmail } from '../wrap/EventsStep.tsx';
import { fromRow } from '../wrap/SummaryStep.tsx';
import type { Participant } from '../../../domain/meeting';

const anna: Participant = { name: 'Anna Nowak', username: 'anna', source: 'gitlab' };

describe('participants', () => {
  it('merges by username/e-mail, keeping typed e-mails', () => {
    const merged = mergePeople([{ ...anna, email: 'anna@x.io', source: 'manual' }], [anna, { name: 'Bob', email: 'bob@x.io', source: 'manual' }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: 'Anna Nowak', email: 'anna@x.io', username: 'anna' });
  });

  it("finds an action item owner's e-mail by name, first name or username", () => {
    const people = [{ ...anna, email: 'anna@x.io' }, { name: 'Bob Smith', source: 'manual' as const }];
    expect(ownerEmail('Anna', people)).toBe('anna@x.io');
    expect(ownerEmail('@anna', people)).toBe('anna@x.io');
    expect(ownerEmail('Bob', people)).toBeUndefined();
    expect(ownerEmail(undefined, people)).toBeUndefined();
  });

  it('turns an edited action-item row back into the summary line', () => {
    expect(fromRow({ owner: 'Anna', task: 'send notes', due: 'Friday' })).toBe('Anna: send notes (Friday)');
    expect(fromRow({ owner: '', task: 'book a room', due: '' })).toBe('Unassigned: book a room');
  });
});
