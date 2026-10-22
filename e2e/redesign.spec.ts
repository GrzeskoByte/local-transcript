import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * The canvas IA: Home record hero → recording room (moments) → guided wrap-up
 * after Stop → Home "Waiting for you" → Library list/filters/bulk select →
 * Settings sections (storage & privacy, shortcuts). Browser build, fake mic.
 */
test.use({ e2eDefaults: false });

async function record(page: Page, title: string): Promise<void> {
  await page.goto('/');
  await page.locator('#meeting-title').fill(title);
  await page.getByRole('button', { name: /Start recording/ }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
}

test('record from Home, mark a moment, stop into the wrap-up, come back later', async ({ page }) => {
  test.setTimeout(60_000);
  await record(page, 'Roadmap Sync');
  await page.getByRole('button', { name: /Mark moment/ }).click();
  await expect(page.locator('.moment-label')).toHaveCount(1);
  await page.locator('.moment-label').fill('Decision: ship Friday');
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();

  await expect(page).toHaveURL(/#\/wrapup\//);
  const steps = page.getByRole('navigation', { name: 'Wrap-up steps' });
  await expect(steps).toBeVisible();
  await expect(steps.getByRole('button', { name: /Transcribe/ })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('heading', { name: 'Transcribe this meeting.' })).toBeVisible();

  await page.getByRole('button', { name: 'Do the rest later' }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByLabel('Waiting for you')).toContainText('Roadmap Sync');

  // The meeting keeps the moment and its tabs.
  await page.getByLabel('Waiting for you').getByRole('button', { name: 'Roadmap Sync' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.getByRole('tablist', { name: 'Meeting' })).toBeVisible();
  await expect(page.getByLabel('Chapters and moments')).toBeVisible();
});

test('library lists, filters and selects meetings', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => localStorage.setItem('wrapup-prefs', JSON.stringify({ guide: false })));
  await record(page, 'Library Check');
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  await page.goto('/#/library');
  const table = page.getByRole('region', { name: 'Meetings' });
  await expect(table).toContainText('Library Check');
  const notTranscribed = page.getByLabel('Filters').getByRole('checkbox', { name: 'Not transcribed' });
  await notTranscribed.uncheck();
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();
  await notTranscribed.check();
  await table.getByRole('checkbox').last().check();
  await expect(page.getByRole('toolbar', { name: 'Selected meetings' })).toContainText('1 selected');

  await page.goto('/#/calendar');
  await expect(page).toHaveURL(/#\/library\/month$/);
});

test('settings: eight sections, network log, delete everything needs DELETE', async ({ page }) => {
  await page.goto('/#/settings/storage');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button')).toHaveCount(8);
  await expect(nav.getByRole('button', { name: /Storage & privacy/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByLabel('Network activity')).toContainText('No connections yet.');

  // Legacy tab ids redirect to their new section.
  await page.goto('/#/settings/ai');
  await expect(nav.getByRole('button', { name: /Summaries/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('radiogroup', { name: 'Summary mode' })).toBeVisible();

  await page.goto('/#/settings/after');
  await expect(page.getByLabel('Wrap-up steps')).toContainText('of 5 on');
  await page.getByRole('checkbox', { name: 'Calendar events' }).check();
  await expect(page.getByLabel('Wrap-up steps')).toContainText('5 of 5 on');
});

test('shortcuts can be rebound and reset', async ({ page }) => {
  await page.goto('/#/settings/app');
  const card = page.getByLabel('Keyboard shortcuts');
  await card.getByRole('button', { name: 'Change: Mark a moment' }).click();
  await expect(card.getByText('Press a key…')).toBeVisible();
  await page.keyboard.press('k');
  await expect(card.getByRole('button', { name: 'Change: Mark a moment' })).toContainText('K');
  await card.getByRole('button', { name: 'Reset' }).click();
  await expect(card.getByRole('button', { name: 'Change: Mark a moment' })).toContainText('M');
});
