import type { AudioSource } from './recorder';
import { MediaAccessError, mediaAccessError } from './permissions';

export const NO_DEVICE_AUDIO_MESSAGE =
  'No audio was provided by the selected source. Please select a source with audio sharing enabled.';

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
      throw new Error(NO_DEVICE_AUDIO_MESSAGE);
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
