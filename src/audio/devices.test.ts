import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chosenMicrophoneId,
  getMicrophoneDevice,
  getSystemOutput,
  listDevices,
  resolveDevice,
  setMicrophoneDevice,
  setSystemOutput,
} from './devices';

type Dev = { kind: string; label: string; deviceId: string };

function install(devices: Dev[]) {
  const store = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { enumerateDevices: async () => devices } },
  });
}

const builtIn = { kind: 'audioinput', label: 'Built-in Audio', deviceId: 'a1' };
const usb = { kind: 'audioinput', label: 'USB Mic', deviceId: 'u1' };

describe('audio device selection', () => {
  beforeEach(() => install([]));
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('lists inputs without browser aliases or the virtual system-audio source', async () => {
    install([
      { kind: 'audioinput', label: 'Default', deviceId: 'default' },
      builtIn,
      usb,
      { kind: 'audioinput', label: 'Local_Transcribe_system_audio', deviceId: 'sys' },
      { kind: 'audiooutput', label: 'Speakers', deviceId: 'o1' },
    ]);
    const list = await listDevices('audioinput');
    expect(list.options).toEqual([
      { id: 'a1', label: 'Built-in Audio' },
      { id: 'u1', label: 'USB Mic' },
    ]);
    expect(list.labelsHidden).toBe(false);
  });

  it('flags hidden labels (no capture permission yet)', async () => {
    install([{ kind: 'audioinput', label: '', deviceId: 'x' }]);
    const list = await listDevices('audioinput');
    expect(list.labelsHidden).toBe(true);
    expect(list.options[0]!.label).toBe('Microphone 1');
  });

  it('resolves a saved device by id, then by label, else the default', () => {
    const options = [{ id: 'u2', label: 'USB Mic' }];
    expect(resolveDevice(null, options)).toBeUndefined();
    expect(resolveDevice({ deviceId: 'u2', label: '' }, options)).toBe('u2');
    expect(resolveDevice({ deviceId: 'u1', label: 'USB Mic' }, options)).toBe('u2');
    expect(resolveDevice({ deviceId: 'gone', label: 'Old Mic' }, options)).toBeUndefined();
  });

  it('persists the choices and uses the connected microphone', async () => {
    install([builtIn, usb]);
    expect(await chosenMicrophoneId()).toBeUndefined();
    setMicrophoneDevice({ deviceId: 'u1', label: 'USB Mic' });
    expect(getMicrophoneDevice()).toEqual({ deviceId: 'u1', label: 'USB Mic' });
    expect(await chosenMicrophoneId()).toBe('u1');
    setMicrophoneDevice(null);
    expect(getMicrophoneDevice()).toBeNull();

    expect(getSystemOutput()).toBe('');
    setSystemOutput('bluez_output.headset');
    expect(getSystemOutput()).toBe('bluez_output.headset');
  });
});
