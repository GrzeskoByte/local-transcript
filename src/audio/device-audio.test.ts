import { afterEach, describe, expect, it, vi } from 'vitest';
import { macDeviceAudioLimit } from './device-audio';

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko)';

function env(userAgent: string, desktop: boolean): void {
  vi.stubGlobal('navigator', { userAgent });
  vi.stubGlobal('window', desktop ? { __TAURI_INTERNALS__: { invoke: async () => null } } : {});
}

describe('macDeviceAudioLimit', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('explains the limit in the macOS desktop shell', () => {
    env(MAC_UA, true);
    expect(macDeviceAudioLimit()).toMatch(/macOS.*Speaker mode/);
  });

  it('is silent on Linux and outside the desktop shell', () => {
    env(LINUX_UA, true);
    expect(macDeviceAudioLimit()).toBeNull();
    env(MAC_UA, false);
    expect(macDeviceAudioLimit()).toBeNull();
  });
});
