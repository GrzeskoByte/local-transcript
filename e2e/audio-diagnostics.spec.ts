import { expect, test } from '@playwright/test';

/**
 * Recording diagnostics in a real engine: the inputs are synthetic so the
 * expected problems are known. "System sound" is noise; the "microphone" is
 * the same noise 40 ms later (speakers → mic), overdriven into clipping. The
 * fake desktop shell reports a Bluetooth headset switching to call mode.
 * The analysers, the bleed correlation and the report run for real.
 */
test('Mic + Device recording reports clipping, speaker bleed and a headset switching to call mode', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    const card = (profile: string) => ({ name: 'bluez_card.X', description: 'Test Headset', profile, codec: null });
    const start = { defaultSink: 'bluez_output.X.a2dp', defaultSource: 'alsa_input.test', cards: [card('a2dp-sink')] };
    const log = {
      server: 'PulseAudio (on PipeWire 1.0)',
      start,
      events: [
        {
          atMs: 3000,
          event: "Event 'change' on card #77",
          snapshot: { ...start, defaultSink: 'bluez_output.X.hfp', cards: [card('headset-head-unit')] },
        },
      ],
      dropped: 0,
    };
    let sourceUp = false;
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        switch (cmd) {
          case 'native_system_audio_status': return { available: true, hint: null };
          case 'native_system_audio_start': sourceUp = true; return { label: 'Local_Transcribe_system_audio', sink: 'x' };
          case 'native_system_audio_stop': sourceUp = false; return null;
          case 'native_audio_diag_start': return start;
          case 'native_audio_diag_peek':
          case 'native_audio_diag_stop': return log;
          case 'native_storage_dir': return '/tmp/Local Transcribe';
          default: return null;
        }
      },
    };

    let streams: { mic: MediaStream; device: MediaStream } | null = null;
    const synth = () => {
      if (streams) return streams;
      const ctx = new AudioContext({ sampleRate: 48000 });
      const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const device = ctx.createMediaStreamDestination();
      const level = ctx.createGain();
      level.gain.value = 0.3;
      src.connect(level).connect(device);
      // Speakers → microphone: 40 ms later, far too loud (hard clip at ±1).
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.04;
      const hot = ctx.createGain();
      hot.gain.value = 6;
      const clip = ctx.createWaveShaper();
      clip.curve = new Float32Array([-1, 1]);
      const mic = ctx.createMediaStreamDestination();
      src.connect(delay).connect(hot).connect(clip).connect(mic);
      src.start();
      void ctx.resume();
      streams = { mic: mic.stream, device: device.stream };
      return streams;
    };
    const md = navigator.mediaDevices;
    const enumerate = md.enumerateDevices.bind(md);
    md.enumerateDevices = async () => {
      const list = await enumerate();
      if (!sourceUp) return list;
      const fake = { kind: 'audioinput', label: 'Local_Transcribe_system_audio', deviceId: 'lt-system', groupId: 'lt', toJSON() { return this; } };
      return [...list, fake as unknown as MediaDeviceInfo];
    };
    MediaDevices.prototype.getUserMedia = async function (c?: MediaStreamConstraints) {
      const audio = c?.audio as { deviceId?: { exact?: string } } | undefined;
      const s = synth();
      return audio?.deviceId?.exact === 'lt-system' ? s.device : s.mic;
    };
  });

  await page.goto('/#/new');
  await page.getByRole('button', { name: /Mic \+ Device/ }).click();
  await page.locator('#meeting-title').fill('Diagnostics');
  await page.getByRole('button', { name: '● Start Recording' }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();

  // Live warning while recording.
  const live = page.getByRole('status', { name: 'Audio warnings' });
  await expect(live).toBeVisible({ timeout: 15_000 });
  await expect(live).toContainText('Microphone is clipping');

  await page.waitForTimeout(6_000);
  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await expect(page).toHaveURL(/#\/meeting\//);

  const check = page.getByRole('region', { name: 'Audio check' });
  await expect(check).toBeVisible();
  await expect(check).toContainText('Microphone is clipping (too loud)');
  await expect(check).toContainText('Speakers leak into the microphone');
  await expect(check).toContainText(/about (3\d|4\d) ms later/);
  await expect(check).toContainText('Test Headset switched to headset call mode at 0:03');
  await expect(check).toContainText('Default output changed at 0:03');
  await expect(check).not.toContainText('telephone quality (nothing above 4 kHz)');

  // Stored with the meeting (survives reload).
  await page.reload();
  await expect(page.getByRole('region', { name: 'Audio check' })).toContainText('Speakers leak into the microphone');
});
