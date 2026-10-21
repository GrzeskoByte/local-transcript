import { expect, test } from '@playwright/test';

/** Settings → Appearance: presets/colours apply at once and survive a reload. */
test('appearance: a preset recolours the app and is remembered', async ({ page }) => {
  await page.goto('/#/settings/appearance');
  const hot = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--hot').trim());
  expect(await hot()).toBe('#ff4e7e');

  await page.getByRole('button', { name: 'Harbour' }).click();
  await expect(page.getByRole('button', { name: 'Harbour' })).toHaveAttribute('aria-pressed', 'true');
  expect(await hot()).toBe('#2f6bff');
  await expect(page.getByRole('status').filter({ hasText: 'Text on the accent' })).toContainText('passes AA');

  await page.getByLabel('Halftone dots on page heads').uncheck();
  await expect(page.locator('html')).toHaveClass(/noht/);

  await page.reload();
  expect(await hot()).toBe('#2f6bff');
  await expect(page.locator('html')).toHaveClass(/noht/);

  await page.getByRole('button', { name: 'Reset to Halftone' }).click();
  expect(await hot()).toBe('#ff4e7e');
  await expect(page.locator('html')).not.toHaveClass(/noht/);
});
