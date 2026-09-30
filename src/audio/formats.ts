/**
 * Runtime codec/container selection (§8).
 * Probe MediaRecorder support; prefer Opus-in-WebM, fall back to mp4 where supported (Safari).
 *
 * Opus-in-MP4 comes before AAC-in-MP4 for WebKitGTK: WebKit refuses WebM/Ogg
 * recording on GStreamer < 1.24.9 (the AppImage runs Ubuntu 22.04's 1.20),
 * leaving only MP4 — and AAC recordings from that stack fail to decode
 * (faad), while Opus decodes with the same plugins as WebM.
 */
export const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

export function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const mime of CANDIDATE_MIME_TYPES) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime;
    } catch {
      // ignore and continue
    }
  }
  return '';
}

export function extensionForMimeType(mime: string): string {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  return 'webm';
}

export function chunkFileName(index: number, mime: string): string {
  return `${String(index).padStart(6, '0')}.${extensionForMimeType(mime)}`;
}
