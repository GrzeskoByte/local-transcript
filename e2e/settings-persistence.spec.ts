import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Desktop settings live in a file (`native_settings_*`), not in the webview
 * profile: wiping IndexedDB + localStorage (what an AppImage update or an
 * unreadable WebKit database looks like to the app) must not lose them. The
 * fake shell keeps its "settings file" in sessionStorage so it outlives a
 * reload but not IndexedDB/localStorage.
 */
async function mockShell(page: Page, opts: { brokenDatabase?: boolean } = {}): Promise<void> {
  await page.addInitScript((broken) => {
    const FILE = '__fake-settings-file';
    const read = (): Record<string, unknown> => JSON.parse(sessionStorage.getItem(FILE) ?? '{}');
    const w = window as unknown as {
      __resets: string[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__resets = [];
    if (broken) {
      // What WebKit 2.50 reports for a database written by a newer WebKit.
      indexedDB.open = function open() {
        const req = {} as IDBOpenDBRequest & { error: DOMException };
        setTimeout(() => {
          Object.defineProperty(req, 'error', {
            value: new DOMException('Unable to establish IDB database file', 'UnknownError'),
          });
          req.onerror?.(new Event('error'));
        }, 0);
        return req;
      };
    }
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'native_settings_load': return read();
          case 'native_settings_set': {
            const file = read();
            file[String(args?.key)] = args?.value ?? null;
            sessionStorage.setItem(FILE, JSON.stringify(file));
            return null;
          }
          case 'native_reset_webview_database':
            w.__resets.push(String(args?.origin));
            return '/backup';
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  }, opts.brokenDatabase ?? false);
}

test('settings survive a wiped webview profile', async ({ page }) => {
  await mockShell(page);
  await page.goto('/#/settings');
  await page.getByLabel('Spoken language').selectOption('de');
  await expect(page.getByLabel('Spoken language')).toHaveValue('de');

  // Wipe everything WebKit stores for the app.
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase('local-transcribe');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });
  await page.reload();
  await expect(page.getByLabel('Spoken language')).toHaveValue('de');
});

test('an unreadable database is explained and can be moved aside', async ({ page }) => {
  await mockShell(page, { brokenDatabase: true });
  await page.goto('/');
  const banner = page.getByRole('alert', { name: 'Database problem' });
  await expect(banner).toContainText('Unable to establish IDB database file');
  await banner.getByRole('button', { name: 'Start with a fresh database' }).click();
  await banner.getByRole('button', { name: /Move old database aside/ }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __resets: string[] }).__resets))
    .toEqual([new URL(page.url()).origin]);
});
