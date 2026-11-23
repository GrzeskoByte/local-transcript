import { useEffect, useState } from 'react';
import { fetchUsage, type Usage } from './api';
import { formatBytes } from '../../../platform/system';

/** Storage used vs the account's quota (`GET /api/me/usage`). */
export function UsageMeter(): React.JSX.Element {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchUsage()
      .then(setUsage)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!usage) return <p className="muted" role="status">Measuring…</p>;
  const limited = usage.quotaBytes > 0;
  const ratio = limited ? Math.min(1, usage.bytes / usage.quotaBytes) : 0;
  return (
    <div aria-label="Storage used">
      <div className="row wrap">
        <span className="stat">{formatBytes(usage.bytes)}</span>
        <span className="muted">{limited ? `of ${formatBytes(usage.quotaBytes)}` : 'no limit'}</span>
      </div>
      {limited && (
        <div
          className="usage-bar"
          role="img"
          aria-label={`${Math.round(ratio * 100)}% of your quota used`}
        >
          <span className="u-audio" style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      <p className="muted small mb-0">Recordings, transcripts and settings in your account.</p>
    </div>
  );
}
