import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Live transcription, end to end: Settings → download the small live model
 * (main model unchanged) → enable → record (text appears while recording) →
 * stop → the live text is the saved transcript, and whole-file Re-transcribe
 * is still offered. Only the Tauri bridge is mocked (a fake whisper.cpp);
 * capture, the PCM tap, VAD segmentation, WAV encoding and IndexedDB run for real.
 */
async function mockDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type LiveCall = { model: string; seconds: number };
    const w = window as unknown as {
      __liveCalls: LiveCall[];
      __fileCalls: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__liveCalls = [];
    w.__fileCalls = 0;
    let baseInstalled = false;
    const base = () => ({ name: 'base', engine: 'whisper', installed: baseInstalled, downloadable: true,
      path: baseInstalled ? '/m/base.bin' : null, sizeBytes: null, accuracy: 2, recommended: false, detail: '' });
    const status = {
      available: true, backend: 'whisper-cli', binaryPath: '/opt/lt-whisper', version: null, engines: ['whisper'],
      acceleration: null, modelDir: '/models', installHint: null, bundled: true, recommendedModel: 'large-v3-turbo-q5_0',
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [{ name: 'large-v3-turbo-q5_0', engine: 'whisper', installed: true, downloadable: true, path: '/m.bin',
        sizeBytes: 1, accuracy: 5, recommended: true, detail: '~547 MB · Multilingual' }],
    };
    const current = () => ({ ...status, models: [...status.models, base()] });
    const seconds = (b64: string, rate: number) => (Math.floor((b64.length * 3) / 4) - 44) / 2 / rate;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'native_asr_status': return current();
          case 'native_asr_models': return current().models;
          case 'native_asr_download_model':
            await new Promise((r) => setTimeout(r, 800));
            if (args?.name === 'base') baseInstalled = true;
            return null;
          case 'native_asr_download_progress':
            return { received: 70_000_000, total: 147_951_465, done: baseInstalled };
          case 'native_live_transcribe': {
            const req = args?.request as { samplesBase64: string; sampleRate: number; model: string };
            w.__liveCalls.push({ model: req.model, seconds: seconds(req.samplesBase64, req.sampleRate) });
            return [{ startMs: 0, endMs: 1000, text: `Live line ${w.__liveCalls.length}` }];
          }
          case 'native_asr_transcribe': {
            w.__fileCalls += 1;
            const req = args?.request as { samplesBase64: string; sampleRate: number };
            return [{ startMs: 0, endMs: seconds(req.samplesBase64, req.sampleRate) * 1000, text: 'Whole-file line' }];
          }
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  });
}

test('live transcription: enable, see text while recording, keep it, re-transcribe the whole file', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (d) => void d.accept());
  await mockDesktop(page);

  // --- Settings: base is offered before download; download it, then enable ---
  await page.goto('/#/settings/models');
  const card = page.getByRole('region', { name: 'Live transcription' });
  await expect(card).toBeVisible();
  const picker = card.getByRole('combobox', { name: 'Live transcription model' });
  await expect(picker.locator('option').first()).toHaveText(/base — recommended for live · not downloaded/);
  await card.getByRole('button', { name: 'Download base' }).click();
  await expect(picker.locator('option').first()).toHaveText(/base — recommended for live$/, { timeout: 10_000 });
  // The installed whole-file model is a live option too, and stays the main model.
  await expect(picker.locator('option')).toHaveCount(2);
  await expect(page.locator('.sidebar .model-chip')).toContainText('large-v3-turbo-q5_0');
  await card.getByRole('checkbox', { name: 'Transcribe while recording' }).check();
  await expect(card.getByText('On', { exact: true })).toBeVisible();

  // --- New Meeting shows the same switch, with the model ---
  await page.goto('/#/new');
  const toggle = page.getByRole('checkbox', { name: 'Transcribe live while recording (base)' });
  await expect(toggle).toBeChecked();
  await page.locator('#meeting-title').fill('Live Test');
  await page.getByRole('button', { name: '● Start Recording' }).click();

  // --- text arrives while recording ---
  const live = page.getByRole('region', { name: 'Live transcript' });
  await expect(live).toBeVisible();
  await expect(live.locator('.transcript li').first()).toContainText('Live line 1', { timeout: 30_000 });
  await page.getByRole('button', { name: '■ Stop & save' }).click();

  // --- the live text is the meeting's transcript; whole-file stays available ---
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.locator('.transcript li').first()).toContainText('Live line 1', { timeout: 15_000 });
  await expect(page.getByLabel('Transcript source')).toContainText('Live transcript (base)');
  const calls = await page.evaluate(() => (window as unknown as { __liveCalls: { model: string; seconds: number }[] }).__liveCalls);
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.model).toBe('base');
    expect(c.seconds).toBeLessThanOrEqual(10.5);
  }
  expect(await page.evaluate(() => (window as unknown as { __fileCalls: number }).__fileCalls)).toBe(0);

  // Re-transcribe runs the whole recording through the regular model.
  await page.getByRole('button', { name: 'Re-transcribe' }).click();
  await expect(page.locator('.transcript li').first()).toContainText('Whole-file line', { timeout: 30_000 });
  await expect(page.getByLabel('Transcript source')).toHaveCount(0);
});

test('live transcription off: recording behaves as before (no live calls, not transcribed)', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await mockDesktop(page);
  await page.goto('/#/new');
  await expect(page.getByRole('checkbox', { name: /Transcribe live while recording/ })).not.toBeChecked();
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live transcript' })).toHaveCount(0);
  await page.waitForTimeout(3_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.getByText('Not transcribed yet.')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __liveCalls: unknown[] }).__liveCalls)).toEqual([]);
});
