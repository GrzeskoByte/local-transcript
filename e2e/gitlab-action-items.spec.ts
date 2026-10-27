import { expect, test } from './fixtures';
import type { Page, Route } from '@playwright/test';
import { route } from './helpers';

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
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByText('Anna will send the notes.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('tab', { name: /Summary/ }).click();
  await page.getByRole('button', { name: 'Summarize with LLM' }).click();
  await expect(page.getByRole('region', { name: 'Action items' })).toBeVisible();
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

  // Route two of the three items to GitLab, then create them in the GitLab tab.
  await route(page, 'send the release notes', 'GitLab');
  await route(page, 'book the demo room', 'GitLab', false);
  await route(page, 'update the changelog', 'GitLab');
  await page.getByRole('tab', { name: /GitLab/ }).click();
  const table = page.getByRole('table', { name: 'Issues to create' });
  await expect(table.getByLabel('Issue title')).toHaveCount(2);
  await page.getByRole('button', { name: 'Create 2 issues' }).click();
  await expect(page.getByRole('link', { name: '#41' })).toBeVisible();

  expect(issues.map((i) => i.title)).toEqual(['send the release notes', 'update the changelog']);
  expect(issues[0]).toMatchObject({ due_date: '2026-10-20', assignee_ids: [7], labels: 'local-transcribe,action-item' });
  expect(issues[1]).not.toHaveProperty('assignee_ids');
  expect(String(issues[1]!.description)).toContain('**Due:** Friday');

  // Created issues stay linked after a reload and are never offered again.
  await page.reload();
  await page.getByRole('tab', { name: /Summary/ }).click();
  const items = page.getByRole('region', { name: 'Action items' });
  await expect(items.getByRole('link', { name: /GitLab #42/ })).toBeVisible();
  await expect(items.getByRole('listitem').filter({ hasText: 'send the release notes' }).getByRole('button', { name: /GitLab/ })).toBeDisabled();
  await page.getByRole('tab', { name: /GitLab/ }).click();
  await expect(page.getByRole('table', { name: 'Issues to create' })).toHaveCount(0);
});

test('without GitLab set up, the GitLab tab asks to connect it', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page, false);
  await summarizedMeeting(page, 'No GitLab');
  const items = page.getByRole('region', { name: 'Action items' });
  await expect(items).toContainText('send the release notes');
  await expect(items).toContainText('not set up');
  await page.getByRole('tab', { name: /GitLab/ }).click();
  await expect(page.getByRole('button', { name: /Create .* issue/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Set up GitLab sharing' }).or(page.getByRole('button', { name: 'Connect GitLab' })).first()).toBeVisible();
});

test('edit the summary row by row, load participants from a GitLab group, create issues in another project', async ({ page }) => {
  test.setTimeout(120_000);
  await mockDesktop(page);
  const posted: { url: string; body: Record<string, unknown> }[] = [];
  await page.route('https://git.example.com/api/v4/**', (route: Route) => {
    const url = route.request().url();
    if (route.request().method() === 'POST') {
      posted.push({ url, body: route.request().postDataJSON() as Record<string, unknown> });
      return route.fulfill({ status: 201, json: { iid: 5, web_url: 'https://git.example.com/ops/infra/-/issues/5' } });
    }
    if (url.includes('/api/v4/groups?')) return route.fulfill({ json: [{ id: 4, full_path: 'team', full_name: 'Team' }] });
    if (url.includes('/api/v4/projects?')) {
      return route.fulfill({
        json: [
          { id: 1, path_with_namespace: 'team/app', name_with_namespace: 'Team / App', web_url: 'https://git.example.com/team/app' },
          { id: 2, path_with_namespace: 'ops/infra', name_with_namespace: 'Ops / Infra', web_url: 'https://git.example.com/ops/infra' },
        ],
      });
    }
    if (url.includes('/groups/4/members/all')) {
      return route.fulfill({ json: [{ id: 11, username: 'carol', name: 'Carol Diaz', state: 'active' }, { id: 12, username: 'dan', name: 'Dan', state: 'active' }] });
    }
    if (url.endsWith('/users/11')) return route.fulfill({ json: { public_email: 'carol@example.com' } });
    if (url.includes('/users/')) return route.fulfill({ json: { public_email: '' } });
    if (url.includes('/members/all')) return route.fulfill({ json: [] });
    return route.fulfill({ json: [] });
  });
  await summarizedMeeting(page, 'Infra sync');

  // Participants from a GitLab group (public e-mails come along).
  const people = page.getByRole('region', { name: 'Participants' });
  await people.getByRole('button', { name: 'From GitLab…' }).click();
  await people.getByRole('button', { name: 'Load my projects & groups' }).click();
  await people.getByLabel('GitLab group').selectOption({ label: 'Team' });
  await people.getByRole('button', { name: 'Load members of Team' }).click();
  await people.getByRole('button', { name: 'Add 2 participants' }).click();
  await expect(people.getByRole('list', { name: 'Meeting participants' })).toContainText('Carol Diaz @carol · carol@example.com');
  await expect(people).toContainText('Participants · 2');

  // Structured editor: change an owner, reword a task, add a key point.
  await page.getByRole('button', { name: '✎ Edit summary' }).click();
  await page.getByLabel('Owner of action item 3').fill('Carol Diaz');
  await page.getByLabel('Action item 3', { exact: true }).fill('patch the VPN');
  await page.getByRole('button', { name: '+ Add key point' }).click();
  await page.getByLabel('Key points 2', { exact: true }).fill('VPN patch is urgent');
  await page.getByRole('button', { name: 'Save summary' }).click();
  const items = page.getByRole('region', { name: 'Action items' });
  await expect(items).toContainText('patch the VPN');
  await expect(items).toContainText('Carol Diaz · Friday');
  await expect(page.getByRole('region', { name: 'Meeting summary' })).toContainText('VPN patch is urgent');

  // Only the VPN item goes to GitLab, into another project picked from the list.
  await route(page, 'send the release notes', 'GitLab', false);
  await route(page, 'book the demo room', 'GitLab', false);
  await route(page, 'patch the VPN', 'GitLab');
  await page.getByRole('tab', { name: /GitLab/ }).click();
  await page.getByRole('button', { name: 'Another project…' }).click();
  await page.getByRole('button', { name: 'Load my projects & groups' }).click();
  await page.getByLabel('GitLab create issues in').selectOption('ops/infra');
  await page.getByRole('button', { name: 'Create 1 issue' }).click();
  await expect(page.getByRole('link', { name: '#5' })).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]!.url).toContain('/projects/ops%2Finfra/issues');
  expect(posted[0]!.body.title).toBe('patch the VPN');
});
