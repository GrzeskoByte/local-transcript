/**
 * Human-readable media-permission handling.
 *
 * `getUserMedia` / `getDisplayMedia` reject with bare `DOMException`s such as
 * "The request is not allowed by the user agent or the platform in the current
 * context, possibly because the user denied permission." — technically correct
 * and useless to a user. This module classifies those failures and produces an
 * actionable message + hint, plus helpers to *trigger* the permission prompt.
 *
 * Guidance targets the desktop (Tauri) shell: there is no address bar, so
 * denials point at the OS privacy settings instead.
 */

export type MediaInput = 'microphone' | 'display';

export interface MediaAccessFailure {
  /** Short, user-facing message. */
  message: string;
  /** Concrete next step the user can take. */
  hint: string;
  /** Whether pressing "Try again" could succeed after the user acts. */
  retryable: boolean;
  /** 'insecure' | 'unsupported' | 'denied' | 'no-device' | 'busy' | 'unknown' */
  code: string;
}

export class MediaAccessError extends Error {
  readonly failure: MediaAccessFailure;

  constructor(failure: MediaAccessFailure) {
    super(failure.message);
    this.name = 'MediaAccessError';
    this.failure = failure;
  }
}

/**
 * Secure-context check. Capture is only reachable from a secure context
 * (https:// or localhost).
 */
export function isSecureMediaContext(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return navigator.mediaDevices !== undefined && window.isSecureContext === true;
}

export const INSECURE_CONTEXT_FAILURE: MediaAccessFailure = {
  message: 'Audio capture is blocked in this context.',
  hint: 'Microphone and screen audio require a secure context. Run the app over https:// or on localhost.',
  retryable: false,
  code: 'insecure',
};

const UNSUPPORTED_FAILURE: MediaAccessFailure = {
  message: 'This build cannot capture audio.',
  hint: 'Update the app to a current version and try again.',
  retryable: false,
  code: 'unsupported',
};

function errorName(err: unknown): string {
  return (err as { name?: string } | null | undefined)?.name ?? '';
}

/** Map a capture failure to a message + actionable hint. */
export function mediaAccessError(err: unknown, input: MediaInput): MediaAccessFailure {
  if (!isSecureMediaContext()) return INSECURE_CONTEXT_FAILURE;

  const name = errorName(err);
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      if (input === 'display') {
        return {
          code: 'denied',
          retryable: true,
          message: 'Screen sharing was cancelled or blocked.',
          hint: 'Pick a window or screen and enable “Share audio” when the picker opens, then press Try again.',
        };
      }
      return {
        code: 'denied',
        retryable: true,
        message: 'Microphone access was blocked.',
        hint: 'The app was not granted microphone access. Allow it for this app in your system privacy settings, then press Try again — restart the app if it was already running.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return input === 'display'
        ? {
            code: 'no-device',
            retryable: true,
            message: 'No screen or window was available to share.',
            hint: 'Connect or enable a display source, then press Try again.',
          }
        : {
            code: 'no-device',
            retryable: true,
            message: 'No microphone was found.',
            hint: 'Connect a microphone and make sure it is enabled in your system sound settings, then press Try again.',
          };
    case 'OverconstrainedError':
      // WebKitGTK reports "Invalid constraint" when it sees no capture
      // device at all — e.g. no audio plugins (GStreamer) are available to
      // the app — before any permission prompt.
      return {
        code: 'no-device',
        retryable: true,
        message:
          input === 'display'
            ? 'No screen-sharing source is available to the app.'
            : 'The app cannot see any microphone.',
        hint:
          input === 'display'
            ? 'Screen sharing needs PipeWire and the desktop portal. Make sure both are running, then press Try again.'
            : 'Check that a microphone is connected and enabled in your system sound settings, then press Try again. If it still fails, reinstall or update the app — its audio components may be missing.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'busy',
        retryable: true,
        message: 'The audio device could not be read.',
        hint: 'Another app may be using the microphone. Close it, then press Try again.',
      };
    case 'AbortError':
      return {
        code: 'unknown',
        retryable: true,
        message: 'Audio capture was interrupted.',
        hint: 'Press Try again to restart capture.',
      };
    default:
      return {
        code: 'unknown',
        retryable: true,
        message: err instanceof Error && err.message ? err.message : 'Could not start audio capture.',
        hint: 'Check the system privacy settings for microphone/screen access, then press Try again.',
      };
  }
}

/** Read the current microphone permission where the Permissions API supports it. */
export async function queryMicrophonePermission(): Promise<
  'granted' | 'denied' | 'prompt' | 'unknown'
> {
  try {
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state as 'granted' | 'denied' | 'prompt';
  } catch {
    // The desktop webview may not expose 'microphone' here.
    return 'unknown';
  }
}

/**
 * Ask for microphone access *now* (this is what actually shows the prompt) and
 * immediately release the device. Returns a failure to display, or null when
 * access was granted.
 */
export async function primeMicrophonePermission(): Promise<MediaAccessFailure | null> {
  if (!isSecureMediaContext()) return INSECURE_CONTEXT_FAILURE;
  if (navigator.mediaDevices?.getUserMedia === undefined) return UNSUPPORTED_FAILURE;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return null;
  } catch (err) {
    return mediaAccessError(err, 'microphone');
  }
}
