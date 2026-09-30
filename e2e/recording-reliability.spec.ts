import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Recording reliability in a real engine (runs on Chromium ≈ WebView2 and
 * WebKit ≈ WKWebView/WebKitGTK, on Linux, macOS and Windows in CI).
 */

const meetingIdFromUrl = (url: string) => decodeURIComponent(url.split('#/meeting/')[1] ?? '');

/** OPFS chunk files of a single-track meeting, with sizes. */
async function chunksOf(page: Page, id: string): Promise<{ name: string; size: number }[]> {
  return page.evaluate(async (meetingId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('meetings')).getDirectoryHandle(meetingId);
    const out: { name: string; size: number }[] = [];
    const it = dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
    for await (const [name, handle] of it.entries()) {
      if (handle.kind === 'file' && name !== 'meta.json') {
        out.push({ name, size: (await (handle as FileSystemFileHandle).getFile()).size });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, id);
}

/** Decode the stored chunks the way transcription does; returns seconds of audio. */
async function decodedSeconds(page: Page, id: string): Promise<number> {
  return page.evaluate(async (meetingId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('meetings')).getDirectoryHandle(meetingId);
    const meta = JSON.parse(await (await (await dir.getFileHandle('meta.json')).getFile()).text()) as {
      mimeType: string;
    };
    const it = dir as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
    const names: string[] = [];
    for await (const [name, handle] of it.entries()) {
      if (handle.kind === 'file' && name !== 'meta.json') names.push(name);
    }
    names.sort();
    const parts: Blob[] = [];
    for (const name of names) parts.push(await (await dir.getFileHandle(name)).getFile());
    const bytes = await new Blob(parts, { type: meta.mimeType }).arrayBuffer();
    const ctx = new AudioContext();
    try {
      return (await ctx.decodeAudioData(bytes)).duration;
    } finally {
      await ctx.close();
    }
  }, id);
}

/**
 * `prepare` runs in the page after navigation and before Start — not as an
 * init script, which a persistent context's first page (WebKit) may miss.
 */
async function startSpeakerRecording(page: Page, title: string, prepare?: () => void): Promise<void> {
  await page.goto('/#/new');
  if (prepare) await page.evaluate(prepare);
  await page.locator('#meeting-title').fill(title);
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
}

test('records through the worker writer when createWritable is missing (older macOS WebKit)', async ({
  page,
}) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await startSpeakerRecording(page, 'Worker writer', () => {
    delete (FileSystemFileHandle.prototype as { createWritable?: unknown }).createWritable;
  });
  expect(await page.evaluate(() => 'createWritable' in FileSystemFileHandle.prototype)).toBe(false);
  await page.waitForTimeout(6_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  const id = meetingIdFromUrl(page.url());

  const chunks = await chunksOf(page, id);
  expect(chunks.length).toBeGreaterThanOrEqual(2);
  expect(chunks.every((c) => c.size > 0)).toBe(true);
  expect(await decodedSeconds(page, id)).toBeGreaterThan(5);
  await expect(page.getByText(/could not be saved/i)).toHaveCount(0);
});

test('an unplugged microphone stops cleanly and keeps what was recorded', async ({ page }) => {
  test.setTimeout(60_000);
  page.on('dialog', (d) => void d.accept());
  await startSpeakerRecording(page, 'Unplugged mic', () => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    // Patch the prototype: WebKit ignores an own-property override on
    // navigator.mediaDevices.
    const proto = MediaDevices.prototype;
    const original = proto.getUserMedia;
    proto.getUserMedia = async function (this: MediaDevices, constraints?: MediaStreamConstraints) {
      const stream = await original.call(this, constraints);
      w.__streams.push(stream);
      return stream;
    };
  });
  await page.waitForTimeout(6_500);
  expect(
    await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length),
  ).toBeGreaterThan(0);

  // What the OS does on unplug: the track ends (script stop() fires no event).
  await page.evaluate(() => {
    for (const stream of (window as unknown as { __streams: MediaStream[] }).__streams) {
      for (const track of stream.getAudioTracks()) {
        track.stop();
        track.dispatchEvent(new Event('ended'));
      }
    }
  });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Recording interrupted');
  await expect(alert).toContainText('disconnected');
  await expect(page.getByRole('button', { name: 'Retry saving' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Stop & keep what was saved' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  const id = meetingIdFromUrl(page.url());
  expect((await chunksOf(page, id)).length).toBeGreaterThanOrEqual(1);
  expect(await decodedSeconds(page, id)).toBeGreaterThan(5);
});

test('refuses to record when recordings could not be stored durably', async ({ page }) => {
  await page.addInitScript(() => {
    delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory;
  });
  await page.goto('/#/new');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByText(/cannot store recordings safely/i)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toHaveCount(0);
});
