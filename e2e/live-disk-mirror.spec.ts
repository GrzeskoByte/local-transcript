import { expect, test } from '@playwright/test';

/**
 * Desktop: the recording is written into the local folder chunk by chunk while
 * it records (native_save_file with `append`), so Stop never copies the whole
 * recording in one go. The fake shell keeps both the recording store and the
 * local folder in the page.
 */
test('desktop mirror appends audio while recording; stop does not re-copy it', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    delete (StorageManager.prototype as { getDirectory?: unknown }).getDirectory;
    const files = new Map<string, string>(); // recording store: "<id>/<track>/<name>" -> base64
    const disk = new Map<string, string>(); // local folder: relativePath -> binary string
    const meta = new Map<string, string>();
    const w = window as unknown as {
      __disk: Map<string, string>;
      __saves: { path: string; append: boolean; bytes: number; at: number }[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
    };
    w.__disk = disk;
    w.__saves = [];
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args = {}) => {
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
            const parts = [...files].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
            return btoa(parts.map(([, v]) => atob(v)).join(''));
          }
          case 'native_save_file': {
            const r = args.request as { relativePath: string; dataBase64: string; append?: boolean };
            const data = atob(r.dataBase64);
            disk.set(r.relativePath, (r.append ? (disk.get(r.relativePath) ?? '') : '') + data);
            w.__saves.push({ path: r.relativePath, append: !!r.append, bytes: data.length, at: Date.now() });
            return `/docs/${r.relativePath}`;
          }
          case 'native_storage_file_size': {
            const f = disk.get(args.relativePath as string);
            return f === undefined ? null : f.length;
          }
          default:
            return null;
        }
      },
    };
  });

  page.on('dialog', (d) => void d.accept());
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Live mirror');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(6_500);

  // A chunk is already on disk before Stop.
  const before = await page.evaluate(() => {
    const w = window as unknown as { __disk: Map<string, string> };
    return [...w.__disk].filter(([p]) => /\/audio\.\w+$/.test(p)).map(([p, d]) => ({ p, size: d.length }));
  });
  expect(before).toHaveLength(1);
  expect(before[0]!.size).toBeGreaterThan(0);
  const stopAt = await page.evaluate(() => Date.now());

  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  const id = decodeURIComponent(page.url().split('#/meeting/')[1] ?? '');
  await expect
    .poll(() => page.evaluate(() => [...(window as unknown as { __disk: Map<string, string> }).__disk.keys()].some((p) => p.endsWith('/meeting.json'))))
    .toBe(true);

  const result = await page.evaluate(
    async ({ meetingId, stopAt, audioPath }) => {
      const w = window as unknown as {
        __disk: Map<string, string>;
        __saves: { path: string; append: boolean; bytes: number; at: number }[];
        __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
      };
      const audioSaves = w.__saves.filter((s) => s.path === audioPath);
      const stored = atob((await w.__TAURI_INTERNALS__.invoke('native_recording_read', { meetingId, track: '' })) as string);
      const onDisk = w.__disk.get(audioPath) ?? '';
      const bytes = Uint8Array.from(onDisk, (c) => c.charCodeAt(0));
      const ctx = new AudioContext();
      try {
        return {
          writes: audioSaves.filter((s) => !s.append).length,
          afterStop: audioSaves.filter((s) => s.at >= stopAt).reduce((n, s) => n + s.bytes, 0),
          same: onDisk === stored,
          seconds: (await ctx.decodeAudioData(bytes.buffer)).duration,
        };
      } finally {
        await ctx.close();
      }
    },
    { meetingId: id, stopAt, audioPath: before[0]!.p },
  );
  // Created once, then only appended; Stop added just the final slice.
  expect(result.writes).toBe(1);
  expect(result.afterStop).toBeLessThan(before[0]!.size * 2);
  expect(result.same).toBe(true);
  expect(result.seconds).toBeGreaterThan(5);
});
