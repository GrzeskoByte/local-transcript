import { useState } from 'react';
import { useApp } from '../../store.tsx';
import type { ExportFormat, Meeting } from '../../../domain/meeting';
import { exportFormats, revealExport } from '../../../features/meetings/exports';
import { folderName } from '../../../features/meetings/disk-sync';
import { wikiSummaryTitle } from '../../../integrations/gitlab';
import { exportBaseName, exportPrefs } from '../../preferences';
import { gitlabReady } from './SummaryStep.tsx';
import { isDesktopApp } from '../../../platform/desktop';

const FORMATS: Array<{ id: ExportFormat; name: string; detail: string }> = [
  { id: 'md', name: 'Markdown', detail: 'Summary, actions, transcript' },
  { id: 'txt', name: 'TXT', detail: 'Plain transcript' },
  { id: 'json', name: 'JSON', detail: 'Segments with timestamps' },
  { id: 'audio', name: 'Audio', detail: 'The recording' },
];

/**
 * Save the meeting as files (into its folder in the local-files folder on
 * desktop, as downloads in a browser) — formats and file names from
 * Settings → After recording — and optionally post the summary to the wiki.
 */
export function ExportStep({
  m,
  onError,
  onSaved,
}: {
  m: Meeting;
  onError: (e: string) => void;
  onSaved?: () => void;
}): React.JSX.Element {
  const { recordExport, gitlabConfig, postSummaryToWiki, storageDir, openStorageDir } = useApp();
  const prefs = exportPrefs();
  const [on, setOn] = useState<Record<ExportFormat, boolean>>(prefs.formats);
  const canWiki = gitlabReady(gitlabConfig) && !!m.summary && gitlabConfig.wikiSummaries !== false;
  const [wiki, setWiki] = useState(prefs.wiki);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);
  const chosen = FORMATS.filter((f) => on[f.id] && (f.id === 'audio' ? !m.audioRemovedAt : m.transcriptionStatus === 'completed'));
  const base = exportBaseName(prefs.fileName, m.title, m.startedAt);
  const folder = storageDir ? `${storageDir}/${folderName(m)}/` : null;

  return (
    <div className="export-step">
      <div className="format-grid" role="group" aria-label="Formats">
        {FORMATS.map((f) => {
          const last = m.exports?.[f.id];
          const unavailable = f.id === 'audio' ? !!m.audioRemovedAt : m.transcriptionStatus !== 'completed';
          return (
            <button
              key={f.id}
              type="button"
              className="format"
              aria-pressed={on[f.id] && !unavailable}
              disabled={unavailable}
              onClick={() => setOn({ ...on, [f.id]: !on[f.id] })}
            >
              <span className="format-name">
                {on[f.id] && !unavailable ? '[x]' : '[ ]'} {f.name}
              </span>
              <span className="format-detail">
                {unavailable
                  ? f.id === 'audio'
                    ? 'audio removed to save space'
                    : 'needs a transcript'
                  : last
                    ? `[x] saved ${new Date(last.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
                    : f.detail}
              </span>
            </button>
          );
        })}
      </div>
      {canWiki && (
        <label className="check-row">
          <input type="checkbox" checked={wiki} onChange={(e) => setWiki(e.target.checked)} />
          Also post the summary to the GitLab wiki page <code>{wikiSummaryTitle(m)}</code>
        </label>
      )}
      <p className="muted small">
        File names: <code>{base}.md</code>
        {folder ? (
          <>
            {' '}
            in <code>{folder}</code>
          </>
        ) : (
          ' (downloaded)'
        )}
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || (chosen.length === 0 && !(canWiki && wiki))}
          onClick={() => {
            setBusy(true);
            void (async () => {
              try {
                const out = await exportFormats(m, chosen.map((f) => f.id), base);
                for (const [fmt, path] of Object.entries(out)) await recordExport(m.id, fmt as ExportFormat, path ?? undefined);
                if (canWiki && wiki) await postSummaryToWiki(m.id);
                setSaved(Object.values(out).filter((p): p is string => !!p));
                onSaved?.();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? 'Saving…' : `Save ${chosen.length} file${chosen.length === 1 ? '' : 's'}${canWiki && wiki ? ' + wiki' : ''}`}
        </button>
        {isDesktopApp() && (
          <button
            type="button"
            className="btn"
            onClick={() => void (saved[0] ? revealExport(saved[0]) : openStorageDir()).catch(() => undefined)}
          >
            Show in folder
          </button>
        )}
      </div>
      {saved.length > 0 && (
        <p className="muted small mb-0" role="status" aria-label="Export saved">
          Saved to {saved.join(', ')}
        </p>
      )}
    </div>
  );
}
