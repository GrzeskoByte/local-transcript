/** Date labels for lists. */

/** "Today" / "Yesterday" / weekday this week / full date: the list's day groups. */
export function dayGroupLabel(ts: number, now = new Date()): string {
  const day = new Date(ts);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(day)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return day.toLocaleDateString(undefined, { weekday: 'long' });
  return day.toLocaleDateString(undefined, {
    day: 'numeric', month: 'long', ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}
