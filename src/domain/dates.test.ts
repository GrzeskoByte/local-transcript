import { describe, expect, it } from 'vitest';
import { dayGroupLabel } from './dates';

describe('dayGroupLabel', () => {
  const now = new Date(2026, 9, 8, 15, 0); // Thursday
  it('names today, yesterday and this week', () => {
    expect(dayGroupLabel(new Date(2026, 9, 8, 0, 5).getTime(), now)).toBe('Today');
    expect(dayGroupLabel(new Date(2026, 9, 7, 23, 59).getTime(), now)).toBe('Yesterday');
    expect(dayGroupLabel(new Date(2026, 9, 5, 9).getTime(), now)).toBe(
      new Date(2026, 9, 5).toLocaleDateString(undefined, { weekday: 'long' }),
    );
  });
  it('gives older days a date, with the year only when it differs', () => {
    expect(dayGroupLabel(new Date(2026, 8, 1).getTime(), now)).not.toMatch(/2026/);
    expect(dayGroupLabel(new Date(2025, 8, 1).getTime(), now)).toMatch(/2025/);
  });
});
