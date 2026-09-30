import type { AudioSource } from './recorder';
import { MediaAccessError, mediaAccessError } from './permissions';
import { isDesktopApp } from '../platform/desktop';

export const NO_DEVICE_AUDIO_MESSAGE =
  'No audio was provided by the selected source. Please select a source with audio sharing enabled.';

/**
 * macOS desktop shell: WKWebView's getDisplayMedia never delivers an audio
 * track, so Device Audio / Two-way cannot capture call audio there. Returns
 * the explanation to show, or null where device audio may work.
 */
export function macDeviceAudioLimit(): string | null {
  if (!isDesktopApp() || !/Macintosh|Mac OS X/.test(navigator.userAgent)) return null;
  return 'On macOS, screen sharing in this app provides no audio, so Device Audio cannot record call audio yet. Use Speaker mode (the microphone picks up the call through your speakers).';
}

/**
 * Device Audio mode via getDisplayMedia (§2, §18).
 * Never requests microphone permission. Label is "Device Audio",
 * never "system audio" — browser/OS support varies.
 */
export class DeviceAudioSource implements AudioSource {
  private stream: MediaStream | null = null;

  async start(): Promise<MediaStream> {
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
    } catch (err) {
      // Turn the cryptic DOMException into an actionable message.
      throw new MediaAccessError(mediaAccessError(err, 'display'));
    }
    if (this.stream.getAudioTracks().length === 0) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      const mac = macDeviceAudioLimit();
      throw new Error(mac ? `${NO_DEVICE_AUDIO_MESSAGE} ${mac}` : NO_DEVICE_AUDIO_MESSAGE);
    }
    // Video track is only needed to keep the picker alive; stop it so we record audio only.
    this.stream.getVideoTracks().forEach((t) => t.stop());
    return this.stream;
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
