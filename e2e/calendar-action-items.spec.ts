import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * Summary → calendar events: each picked action item becomes its own editable
 * event draft (task as title, due date or the next working day), created only
 * after approval, and never offered twice. Only the network (LLM) and the
 * Tauri bridge (settings file, a fake whisper, the calendar transport) are mocked.
 */
async function mockDesktop(page: Page, failOnCall = 0): Promise<void> {
  await page.addInitScript((failOn) => {
    const status = {
      available: true, backend: 'voxtype', binaryPath: '/usr/bin/voxtype', version: '1.0.1',
      engines: ['whisper'], acceleration: null, modelDir: '/tmp/models', installHint: null,
      gpu: { available: false, active: false, backend: null, devices: [], hint: null },
      models: [{ name: 'large-v3-turbo', engine: 'whisper', installed: true, downloadable: true, path: '/tmp/m.bin',
        sizeBytes: 1, accuracy: 90, recommended: true, detail: '' }],
    };
    const settings: Record<string, unknown> = {
      'calendar-config': {
        provider: 'caldav', serverUrl: 'https://cal.example/dav/me/', protocol: 'https', port: '',
        username: 'me', password: 'secret', token: '', calendarUrl: '', useNtlm: false,
      },
      'llm-config': { preset: 'ollama', baseUrl: 'http://localhost:11434/v1', completionsPath: '/chat/completions', apiKey: '', model: 'llama3.1' },
    };
    const w = window as unknown as { __created: unknown[]; __TAURI_INTERNALS__: unknown };
    w.__created = [];
    let calls = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        switch (cmd) {
          case 'native_settings_load': return settings;
          case 'native_settings_set': settings[args!.key as string] = args!.value; return null;
          case 'native_asr_status': return status;
          case 'native_asr_models': return status.models;
          case 'native_asr_transcribe': return [{ startMs: 0, endMs: 2000, text: 'Anna will send the notes.' }];
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          case 'native_calendar_create':
            calls += 1;
            if (calls === failOn) throw 'HTTP 503 from the calendar server';
            w.__created.push(args!.request);
            return '201';
          default: return null;
        }
      },
    };
  }, failOnCall);
}

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
  await expect(page.getByRole('region', { name: 'Calendar event' })).toBeVisible();
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

type Created = { body: string; method: string; endpoint: string };

test('picked action items become one approved calendar event each, never twice', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page);
  await summarizedMeeting(page, 'Release sync');

  const card = page.getByRole('region', { name: 'Calendar event' });
  const items = page.getByRole('list', { name: 'Action items' });
  await expect(items.getByRole('checkbox')).toHaveCount(3);
  await items.getByRole('checkbox', { name: 'Unassigned: book the demo room' }).uncheck();
  await page.getByRole('button', { name: 'Prepare calendar events (2)' }).click();

  // One editable draft per item; nothing is sent yet.
  const anna = card.getByRole('group', { name: 'Event for Anna: send the release notes (2026-10-20)' });
  await expect(anna.getByLabel('Event title')).toHaveValue('send the release notes');
  await expect(anna.getByLabel('Event start')).toHaveValue('2026-10-20T09:00');
  const bob = card.getByRole('group', { name: 'Event for Bob: update the changelog (Friday)' });
  await bob.getByLabel('Event title').fill('Changelog review with Bob');
  if (process.env.LT_SHOT) await card.screenshot({ path: process.env.LT_SHOT });
  expect(await page.evaluate(() => (window as unknown as { __created: unknown[] }).__created.length)).toBe(0);

  await card.getByRole('button', { name: 'Approve & create 2 events' }).click();
  await expect(card.getByRole('status')).toHaveText('Created 2 calendar events.');
  const created = await page.evaluate(() => (window as unknown as { __created: Created[] }).__created);
  expect(created).toHaveLength(2);
  expect(created[0]!.method).toBe('PUT');
  expect(created[0]!.body).toContain('SUMMARY:send the release notes');
  expect(created[0]!.body).toContain('DTSTART:20261020T090000');
  expect(created[0]!.body).toContain('Owner: Anna');
  expect(created[1]!.body).toContain('SUMMARY:Changelog review with Bob');
  expect(created[0]!.endpoint).not.toBe(created[1]!.endpoint);

  // After a reload the scheduled items are ticked; only the remaining one is offered.
  await page.reload();
  await expect(items).toContainText('✓ Anna: send the release notes (2026-10-20)Event 2026-10-20 09:00');
  await expect(items.getByRole('checkbox')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Prepare calendar event (1)' })).toBeVisible();
  await expect(card.getByRole('list', { name: 'Created calendar events' })).toContainText('Changelog review with Bob');
});

test('a failed event keeps only the drafts not yet created', async ({ page }) => {
  test.setTimeout(90_000);
  await mockDesktop(page, 2);
  await summarizedMeeting(page, 'Flaky calendar');
  const card = page.getByRole('region', { name: 'Calendar event' });
  await page.getByRole('button', { name: 'Prepare calendar events (3)' }).click();
  await card.getByRole('button', { name: 'Approve & create 3 events' }).click();
  await expect(card.getByRole('status')).toContainText('Created 1 event, then: HTTP 503 from the calendar server');
  await expect(card.getByRole('group')).toHaveCount(2);
  // Retrying creates the rest, not the first one again.
  await card.getByRole('button', { name: 'Approve & create 2 events' }).click();
  await expect(card.getByRole('status')).toHaveText('Created 2 calendar events.');
  const created = await page.evaluate(() => (window as unknown as { __created: Created[] }).__created);
  expect(created.map((c) => c.body.match(/SUMMARY:(.*)/)![1]!.trim())).toEqual([
    'send the release notes', 'book the demo room', 'update the changelog',
  ]);
});
