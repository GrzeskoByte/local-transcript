import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * Summary → GitLab issues: once GitLab is set up, each action item of the
 * LLM summary can become an issue (owner assigned when they are a project
 * member, due date when it is a date). Only the network (LLM + GitLab) and
 * the Tauri bridge (settings file, a fake whisper) are mocked.
 */
async function mockDesktop(page: Page, gitlab = true): Promise<void> {
  await page.addInitScript((withGitlab) => {
    const status = {
      available: true, backend: 'voxtype', binaryPath: '/usr/bin/voxtype', version: '1.0.1',
      engines: ['whisper'], acceleration: null, modelDir: '/tmp/models', installHint: null,
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [{ name: 'large-v3-turbo', engine: 'whisper', installed: true, downloadable: true, path: '/tmp/m.bin',
        sizeBytes: 1, accuracy: 90, recommended: true, detail: '' }],
    };
    const settings: Record<string, unknown> = {
      'gitlab-config': { url: 'https://git.example.com', project: 'team/app', token: 'glpat-x', target: 'wiki', branch: 'main' },
      'llm-config': { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', completionsPath: '/chat/completions', apiKey: '', model: 'llama3.1' },
    };
    if (!withGitlab) delete settings['gitlab-config'];
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        switch (cmd) {
          case 'native_settings_load': return settings;
          case 'native_settings_set': settings[args!.key as string] = args!.value; return null;
          case 'native_asr_status': return status;
          case 'native_asr_models': return status.models;
          case 'native_asr_transcribe': return [{ startMs: 0, endMs: 2000, text: 'Anna will send the notes.' }];
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
  }, gitlab);
}

/** Record a short meeting, transcribe it (fake whisper) and summarize it (mocked LLM). */
async function summarizedMeeting(page: Page, title: string): Promise<void> {
  page.on('dialog', (d) => void d.accept());
  await page.route('http://localhost:11434/v1/chat/completions', (route: Route) =>
    route.fulfill({ json: { choices: [{ message: { content: SUMMARY } }] } }),
  );
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill(title);
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(2_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByText('Anna will send the notes.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Summarize with LLM' }).click();
  await expect(page.getByRole('region', { name: 'Meeting summary' })).toBeVisible();
}

const SUMMARY = [
  '# TL;DR',
  'We planned the release.',
  '# Key points',
  '- Release on Friday',
  '# Action items',
  '- Anna: send the release notes (2026-10-20)',
  '- Unassigned: book the demo room',
  '- Bob: update the changelog (Friday)',
].join('\n');

test('summary action items become GitLab issues, only the selected ones, once each', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  const issues: Record<string, unknown>[] = [];
  await page.route('https://git.example.com/api/v4/**', (route: Route) => {
    const url = route.request().url();
    if (url.includes('/members/all')) {
      const q = new URL(url).searchParams.get('query');
      return route.fulfill({ json: q === 'Anna' ? [{ id: 7, username: 'anna', name: 'Anna' }] : [] });
    }
    if (url.endsWith('/projects/team%2Fapp/issues') && route.request().method() === 'POST') {
      issues.push(route.request().postDataJSON() as Record<string, unknown>);
      const iid = 40 + issues.length;
      return route.fulfill({ status: 201, json: { iid, web_url: `https://git.example.com/team/app/-/issues/${iid}` } });
    }
    return route.fulfill({ status: 404, body: 'unexpected' });
  });

  await summarizedMeeting(page, 'Release sync');

  const items = page.getByRole('list', { name: 'Action items' });
  await expect(items.getByRole('checkbox')).toHaveCount(3);
  if (process.env.LT_SHOT) await page.getByRole('region', { name: 'Meeting summary' }).screenshot({ path: process.env.LT_SHOT });
  // All selected by default; leave out the unassigned one.
  await items.getByRole('checkbox', { name: 'Unassigned: book the demo room' }).uncheck();
  await page.getByRole('button', { name: 'Create GitLab issues (2)' }).click();
  await expect(page.getByText('Created 2 GitLab issues in team/app.')).toBeVisible();

  expect(issues.map((i) => i.title)).toEqual(['send the release notes', 'update the changelog']);
  expect(issues[0]).toMatchObject({ due_date: '2026-10-20', assignee_ids: [7], labels: 'local-transcribe,action-item' });
  expect(issues[1]).not.toHaveProperty('assignee_ids');
  expect(String(issues[1]!.description)).toContain('**Due:** Friday');
  await expect(items.getByRole('link', { name: 'Issue #41' })).toBeVisible();
  await expect(items).toContainText('@anna');

  // Created issues stay linked after a reload; only the remaining item is offered.
  await page.reload();
  await expect(items.getByRole('link', { name: 'Issue #42' })).toBeVisible();
  await expect(items.getByRole('checkbox')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Create GitLab issue (1)' })).toBeVisible();
});

test('without GitLab set up, action items stay a plain list', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page, false);
  await summarizedMeeting(page, 'No GitLab');
  const items = page.getByRole('list', { name: 'Action items' });
  await expect(items).toContainText('☐ Anna: send the release notes (2026-10-20)');
  await expect(items.getByRole('checkbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Create GitLab issue/ })).toHaveCount(0);
});
