import { useState } from 'react';
import { useApp } from '../../store.tsx';
import type { Meeting, Participant } from '../../../domain/meeting';
import { parseAttendees } from '../../../integrations/calendar';
import { gitlabReady } from '../wrap/SummaryStep.tsx';
import { GitlabProjectPicker } from '../GitlabPicker.tsx';
import type { GitlabGroup } from '../../../integrations/gitlab';

/** Merge people by e-mail / username / name, keeping the first's fields and filling gaps. */
export function mergePeople(a: Participant[], b: Participant[]): Participant[] {
  const out = [...a];
  const key = (p: Participant) => (p.email ?? p.username ?? p.name).toLowerCase();
  for (const p of b) {
    const i = out.findIndex((x) => key(x) === key(p) || (!!p.username && x.username === p.username));
    if (i < 0) out.push(p);
    else out[i] = { ...p, ...out[i], email: out[i]!.email ?? p.email, username: out[i]!.username ?? p.username };
  }
  return out;
}

/**
 * Who was in the meeting: typed by hand or loaded from a GitLab project's or
 * group's members. Used as action-item owners, issue assignees and calendar
 * invitees (people with an e-mail).
 */
export function ParticipantsCard({ m }: { m: Meeting }): React.JSX.Element {
  const { gitlabConfig, setParticipants, loadGitlabPeople } = useApp();
  const people = m.participants ?? [];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [from, setFrom] = useState(false);
  const [project, setProject] = useState(gitlabConfig.project);
  const [group, setGroup] = useState<GitlabGroup | null>(null);
  const [found, setFound] = useState<Participant[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const glReady = gitlabReady(gitlabConfig);
  const keyOf = (p: Participant) => p.username ?? p.email ?? p.name;

  const add = (): void => {
    const addr = parseAttendees(email)[0];
    if (!name.trim() && !addr) return;
    if (email.trim() && !addr) return setError(`"${email.trim()}" is not an e-mail address.`);
    setError(null);
    void setParticipants(m.id, mergePeople(people, [{ name: name.trim() || addr!, ...(addr ? { email: addr } : {}), source: 'manual' }]));
    setName('');
    setEmail('');
  };

  const load = (): void => {
    setBusy(true);
    setError(null);
    loadGitlabPeople(group ? { groupId: group.id, name: group.name } : { project })
      .then((list) => {
        setFound(list);
        setPicked(list.filter((p) => !people.some((x) => keyOf(x) === keyOf(p))).map(keyOf));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" aria-label="Participants">
      <div className="card-title">
        <strong>Participants · {people.length}</strong>
        <span className="muted">owners, assignees and invitees</span>
      </div>
      {people.length === 0 ? (
        <p className="muted mt-0">Nobody yet. Add people by hand{glReady ? ' or load a GitLab project’s or group’s members' : ''}.</p>
      ) : (
        <ul className="people" aria-label="Meeting participants">
          {people.map((p) => (
            <li key={keyOf(p)} className="person">
              <b>{p.name}</b>
              {p.username && <span className="muted"> @{p.username}</span>}
              {p.email ? <span className="small"> · {p.email}</span> : <span className="muted small"> · no e-mail</span>}
              <button
                type="button"
                className="icon-btn"
                aria-label={`Remove ${p.name}`}
                onClick={() => void setParticipants(m.id, people.filter((x) => keyOf(x) !== keyOf(p)))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="row wrap mt-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="input input-sm" aria-label="Participant name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input input-sm" aria-label="Participant e-mail" placeholder="e-mail (for invitations)" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button type="submit" className="btn btn-sm">
          Add
        </button>
        {glReady && (
          <button type="button" className="btn btn-sm" aria-expanded={from} onClick={() => setFrom((v) => !v)}>
            From GitLab…
          </button>
        )}
      </form>
      {from && glReady && (
        <div className="gl-people">
          <GitlabProjectPicker config={gitlabConfig} value={project} onChange={(p) => { setProject(p); setGroup(null); }} onGroup={setGroup} />
          <div className="btn-row mt-2">
            <button type="button" className="btn btn-sm" disabled={busy || (!group && !project)} onClick={load}>
              {busy ? 'Loading…' : `Load members of ${group ? group.name : project}`}
            </button>
          </div>
          {found && (
            <>
              <ul className="people pick" aria-label="GitLab members">
                {found.map((p) => {
                  const k = keyOf(p);
                  const already = people.some((x) => keyOf(x) === k);
                  return (
                    <li key={k}>
                      <label className="check-row mt-0">
                        <input
                          type="checkbox"
                          disabled={already}
                          checked={already || picked.includes(k)}
                          onChange={(e) => setPicked((xs) => (e.target.checked ? [...xs, k] : xs.filter((x) => x !== k)))}
                        />
                        {p.name} <span className="muted">@{p.username}</span>
                        {p.email ? <span className="small"> · {p.email}</span> : <span className="muted small"> · no public e-mail</span>}
                      </label>
                    </li>
                  );
                })}
              </ul>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={picked.length === 0}
                  onClick={() => {
                    void setParticipants(m.id, mergePeople(people, found.filter((p) => picked.includes(keyOf(p)))));
                    setFound(null);
                    setFrom(false);
                  }}
                >
                  Add {picked.length} participant{picked.length === 1 ? '' : 's'}
                </button>
                <span className="muted small self-center">Members without a public e-mail can be given one by hand.</span>
              </div>
            </>
          )}
        </div>
      )}
      {people.some((p) => !p.email) && (
        <details className="mt-2">
          <summary className="small">Add missing e-mails</summary>
          {people
            .filter((p) => !p.email)
            .map((p) => (
              <label key={keyOf(p)} className="set-row">
                <span className="grow">{p.name}</span>
                <input
                  className="input input-sm"
                  aria-label={`E-mail of ${p.name}`}
                  placeholder="name@company.com"
                  onBlur={(e) => {
                    const addr = parseAttendees(e.target.value)[0];
                    if (addr) void setParticipants(m.id, people.map((x) => (keyOf(x) === keyOf(p) ? { ...x, email: addr } : x)));
                  }}
                />
              </label>
            ))}
        </details>
      )}
      {error && (
        <p className="warn small mb-0" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
