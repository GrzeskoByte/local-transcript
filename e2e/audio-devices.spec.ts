import { expect, test } from '@playwright/test';

/**
 * Input/output selection: Settings and New Meeting share one choice, the
 * recording captures from it, and on the Linux desktop Device Audio records
 * the chosen sound-server output. Devices are faked; capture runs for real
 * on Chromium's fake device.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __calls: Array<{ cmd: string; args?: unknown }>;
      __gum: unknown[];
      __TAURI_INTERNALS__: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    w.__calls = [];
    w.__gum = [];
    let sourceUp = false;
    w.__TAURI_INTERNALS__ = {
      invoke: async (cmd, args) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'native_system_audio_status': return { available: true, hint: null };
          case 'native_system_audio_outputs':
            return [
              { name: 'alsa_output.pci.analog-stereo', description: 'Built-in Speakers', isDefault: true },
              { name: 'bluez_output.AA_BB.1', description: 'WH-1000XM4', isDefault: false },
            ];
          case 'native_system_audio_start': sourceUp = true; return { label: 'Local_Transcribe_system_audio', sink: 'x' };
          case 'native_system_audio_stop': sourceUp = false; return null;
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };
    const md = navigator.mediaDevices;
    const gum = md.getUserMedia.bind(md);
    const dev = (kind: string, label: string, deviceId: string) =>
      ({ kind, label, deviceId, groupId: 'g', toJSON() { return this; } }) as unknown as MediaDeviceInfo;
    md.enumerateDevices = async () => [
      dev('audioinput', 'Default', 'default'),
      dev('audioinput', 'Built-in Mic', 'mic-builtin'),
      dev('audioinput', 'USB Podcast Mic', 'mic-usb'),
      ...(sourceUp ? [dev('audioinput', 'Local_Transcribe_system_audio', 'lt-system')] : []),
    ];
    md.getUserMedia = async (c) => {
      w.__gum.push(JSON.parse(JSON.stringify(c ?? null)));
      // Chromium's fake device stands in for every faked input.
      const audio = c && typeof c.audio === 'object' ? { ...c.audio, deviceId: undefined } : c?.audio;
      return gum({ ...c, audio });
    };
  });
});

test('microphone chosen in Settings is used for recording and shown on New Meeting', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByRole('tab', { name: 'App' }).click();
  const card = page.getByRole('region', { name: 'Audio devices' });
  const mic = card.getByLabel('Microphone');
  await expect(mic.locator('option')).toHaveText(['System default', 'Built-in Mic', 'USB Podcast Mic']);
  await mic.selectOption({ label: 'USB Podcast Mic' });
  await card.getByLabel('Record sound from').selectOption({ label: 'WH-1000XM4' });

  await page.goto('/#/new');
  await expect(page.getByLabel('Microphone')).toHaveValue('mic-usb');
  await expect(page.getByLabel('Record sound from')).toHaveCount(0); // Speaker mode: no output
  await page.getByRole('button', { name: /Mic \+ Device/ }).click();
  await expect(page.getByLabel('Record sound from')).toHaveValue('bluez_output.AA_BB.1');

  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  const { gum, calls } = await page.evaluate(() => {
    const w = window as unknown as { __gum: Array<{ audio?: { deviceId?: { exact?: string } } }>; __calls: Array<{ cmd: string; args?: { sink?: string | null } }> };
    return { gum: w.__gum, calls: w.__calls };
  });
  expect(gum.some((c) => c.audio?.deviceId?.exact === 'mic-usb')).toBe(true);
  expect(calls.find((c) => c.cmd === 'native_system_audio_start')?.args).toEqual({ sink: 'bluez_output.AA_BB.1' });
});

test('an unplugged saved microphone falls back to the system default', async ({ page }) => {
  await page.goto('/#/new');
  await page.evaluate(() =>
    localStorage.setItem('audio-input-device', JSON.stringify({ deviceId: 'gone', label: 'Old Headset' })),
  );
  await page.reload();
  await expect(page.getByLabel('Microphone')).toHaveValue('missing:gone');
  await expect(page.getByText('This microphone isn’t connected — the system default will be used.')).toBeVisible();

  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);
  const gum = await page.evaluate(
    () => (window as unknown as { __gum: Array<{ audio?: { deviceId?: unknown } }> }).__gum,
  );
  expect(gum.every((c) => c.audio?.deviceId === undefined)).toBe(true);
});
