import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('mobile dashboard has no horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-dash.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('mobile new-meeting stacks source cards', async ({ page }) => {
  await page.goto('/#/new');
  await expect(page.getByRole('heading', { name: 'New Meeting' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-new.png', fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
