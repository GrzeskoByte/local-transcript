import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * Transcription server (Open WebUI): configured in Settings → Models, then
 * Transcribe on Meeting Detail uploads WAV pieces to that endpoint instead of
 * running the local model. The server is a Playwright route; the desktop shell
 * is mocked with no model installed, so a run can only succeed via the server.
 */
const ENDPOINT = 'https://stt.example.test/api/v1/audio/transcriptions';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function mockShell(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __localRuns: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__localRuns = 0;
    const model = {
      name: 'large-v3-turbo-q5_0', engine: 'whisper', installed: false, downloadable: true, path: null,
      sizeBytes: null, accuracy: 5, recommended: true, detail: '',
    };
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        switch (cmd) {
          case 'native_asr_status':
            return {
              available: true, backend: 'whisper-cli', binaryPath: '/lt-whisper', version: null, engines: ['whisper'],
              acceleration: null, modelDir: '/models', installHint: null, bundled: true,
              recommendedModel: 'large-v3-turbo-q5_0',
              gpu: { available: false, active: false, backend: null, devices: [], hint: null }, models: [model],
            };
          case 'native_asr_models': return [model];
          case 'native_asr_transcribe': w.__localRuns++; return [];
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  });
}

async function mockServer(page: Page, uploads: { auth: string | null; body: string }[]): Promise<void> {
  await page.route(ENDPOINT, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    uploads.push({ auth: req.headers()['authorization'] ?? null, body: req.postDataBuffer()?.toString('latin1') ?? '' });
    return route.fulfill({
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Server heard part ${uploads.length}` }),
    });
  });
}

async function configure(page: Page): Promise<void> {
  await page.goto('/#/settings/models');
  const card = page.getByRole('region', { name: 'Transcription server' });
  await card.getByLabel('Server address').fill('https://stt.example.test');
  await card.getByLabel('API key').fill('sk-e2e');
  await expect(card.getByLabel('Transcription endpoint')).toContainText(ENDPOINT);
  await card.getByRole('button', { name: 'Test connection' }).click();
  await expect(card.getByRole('status')).toHaveText('Transcription server answered.');
  await card.getByLabel('Use the transcription server').check();
  await card.getByRole('button', { name: 'Save server settings' }).click();
  await expect(card.getByRole('status')).toContainText('Transcribe now uses the transcription server');
  await expect(card.getByText('On', { exact: true })).toBeVisible();
}

test('settings: test, save and survive a reload', async ({ page }) => {
  const uploads: { auth: string | null; body: string }[] = [];
  await mockShell(page);
  await mockServer(page, uploads);
  await configure(page);
  expect(uploads).toHaveLength(1);
  expect(uploads[0]!.auth).toBe('Bearer sk-e2e');
  expect(uploads[0]!.body).toContain('name="file"; filename="audio.wav"');
  expect(uploads[0]!.body).toContain('Content-Type: audio/wav');
  await page.reload();
  const card = page.getByRole('region', { name: 'Transcription server' });
  await expect(card.getByLabel('Server address')).toHaveValue('https://stt.example.test');
  await expect(card.getByLabel('Use the transcription server')).toBeChecked();
  // The sidebar chip names the server instead of the missing local model.
  await expect(page.locator('.model-chip')).toContainText('Server · Open WebUI');
});

test('meeting: Transcribe uses the server, not the local engine', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  const uploads: { auth: string | null; body: string }[] = [];
  await mockShell(page);
  await mockServer(page, uploads);
  await configure(page);
  uploads.length = 0;

  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Remote Run');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await page.waitForTimeout(6_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  await expect(page.getByText(/Transcription runs on your server: Open WebUI \(stt\.example\.test\)/)).toBeVisible();
  // No "Download model & transcribe": the server needs no local model.
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.locator('.transcript li').first()).toContainText('Server heard part', { timeout: 30_000 });
  expect(uploads.length).toBeGreaterThan(0);
  expect(uploads.every((u) => u.auth === 'Bearer sk-e2e')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __localRuns: number }).__localRuns)).toBe(0);
});
