/**
 * Mono 16-bit PCM WAV encoding.
 *
 * The native backend (`whisper-cli` / `voxtype transcribe`) only accepts a
 * 16 kHz mono WAV file, so the webview decodes the recording, encodes it here,
 * and ships the bytes over IPC.
 */

/** Clamp float samples to [-1, 1] and convert to signed 16-bit PCM. */
export function floatTo16BitPCM(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** Encode Float32 mono samples as a complete RIFF/WAVE byte buffer. */
export function encodeWav16(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = floatTo16BitPCM(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44, pcm.length).set(pcm);

  return new Uint8Array(buffer);
}

/**
 * Base64-encode bytes for Tauri's JSON IPC. Chunked so large WAVs never blow
 * the argument limit of `String.fromCharCode`.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
