import { useCallback, useEffect, useState } from 'react';
import {
  absoluteUrl,
  createInvite,
  deleteInvite,
  deleteUser,
  formatWhen,
  listInvites,
  listUsers,
  patchUser,
  useServerSession,
  type AdminUser,
  type InviteRow,
} from './api';
import { ConfirmButton } from '../ConfirmButton';
import { CopyButton } from '../CopyButton';
import { formatBytes } from '../../../platform/system';

function InviteCard({ onChanged }: { onChanged: () => void }): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'member'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ email: string; url: string; expiresAt: number | string } | null>(null);
  return (
    <section className="card" aria-label="Invite someone">
      <strong>Invite someone</strong>
      <p className="muted mt-0">
        Accounts are by invitation. Send the link yourself: it works once and expires after 7 days.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          createInvite(email.trim(), role)
            .then((r) => {
              setLink({ email: email.trim(), url: absoluteUrl(r.url), expiresAt: r.expiresAt });
              setEmail('');
              onChanged();
            })
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        <div className="row-selects">
          <label>
            E-mail
            <input className="input" type="email" aria-label="Invite e-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>
            Role
            <select className="input" aria-label="Invite role" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'member')}>
              <option value="member">Member</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="btn-row">
          <button type="submit" className="btn btn-primary" disabled={busy || !email.trim()}>
            {busy ? 'Creating…' : 'Create invite link'}
          </button>
        </div>
      </form>
      {link && (
        <div className="invite-link" role="status" aria-label="Invite link">
          <small className="muted">Link for {link.email} · expires {formatWhen(link.expiresAt)}</small>
          <div className="row wrap">
            <code className="block break-all grow">{link.url}</code>
            <CopyButton label="Copy invite link" text={() => link.url} />
          </div>
        </div>
      )}
    </section>
  );
}

function InvitesCard({ invites, reload }: { invites: InviteRow[]; reload: () => void }): React.JSX.Element | null {
  const [error, setError] = useState<string | null>(null);
  const pending = invites.filter((i) => !i.usedAt);
  if (pending.length === 0) return null;
  return (
    <section className="card" aria-label="Pending invites">
      <strong>Pending invites</strong>
      {error && <p className="error" role="alert">{error}</p>}
      {pending.map((i) => (
        <div className="set-row" key={i.id}>
          <span className="grow">
            <b>{i.email}</b> <span className="pill">{i.role}</span>
            <br />
            <small className="muted">expires {formatWhen(i.expiresAt)}</small>
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() =>
              void deleteInvite(i.id)
                .then(reload)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
            }
          >
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}

/** Settings → Users (admin): accounts, usage, roles, invitations. */
export function UsersSettings(): React.JSX.Element {
  const me = useServerSession()?.user;
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    listUsers()
      .then(setUsers)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    listInvites()
      .then(setInvites)
      .catch(() => setInvites([]));
  }, []);
  useEffect(reload, [reload]);

  const act = (work: Promise<unknown>): void => {
    setError(null);
    work.then(reload).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <>
      <InviteCard onChanged={reload} />
      <section className="card" aria-label="Users">
        <strong>Users{users ? ` · ${users.length}` : ''}</strong>
        <p className="muted mt-0">
          Administrators manage accounts, never anyone&apos;s meetings: there is no way to open another person&apos;s recordings
          or transcripts.
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        {!users && !error && <p className="muted" role="status">Loading…</p>}
        {users && (
          <div className="table-scroll">
            <table className="meetings-table" aria-label="Accounts">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Sign-in</th>
                  <th>Used</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const self = u.id === me?.id;
                  return (
                    <tr key={u.id}>
                      <td className="t">
                        <b>{u.name || u.email}</b> {u.disabled && <span className="pill pill-failed">disabled</span>}
                        <br />
                        <small className="muted">{u.email}</small>
                      </td>
                      <td>
                        <select
                          className="input input-sm"
                          aria-label={`Role of ${u.email}`}
                          value={u.role}
                          disabled={self}
                          onChange={(e) => act(patchUser(u.id, { role: e.target.value as 'admin' | 'member' }))}
                        >
                          <option value="member">Member</option>
                          <option value="admin">Administrator</option>
                        </select>
                      </td>
                      <td>{u.auth === 'oidc' ? 'SSO' : 'local'}</td>
                      <td className="n">{formatBytes(u.bytes)}</td>
                      <td className="n">{formatWhen(u.lastLoginAt)}</td>
                      <td>
                        {!self && (
                          <span className="row wrap">
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => act(patchUser(u.id, { disabled: !u.disabled }))}
                            >
                              {u.disabled ? 'Enable' : 'Disable'}
                            </button>
                            <ConfirmButton
                              className="btn btn-sm btn-danger"
                              prompt={`Delete ${u.email} and all their data?`}
                              confirmLabel="Yes, delete"
                              onConfirm={() => act(deleteUser(u.id))}
                            >
                              Delete
                            </ConfirmButton>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <InvitesCard invites={invites} reload={reload} />
    </>
  );
}
