/**
 * Decode stored audio Blob → mono 16kHz Float32Array for the ASR engine (§12).
 * Uses Web Audio API (OfflineAudioContext preferred, no autoplay issues).
 */
export async function decodeToMono16k(
  blob: Blob,
  onProgress?: (ratio: number) => void,
): Promise<Float32Array> {
  onProgress?.(0);
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  // Fallback: raw PCM16 assumption if Web Audio unavailable (tests).
  if (!AudioCtx && typeof AudioContext === 'undefined') {
    onProgress?.(1);
    return new Float32Array(arrayBuffer.slice(0, 16000 * 10));
  }
  const ctx = new AudioContext();
  try {
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const targetRate = 16000;
    const durationSec = audioBuffer.duration;
    const targetLen = Math.max(1, Math.floor(durationSec * targetRate));
    const offline = new OfflineAudioContext(1, targetLen, targetRate);
    const src = offline.createBufferSource();
    // Downmix to mono.
    const mono = offline.createBuffer(1, audioBuffer.length, audioBuffer.sampleRate);
    const monoData = mono.getChannelData(0);
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < data.length; i++) monoData[i] = (monoData[i] ?? 0) + data[i]! / audioBuffer.numberOfChannels;
    }
    src.buffer = mono;
    // High-pass at 80 Hz: rumble, HVAC, desk thumps and DC offset carry no
    // speech energy but do bias Whisper's mel input and drive hallucination.
    const highpass = offline.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 80;
    highpass.Q.value = 0.7;
    src.connect(highpass);
    highpass.connect(offline.destination);
    src.start(0);
    onProgress?.(0.5);
    const rendered = await offline.startRendering();
    onProgress?.(1);
    return rendered.getChannelData(0).slice();
  } finally {
    void ctx.close().catch(() => undefined);
  }
}
