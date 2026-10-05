import { expect, test } from '@playwright/test';

/**
 * The AppImage's WebKitGTK has no OPFS (`navigator.storage.getDirectory`).
 * The desktop shell then stores recorder chunks on disk through Rust
 * (`native_recording_*`, src-tauri/src/recordings.rs) — recording must work,
 * be playable and decodable, and never fall back to memory. The fake shell
 * keeps the "disk" in the page.
 */
test('records to the native store when the webview has no OPFS', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory;
    const files = new Map<string, string>(); // "<id>/<track>/<name>" -> base64
    const meta = new Map<string, string>();
    const w = window as unknown as {
      __files: Map<string, string>;
      __calls: string[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__files = files;
    w.__calls = [];
    const concat = (parts: string[]) => btoa(parts.map((p) => atob(p)).join(''));
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
        w.__calls.push(cmd);
        const id = args.meetingId as string;
        switch (cmd) {
          case 'native_recording_write': {
            const r = args.request as { meetingId: string; track: string; name: string; dataBase64: string };
            files.set(`${r.meetingId}/${r.track}/${r.name}`, r.dataBase64);
            return null;
          }
          case 'native_recording_write_meta': meta.set(id, args.meta as string); return null;
          case 'native_recording_read_meta': return meta.get(id) ?? null;
          case 'native_recording_list': {
            const tracks = new Map<string, string[]>();
            for (const key of files.keys()) {
              const [mid, track, name] = key.split('/') as [string, string, string];
              if (mid === id) tracks.set(track, [...(tracks.get(track) ?? []), name].sort());
            }
            return [...tracks].map(([track, chunks]) => ({ track, chunks }));
          }
          case 'native_recording_read': {
            const prefix = `${id}/${args.track as string}/`;
            return concat([...files].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v));
          }
          case 'native_recording_delete':
            for (const key of [...files.keys()]) if (key.startsWith(`${id}/`)) files.delete(key);
            return null;
          default:
            return null;
        }
      },
    };
  });

  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('No OPFS');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(6_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.getByText(/could not be saved/i)).toHaveCount(0);
  const id = decodeURIComponent(page.url().split('#/meeting/')[1] ?? '');
  // Meeting Detail does not read the recording until it is played.
  const reads = () =>
    page.evaluate(() => (window as unknown as { __calls: string[] }).__calls.filter((c) => c === 'native_recording_read').length);
  await expect(page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Play' })).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await reads()).toBe(0);
  await page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Play' }).click();
  await expect.poll(reads).toBe(1);
  await expect(page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Pause' })).toHaveCount(1);
  await page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Pause' }).click();

  const result = await page.evaluate(async (meetingId) => {
    const w = window as unknown as {
      __files: Map<string, string>;
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    const chunks = [...w.__files.keys()].filter((k) => k.startsWith(`${meetingId}//`));
    const b64 = (await w.__TAURI_INTERNALS__.invoke('native_recording_read', { meetingId, track: '' })) as string;
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const ctx = new AudioContext();
    try {
      const seconds = (await ctx.decodeAudioData(bytes.buffer)).duration;
      return { chunks: chunks.length, seconds };
    } finally {
      await ctx.close();
    }
  }, id);
  expect(result.chunks).toBeGreaterThanOrEqual(2);
  expect(result.seconds).toBeGreaterThan(5);
  // The player gets the recording from the native store.
  await expect(page.getByRole('region', { name: 'Recording playback' }).getByRole('button', { name: 'Play' })).toHaveCount(1);

  // Delete removes the chunks from disk too.
  await page.getByRole('button', { name: /^Delete/ }).first().click();
  await expect(page).not.toHaveURL(/#\/meeting\//);
  expect(await page.evaluate((meetingId) => {
    const w = window as unknown as { __files: Map<string, string> };
    return [...w.__files.keys()].filter((k) => k.startsWith(`${meetingId}/`)).length;
  }, id)).toBe(0);
});
