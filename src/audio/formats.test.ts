import { afterEach, describe, expect, it } from 'vitest';
import { extensionForMimeType, pickSupportedMimeType } from './formats';

function withRecorder(supported: string[]): void {
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = {
    isTypeSupported: (t: string) => supported.includes(t),
  };
}

afterEach(() => {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
});

describe('pickSupportedMimeType', () => {
  it('prefers Opus in WebM', () => {
    withRecorder(['audio/mp4', 'audio/mp4;codecs=opus', 'audio/webm;codecs=opus']);
    expect(pickSupportedMimeType()).toBe('audio/webm;codecs=opus');
  });

  it('uses Opus in MP4 when WebKit only allows MP4 (GStreamer < 1.24.9)', () => {
    withRecorder(['audio/mp4', 'audio/mp4;codecs=opus']);
    expect(pickSupportedMimeType()).toBe('audio/mp4;codecs=opus');
    expect(extensionForMimeType('audio/mp4;codecs=opus')).toBe('mp4');
  });

  it('falls back to plain MP4 (Safari/WKWebView)', () => {
    withRecorder(['audio/mp4']);
    expect(pickSupportedMimeType()).toBe('audio/mp4');
  });

  it('returns empty when MediaRecorder is missing', () => {
    expect(pickSupportedMimeType()).toBe('');
  });
});
