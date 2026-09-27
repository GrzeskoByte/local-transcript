import { expect, test } from '@playwright/test';

// MVP acceptance slice (no mic/ASR weights): dashboard renders, new-meeting
// form works, untranscribed state is valid, offline shell loads.
test('dashboard loads with privacy notice and new-meeting flow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  await expect(page.getByText('Your recording and transcript stay on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'New Meeting' }).first().click();
  await expect(page.getByRole('heading', { name: 'New Meeting' })).toBeVisible();
  await expect(page.getByText('Device Audio').first()).toBeVisible();
});

// Desktop-only shell: Settings must surface the native engine and the tiered
// model catalog. The browser ASR engine and its "best accuracy" nudge are gone.
test('settings surfaces the desktop engine and model catalog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).first().click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByText('Desktop engine')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(page.getByText('Tiered from best (S) to fastest (D)')).toBeVisible();
});
