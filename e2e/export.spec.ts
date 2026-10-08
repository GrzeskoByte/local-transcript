import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Export in the desktop app. Tauri's webviews (WebKitGTK, WebView2,
 * WKWebView) do not save `<a download>` blob links — the buttons did nothing
 * there — so on desktop every export goes to `native_export_file` (Downloads
 * folder) and the app says where the file went. In a browser the normal
 * download stays. Recording runs for real in the webview (fake mic).
 */
async function mockDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: unknown;
      __exports: { name: string; bytes: number; head: string }[];
      __revealed: string[];
    };
    w.__exports = [];
    w.__revealed = [];
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
        switch (cmd) {
          case 'native_export_file': {
            const name = decodeURIComponent(options?.headers?.['x-file-name'] ?? '');
            const bytes = args as Uint8Array;
            w.__exports.push({ name, bytes: bytes.length, head: new TextDecoder().decode(bytes.slice(0, 40)) });
            return `/home/me/Downloads/${name}`;
          }
          case 'native_reveal_export':
            w.__revealed.push((args as { path: string }).path);
            return null;
          case 'native_storage_dir':
            return '/tmp/Local Transcribe';
          default:
            return null;
        }
      },
    };
  });
}

async function recordMeeting(page: Page, title: string): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill(title);
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(2_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
}

test('desktop: every export is saved through the shell and the app says where', async ({ page }) => {
  test.setTimeout(60_000);
  await mockDesktop(page);
  await recordMeeting(page, 'Export Test');
  const saved = page.getByRole('status', { name: 'Export saved' });

  await page.getByRole('button', { name: 'TXT', exact: true }).click();
  await expect(saved).toContainText('Saved to /home/me/Downloads/Export-Test.txt');
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  await expect(saved).toContainText('Export-Test.md');
  await page.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(saved).toContainText('Export-Test.json');
  await page.getByRole('button', { name: 'Audio file', exact: true }).click();
  await expect(saved).toContainText(/Export-Test\.(webm|mp4|ogg)/);
  await saved.getByRole('button', { name: 'Show in folder' }).click();

  const result = await page.evaluate(() => {
    const w = window as unknown as { __exports: { name: string; bytes: number; head: string }[]; __revealed: string[] };
    return { exports: w.__exports, revealed: w.__revealed };
  });
  expect(result.exports.map((e) => e.name.replace(/\.(webm|mp4|ogg)$/, '.audio'))).toEqual([
    'Export-Test.txt',
    'Export-Test.md',
    'Export-Test.json',
    'Export-Test.audio',
  ]);
  expect(result.exports[1]!.head).toContain('# Export Test');
  expect(result.exports[2]!.head.trimStart()).toMatch(/^\{/);
  expect(result.exports[3]!.bytes).toBeGreaterThan(1000);
  expect(result.revealed[0]).toMatch(/^\/home\/me\/Downloads\/Export-Test\./);
});

test('browser: exports stay regular downloads', async ({ page }) => {
  test.setTimeout(60_000);
  await recordMeeting(page, 'Browser Export');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Markdown', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Browser-Export.md');
  await expect(page.getByRole('status', { name: 'Export saved' })).toHaveCount(0);
});
