import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Meeting screen ergonomics: tabs (in the URL), editable lines, copy, rename,
 * Ctrl+F, and Library search that matches titles and carries a transcript hit
 * into the meeting.
 */
async function mockDesktop(page: Page, opts: { failTranscribe?: boolean } = {}): Promise<void> {
  await page.addInitScript((failTranscribe) => {
    const status = {
      available: true, backend: 'voxtype', binaryPath: '/usr/bin/voxtype', version: '1.0.1',
      engines: ['whisper'], acceleration: null, modelDir: '/tmp/models', installHint: null,
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [{ name: 'large-v3-turbo', engine: 'whisper', installed: true, downloadable: true, path: '/tmp/m.bin',
        sizeBytes: 1, accuracy: 90, recommended: true, detail: '' }],
    };
    const settings: Record<string, unknown> = {};
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        switch (cmd) {
          case 'native_settings_load': return settings;
          case 'native_settings_set': settings[args!.key as string] = args!.value; return null;
          case 'native_asr_status': return status;
          case 'native_asr_models': return status.models;
          case 'native_asr_transcribe':
            if (failTranscribe) throw 'whisper.cpp exited with status 3 (model file is damaged)';
            return [{ startMs: 0, endMs: 2000, text: 'Anna will send the budget notes.' }];
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  }, opts.failTranscribe ?? false);
}

async function transcribedMeeting(page: Page, title: string): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill(title);
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByText('Anna will send the budget notes.')).toBeVisible({ timeout: 30_000 });
}

test('tabs live in the URL; lines can be fixed; Copy, Ctrl+F and Rename work', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Budget sync');

  const tabs = page.getByRole('tablist', { name: 'Meeting' });
  await tabs.getByRole('tab', { name: /Summary/ }).click();
  await expect(page).toHaveURL(/\/summary$/);
  await page.reload();
  await expect(tabs.getByRole('tab', { name: /Summary/ })).toHaveAttribute('aria-selected', 'true');
  await tabs.getByRole('tab', { name: /Transcript/ }).click();

  // Fix a line in place.
  const transcript = page.getByRole('region', { name: 'Transcript text' });
  await transcript.getByRole('button', { name: 'Anna will send the budget notes.' }).click();
  await transcript.getByLabel('Edit line').fill('Anna will send the final budget notes.');
  await transcript.getByLabel('Edit line').press('Enter');
  await expect(transcript).toContainText('Anna will send the final budget notes.');
  await page.reload();
  await expect(transcript).toContainText('Anna will send the final budget notes.');

  // Copy the whole transcript.
  await transcript.getByRole('button', { name: 'Copy transcript' }).click();
  await expect(transcript.getByRole('button', { name: 'Copy transcript' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('final budget notes');

  // Ctrl+F focuses the transcript search.
  await page.locator('h1').click();
  await page.keyboard.press('Control+f');
  await expect(page.getByLabel('Search transcript')).toBeFocused();

  // Rename in place; Home shows the new title.
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Meeting title').fill('Budget sync (Q4)');
  await page.getByLabel('Meeting title').press('Enter');
  await expect(page.getByRole('heading', { name: 'Budget sync (Q4)' })).toBeVisible();
  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Recent meetings' })).toContainText('Budget sync (Q4)');
});

test('Library search matches titles at once and carries a transcript hit into the meeting', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Weekly planning');
  await page.goto('/#/library');

  const search = page.getByLabel('Search meetings');
  await search.fill('weekly');
  await expect(page.getByRole('region', { name: /Meetings matching/ }).getByRole('button', { name: 'Weekly planning' })).toBeVisible();

  await search.fill('budget');
  await page.getByRole('region', { name: 'Lines matching budget' }).getByRole('button', { name: 'Weekly planning' }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('budget');
  await expect(page.locator('.transcript mark')).toHaveText('budget');
  await expect(page.getByRole('region', { name: 'Transcript text' }).getByRole('status')).toHaveText('1 of 1 lines');
});

test('player: Space plays, speed cycles, the transcript follows; keys stay out of text fields', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Player keys');
  const playback = page.getByRole('region', { name: 'Recording playback' });

  await page.locator('h1').click();
  await page.keyboard.press('Space');
  await expect(playback.getByRole('button', { name: 'Pause', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.transcript li.active')).toContainText('Anna will send the budget notes.');
  await page.keyboard.press('Space');
  await expect(playback.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  await playback.getByRole('button', { name: 'Speed 1×' }).click();
  await expect(playback.getByRole('button', { name: 'Speed 1.25×' })).toBeVisible();
  await page.reload();
  await expect(playback.getByRole('button', { name: 'Speed 1.25×' })).toBeVisible();

  // Typing a space in the search box types; it does not start playback.
  await page.getByLabel('Search transcript').fill('budget');
  await page.getByLabel('Search transcript').press('Space');
  await expect(page.getByLabel('Search transcript')).toHaveValue('budget ');
  await expect(playback.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
});

test('a failed transcription keeps its reason on the meeting', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page, { failTranscribe: true });
  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByText('Transcription failed.')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(page.getByLabel('Failure reason')).toContainText('model file is damaged');
  // Untitled meetings get a dated name.
  await expect(page.locator('h1')).toHaveText(/^Meeting /);
});

test('opt-in: transcribe automatically after Stop', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  await page.goto('/#/settings/after');
  await page.getByRole('region', { name: 'Transcribe after recording' }).getByLabel('Transcribe automatically after Stop').check();
  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Auto run');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  // No Transcribe click.
  await expect(page.getByText('Anna will send the budget notes.')).toBeVisible({ timeout: 30_000 });
});

test('library: status filters, bulk delete, back link to the month view', async ({ page }) => {
  test.setTimeout(120_000);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Filter me');
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Raw audio');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  await page.goto('/#/library');
  const filters = page.getByLabel('Filters');
  const rows = page.locator('.meetings-table tbody tr');
  await expect(rows).toHaveCount(2);
  await filters.getByRole('checkbox', { name: 'Not transcribed' }).uncheck();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Filter me');
  await filters.getByRole('checkbox', { name: 'Not transcribed' }).check();

  await page.getByRole('checkbox', { name: 'Select Raw audio' }).check();
  const bar = page.getByRole('toolbar', { name: 'Selected meetings' });
  await bar.getByRole('button', { name: 'Delete…' }).click();
  await bar.getByRole('button', { name: 'Yes, delete 1' }).click();
  await expect(rows).toHaveCount(1);

  // Opened from the month view (today is selected), the back link returns there.
  await page.getByRole('button', { name: 'Month', exact: true }).click();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await page.getByRole('button', { name: '← Library' }).click();
  await expect(page.locator('.cal-grid')).toBeVisible();
});
