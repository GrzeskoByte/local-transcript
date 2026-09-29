import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Fresh install, zero setup: the app's built-in whisper.cpp engine is present
 * but no model is. One click must download the recommended model (with real
 * progress) and then transcribe — no trip to Settings. Only the Tauri bridge
 * is mocked; recording, storage and the transcription pipeline run for real.
 */
async function mockFreshInstall(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __downloads: string[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__downloads = [];
    const TOTAL = 574_041_195;
    let installed = false;
    let startedAt = 0;
    const model = () => ({
      name: 'large-v3-turbo-q5_0', engine: 'whisper', installed, downloadable: true, path: installed ? '/m.bin' : null,
      sizeBytes: installed ? TOTAL : null, accuracy: 5, recommended: true, detail: '',
    });
    const status = () => ({
      available: true, backend: 'whisper-cli', binaryPath: '/opt/Local Transcribe/lt-whisper', version: null,
      engines: ['whisper'], acceleration: null, modelDir: '/models', installHint: null, bundled: true,
      recommendedModel: 'large-v3-turbo-q5_0',
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [model()],
    });
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'native_asr_status': return status();
          case 'native_asr_models': return [model()];
          case 'native_asr_download_model':
            w.__downloads.push(String(args?.name));
            startedAt = Date.now();
            await new Promise((r) => setTimeout(r, 2_500));
            installed = true;
            return null;
          case 'native_asr_download_progress': {
            const f = Math.min(1, (Date.now() - startedAt) / 2_500);
            return { received: Math.round(TOTAL * f), total: TOTAL, done: installed };
          }
          case 'native_asr_transcribe': {
            const req = args?.request as { samplesBase64: string; sampleRate: number; model: string };
            const seconds = (Math.floor((req.samplesBase64.length * 3) / 4) - 44) / 2 / req.sampleRate;
            return [{ startMs: 0, endMs: seconds * 1000, text: `Heard with ${req.model}` }];
          }
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  });
}

test('dashboard: one click sets up transcription with live progress', async ({ page }) => {
  await mockFreshInstall(page);
  await page.goto('/');
  await expect(page.getByText('Built-in engine: whisper.cpp, included with the app')).toBeVisible();
  await page.getByRole('button', { name: 'Set up transcription' }).click();
  const progress = page.getByRole('status', { name: 'Downloading speech model' });
  await expect(progress).toBeVisible();
  await expect(progress).toContainText(/\d+% · \d+ of 547 MB/);
  // Done: the setup card disappears once the model is installed.
  await expect(page.getByRole('button', { name: 'Set up transcription' })).toHaveCount(0, { timeout: 10_000 });
  await expect(progress).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads)).toEqual([
    'large-v3-turbo-q5_0',
  ]);
});

test('meeting: "Download model & transcribe" does both in one click', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await mockFreshInstall(page);
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('First Run');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await page.waitForTimeout(6_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  await page.getByRole('button', { name: 'Download model & transcribe' }).click();
  await expect(page.getByRole('status', { name: 'Downloading speech model' })).toBeVisible();
  await expect(page.locator('.transcript li').first()).toContainText('Heard with large-v3-turbo-q5_0', {
    timeout: 30_000,
  });
});
