import { useCallback, useEffect, useState } from 'react';
import {
  changePassword,
  deleteOwnAccount,
  leaveSession,
  formatWhen,
  listSessions,
  revokeSession,
  useServerSession,
  type ServerSessionRow,
} from './api';
import { UsageMeter } from './Usage';
import { SignOutButton } from './SignOutButton';
import { ConfirmButton } from '../ConfirmButton';

const MIN_PASSWORD = 8;

function ProfileCard(): React.JSX.Element | null {
  const session = useServerSession();
  if (!session) return null;
  const { user } = session;
  return (
    <section className="card" aria-label="Profile">
      <strong>Profile</strong>
      <div className="set-row">
        <span className="grow">
          <b>{user.name || user.email}</b>
          <br />
          <small className="muted">{user.email}</small>
        </span>
        <span className="pill">{user.role === 'admin' ? '[x] administrator' : 'member'}</span>
        <span className="pill">{user.auth === 'oidc' ? 'single sign-on' : 'local account'}</span>
      </div>
      <div className="btn-row">
        <SignOutButton className="btn" />
      </div>
    </section>
  );
}

function PasswordCard(): React.JSX.Element | null {
  const session = useServerSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (session?.user.auth !== 'local') return null;
  const valid = current.length > 0 && next.length >= MIN_PASSWORD && next === again;
  return (
    <section className="card" aria-label="Change password">
      <strong>Change password</strong>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setMessage(null);
          changePassword(current, next)
            .then(() => {
              setCurrent('');
              setNext('');
              setAgain('');
              setMessage({ ok: true, text: 'Password changed.' });
            })
            .catch((err: unknown) => setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) }))
            .finally(() => setBusy(false));
        }}
      >
        <label className="field-label" htmlFor="pw-current">Current password</label>
        <input id="pw-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        <label className="field-label" htmlFor="pw-next">New password</label>
        <input id="pw-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        <small className="muted">At least {MIN_PASSWORD} characters.</small>
        <label className="field-label" htmlFor="pw-again">New password again</label>
        <input id="pw-again" className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        {again.length > 0 && again !== next && <p className="error mb-0" role="alert">The passwords do not match.</p>}
        {message && <p className={message.ok ? 'muted small mb-0' : 'error mb-0'} role={message.ok ? 'status' : 'alert'}>{message.text}</p>}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !valid}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </section>
  );
}

function SessionsCard(): React.JSX.Element {
  const [rows, setRows] = useState<ServerSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    listSessions()
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(reload, [reload]);
  return (
    <section className="card" aria-label="Sessions">
      <strong>Sessions</strong>
      <p className="muted mt-0">Browsers and devices signed in to your account. Revoke one you do not recognise.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!rows && !error && <p className="muted" role="status">Loading…</p>}
      {rows?.map((s) => (
        <div className="set-row" key={s.id}>
          <span className="grow">
            <b>{s.userAgent || 'Unknown browser'}</b> {s.current && <span className="pill">this one</span>}
            <br />
            <small className="muted">
              Signed in {formatWhen(s.createdAt)} · last seen {formatWhen(s.lastSeenAt)}
            </small>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void revokeSession(s.id)
                .then(() => (s.current ? leaveSession() : reload()))
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            {s.current ? 'Sign out' : 'Revoke'}
          </button>
        </div>
      ))}
    </section>
  );
}

function DataCard(): React.JSX.Element {
  return (
    <section className="card" aria-label="Your data">
      <strong>Your data</strong>
      <UsageMeter />
      <div className="set-row">
        <span className="grow">
          <b>Export my data</b>
          <br />
          <small className="muted">A zip with your meetings, recordings and settings.</small>
        </span>
        <a className="btn btn-sm" href="/api/me/export" download="local-transcribe-export.zip">
          Download
        </a>
      </div>
    </section>
  );
}

function DeleteCard(): React.JSX.Element | null {
  const session = useServerSession();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!session) return null;
  const email = session.user.email;
  return (
    <section className="card danger-zone" aria-label="Delete account">
      <strong>Delete account</strong>
      <p className="mt-0">
        Deletes your account and everything in it: meetings, recordings, transcripts and settings. This cannot be undone.
        The last administrator cannot be deleted.
      </p>
      <label className="field-label" htmlFor="delete-confirm">Type {email} to confirm</label>
      <input id="delete-confirm" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="btn-row">
        <ConfirmButton
          className="btn btn-danger"
          prompt="Delete your account and all its data?"
          confirmLabel="Yes, delete everything"
          disabled={typed.trim().toLowerCase() !== email.toLowerCase()}
          onConfirm={() => {
            setError(null);
            deleteOwnAccount(typed.trim())
              .then(() => {
                leaveSession();
              })
              .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
          }}
        >
          Delete my account
        </ConfirmButton>
      </div>
    </section>
  );
}

/** Settings → Account (server edition). */
export function AccountSettings(): React.JSX.Element {
  return (
    <>
      <ProfileCard />
      <DataCard />
      <PasswordCard />
      <SessionsCard />
      <DeleteCard />
    </>
  );
}
