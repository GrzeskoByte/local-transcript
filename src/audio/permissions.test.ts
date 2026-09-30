import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MediaAccessError,
  mediaAccessError,
  primeMicrophonePermission,
  type MediaAccessFailure,
} from './permissions';

/** `mediaAccessError` inspects the DOMException `name`, so a plain object works. */
function named(name: string, message = ''): Error {
  return Object.assign(new Error(message), { name });
}

function inSecureContext<T>(fn: () => T): T {
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { mediaDevices: {} });
  try {
    return fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('mediaAccessError (secure context)', () => {
  it('maps a blocked microphone to an actionable denial', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('NotAllowedError'), 'microphone');
      expect(failure.code).toBe('denied');
      expect(failure.retryable).toBe(true);
      expect(failure.message).toMatch(/Microphone access was blocked/i);
      expect(failure.hint).toMatch(/privacy settings/i);
    });
  });

  it('maps a blocked/cancelled display request to screen-sharing guidance', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('NotAllowedError'), 'display');
      expect(failure.code).toBe('denied');
      expect(failure.message).toMatch(/Screen sharing/i);
      expect(failure.hint).toMatch(/Share audio/i);
    });
  });

  it('explains a missing microphone', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('NotFoundError'), 'microphone');
      expect(failure.code).toBe('no-device');
      expect(failure.message).toMatch(/No microphone/i);
    });
  });

  it('explains WebKit seeing no capture device ("Invalid constraint")', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('OverconstrainedError'), 'microphone');
      expect(failure.code).toBe('no-device');
      expect(failure.message).toMatch(/cannot see any microphone/i);
      expect(failure.hint).not.toMatch(/privacy/i);
    });
  });

  it('explains a busy audio device', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('NotReadableError'), 'microphone');
      expect(failure.code).toBe('busy');
      expect(failure.hint).toMatch(/Another app/i);
    });
  });

  it('falls back to the original message for unknown failures', () => {
    inSecureContext(() => {
      const failure = mediaAccessError(named('WeirdError', 'boom'), 'microphone');
      expect(failure.code).toBe('unknown');
      expect(failure.retryable).toBe(true);
      expect(failure.message).toBe('boom');
    });
  });
});

describe('mediaAccessError (insecure context)', () => {
  it('reports that no prompt is possible on a plain http page', () => {
    const failure = mediaAccessError(named('NotAllowedError'), 'microphone');
    expect(failure.code).toBe('insecure');
    expect(failure.retryable).toBe(false);
    expect(failure.hint).toMatch(/https:\/\//);
  });
});

describe('MediaAccessError', () => {
  it('carries the structured failure', () => {
    const failure: MediaAccessFailure = {
      message: 'nope',
      hint: 'try again',
      retryable: true,
      code: 'denied',
    };
    const err = new MediaAccessError(failure);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MediaAccessError');
    expect(err.message).toBe('nope');
    expect(err.failure).toBe(failure);
  });
});

describe('primeMicrophonePermission', () => {
  it('resolves null and releases the device when access is granted', async () => {
    const stop = vi.fn();
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }) },
    });
    await expect(primeMicrophonePermission()).resolves.toBeNull();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('returns a failure instead of throwing when access is denied', async () => {
    vi.stubGlobal('window', { isSecureContext: true });
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue(named('NotAllowedError')) },
    });
    const failure = await primeMicrophonePermission();
    expect(failure?.code).toBe('denied');
  });

  it('refuses to prompt outside a secure context', async () => {
    const failure = await primeMicrophonePermission();
    expect(failure?.code).toBe('insecure');
  });
});
