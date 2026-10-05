import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Desktop shells record natively (src-tauri/src/recorder): the webview opens
 * no capture stream and no MediaRecorder, Stop is one shell call, and Meeting
 * Detail plays the Ogg Opus recording through the shell's decoder. Only the
 * Tauri bridge is mocked (a fake recorder with the same commands).
 */
async function mockNativeShell(page: Page, opts: { failStart?: boolean } = {}): Promise<void> {
  await page.addInitScript((failStart) => {
    type Call = { cmd: string; args?: unknown; headers?: Record<string, string> };
    const w = window as unknown as {
      __calls: Call[];
      __webviewCapture: number;
      __TAURI_INTERNALS__: unknown;
    };
    w.__calls = [];
    w.__webviewCapture = 0;
    const md = navigator.mediaDevices;
    if (md) {
      const gum = md.getUserMedia?.bind(md);
      const gdm = md.getDisplayMedia?.bind(md);
      md.getUserMedia = (c?: MediaStreamConstraints) => {
        w.__webviewCapture++;
        return gum!(c);
      };
      if (gdm) {
        md.getDisplayMedia = (c?: DisplayMediaStreamOptions) => {
          w.__webviewCapture++;
          return gdm(c);
        };
      }
    }
    const recorded = new Set<string>();
    let started = 0;
    let paused = false;
    const inputStats = (role: string) => ({
      role,
      settings: { label: role === 'device' ? 'Speakers' : 'USB Mic', sampleRate: 48000, channelCount: 1 },
      polls: 10,
      activePolls: 8,
      wideband4kPolls: 8,
      wideband8kPolls: 8,
      clippedPolls: 0,
      clippedSamples: 0,
      sampledSamples: 163840,
      dropoutPolls: 0,
      peakDb: -6,
      timeline: [{ t: 0, rmsDb: -24, peakDb: -6, clipped: 0 }],
    });
    let mode = 'speaker';
    const diagnostics = () => ({
      inputs: mode === 'dual' ? [inputStats('microphone'), inputStats('device')] : [inputStats(mode === 'device' ? 'device' : 'microphone')],
      events: [],
    });
    const pcm = () => {
      const out = new Int16Array(24000 * 3);
      for (let i = 0; i < out.length; i++) out[i] = Math.round(8000 * Math.sin((i * 440 * 2 * Math.PI) / 24000));
      return out.buffer;
    };
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args?: Record<string, unknown>, options?: { headers?: Record<string, string> }) => {
        w.__calls.push({ cmd, args: args instanceof Uint8Array ? `bytes:${args.length}` : args, headers: options?.headers });
        switch (cmd) {
          case 'native_recorder_devices':
            return {
              host: 'Fake',
              inputs: [{ id: 'mic', name: 'USB Mic', isDefault: true }],
              outputs: [{ id: 'spk', name: 'Speakers', isDefault: true }],
              systemAudio: true,
            };
          case 'native_recorder_start': {
            if (failStart) throw 'Could not open the microphone: busy';
            const req = (args as { request: { meetingId: string; mode: string } }).request;
            recorded.add(req.meetingId);
            mode = req.mode;
            started = Date.now();
            return { mimeType: 'audio/ogg;codecs=opus', inputs: ['USB Mic'] };
          }
          case 'native_recorder_pause':
            paused = true;
            return null;
          case 'native_recorder_resume':
            paused = false;
            return null;
          case 'native_recorder_poll':
            return {
              state: paused ? 'paused' : 'recording',
              elapsedMs: Date.now() - started,
              chunks: 1,
              unsavedChunks: 0,
              levels: [-24],
              mirrorOk: true,
              diagnostics: (args as { diagnostics?: boolean })?.diagnostics ? diagnostics() : undefined,
            };
          case 'native_recorder_stop':
            return {
              mimeType: 'audio/ogg;codecs=opus',
              durationMs: Date.now() - started,
              chunkCount: 1,
              unsavedChunks: 0,
              mirrorOk: true,
              diagnostics: diagnostics(),
            };
          case 'native_recording_list': {
            const id = (args as { meetingId: string }).meetingId;
            return recorded.has(id) ? [{ track: '', chunks: ['000000.ogg'] }] : [];
          }
          case 'native_recording_read_meta': {
            const id = (args as { meetingId: string }).meetingId;
            return recorded.has(id) ? JSON.stringify({ mimeType: 'audio/ogg;codecs=opus', startedAt: started }) : null;
          }
          case 'native_recording_read':
            return new Uint8Array([79, 103, 103, 83, 0, 2]).buffer;
          case 'native_audio_decode':
            return pcm();
          case 'native_storage_dir':
            return '/tmp/Local Transcribe';
          default:
            return null;
        }
      },
    };
  }, opts.failStart ?? false);
}

const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __calls: { cmd: string; args?: unknown; headers?: Record<string, string> }[] }).__calls);

test('records in the shell: no webview capture, instant Stop, playback via the shell decoder', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await mockNativeShell(page);
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Native Test');
  await page.getByRole('button', { name: /Mic \+ Device/ }).click();
  // System sound is recorded directly: no screen-share instructions.
  await expect(page.getByText(/pick a screen or window to share/)).toHaveCount(0);
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  await page.waitForTimeout(2_500);
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('button', { name: 'Resume' }).click();

  const stoppedAt = Date.now();
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  // Meeting Detail (Active Meeting shows the same title): the player is there.
  await expect(page).toHaveURL(/#\/meeting\//);
  await expect(page.getByRole('region', { name: 'Recording playback' })).toBeVisible();
  expect(Date.now() - stoppedAt).toBeLessThan(3_000);
  expect(await page.evaluate(() => (window as unknown as { __webviewCapture: number }).__webviewCapture)).toBe(0);

  const log = await calls(page);
  const start = log.find((c) => c.cmd === 'native_recorder_start')!.args as { request: Record<string, unknown> };
  expect(start.request).toMatchObject({ mode: 'dual' });
  expect(String(start.request.mirrorPath)).toMatch(/^Native-Test-.+\/audio\.ogg$/);
  for (const cmd of ['native_recorder_pause', 'native_recorder_resume', 'native_recorder_stop']) {
    expect(log.map((c) => c.cmd), cmd).toContain(cmd);
  }

  // Measurements came from the shell (both inputs, before the mix).
  const check = page.getByRole('region', { name: 'Audio check' });
  await check.getByText('Measurements').click();
  await expect(check.getByText(/“USB Mic”/)).toBeVisible();
  await expect(check.getByText(/“Speakers”/)).toBeVisible();

  // Play: the shell decodes the Ogg Opus file at the player's rate.
  const playback = page.getByRole('region', { name: 'Recording playback' });
  await playback.getByRole('button', { name: 'Play' }).click();
  await expect(playback.getByRole('button', { name: 'Pause' })).toBeVisible();
  const decode = (await calls(page)).find((c) => c.cmd === 'native_audio_decode');
  expect(decode?.headers).toEqual({ 'x-sample-rate': '24000' });
  expect(decode?.args).toMatch(/^bytes:/);
  await playback.getByRole('button', { name: 'Pause' }).click();
});

test('falls back to webview recording when the shell cannot open the devices', async ({ page }) => {
  page.on('dialog', (d) => void d.accept());
  await mockNativeShell(page, { failStart: true });
  await page.goto('/#/new');
  await page.locator('#meeting-title').fill('Fallback Test');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByRole('region', { name: 'Recording in progress' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __webviewCapture: number }).__webviewCapture)).toBeGreaterThan(0);
  await page.waitForTimeout(1_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  expect((await calls(page)).some((c) => c.cmd === 'native_recorder_stop')).toBe(false);
});
