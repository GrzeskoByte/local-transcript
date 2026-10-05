import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Stop must always land on Meeting Detail, quickly, even when parts of the
 * teardown hang (a sound-server log, a capture device, the live tap) — and
 * opening the meeting must not read the recording until Play is pressed.
 * Only the Tauri bridge is mocked; recording and storage run for real.
 */
async function mockHangingDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __reads: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    w.__reads = 0;
    const never = new Promise<never>(() => undefined);
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          // The Linux sound-server log starts, then never answers on stop.
          case 'native_audio_diag_start':
            return { defaultSink: 'alsa_output.test', defaultSource: 'alsa_input.test', cards: [] };
          case 'native_audio_diag_stop':
            return never;
          case 'native_recording_read':
            w.__reads += 1;
            return null;
          case 'native_storage_dir':
            return '/tmp/Local Transcribe';
          case 'native_log':
            (w as unknown as { __log: string[] }).__log = [
              ...((w as unknown as { __log?: string[] }).__log ?? []),
              String((args as { message?: string } | undefined)?.message),
            ];
            return null;
          default:
            return null;
        }
      },
    };
  });
}

test('Stop opens Meeting Detail within seconds even when teardown hangs', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await mockHangingDesktop(page);
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Hang Test');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(4_000);

  const stoppedAt = Date.now();
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  // The loader shows at once, while the hanging step is still running.
  await expect(page.getByRole('status', { name: 'Saving recording' })).toBeVisible({ timeout: 1_000 });
  await expect(page.getByRole('button', { name: '■ Stop & save' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Hang Test' })).toBeVisible({ timeout: 10_000 });
  expect(Date.now() - stoppedAt).toBeLessThan(8_000);
  await expect(page).toHaveURL(/#\/meeting\//);

  // The page is usable: the player is there (not loaded yet) and the app
  // navigates; nothing read the recording just to open it.
  await expect(page.getByRole('region', { name: 'Recording playback' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __reads: number }).__reads)).toBe(0);
  // The Stop timings reach the terminal and name the step that hung.
  const log = await page.evaluate(() => (window as unknown as { __log?: string[] }).__log ?? []);
  expect(log.join('\n')).toMatch(/Stop took \d+ ms: diagnostics \d{4} ms \(slowest\)/);
  await page.getByRole('button', { name: '← All meetings' }).click();
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  await expect(page.getByText('Hang Test')).toBeVisible();
});
