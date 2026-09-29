import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Desktop shell whose updater reports v9.9.9; install fails so the page stays. */
async function mockDesktopWithUpdate(page: Page, canSelfUpdate = true): Promise<void> {
  await page.addInitScript((selfUpdate) => {
    const w = window as unknown as {
      __installs: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
    };
    w.__installs = 0;
    let downloaded = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        switch (cmd) {
          case 'native_update_check':
            return {
              currentVersion: '0.1.1', available: true, version: '9.9.9', notes: 'Faster transcription.',
              date: null, canSelfUpdate: selfUpdate,
              downloadUrl: 'https://github.com/GrzeskoByte/local-transcript/releases/tag/v9.9.9-ubuntu',
            };
          case 'native_update_install':
            w.__installs++;
            await new Promise((r) => setTimeout(r, 800));
            throw new Error('Update failed: signature mismatch');
          case 'native_update_progress':
            downloaded = Math.min(100, downloaded + 25);
            return { stage: 'downloading', downloaded, total: 100, error: null };
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  }, canSelfUpdate);
}

test('launch check surfaces an update; install needs a click and reports failures', async ({ page }) => {
  await mockDesktopWithUpdate(page);
  await page.goto('/');
  const chip = page.getByRole('button', { name: 'Update available · v9.9.9' });
  await expect(chip).toBeVisible({ timeout: 10_000 });
  expect(await page.evaluate(() => (window as unknown as { __installs: number }).__installs)).toBe(0);

  await chip.click();
  const card = page.getByLabel('Updates');
  await expect(card.getByText('Version 9.9.9 is available.')).toBeVisible();
  await expect(card.getByText('Faster transcription.')).toBeVisible();
  await card.getByRole('button', { name: 'Update & restart' }).click();
  await expect(card.getByLabel('Update progress')).toBeVisible();
  await expect(card.getByText('Update failed: signature mismatch')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __installs: number }).__installs)).toBe(1);
});

test('deb/rpm installs get a download button instead of self-update', async ({ page }) => {
  await mockDesktopWithUpdate(page, false);
  await page.goto('/#/settings/app');
  const card = page.getByLabel('Updates');
  await card.getByRole('button', { name: 'Check for updates' }).click();
  await expect(card.getByRole('button', { name: 'Download v9.9.9' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Update & restart' })).toHaveCount(0);
});

test('launch check can be turned off', async ({ page }) => {
  await mockDesktopWithUpdate(page);
  await page.addInitScript(() => localStorage.setItem('update-auto-check', 'false'));
  await page.goto('/#/settings/app');
  await expect(page.getByLabel('Updates').getByRole('checkbox')).not.toBeChecked();
  await page.waitForTimeout(6_000);
  await expect(page.getByRole('button', { name: /Update available/ })).toHaveCount(0);
});
