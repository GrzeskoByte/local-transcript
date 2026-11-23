import { useEffect, useState, useSyncExternalStore } from 'react';
import { App } from './App';
import { AppProvider } from './store';
import { SignIn } from './screens/auth/SignIn';
import { AcceptInvite } from './screens/auth/AcceptInvite';
import { useServerSession } from './components/server/api';
import { loadNativeSettings } from '../platform/native-settings';
import { applyAppearance, loadAppearance } from './theme';

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => window.removeEventListener('hashchange', listener);
}

/**
 * Server edition shell: nothing of the app (store, storage, settings) starts
 * until an account is signed in; a new account gets a fresh app instance.
 */
export function ServerRoot({ sessionError }: { sessionError: string | null }): React.JSX.Element {
  const session = useServerSession();
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const [readyFor, setReadyFor] = useState<string | null>(null);

  // Per-user settings come from the server: load them before the first render.
  const userId = session?.user.id ?? null;
  useEffect(() => {
    if (!userId) {
      setReadyFor(null);
      return;
    }
    let cancelled = false;
    void Promise.race([loadNativeSettings(), new Promise((resolve) => setTimeout(resolve, 4000))]).then(() => {
      if (cancelled) return;
      applyAppearance(loadAppearance());
      setReadyFor(userId);
    });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!session) {
    if (hash.startsWith('#/invite/')) return <AcceptInvite token={decodeURIComponent(hash.slice(9).split('?')[0] ?? '')} />;
    return (
      <>
        {sessionError && <p className="error auth-error" role="alert">{sessionError}</p>}
        <SignIn />
      </>
    );
  }
  if (readyFor !== session.user.id) return <p className="muted auth-loading" role="status">Loading…</p>;
  return (
    <AppProvider key={session.user.id}>
      <App />
    </AppProvider>
  );
}
