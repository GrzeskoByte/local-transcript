import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Send one action item to GitLab / the calendar (the route toggles in the Summary tab). */
export async function route(page: Page, task: string, target: 'GitLab' | 'Calendar', on = true): Promise<void> {
  const row = page.getByRole('region', { name: 'Action items' }).getByRole('listitem').filter({ hasText: task });
  const toggle = row.getByRole('button', { name: new RegExp(target) });
  if ((await toggle.getAttribute('aria-pressed')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', String(on));
}
