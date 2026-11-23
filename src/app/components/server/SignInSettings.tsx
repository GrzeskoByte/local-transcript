import { useEffect, useState } from 'react';
import { fetchAdminSettings, saveAdminSettings, testOidc, type AdminSettings } from './api';

const asText = (v: string[] | string): string => (Array.isArray(v) ? v.join(', ') : v);
const asList = (v: string): string[] =>
  v
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

interface Draft {
  localLogin: boolean;
  issuer: string;
  clientId: string;
  /** Write-only: empty keeps the stored secret. */
  clientSecret: string;
  scopes: string;
  providerName: string;
  adminGroup: string;
  allowedGroups: string;
  allowedDomains: string;
}

function toDraft(s: AdminSettings): Draft {
  return {
    localLogin: s.localLogin,
    issuer: s.oidc.issuer,
    clientId: s.oidc.clientId,
    clientSecret: '',
    scopes: Array.isArray(s.oidc.scopes) ? s.oidc.scopes.join(' ') : s.oidc.scopes,
    providerName: s.oidc.providerName,
    adminGroup: s.oidc.adminGroup,
    allowedGroups: asText(s.oidc.allowedGroups),
    allowedDomains: asText(s.oidc.allowedDomains),
  };
}

/** Settings → Sign-in (admin): local-login switch and OIDC single sign-on. */
export function SignInSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);

  const load = (): void => {
    fetchAdminSettings()
      .then((s) => {
        setSettings(s);
        setDraft(toDraft(s));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  if (error && !settings) return <section className="card"><strong>Sign-in</strong><p className="error" role="alert">{error}</p></section>;
  if (!settings || !draft) return <section className="card"><strong>Sign-in</strong><p className="muted" role="status">Loading…</p></section>;

  /** Fields set through the server's environment cannot be edited here. */
  const locked = (field: string): boolean =>
    settings.locked.some((l) => l === field || l === `oidc.${field}` || l.toLowerCase() === `lt_oidc_${field.toLowerCase()}`);
  const set = (patch: Partial<Draft>): void => setDraft({ ...draft, ...patch });
  const ssoConfigured = draft.issuer.trim() !== '' && draft.clientId.trim() !== '' && (settings.oidc.clientSecretSet || draft.clientSecret !== '');
  const lockout = !draft.localLogin && !ssoConfigured;

  const text = (
    field: keyof Draft & string,
    label: string,
    opts: { type?: string; placeholder?: string; hint?: string } = {},
  ): React.JSX.Element => (
    <>
      <label className="field-label" htmlFor={`oidc-${field}`}>
        {label} {locked(field) && <span className="pill">set by the server</span>}
      </label>
      <input
        id={`oidc-${field}`}
        className="input"
        type={opts.type ?? 'text'}
        value={draft[field] as string}
        placeholder={opts.placeholder}
        disabled={locked(field)}
        readOnly={locked(field)}
        autoComplete="off"
        onChange={(e) => set({ [field]: e.target.value } as Partial<Draft>)}
      />
      {opts.hint && <small className="muted">{opts.hint}</small>}
    </>
  );

  const save = (): void => {
    setBusy('save');
    setMessage(null);
    const oidc: Record<string, unknown> = {
      issuer: draft.issuer.trim(),
      clientId: draft.clientId.trim(),
      // The server stores scopes as a list.
      scopes: draft.scopes.split(/\s+/).filter(Boolean),
      providerName: draft.providerName.trim(),
      adminGroup: draft.adminGroup.trim(),
      allowedGroups: asList(draft.allowedGroups),
      allowedDomains: asList(draft.allowedDomains),
    };
    if (draft.clientSecret) oidc.clientSecret = draft.clientSecret;
    saveAdminSettings({ localLogin: draft.localLogin, oidc })
      .then(() => {
        setMessage({ ok: true, text: 'Sign-in settings saved.' });
        load();
      })
      .catch((e: unknown) => setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(null));
  };

  const test = (): void => {
    setBusy('test');
    setMessage(null);
    testOidc()
      .then((r) =>
        setMessage(r.ok ? { ok: true, text: `Provider answered: ${r.issuer ?? 'OK'}.` } : { ok: false, text: r.error ?? 'The provider did not answer.' }),
      )
      .catch((e: unknown) => setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(null));
  };

  return (
    <>
      <section className="card" aria-label="Local accounts">
        <strong>Local accounts</strong>
        <label className="set-row">
          <span className="grow">
            <b>Allow e-mail and password sign-in</b>{' '}
            {locked('localLogin') && <span className="pill">set by the server</span>}
            <br />
            <small className="muted">Turn off to allow single sign-on only.</small>
          </span>
          <input
            type="checkbox"
            aria-label="Allow e-mail and password sign-in"
            checked={draft.localLogin}
            disabled={locked('localLogin')}
            onChange={(e) => set({ localLogin: e.target.checked })}
          />
        </label>
        {lockout && (
          <p className="warn mb-0" role="alert">
            With local sign-in off and no single sign-on configured, nobody could sign in.
          </p>
        )}
      </section>
      <section className="card" aria-label="Single sign-on">
        <strong>Single sign-on (OpenID Connect)</strong>
        <p className="muted mt-0">
          Works with Keycloak, Authentik, Entra ID, Google and other OpenID Connect providers. Redirect URI:{' '}
          <code>{window.location.origin}/auth/oidc/callback</code>
        </p>
        {text('issuer', 'Issuer URL', { placeholder: 'https://sso.example.com/realms/main' })}
        {text('clientId', 'Client ID')}
        <label className="field-label" htmlFor="oidc-clientSecret">
          Client secret {locked('clientSecret') && <span className="pill">set by the server</span>}
        </label>
        <input
          id="oidc-clientSecret"
          className="input"
          type="password"
          autoComplete="new-password"
          value={draft.clientSecret}
          disabled={locked('clientSecret')}
          placeholder={settings.oidc.clientSecretSet ? 'Set — type to replace' : 'Not set'}
          onChange={(e) => set({ clientSecret: e.target.value })}
        />
        <small className="muted">Write-only: the stored secret is never shown again.</small>
        {text('providerName', 'Button label', { placeholder: 'SSO', hint: 'Shown as “Sign in with …”.' })}
        {text('scopes', 'Scopes', { placeholder: 'openid email profile' })}
        {text('adminGroup', 'Administrator group', { hint: 'Members of this group (the “groups” claim) become administrators.' })}
        {text('allowedGroups', 'Allowed groups', { hint: 'Comma-separated. Empty = anyone the provider signs in.' })}
        {text('allowedDomains', 'Allowed e-mail domains', { hint: 'Comma-separated. Empty = any domain.' })}
        {message && (
          <p className={message.ok ? 'muted small mb-0' : 'error mb-0'} role={message.ok ? 'status' : 'alert'}>
            {message.text}
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={save}>
            {busy === 'save' ? 'Saving…' : 'Save sign-in settings'}
          </button>
          <button type="button" className="btn" disabled={busy !== null || draft.issuer.trim() === ''} onClick={test}>
            {busy === 'test' ? 'Testing…' : 'Test'}
          </button>
        </div>
      </section>
    </>
  );
}
