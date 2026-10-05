/**
 * Decode Ogg Opus in the desktop shell (libopus in Rust, `native_audio_decode`)
 * instead of the webview: native recordings are Ogg Opus, which not every
 * webview decodes (WKWebView, the AppImage's GStreamer stack), and libopus
 * decodes straight to the wanted rate. Returns null when this does not apply
 * or fails, so callers fall back to decodeAudioData.
 */
import { invokeDesktopRaw, isDesktopApp } from '../platform/desktop';
import { nativeBytes } from '../storage/recordings';

export function isOggOpus(mimeType: string): boolean {
  return /ogg|opus/i.test(mimeType);
}

/** Little-endian 16-bit PCM bytes → Int16Array (copies only when misaligned). */
export function pcm16(bytes: Uint8Array): Int16Array {
  if (bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  return new Int16Array(bytes.slice().buffer, 0, bytes.byteLength >> 1);
}

export async function decodeOggNative(blob: Blob, sampleRate: number): Promise<Int16Array | null> {
  if (!isDesktopApp() || !isOggOpus(blob.type)) return null;
  try {
    const reply = await invokeDesktopRaw<unknown>('native_audio_decode', new Uint8Array(await blob.arrayBuffer()), {
      'x-sample-rate': String(sampleRate),
    });
    const bytes = nativeBytes(reply);
    return bytes ? pcm16(bytes) : null;
  } catch {
    return null;
  }
}
