import { useState } from 'react';
import { acceptInvite, reloadApp } from '../../components/server/api';
import { AuthFrame } from './SignIn';

const MIN_PASSWORD = 8;

/** `#/invite/<token>`: choose a name and password; the server signs the new account in. */
export function AcceptInvite({ token }: { token: string }): React.JSX.Element {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem =
    password.length > 0 && password.length < MIN_PASSWORD
      ? `Use at least ${MIN_PASSWORD} characters.`
      : again.length > 0 && again !== password
        ? 'The passwords do not match.'
        : null;

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    acceptInvite(token, name.trim(), password)
      .then(() => {
        reloadApp('#/');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <AuthFrame title="Join" lede="You were invited to this transcription server. Choose how you sign in.">
      <section className="card auth-card" aria-label="Accept invite">
        <strong>Create your account</strong>
        <form onSubmit={submit}>
          <label className="field-label" htmlFor="invite-name">Your name</label>
          <input id="invite-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          <label className="field-label" htmlFor="invite-password">Password</label>
          <input
            id="invite-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <label className="field-label" htmlFor="invite-again">Password again</label>
          <input
            id="invite-again"
            className="input"
            type="password"
            autoComplete="new-password"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
            required
          />
          {(problem || error) && <p className="error" role="alert">{problem ?? error}</p>}
          <div className="btn-row">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={busy || !name.trim() || password.length < MIN_PASSWORD || password !== again}
            >
              {busy ? 'Creating…' : 'Create account'}
            </button>
            <button type="button" className="btn" onClick={() => (window.location.hash = '#/signin')}>
              I already have an account
            </button>
          </div>
        </form>
      </section>
    </AuthFrame>
  );
}
