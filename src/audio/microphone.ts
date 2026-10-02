import type { AudioSource } from './recorder';
import { MediaAccessError, mediaAccessError } from './permissions';

/** Speaker mode: microphone via getUserMedia. Permission requested only on start (§18). */
export class MicrophoneAudioSource implements AudioSource {
  private stream: MediaStream | null = null;

  /** @param deviceId microphone to use (undefined = system default). */
  constructor(private readonly deviceId?: string) {}

  async start(): Promise<MediaStream> {
    // ASR-oriented capture constraints.
    //  - mono 48 kHz: fewer resampling artefacts than an unknown device default,
    //    and Whisper wants mono anyway.
    //  - Voice processing (AEC / noise suppression / AGC) is tuned for phone
    //    calls, not speech recognition: AEC can gate/duck speech and NS smears
    //    consonants. We prefer them OFF and do our own high-pass + levelling in
    //    `decode.ts`/`preprocess.ts`. `ideal` keeps exotic devices connectable.
    //  - AGC stays ON: a quiet mic hurts accuracy far more than mild level drift.
    // NOTE: "echo" in a room recording is reverberation, which AEC does NOT
    // remove (it cancels playback bleed). To capture a call echo-free, use
    // Device Audio mode, which records the stream digitally.
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.deviceId ? { deviceId: { exact: this.deviceId } } : {}),
          channelCount: 1,
          sampleRate: 48000,
          echoCancellation: { ideal: false },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: true },
        },
      });
    } catch (err) {
      // Turn the cryptic DOMException into an actionable message.
      throw new MediaAccessError(mediaAccessError(err, 'microphone'));
    }
    if (this.stream.getAudioTracks().length === 0) {
      throw new Error('No audio was provided by the selected source.');
    }
    return this.stream;
  }

  /** The live capture stream (diagnostics), null when stopped. */
  currentStream(): MediaStream | null {
    return this.stream;
  }

  async stop(): Promise<void> {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
