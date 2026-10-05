import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Live transcription, end to end: Settings → download Whistle → enable →
 * record (text appears while recording) → stop → the live text is the saved
 * transcript, and whole-file Re-transcribe is still offered. Only the Tauri
 * bridge is mocked (a fake Whistle engine); capture, the PCM tap, VAD
 * segmentation, WAV encoding and IndexedDB run for real.
 */
async function mockDesktop(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type LiveCall = { engine: string; model?: string; seconds: number };
    const w = window as unknown as {
      __liveCalls: LiveCall[];
      __fileCalls: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__liveCalls = [];
    w.__fileCalls = 0;
    let whistleInstalled = false;
    const status = {
      available: true, backend: 'whisper-cli', binaryPath: '/opt/lt-whisper', version: null, engines: ['whisper'],
      acceleration: null, modelDir: '/models', installHint: null, bundled: true, recommendedModel: 'large-v3-turbo-q5_0',
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [{ name: 'large-v3-turbo-q5_0', engine: 'whisper', installed: true, downloadable: true, path: '/m.bin',
        sizeBytes: 1, accuracy: 5, recommended: true, detail: '~547 MB · Multilingual' }],
    };
    const seconds = (b64: string, rate: number) => (Math.floor((b64.length * 3) / 4) - 44) / 2 / rate;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        switch (cmd) {
          case 'native_asr_status': return status;
          case 'native_asr_models': return status.models;
          case 'native_whistle_status':
            return { supported: true, installed: whistleInstalled, platform: 'linux-x86_64', dir: '/models/whistle' };
          case 'native_whistle_download':
            await new Promise((r) => setTimeout(r, 800));
            whistleInstalled = true;
            return null;
          case 'native_whistle_download_progress':
            return { received: 9_000_000, total: 18_436_607, done: whistleInstalled };
          case 'native_live_transcribe': {
            const req = args?.request as { samplesBase64: string; sampleRate: number; engine: string; model?: string };
            w.__liveCalls.push({ engine: req.engine, model: req.model, seconds: seconds(req.samplesBase64, req.sampleRate) });
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

  // --- Settings: Whistle is offered before download; download, then enable ---
  await page.goto('/#/settings/models');
  const card = page.getByRole('region', { name: 'Live transcription' });
  await expect(card).toBeVisible();
  const picker = card.getByRole('combobox', { name: 'Live transcription model' });
  await expect(picker.locator('option').first()).toHaveText(/Whistle — not downloaded/);
  await card.getByRole('button', { name: /Download Whistle/ }).click();
  await expect(card.getByRole('button', { name: /Download Whistle/ })).toHaveCount(0, { timeout: 10_000 });
  await expect(picker.locator('option').first()).toHaveText(/Whistle — 17 MB/);
  // The installed whole-file model is a live option too.
  await expect(picker.locator('option')).toHaveCount(2);
  await card.getByRole('checkbox', { name: 'Transcribe while recording' }).check();
  await expect(card.getByText('On', { exact: true })).toBeVisible();

  // --- New Meeting shows the same switch, with the model ---
  await page.goto('/#/new');
  const toggle = page.getByRole('checkbox', { name: 'Transcribe live while recording (Whistle)' });
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
  await expect(page.getByLabel('Transcript source')).toContainText('Live transcript (Whistle)');
  const calls = await page.evaluate(() => (window as unknown as { __liveCalls: { engine: string; seconds: number }[] }).__liveCalls);
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    expect(c.engine).toBe('whistle');
    expect(c.seconds).toBeLessThanOrEqual(30);
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
