import { expect, test } from '@playwright/test';

/**
 * Linux desktop: Device Audio / Two-way record system sound through the sound
 * server's virtual source (`native_system_audio_*`), never the screen picker.
 * The fake shell announces the virtual source as an extra audio input; the
 * recording, OPFS tracks and cleanup run for real.
 */
test('two-way on Linux records mic + system audio without a screen picker', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __calls: string[];
      __gum: unknown[];
      __TAURI_INTERNALS__: { invoke: (cmd: string) => Promise<unknown> };
    };
    w.__calls = [];
    w.__gum = [];
    let sourceUp = false;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd) => {
        w.__calls.push(cmd);
        switch (cmd) {
          case 'native_system_audio_status': return { available: true, hint: null };
          case 'native_system_audio_start': sourceUp = true; return { label: 'Local_Transcribe_system_audio', sink: 'alsa_output.test' };
          case 'native_system_audio_stop': sourceUp = false; return null;
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
    const md = navigator.mediaDevices;
    const enumerate = md.enumerateDevices.bind(md);
    const gum = md.getUserMedia.bind(md);
    md.enumerateDevices = async () => {
      const list = await enumerate();
      if (!sourceUp) return list;
      const fake = { kind: 'audioinput', label: 'Local_Transcribe_system_audio', deviceId: 'lt-system', groupId: 'lt', toJSON() { return this; } };
      return [...list, fake as unknown as MediaDeviceInfo];
    };
    md.getUserMedia = async (c) => {
      w.__gum.push(JSON.parse(JSON.stringify(c ?? null)));
      // Chromium's fake device stands in for the virtual source.
      const audio = c && typeof c.audio === 'object' ? { ...c.audio, deviceId: undefined } : c?.audio;
      return gum({ ...c, audio });
    };
    md.getDisplayMedia = async () => {
      throw new Error('screen picker must not be used for Linux system audio');
    };
  });

  await page.goto('/#/new');
  await page.getByRole('button', { name: /Mic \+ Device/ }).click();
  await expect(page.getByText('everything your computer plays (e.g. the call)')).toBeVisible();
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
  await page.waitForTimeout(2500);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  const id = decodeURIComponent(page.url().split('#/meeting/')[1]!);
  const state = await page.evaluate(async (meetingId) => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('meetings')).getDirectoryHandle(meetingId);
    const tracks: Record<string, number> = {};
    for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (handle.kind !== 'directory') continue;
      let n = 0;
      for await (const _ of (handle as unknown as { entries(): AsyncIterable<unknown> }).entries()) n++;
      tracks[name] = n;
    }
    const w = window as unknown as { __calls: string[]; __gum: Array<{ audio?: { deviceId?: { exact?: string }; echoCancellation?: boolean } }> };
    return { tracks, calls: w.__calls, gum: w.__gum };
  }, id);

  expect(state.tracks.microphone).toBeGreaterThan(0);
  expect(state.tracks.device).toBeGreaterThan(0);
  const system = state.gum.find((c) => c.audio?.deviceId?.exact === 'lt-system');
  expect(system?.audio?.echoCancellation).toBe(false);
  // The virtual source is created for the recording and removed afterwards.
  const start = state.calls.indexOf('native_system_audio_start');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(state.calls.indexOf('native_system_audio_stop', start)).toBeGreaterThan(start);
});
