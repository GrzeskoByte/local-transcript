import { afterEach, describe, expect, it } from 'vitest';
import { findSystemAudioDevice, SystemAudioSource, systemAudioOutputs, systemAudioStatus } from './system-audio';

type Dev = { kind: string; label: string; deviceId: string };

function install(opts: { devices: Dev[][]; start?: 'ok' | 'fail'; gum?: 'ok' | 'fail' }) {
  const calls: { cmd: string; args?: unknown }[] = [];
  const gum: unknown[] = [];
  let enumerations = 0;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: unknown) => {
        calls.push({ cmd, args });
        if (cmd === 'native_system_audio_status') return { available: true, hint: null };
        if (cmd === 'native_system_audio_outputs') {
          return [{ name: 'alsa_output.x', description: 'Speakers', isDefault: true }, { bogus: 1 }];
        }
        if (cmd === 'native_system_audio_start') {
          if (opts.start === 'fail') throw new Error('pactl missing');
          return { label: 'Local_Transcribe_system_audio', sink: 'alsa_output.x' };
        }
        return null;
      },
    },
  };
  const track = { stopped: false, stop() { this.stopped = true; } };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        enumerateDevices: async () => opts.devices[Math.min(enumerations++, opts.devices.length - 1)],
        getUserMedia: async (c: unknown) => {
          gum.push(c);
          if (opts.gum === 'fail') throw Object.assign(new Error('Invalid constraint'), { name: 'OverconstrainedError' });
          return { getTracks: () => [track], getAudioTracks: () => [track] };
        },
      },
    },
  });
  return { calls, gum, track };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const mic = { kind: 'audioinput', label: 'Built-in Audio', deviceId: 'mic' };
const sys = { kind: 'audioinput', label: 'Local_Transcribe_system_audio', deviceId: 'sys' };

describe('system audio (Linux desktop)', () => {
  it('reports availability from the desktop shell', async () => {
    install({ devices: [[mic]] });
    expect(await systemAudioStatus()).toEqual({ available: true, hint: null });
  });

  it('waits for the virtual source to appear, priming labels once', async () => {
    const env = install({ devices: [[{ ...mic, label: '' }], [mic], [mic, sys]] });
    const d = await findSystemAudioDevice('Local_Transcribe_system_audio', 5);
    expect(d.deviceId).toBe('sys');
    expect(env.gum).toEqual([{ audio: true }]);
  });

  it('records the virtual source raw and removes it on stop', async () => {
    const env = install({ devices: [[mic, sys]] });
    const src = new SystemAudioSource();
    await src.start();
    expect(env.gum.at(-1)).toEqual({
      audio: { deviceId: { exact: 'sys' }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    await src.stop();
    expect(env.track.stopped).toBe(true);
    expect(env.calls.map((c) => c.cmd)).toEqual(['native_system_audio_start', 'native_system_audio_stop']);
  });

  it('records the chosen output, or the default when none is chosen', async () => {
    const env = install({ devices: [[mic, sys]] });
    await new SystemAudioSource('bluez_output.headset').start();
    await new SystemAudioSource().start();
    const starts = env.calls.filter((c) => c.cmd === 'native_system_audio_start').map((c) => c.args);
    expect(starts).toEqual([{ sink: 'bluez_output.headset' }, { sink: null }]);
  });

  it('lists the outputs that can be recorded', async () => {
    install({ devices: [[mic]] });
    expect(await systemAudioOutputs()).toEqual([{ name: 'alsa_output.x', description: 'Speakers', isDefault: true }]);
  });

  it('removes the virtual source again when capture fails', async () => {
    const env = install({ devices: [[mic, sys]], gum: 'fail' });
    await expect(new SystemAudioSource().start()).rejects.toThrow();
    expect(env.calls.map((c) => c.cmd)).toEqual(['native_system_audio_start', 'native_system_audio_stop']);
  });

  it('surfaces a missing sound-server tool', async () => {
    install({ devices: [[mic]], start: 'fail' });
    await expect(new SystemAudioSource().start()).rejects.toThrow(/pactl/);
  });
});
