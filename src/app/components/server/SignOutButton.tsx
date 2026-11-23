import { useState } from 'react';
import { ConfirmButton } from '../ConfirmButton';
import { useApp } from '../../store';
import { signOut } from './api';

/**
 * Sign out of the server. A recording or transcription in progress belongs to
 * this account: with a recording running the user is asked first, then it is
 * stopped and saved (and imports/transcriptions are cancelled) before the
 * session ends.
 */
export function SignOutButton({ className = 'btn' }: { className?: string }): React.JSX.Element {
  const { recordingState, prepareSignOut } = useApp();
  const [error, setError] = useState<string | null>(null);
  const recording = recordingState !== 'IDLE' && recordingState !== 'COMPLETED';

  const leave = (): void => {
    setError(null);
    prepareSignOut()
      .then(() => signOut())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <ConfirmButton
        className={className}
        prompt="Stop the recording and sign out?"
        confirmLabel="Stop & sign out"
        skipConfirm={!recording}
        onConfirm={leave}
      >
        Sign out
      </ConfirmButton>
      {error && (
        <span className="error" role="alert">
          Could not stop the recording: {error}
        </span>
      )}
    </>
  );
}
