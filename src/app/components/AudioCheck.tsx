import { useState } from 'react';
import {
  formatAt,
  isCallProfile,
  type AudioIssue,
  type InputStats,
  type RecordingDiagnostics,
} from '../../domain/audio-diagnostics';
import { formatStopTrace, type StopStep } from '../../domain/stop-trace';

const ROLE: Record<InputStats['role'], string> = { microphone: 'Microphone', device: 'System sound' };

/** Problems found in the running recording (Active Meeting). */
export function LiveAudioWarnings({ issues }: { issues: AudioIssue[] }): React.JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <section className="card audio-warnings" role="status" aria-label="Audio warnings">
      <strong>Audio problem detected</strong>
      <ul className="audio-issues">
        {issues.slice(0, 3).map((i) => (
          <li key={i.id}>
            <span className="audio-issue-title">{i.title}</span>
            <span className="muted small">{i.detail}</span>
          </li>
        ))}
      </ul>
      <p className="muted small mb-0">Recording continues. Fixing it now improves the rest of the meeting.</p>
    </section>
  );
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

function inputSummary(input: InputStats): string {
  const speech = median(input.timeline.filter((b) => b.rmsDb > -50).map((b) => b.rmsDb));
  const parts = [
    input.settings.label ? `“${input.settings.label}”` : null,
    speech != null ? `typical level ${speech.toFixed(0)} dBFS` : 'no signal',
    `peak ${input.peakDb.toFixed(1)} dBFS`,
    input.clippedPolls ? `${input.clippedPolls} clipped moments` : null,
    input.activePolls ? `${Math.round((100 * input.wideband4kPolls) / input.activePolls)}% wideband` : null,
    input.settings.autoGainControl != null ? `auto gain ${input.settings.autoGainControl ? 'on' : 'off'}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** What was measured during the recording, with plain advice (Meeting Detail). */
export function AudioCheckCard({
  diagnostics: d,
  stopTrace,
}: {
  diagnostics: RecordingDiagnostics;
  stopTrace?: { steps: StopStep[]; totalMs: number };
}): React.JSX.Element {
  const [copied, setCopied] = useState<string | null>(null);
  const problems = d.issues.filter((i) => i.severity === 'problem');
  const notices = d.issues.filter((i) => i.severity === 'notice');
  const bt = d.native?.start.cards.filter((c) => c.name.startsWith('bluez')) ?? [];

  return (
    <section className="card" aria-label="Audio check">
      <div className="model-title">
        <strong>Audio check</strong>
        <span className={`badge${problems.length ? ' badge-warn' : ''}`}>
          {problems.length ? `${problems.length} problem${problems.length > 1 ? 's' : ''}` : 'OK'}
        </span>
      </div>
      {!d.complete && (
        <p className="muted small">Measured until the recording was interrupted.</p>
      )}
      {d.error && <p className="muted small">Some measurements were unavailable ({d.error}).</p>}
      {d.issues.length === 0 ? (
        <p className="muted mb-0">No audio problems were detected while recording.</p>
      ) : (
        <ul className="audio-issues">
          {[...problems, ...notices].map((i) => (
            <li key={i.id} className={i.severity === 'problem' ? 'is-problem' : 'is-notice'}>
              <span className="audio-issue-title">{i.title}</span>
              <span className="muted small">{i.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <details className="audio-details">
        <summary>Measurements</summary>
        <ul className="muted small">
          {d.inputs.map((input) => (
            <li key={input.role}>
              <strong>{ROLE[input.role]}:</strong> {inputSummary(input)}
            </li>
          ))}
          {d.bleed && (
            <li>
              <strong>System sound in microphone:</strong> similarity {d.bleed.medianCorr.toFixed(2)}, delay{' '}
              {Math.round(d.bleed.medianLagMs)} ms ({d.bleed.windows} samples)
            </li>
          )}
          {d.native && (
            <li>
              <strong>Sound server:</strong> {d.native.server ?? 'unknown'} · output {d.native.start.defaultSink ?? '?'} ·
              input {d.native.start.defaultSource ?? '?'}
              {bt.map((c) => (
                <span key={c.name}>
                  {' '}
                  · {c.description || c.name}: {c.profile}
                  {c.codec ? ` (${c.codec})` : ''}
                  {isCallProfile(c.profile) ? ' — call mode' : ''}
                </span>
              ))}
            </li>
          )}
          {stopTrace && (
            <li>
              <strong>Stop:</strong> {formatStopTrace(stopTrace.steps, stopTrace.totalMs).replace(/^Stop /, '')}
            </li>
          )}
          {d.events.map((e, n) => (
            <li key={`${e.atMs}-${n}`}>
              {formatAt(e.atMs)} — {e.detail}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn"
          onClick={() => {
            navigator.clipboard
              .writeText(JSON.stringify(stopTrace ? { ...d, stopTrace } : d, null, 2))
              .then(() => setCopied('Copied the full report.'))
              .catch(() => setCopied('Copy failed — the report is also saved as diagnostics.json in the meeting folder.'));
          }}
        >
          Copy report
        </button>
        {copied && <p className="muted small mb-0">{copied}</p>}
      </details>
    </section>
  );
}
