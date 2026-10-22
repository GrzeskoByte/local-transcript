import { expect, test } from './fixtures';

test.use({ viewport: { width: 390, height: 844 } });

test('mobile home has no horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Record now.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-dash.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile library and settings have no horizontal overflow', async ({ page }) => {
  await page.goto('/#/library');
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-library.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
  await page.goto('/#/settings/storage');
  await page.screenshot({ path: 'test-results/mobile-settings.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
