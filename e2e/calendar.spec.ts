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

test('calendar detection explains it needs the desktop app in a browser', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByRole('tab', { name: 'Calendar' }).or(page.getByRole('button', { name: 'Calendar', exact: true })).last().click();
  const card = page.getByLabel('Company calendar');
  await card.getByRole('button', { name: 'Find in Thunderbird' }).click();
  await expect(card.getByRole('status')).toHaveText('Detection needs the desktop app.');
});

test('recurring SOGo events (entity-escaped, TZID) show in the month view', async ({ page }) => {
  await page.addInitScript(() => {
    const ics = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:daily-1',
      'DTSTART;TZID=Europe/Warsaw:20200106T093000', 'DTEND;TZID=Europe/Warsaw:20200106T094500',
      'RRULE:FREQ=DAILY', 'SUMMARY:Daily standup', 'END:VEVENT', 'END:VCALENDAR',
    ].join('&#13;\n');
    const xml = '<D:multistatus xmlns:D="DAV:"><D:response><D:href>/SOGo/dav/me/Calendar/personal/daily-1.ics</D:href>' +
      '<D:propstat><D:prop><C:calendar-data xmlns:C="urn:ietf:params:xml:ns:caldav">' + ics +
      '</C:calendar-data></D:prop></D:propstat></D:response></D:multistatus>';
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => (cmd === 'native_calendar_fetch' ? xml : cmd === 'native_storage_dir' ? '/tmp/LT' : null),
    };
  });
  await page.goto('/#/settings/calendar');
  const card = page.getByLabel('Company calendar');
  await card.getByLabel('Server host + path').fill('https://mail.example/SOGo/dav/me/Calendar/personal/');
  await card.getByLabel('Username').fill('me');
  await card.getByLabel('Password').fill('secret');
  await card.getByRole('button', { name: 'Save calendar settings' }).click();
  await expect(card.getByText('Calendar settings saved on this device.')).toBeVisible();

  await page.goto('/#/calendar');
  await expect(page.getByLabel('Server event count')).toHaveText(/^(28|29|30|31) server events in /);
  await expect(page.locator('.cal-day:not(.out) .cal-dot.server')).not.toHaveCount(0);
  await expect(page.getByLabel('Selected day').getByText('Daily standup')).toBeVisible();
  await expect(page.getByLabel('Selected day').getByText(/\d\d:\d\d–\d\d:\d\d/)).toBeVisible();
});
