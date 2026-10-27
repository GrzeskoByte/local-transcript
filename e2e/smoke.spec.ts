import { expect, test } from './fixtures';

// MVP acceptance slice (no mic/ASR weights): Home renders the record hero
// with the privacy line, sources are offered, Settings shows the engine.
test('home loads with privacy notice and the record hero', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Record now.' })).toBeVisible();
  await expect(page.getByText(/Your recording and transcript stay on this device\./)).toBeVisible();
  const sources = page.getByRole('radiogroup', { name: 'Recording source' });
  await expect(sources.getByText('Room mic', { exact: true })).toBeVisible();
  await expect(sources.getByText('This computer', { exact: true })).toBeVisible();
  await expect(sources.getByText('Call', { exact: true })).toBeVisible();
  // The old New Meeting route lands on Home.
  await page.goto('/#/new');
  await expect(page.getByRole('heading', { name: 'Record now.' })).toBeVisible();
});

// Desktop-only shell: Settings must surface the native engine and the tiered
// model catalog.
test('settings surfaces the desktop engine and model catalog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Engine' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible();
  await expect(page.getByText('Tiered from best (S) to fastest (D)')).toBeVisible();
});
