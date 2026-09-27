/**
 * Runtime codec/container selection (§8).
 * Probe MediaRecorder support; prefer Opus-in-WebM, fall back to mp4 where supported (Safari).
 */
export const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
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
