import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

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
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        switch (cmd) {
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

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Agenda', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('Agenda-Meeting-agenda.md');
  const text = await readFile((await download.path())!, 'utf8');
  expect(text).toContain('1. **Status update** (10 min)');
  expect(text).toContain('2. **Roadmap** (@anna, 15 min)');
  expect(text).not.toContain('Q&A');
});
