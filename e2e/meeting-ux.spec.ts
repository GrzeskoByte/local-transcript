import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Meeting Detail ergonomics for long meetings: collapsible sections (state
 * remembered), jump bar, copy, rename, Ctrl+F, and Dashboard search that
 * matches titles and carries the query into the transcript.
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
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByText('Anna will send the budget notes.')).toBeVisible({ timeout: 30_000 });
}

test('sections collapse (remembered), the jump bar reopens them, Copy and Rename work', async ({ page, context }) => {
  test.setTimeout(90_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Budget sync');

  if (process.env.LT_SHOT) await page.screenshot({ path: `${process.env.LT_SHOT}-detail.png`, fullPage: true });
  const transcript = page.getByRole('region', { name: 'Transcript text' });
  const toggle = transcript.getByRole('button', { name: 'Transcript', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(transcript.getByRole('listitem')).toHaveCount(0);
  // Collapsed sections show a one-line preview.
  await expect(transcript).toContainText('Anna will send the budget notes.');

  // Remembered across a reload.
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // The jump bar opens it again.
  await page.getByRole('navigation', { name: 'Meeting sections' }).getByRole('button', { name: 'Jump to transcript' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Collapse all / Expand all.
  const nav = page.getByRole('navigation', { name: 'Meeting sections' });
  await nav.getByRole('button', { name: 'Collapse all' }).click();
  await expect(page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Recording', exact: true }))
    .toHaveAttribute('aria-expanded', 'false');
  if (process.env.LT_SHOT) await page.screenshot({ path: `${process.env.LT_SHOT}-collapsed.png`, fullPage: true });
  await nav.getByRole('button', { name: 'Expand all' }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Copy the whole transcript.
  await transcript.getByRole('button', { name: 'Copy transcript' }).click();
  await expect(transcript.getByRole('button', { name: 'Copy transcript' })).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Anna will send the budget notes.');

  // Ctrl+F focuses the transcript search.
  await page.keyboard.press('Control+f');
  await expect(page.getByLabel('Search transcript')).toBeFocused();

  // Rename in place; the list shows the new title.
  await page.getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('Meeting title').fill('Budget sync (Q4)');
  await page.getByLabel('Meeting title').press('Enter');
  await expect(page.getByRole('heading', { name: 'Budget sync (Q4)' })).toBeVisible();
  await page.getByRole('button', { name: '← All meetings' }).click();
  await expect(page.getByRole('region', { name: 'Today' })).toContainText('Budget sync (Q4)');
  if (process.env.LT_SHOT) await page.screenshot({ path: `${process.env.LT_SHOT}-dashboard.png`, fullPage: true });
});

test('Dashboard search matches titles at once and carries a transcript hit into the meeting', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Weekly planning');
  await page.getByRole('button', { name: '← All meetings' }).click();

  const search = page.getByLabel('Search meetings');
  await search.fill('weekly');
  const results = page.getByRole('region', { name: 'Search results' });
  await expect(results.getByRole('button', { name: /Weekly planning/ })).toBeVisible();

  await search.fill('budget');
  await results.getByRole('button', { name: /budget notes/ }).click();
  await expect(page.getByLabel('Search transcript')).toHaveValue('budget');
  await expect(page.locator('.transcript mark')).toHaveText('budget');
  await expect(page.getByRole('region', { name: 'Transcript text' }).getByRole('status')).toHaveText('1 of 1 lines');

  // The Dashboard query is still there on the way back.
  await page.getByRole('button', { name: '← All meetings' }).click();
  await expect(page.getByLabel('Search meetings')).toHaveValue('budget');
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
  await page.goto('/#/settings/models');
  await page.getByRole('region', { name: 'Transcribe after recording' }).getByLabel('Transcribe automatically after Stop').check();
  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Auto run');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  // No Transcribe click.
  await expect(page.getByText('Anna will send the budget notes.')).toBeVisible({ timeout: 30_000 });
});

test('meeting list: status filters, row rename and delete, back link to the Calendar', async ({ page }) => {
  test.setTimeout(120_000);
  await mockDesktop(page);
  await transcribedMeeting(page, 'Filter me');
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Raw audio');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(1_200);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  await page.goto('/#/');
  const filters = page.getByRole('group', { name: 'Filter meetings' });
  await filters.getByRole('button', { name: 'Transcribed (1)', exact: true }).click();
  await expect(page.locator('.meeting-item')).toHaveCount(1);
  await expect(page.locator('.meeting-item')).toContainText('Filter me');
  await filters.getByRole('button', { name: 'Not transcribed (1)' }).click();
  await expect(page.locator('.meeting-item')).toContainText('Raw audio');
  await filters.getByRole('button', { name: 'All (2)' }).click();

  await page.getByLabel('Actions for Raw audio').click();
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByLabel('Meeting title').fill('Raw audio (kept)');
  await page.getByLabel('Meeting title').press('Enter');
  await expect(page.locator('.meeting-item').filter({ hasText: 'Raw audio (kept)' })).toHaveCount(1);
  await page.getByLabel('Actions for Raw audio (kept)').click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('.meeting-item')).toHaveCount(1);

  // Opened from the Calendar (today is selected), the back link returns there.
  await page.getByRole('button', { name: 'Calendar' }).first().click();
  await page.getByRole('button', { name: 'Open', exact: true }).first().click();
  await expect(page.getByRole('button', { name: '← Calendar' })).toBeVisible();
  await page.getByRole('button', { name: '← Calendar' }).click();
  await expect(page.locator('.cal-grid')).toBeVisible();
});
