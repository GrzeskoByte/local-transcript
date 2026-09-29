import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * MVP §26 data integrity, end to end, through the REAL pipeline:
 * MediaRecorder → OPFS chunks → decode → preprocess → VAD chunking → WAV →
 * native bridge → IndexedDB. Only the Tauri boundary is mocked: a fake voxtype
 * that answers every chunk with one line of text and records what it received.
 */
async function installNativeMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Call = { cmd: string; seconds?: number };
    const w = window as unknown as {
      __nativeCalls: Call[];
      __nativeMode: 'all' | 'first-only';
      __nativeDelayMs: number;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__nativeCalls = [];
    w.__nativeMode = 'all';
    w.__nativeDelayMs = 0;
    const status = {
      available: true, backend: 'voxtype', binaryPath: '/usr/bin/voxtype', version: '1.0.1',
      engines: ['whisper'], acceleration: 'Vulkan', modelDir: '/tmp/models', installHint: null,
      gpu: { available: false, active: true, backend: 'Vulkan', devices: [], hint: null },
      models: [{ name: 'large-v3-turbo', engine: 'whisper', installed: true, downloadable: true, path: '/tmp/m.bin',
        sizeBytes: 1, accuracy: 90, recommended: true, detail: '' }],
    };
    let transcribeCalls = 0;
    let reruns = 0;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        if (cmd === 'native_asr_transcribe') {
          const req = (args?.request ?? {}) as { samplesBase64: string; sampleRate: number };
          const bytes = Math.floor((req.samplesBase64.length * 3) / 4) - 44;
          const seconds = bytes / 2 / req.sampleRate;
          w.__nativeCalls.push({ cmd, seconds });
          transcribeCalls += 1;
          if (w.__nativeDelayMs) await new Promise((r) => setTimeout(r, w.__nativeDelayMs));
          if (w.__nativeMode === 'first-only') {
            reruns += 1;
            return reruns > 1 ? [] : [{ startMs: 0, endMs: seconds * 1000, text: 'Re-run line' }];
          }
          return [{ startMs: 0, endMs: seconds * 1000, text: `Spoken line ${transcribeCalls}` }];
        }
        w.__nativeCalls.push({ cmd });
        if (cmd === 'native_asr_status') return status;
        if (cmd === 'native_asr_models') return status.models;
        if (cmd === 'native_storage_dir') return '/tmp/Local Transcribe';
        return null;
      },
    };
  });
}

/** Everything the app stores for one meeting, read straight from IndexedDB + OPFS. */
async function storedFor(page: Page, id: string) {
  return page.evaluate(async (meetingId) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('local-transcribe');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const get = <T>(store: string, fn: (s: IDBObjectStore) => IDBRequest<T>) =>
      new Promise<T>((res, rej) => {
        const req = fn(db.transaction(store).objectStore(store));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    const meeting = await get('meetings', (s) => s.get(meetingId));
    const segments = await get('segments', (s) => s.index('by-meeting').getAll(meetingId));
    let opfs = false;
    try {
      const root = await navigator.storage.getDirectory();
      const meetings = await root.getDirectoryHandle('meetings');
      await meetings.getDirectoryHandle(meetingId);
      opfs = true;
    } catch {
      opfs = false;
    }
    db.close();
    return { meeting: meeting ?? null, segments: segments as { text: string; startMs: number }[], opfs };
  }, id);
}

const meetingIdFromUrl = (url: string) => decodeURIComponent(url.split('#/meeting/')[1] ?? '');
const seconds = (mmss: string) => mmss.split(':').reduce((n, p) => n * 60 + Number(p), 0);

test('record → stop → reopen → play → transcribe → reopen → re-transcribe → delete', async ({ page }) => {
  test.setTimeout(120_000);
  page.on('dialog', (d) => void d.accept());
  await installNativeMock(page);

  // --- record ---
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Integrity Test');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(6_000);

  // The live recording must never be offered for "recovery" or deletion (§15).
  await page.getByRole('button', { name: 'Meetings' }).first().click();
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  await expect(page.getByText('An unfinished recording was found.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Recording…' }).first().click();

  // Pause for 3 s: paused time is not recording time.
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.waitForTimeout(3_000);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.waitForTimeout(2_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();

  await expect(page).toHaveURL(/#\/meeting\//);
  const id = meetingIdFromUrl(page.url());
  const header = await page.locator('h1 + p.muted').first().textContent();
  const recorded = seconds(header!.split(' · ')[0]!.replace('≈ ', ''));
  expect(recorded).toBeGreaterThanOrEqual(6);
  expect(recorded).toBeLessThanOrEqual(10); // ~8 s recorded, not ~11 s wall clock

  // --- close / reopen → play ---
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Integrity Test' })).toBeVisible();
  const playable = await page.locator('audio.player').first().evaluate(
    (a: HTMLAudioElement) =>
      new Promise<boolean>((res) => {
        if (a.readyState >= 1) return res(true);
        a.onloadedmetadata = () => res(true);
        a.onerror = () => res(false);
      }),
  );
  expect(playable).toBe(true);
  expect((await storedFor(page, id)).meeting?.transcriptionStatus).toBe('not_started');

  // --- transcribe (speech-chunked for the text-only voxtype backend) ---
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.locator('.transcript li').first()).toBeVisible({ timeout: 30_000 });
  const calls = await page.evaluate(
    () => (window as unknown as { __nativeCalls: { cmd: string; seconds?: number }[] }).__nativeCalls
      .filter((c) => c.cmd === 'native_asr_transcribe'),
  );
  expect(calls.length).toBeGreaterThanOrEqual(1);
  for (const c of calls) expect(c.seconds!).toBeLessThanOrEqual(28.5);
  const first = await storedFor(page, id);
  expect(first.meeting?.transcriptionStatus).toBe('completed');
  expect(first.segments.length).toBe(calls.length);

  // --- close / reopen → transcript still exists ---
  await page.reload();
  await expect(page.locator('.transcript li')).toHaveCount(first.segments.length);

  // --- re-transcribe with a backend that now returns fewer lines: no stale rows ---
  await page.evaluate(() => {
    (window as unknown as { __nativeMode: string }).__nativeMode = 'first-only';
  });
  await page.getByRole('button', { name: 'Re-transcribe' }).click();
  // Wait for the re-run's own output, not a row count that may already match.
  await expect
    .poll(async () => (await storedFor(page, id)).segments.map((s) => s.text), { timeout: 30_000 })
    .toEqual(['Re-run line']);
  await expect(page.locator('.transcript li')).toHaveCount(1);

  // --- delete → metadata, transcript and audio all gone (§23) ---
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  const after = await storedFor(page, id);
  expect(after).toEqual({ meeting: null, segments: [], opfs: false });
});

test('storage failure while recording is surfaced, retryable, and never reported as saved', async ({ page }) => {
  test.setTimeout(90_000);
  page.on('dialog', (d) => void d.accept());
  await installNativeMock(page);
  // Test hook: make OPFS writes fail on demand.
  await page.addInitScript(() => {
    const w = window as unknown as { __failWrites: boolean };
    w.__failWrites = false;
    const proto = FileSystemFileHandle.prototype as unknown as { createWritable: (...a: unknown[]) => Promise<unknown> };
    const original = proto.createWritable;
    proto.createWritable = function (this: unknown, ...a: unknown[]) {
      if (w.__failWrites) return Promise.reject(new DOMException('Quota exceeded', 'QuotaExceededError'));
      return original.apply(this, a);
    };
  });
  const setFail = (v: boolean) =>
    page.evaluate((x) => {
      (window as unknown as { __failWrites: boolean }).__failWrites = x;
    }, v);

  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Disk Full');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByText('Audio chunks are being saved on this device')).toBeVisible();

  // Disk fills up: the UI must stop claiming the audio is saved.
  await setFail(true);
  await expect(page.getByText('Some audio could not be saved to disk.')).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText('Audio chunks are being saved on this device')).toHaveCount(0);

  // Space is freed: Retry writes the held chunks and recording carries on.
  await setFail(false);
  await page.getByRole('button', { name: 'Retry saving' }).click();
  await expect(page.getByText('Audio chunks are being saved on this device')).toBeVisible();

  // Fails again and the user stops without retrying: the gap is reported.
  await setFail(true);
  await expect(page.getByText('Some audio could not be saved to disk.')).toBeVisible({ timeout: 12_000 });
  await page.getByRole('button', { name: 'Stop & keep what was saved' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.getByText('Part of this recording could not be saved.')).toBeVisible();
  const id = meetingIdFromUrl(page.url());
  const stored = await storedFor(page, id);
  expect((stored.meeting as { unsavedChunks?: number } | null)?.unsavedChunks).toBeGreaterThan(0);
});

test('deleting a meeting mid-transcription leaves no zombie record or orphan segments', async ({ page }) => {
  test.setTimeout(90_000);
  page.on('dialog', (d) => void d.accept());
  await installNativeMock(page);
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Delete Race');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await page.waitForTimeout(6_000);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  const id = meetingIdFromUrl(page.url());

  // A slow backend keeps the transcription running while the user deletes.
  await page.evaluate(() => {
    (window as unknown as { __nativeDelayMs: number }).__nativeDelayMs = 2_500;
  });
  await page.getByRole('button', { name: 'Transcribe', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Transcription in progress' })).toBeVisible();
  await page.getByRole('button', { name: 'Delete meeting' }).click();
  await expect(page.getByRole('heading', { name: 'My Meetings' })).toBeVisible();
  // Give any straggling write time to land, then verify nothing came back.
  await page.waitForTimeout(4_000);
  expect(await storedFor(page, id)).toEqual({ meeting: null, segments: [], opfs: false });
  await expect(page.getByText('Delete Race')).toHaveCount(0);
});
