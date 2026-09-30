import type { AudioSource } from './recorder';
import { MediaAccessError } from './permissions';
import { invokeDesktop, isDesktopApp } from '../platform/desktop';

/**
 * Device Audio on the Linux desktop app.
 *
 * WebKitGTK's getDisplayMedia yields video only and it never lists the sound
 * server's monitor sources, so Linux had no way to record what the computer
 * plays. The desktop shell (`src-tauri/src/system_audio.rs`) exposes the
 * default output's monitor as a virtual input while recording; we capture it
 * with getUserMedia like a microphone, with voice processing off.
 */
export interface SystemAudioStatus {
  available: boolean;
  hint: string | null;
}

interface NativeSystemAudioSource {
  label: string;
  sink: string;
}

const UNAVAILABLE: SystemAudioStatus = { available: false, hint: null };

/** Whether the desktop shell can capture system audio (Linux + pactl). */
export async function systemAudioStatus(): Promise<SystemAudioStatus> {
  if (!isDesktopApp()) return UNAVAILABLE;
  try {
    const s = await invokeDesktop<SystemAudioStatus | null>('native_system_audio_status');
    return s && typeof s.available === 'boolean' ? { available: s.available, hint: s.hint ?? null } : UNAVAILABLE;
  } catch {
    return UNAVAILABLE;
  }
}

/** Raw system sound: no echo cancellation/noise suppression/AGC. */
export const SYSTEM_AUDIO_PROCESSING = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Find the virtual source among the audio inputs. Labels are only exposed
 * after one capture grant, and the sound server needs a moment to announce a
 * new source, so prime once and poll briefly.
 */
export async function findSystemAudioDevice(label: string, attempts = 25): Promise<MediaDeviceInfo> {
  let primed = false;
  for (let i = 0; i < attempts; i++) {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const hit = inputs.find((d) => d.label === label || d.label.includes(label));
    if (hit) return hit;
    if (!primed && inputs.every((d) => !d.label)) {
      primed = true;
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      continue;
    }
    await sleep(200);
  }
  throw new Error('The system audio source did not appear. Check that your sound server (PipeWire or PulseAudio) is running, then press Try again.');
}

export class SystemAudioSource implements AudioSource {
  private stream: MediaStream | null = null;

  async start(): Promise<MediaStream> {
    const native = await invokeDesktop<NativeSystemAudioSource>('native_system_audio_start');
    try {
      const device = await findSystemAudioDevice(native.label);
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: device.deviceId }, ...SYSTEM_AUDIO_PROCESSING },
      });
      return this.stream;
    } catch (err) {
      await invokeDesktop('native_system_audio_stop').catch(() => undefined);
      throw new MediaAccessError({
        code: 'no-device',
        retryable: true,
        message: 'System audio could not be captured.',
        hint:
          err instanceof Error && err.message.startsWith('The system audio source')
            ? err.message
            : 'Make sure PipeWire or PulseAudio is running and an output device is selected, then press Try again.',
      });
    }
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    await invokeDesktop('native_system_audio_stop').catch(() => undefined);
  }
}
