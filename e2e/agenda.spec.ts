import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Agenda: planned on New Meeting, visible while recording, editable on
 * Meeting Detail, included in exports. Also: the sidebar model chip reflects
 * a model that is already on disk. Only the Tauri bridge is mocked.
 */
async function mockInstalledModel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const model = {
      name: 'base.en', engine: 'whisper', installed: true, downloadable: true, path: '/m.bin',
      sizeBytes: 1, accuracy: 2, recommended: false, detail: '',
    };
    const status = {
      available: true, backend: 'whisper-cli', binaryPath: '/lt-whisper', version: null,
      engines: ['whisper'], acceleration: null, modelDir: '/models', installHint: null, bundled: true,
      recommendedModel: 'large-v3-turbo-q5_0',
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [model],
    };
    const w = window as unknown as { __TAURI_INTERNALS__: unknown; __exports: { name: string; text: string }[] };
    w.__exports = [];
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
        switch (cmd) {
          // The desktop webview cannot save <a download> links: exports go to the shell.
          case 'native_export_file': {
            const name = decodeURIComponent(options?.headers?.['x-file-name'] ?? '');
            w.__exports.push({ name, text: new TextDecoder().decode(args as Uint8Array) });
            return `/home/me/Downloads/${name}`;
          }
          case 'native_asr_status': return status;
          case 'native_asr_models': return [model];
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  });
}

test('sidebar shows the installed model even without a saved selection', async ({ page }) => {
  await mockInstalledModel(page);
  await page.goto('/');
  await expect(page.locator('.sidebar .model-chip')).toHaveText('Model: base.en');
});

test('agenda: plan, record, edit and export', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await mockInstalledModel(page);
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Agenda Meeting');
  await page.getByRole('button', { name: '+ Add agenda' }).click();
  await page.getByLabel('Topic 1', { exact: true }).fill('Status update');
  await page.getByLabel('Minutes for topic 1').fill('10');
  await page.getByRole('button', { name: 'Paste list…' }).click();
  await page.locator('#agenda-paste').fill('- Roadmap @anna 15 min\n- Q&A');
  await page.getByRole('button', { name: 'Add pasted topics' }).click();
  await expect(page.getByLabel('Topic 3', { exact: true })).toHaveValue('Q&A');

  await page.getByRole('button', { name: '● Start Recording' }).click();
  const live = page.getByRole('region', { name: 'Meeting agenda' });
  await expect(live).toContainText('Roadmap');
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  const card = page.getByRole('region', { name: 'Meeting agenda' });
  await expect(card).toContainText('3 topics');
  await expect(card).toContainText('Planned: 25 min');
  await card.getByRole('button', { name: 'Edit agenda' }).click();
  await card.getByLabel('Remove topic 3').click();
  await card.getByRole('button', { name: 'Save agenda' }).click();
  await expect(card).toContainText('2 topics');

  // Persists across a reload.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Meeting agenda' })).toContainText('@anna · 15 min');

  await page.getByRole('button', { name: 'Agenda file', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Export saved' })).toContainText(
    'Saved to /home/me/Downloads/Agenda-Meeting-agenda.md',
  );
  const exports = await page.evaluate(() => (window as unknown as { __exports: { name: string; text: string }[] }).__exports);
  expect(exports.map((e) => e.name)).toEqual(['Agenda-Meeting-agenda.md']);
  const text = exports[0]!.text;
  expect(text).toContain('1. **Status update** (10 min)');
  expect(text).toContain('2. **Roadmap** (@anna, 15 min)');
  expect(text).not.toContain('Q&A');
});
