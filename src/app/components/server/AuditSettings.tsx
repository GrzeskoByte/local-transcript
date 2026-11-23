import { useEffect, useState } from 'react';
import { fetchAudit, formatWhen, type AuditRow } from './api';

/** Settings → Audit log (admin): sign-ins and admin actions, never meeting content. */
export function AuditSettings(): React.JSX.Element {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = (): void => {
    setError(null);
    fetchAudit(200)
      .then(setRows)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);
  return (
    <section className="card" aria-label="Audit log">
      <div className="card-title">
        <strong>Audit log · last 200</strong>
        <button type="button" className="btn btn-sm" onClick={load}>
          Refresh
        </button>
      </div>
      <p className="muted mt-0">Sign-ins, failed sign-ins and administrator actions. It never contains meeting content.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {!rows && !error && <p className="muted" role="status">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted mb-0">Nothing recorded yet.</p>}
      {rows && rows.length > 0 && (
        <div className="table-scroll">
          <table className="meetings-table" aria-label="Audit entries">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="n">{formatWhen(r.at)}</td>
                  <td>{r.action}</td>
                  <td className="break-all">{formatDetail(r.detail)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** `detail` is whatever JSON the server attached: show `key: value` pairs. */
function formatDetail(detail: unknown): string {
  if (detail === null || detail === undefined || detail === '') return '—';
  if (typeof detail !== 'object') return String(detail);
  return Object.entries(detail as Record<string, unknown>)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(', ');
}
