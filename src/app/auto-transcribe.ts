/**
 * Opt-in: transcribe each recording as soon as it is stopped (user-requested
 * exception to "never auto-transcribe"; off by default). Recording stays
 * independent: a failed run leaves the audio untouched, as always.
 */
import { getPref, setPref } from '../platform/prefs';

const PREF = 'auto-transcribe';

export function autoTranscribeEnabled(): boolean {
  return getPref(PREF) === 'true';
}

export function setAutoTranscribeEnabled(on: boolean): void {
  setPref(PREF, on ? 'true' : 'false');
}
