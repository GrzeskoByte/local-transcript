import { expect, test } from '@playwright/test';

test('calendar route renders month grid with provider switcher', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Calendar' }).first().click();
  await expect(page.getByRole('heading', { name: 'Calendar' })).toBeVisible();
  await expect(page.getByLabel('Month calendar')).toBeVisible();
  await expect(page.getByLabel('Calendar provider')).toBeVisible();
  // Month navigation works.
  const label = await page.locator('.cal-grid').getAttribute('aria-label');
  await page.getByRole('button', { name: 'Next month' }).click();
  const next = await page.locator('.cal-grid').getAttribute('aria-label');
  expect(next).not.toBe(label);
});
