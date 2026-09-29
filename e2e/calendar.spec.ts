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

test('calendar view offers a manual refresh', async ({ page }) => {
  await page.goto('/#/calendar');
  await expect(page.getByRole('button', { name: 'Refresh server events' })).toBeVisible();
});

test('settings fills the SOGo CalDAV address from host + username', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByRole('tab', { name: 'Calendar' }).or(page.getByRole('button', { name: 'Calendar', exact: true })).last().click();
  const card = page.getByLabel('Company calendar');
  await card.getByLabel('Server host + path').fill('mail.host.com');
  await card.getByLabel('Username').fill('me@host.com');
  await card.getByRole('button', { name: 'Use SOGo address' }).click();
  await expect(card.getByLabel('Server host + path')).toHaveValue(
    'mail.host.com/SOGo/dav/me@host.com/Calendar/personal/',
  );
});
