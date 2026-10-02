import { getPref, setPref } from '../platform/prefs';
import { SYSTEM_AUDIO_LABEL } from './system-audio';

/**
 * Audio input/output selection (Settings + New Meeting + Meeting Detail share
 * these prefs). Empty = the system default.
 *
 *  - microphone: an `audioinput` from enumerateDevices. Saved with its label,
 *    because device ids can change (re-plugged USB mic, webview profile reset).
 *  - system-audio output (Linux desktop): which sound-server output's sound
 *    Device Audio / Mic + Device record (see system-audio.ts).
 *  - playback output: where Meeting Detail plays recordings, only where the
 *    engine supports `AudioContext.setSinkId` (Chromium/WebView2).
 */
export const MIC_DEVICE_PREF = 'audio-input-device';
export const SYSTEM_OUTPUT_PREF = 'audio-system-output';
export const PLAYBACK_OUTPUT_PREF = 'audio-playback-output';

export interface SavedDevice {
  deviceId: string;
  label: string;
}

export interface DeviceOption {
  id: string;
  label: string;
}

function readDevice(key: string): SavedDevice | null {
  const raw = getPref(key);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SavedDevice>;
    return typeof v.deviceId === 'string' && v.deviceId
      ? { deviceId: v.deviceId, label: typeof v.label === 'string' ? v.label : '' }
      : null;
  } catch {
    return null;
  }
}

function writeDevice(key: string, device: SavedDevice | null): void {
  setPref(key, device ? JSON.stringify(device) : '');
}

export const getMicrophoneDevice = (): SavedDevice | null => readDevice(MIC_DEVICE_PREF);
export const setMicrophoneDevice = (d: SavedDevice | null): void => writeDevice(MIC_DEVICE_PREF, d);
export const getPlaybackDevice = (): SavedDevice | null => readDevice(PLAYBACK_OUTPUT_PREF);
export const setPlaybackDevice = (d: SavedDevice | null): void => writeDevice(PLAYBACK_OUTPUT_PREF, d);

/** Sound-server sink name; '' = default output. */
export const getSystemOutput = (): string => getPref(SYSTEM_OUTPUT_PREF) ?? '';
export const setSystemOutput = (sink: string): void => setPref(SYSTEM_OUTPUT_PREF, sink);

/** Browser-level "default"/"communications" aliases duplicate a real device. */
function isAlias(d: MediaDeviceInfo): boolean {
  return d.deviceId === '' || d.deviceId === 'default' || d.deviceId === 'communications';
}

export interface DeviceList {
  options: DeviceOption[];
  /** Labels stay empty until the app has been granted capture once. */
  labelsHidden: boolean;
}

export async function listDevices(kind: 'audioinput' | 'audiooutput'): Promise<DeviceList> {
  if (!navigator.mediaDevices?.enumerateDevices) return { options: [], labelsHidden: false };
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  const devices = all
    .filter((d) => d.kind === kind && !isAlias(d))
    // Our own virtual system-audio source is not a microphone.
    .filter((d) => !d.label.includes(SYSTEM_AUDIO_LABEL));
  return {
    options: devices.map((d, i) => ({
      id: d.deviceId,
      label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${i + 1}`,
    })),
    labelsHidden: all.some((d) => d.kind === kind) && all.filter((d) => d.kind === kind).every((d) => !d.label),
  };
}

/**
 * The saved device's current id: same id, else same label (ids change), else
 * undefined = use the system default (e.g. the USB mic is unplugged).
 */
export function resolveDevice(saved: SavedDevice | null, options: DeviceOption[]): string | undefined {
  if (!saved) return undefined;
  if (options.some((o) => o.id === saved.deviceId)) return saved.deviceId;
  return saved.label ? options.find((o) => o.label === saved.label)?.id : undefined;
}

/** Microphone deviceId to capture from, or undefined for the default. */
export async function chosenMicrophoneId(): Promise<string | undefined> {
  const saved = getMicrophoneDevice();
  if (!saved) return undefined;
  return resolveDevice(saved, (await listDevices('audioinput')).options);
}

type SinkCapable = { setSinkId(id: string): Promise<void>; sinkId?: unknown };

/** Players are Web Audio (see `player.ts`): routing needs AudioContext.setSinkId. */
export function canChoosePlaybackOutput(): boolean {
  return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
}

/** Route the playback context to the chosen output (no-op where unsupported). */
export async function applyPlaybackOutput(ctx: AudioContext): Promise<void> {
  if (!canChoosePlaybackOutput()) return;
  const saved = getPlaybackDevice();
  const id = saved ? resolveDevice(saved, (await listDevices('audiooutput')).options) : undefined;
  const target = ctx as AudioContext & SinkCapable;
  const current = typeof target.sinkId === 'string' ? target.sinkId : '';
  if (current === (id ?? '')) return;
  await target.setSinkId(id ?? '').catch(() => undefined);
}
