import { useEffect, useState } from 'react';
import { fetchAuthConfig, reloadApp, signIn, type AuthConfig } from '../../components/server/api';

/** Layout shared by Sign in and Accept invite: a pink head over one window. */
export function AuthFrame({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="auth">
      <div className="page-head auth-head">
        <div>
          <h1>{title}</h1>
          <p>{lede}</p>
        </div>
      </div>
      {children}
      <footer className="footer-band auth-foot">Your recordings and transcripts stay on this server; only you can open them.</footer>
    </div>
  );
}

/** `#/signin`: local form and/or "Sign in with <provider>", per `/api/auth/config`. */
export function SignIn(): React.JSX.Element {
  const [config, setConfig] = useState<AuthConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAuthConfig()
      .then(setConfig)
      .catch((e: unknown) => setConfigError(e instanceof Error ? e.message : String(e)));
  }, []);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    signIn(email.trim(), password)
      .then(() => {
        reloadApp('#/');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const local = config?.localLogin === true;
  const sso = config?.sso ?? null;

  return (
    <AuthFrame title="Sign in" lede="local-transcriber on this server. Accounts are by invitation.">
      <section className="card auth-card" aria-label="Sign in">
        <strong>Sign in</strong>
        {!config && !configError && <p className="muted" role="status">Loading…</p>}
        {configError && <p className="error" role="alert">{configError}</p>}
        {config && !local && !sso && (
          <p className="warn" role="alert">No sign-in method is enabled. Ask your administrator.</p>
        )}
        {local && (
          <form onSubmit={submit}>
            <label className="field-label" htmlFor="signin-email">E-mail</label>
            <input
              id="signin-email"
              className="input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <label className="field-label" htmlFor="signin-password">Password</label>
            <input
              id="signin-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {error && <p className="error" role="alert">{error}</p>}
            <div className="btn-row">
              <button type="submit" className="btn btn-primary" disabled={busy || !email || !password}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>
        )}
        {sso && (
          <div className={local ? 'auth-sso' : undefined}>
            <a className={`btn${local ? '' : ' btn-primary'}`} href="/auth/oidc/start">
              Sign in with {sso.name}
            </a>
          </div>
        )}
      </section>
    </AuthFrame>
  );
}
