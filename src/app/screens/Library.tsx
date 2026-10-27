import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store.tsx';
import { formatDuration, type Meeting, type RecordingMode } from '../../domain/meeting';
import { searchSegments, type TranscriptSegment } from '../../domain/transcript';
import { getSegments } from '../../storage/transcripts';
import { actionItemsOf } from '../../domain/action-items';
import { eventFor, issueFor } from '../../domain/wrapup';
import { formatClock } from '../../audio/player';
import { exportAudio, exportTranscript } from '../../features/meetings/exports';
import { SourcePill, StatusPill } from '../components/MeetingRow.tsx';
import { MonthView } from './MonthView.tsx';
import { Keys, useShortcuts } from '../App.tsx';
import { exportPrefs, setLibraryView } from '../preferences';
import { dayGroupLabel } from '../../domain/dates';

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_BATCH = 8;
const MAX_HITS = 50;
const PAGE = 50;

type StatusKey = 'completed' | 'not_started' | 'failed';
type SourceKey = 'speaker' | 'dual' | 'device' | 'file';
const STATUS: Array<[StatusKey, string]> = [
  ['completed', 'Transcribed'],
  ['not_started', 'Not transcribed'],
  ['failed', 'Failed'],
];
const SOURCES: Array<[SourceKey, string]> = [
  ['speaker', '● Room mic'],
  ['dual', '◐ Call'],
  ['device', '▣ This computer'],
  ['file', '▤ Imported'],
];

/** The search survives a trip to a meeting and back. */
let lastQuery = '';

function statusOf(m: Meeting): StatusKey {
  return m.transcriptionStatus === 'processing' ? 'not_started' : m.transcriptionStatus;
}

function hasOpenActions(m: Meeting): boolean {
  return actionItemsOf(m).some((a) => !issueFor(m, a.text) && !eventFor(m, a.text));
}

interface Hit {
  meetingId: string;
  title: string;
  startMs: number;
  text: string;
}

export function Library({ view, initialQuery }: { view: 'list' | 'month'; initialQuery?: string }): React.JSX.Element {
  const { meetings, go, setupAndTranscribe, deleteMeeting, txProgress, txStage } = useApp();
  const keys = useShortcuts();
  const [query, setQueryState] = useState(() => initialQuery ?? lastQuery);
  const setQuery = (q: string): void => {
    lastQuery = q;
    setQueryState(q);
  };
  const [status, setStatus] = useState<Record<StatusKey, boolean>>({ completed: true, not_started: true, failed: true });
  const [sources, setSources] = useState<Record<SourceKey, boolean>>({ speaker: true, dual: true, device: true, file: true });
  const [hasActions, setHasActions] = useState(false);
  const [hasMoments, setHasMoments] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [hits, setHits] = useState<Hit[]>([]);
  const [searching, setSearching] = useState(false);
  const [bulk, setBulk] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Transcript lines (debounced, batched, cancellable).
  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => void run(), SEARCH_DEBOUNCE_MS);
    async function run(): Promise<void> {
      const out: Hit[] = [];
      const done = meetings.filter((m) => m.transcriptionStatus === 'completed');
      for (let i = 0; i < done.length && out.length < MAX_HITS; i += SEARCH_BATCH) {
        const batch = done.slice(i, i + SEARCH_BATCH);
        const segs = await Promise.all(batch.map((m) => getSegments(m.id).catch(() => [] as TranscriptSegment[])));
        if (cancelled) return;
        batch.forEach((m, k) => {
          for (const h of searchSegments(segs[k]!, q)) {
            if (out.length >= MAX_HITS) break;
            out.push({ meetingId: m.id, title: m.title, startMs: h.segment.startMs, text: h.segment.text });
          }
        });
      }
      if (!cancelled) {
        setHits(out);
        setSearching(false);
      }
    }
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, meetings]);

  const q = query.trim().toLowerCase();
  const passesFilters = (m: Meeting): boolean =>
    status[statusOf(m)] &&
    sources[m.mode as SourceKey] !== false &&
    (!hasActions || hasOpenActions(m)) &&
    (!hasMoments || (m.moments?.length ?? 0) > 0);
  const matching = useMemo(() => {
    const hitIds = new Set(hits.map((h) => h.meetingId));
    return meetings.filter(
      (m) =>
        passesFilters(m) &&
        (!q || m.title.toLowerCase().includes(q) || (m.summary?.text ?? '').toLowerCase().includes(q) || hitIds.has(m.id)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetings, q, hits, status, sources, hasActions, hasMoments]);

  const count = (pred: (m: Meeting) => boolean): number => meetings.filter(pred).length;
  const allVisibleSelected = matching.length > 0 && matching.slice(0, limit).every((m) => selected.includes(m.id));
  const chosen = meetings.filter((m) => selected.includes(m.id));

  const runBulk = (what: string, work: () => Promise<string>): void => {
    setBulk(what);
    setMessage(null);
    work()
      .then((msg) => {
        setMessage(msg);
        setSelected([]);
      })
      .catch((e: unknown) => setMessage(e instanceof Error ? e.message : String(e)))
      .finally(() => setBulk(null));
  };

  const switchView = (v: 'list' | 'month'): void => {
    setLibraryView(v);
    go({ name: 'library', view: v });
  };

  return (
    <>
      <header className="page-head library-head">
        <div className="row between wrap grow-row">
          <h1>Library</h1>
          <div className="tabs" role="group" aria-label="View">
            <button type="button" className={`tab${view === 'list' ? ' active' : ''}`} aria-pressed={view === 'list'} onClick={() => switchView('list')}>
              List
            </button>
            <button type="button" className={`tab${view === 'month' ? ' active' : ''}`} aria-pressed={view === 'month'} onClick={() => switchView('month')}>
              Month
            </button>
          </div>
        </div>
        {view === 'list' && (
          <>
            <form
              className="search-bar"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                (document.getElementById('library-search') as HTMLInputElement | null)?.focus();
              }}
            >
              <label htmlFor="library-search" className="sr-only">
                Search titles and transcripts
              </label>
              <input
                id="library-search"
                className="input"
                aria-label="Search meetings"
                placeholder="Search titles, summaries and transcripts…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">
                Search <Keys binding={keys.search} />
              </button>
            </form>
            <p className="hero-note">Searching titles, summaries and every transcript line on this computer.</p>
          </>
        )}
      </header>

      {view === 'month' ? (
        <MonthView />
      ) : (
        <div className="library-grid">
          <aside className="card filters" aria-label="Filters">
            <strong>Filters</strong>
            <div className="grp">Status</div>
            {STATUS.map(([k, label]) => (
              <label key={k} className="flt">
                <span className="row">
                  <input type="checkbox" checked={status[k]} onChange={(e) => setStatus({ ...status, [k]: e.target.checked })} /> {label}
                </span>
                <span className="flt-count">{count((m) => statusOf(m) === k)}</span>
              </label>
            ))}
            <div className="grp">Source</div>
            {SOURCES.map(([k, label]) => (
              <label key={k} className="flt">
                <span className="row">
                  <input type="checkbox" checked={sources[k]} onChange={(e) => setSources({ ...sources, [k]: e.target.checked })} /> {label}
                </span>
                <span className="flt-count">{count((m) => (m.mode as RecordingMode) === k)}</span>
              </label>
            ))}
            <div className="grp">Has</div>
            <label className="flt">
              <span className="row">
                <input type="checkbox" checked={hasActions} onChange={(e) => setHasActions(e.target.checked)} /> Open action items
              </span>
              <span className="flt-count">{count(hasOpenActions)}</span>
            </label>
            <label className="flt">
              <span className="row">
                <input type="checkbox" checked={hasMoments} onChange={(e) => setHasMoments(e.target.checked)} /> Moments
              </span>
              <span className="flt-count">{count((m) => (m.moments?.length ?? 0) > 0)}</span>
            </label>
          </aside>

          <div className="library-main">
            {selected.length > 0 && (
              <div className="select-bar" role="toolbar" aria-label="Selected meetings">
                <strong>{selected.length} selected</strong>
                <span className="grow" />
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!bulk}
                  onClick={() =>
                    runBulk('transcribe', async () => {
                      const todo = chosen.filter((m) => m.transcriptionStatus !== 'processing' && !txStage[m.id] && !m.audioRemovedAt);
                      for (const m of todo) void setupAndTranscribe(m.id).catch(() => undefined);
                      return `Queued ${todo.length} transcription${todo.length === 1 ? '' : 's'}.`;
                    })
                  }
                >
                  {bulk === 'transcribe' ? 'Queuing…' : 'Transcribe'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!bulk}
                  onClick={() =>
                    runBulk('export', async () => {
                      const f = exportPrefs().formats;
                      let files = 0;
                      for (const m of chosen) {
                        if (m.transcriptionStatus === 'completed') {
                          for (const fmt of ['md', 'txt', 'json'] as const) {
                            if (!f[fmt]) continue;
                            await exportTranscript(m.id, fmt);
                            files += 1;
                          }
                        }
                        if (f.audio && !m.audioRemovedAt) {
                          const r = await exportAudio(m);
                          files += Array.isArray(r) ? r.length : 1;
                        }
                      }
                      return `Exported ${files} file${files === 1 ? '' : 's'} (Settings → After recording sets the formats).`;
                    })
                  }
                >
                  {bulk === 'export' ? 'Exporting…' : 'Export'}
                </button>
                {confirmDelete ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={!!bulk}
                      onClick={() => {
                        setConfirmDelete(false);
                        runBulk('delete', async () => {
                          for (const m of chosen) await deleteMeeting(m.id);
                          return `Deleted ${chosen.length} meeting${chosen.length === 1 ? '' : 's'}.`;
                        });
                      }}
                    >
                      Yes, delete {selected.length}
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => setConfirmDelete(false)}>
                      Keep them
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm btn-hot" disabled={!!bulk} onClick={() => setConfirmDelete(true)}>
                    Delete…
                  </button>
                )}
              </div>
            )}
            {message && (
              <p className="muted small" role="status">
                {message}
              </p>
            )}

            <section className="card lift table-card" aria-label={q ? `Meetings matching ${query.trim()}` : 'Meetings'}>
              <div className="card-title">
                <strong>
                  Meetings · {q ? `${matching.length} match${matching.length === 1 ? '' : 'es'}` : matching.length}
                </strong>
              </div>
              {matching.length === 0 ? (
                <p className="muted pad">{meetings.length === 0 ? 'No meetings yet — record one from Home.' : 'Nothing matches these filters.'}</p>
              ) : (
                <div className="table-scroll">
                  <table className="meetings-table">
                    <thead>
                      <tr>
                        <th scope="col">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            checked={allVisibleSelected}
                            onChange={(e) =>
                              setSelected(e.target.checked ? matching.slice(0, limit).map((m) => m.id) : [])
                            }
                          />
                        </th>
                        <th scope="col">Title</th>
                        <th scope="col">When</th>
                        <th scope="col">Length</th>
                        <th scope="col">Source</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {matching.slice(0, limit).map((m) => {
                        const sel = selected.includes(m.id);
                        return (
                          <tr key={m.id} className={sel ? 'selected' : undefined}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={`Select ${m.title}`}
                                checked={sel}
                                onChange={(e) =>
                                  setSelected(e.target.checked ? [...selected, m.id] : selected.filter((x) => x !== m.id))
                                }
                              />
                            </td>
                            <td className="t">
                              <button type="button" className="meeting-link" onClick={() => go({ name: 'detail', id: m.id })}>
                                {m.title}
                              </button>
                            </td>
                            <td className="nowrap">
                              {dayGroupLabel(m.createdAt)}{' '}
                              {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="n">{formatDuration(m.durationMs)}</td>
                            <td>
                              <SourcePill mode={m.mode} />
                            </td>
                            <td>
                              <StatusPill m={m} progress={txProgress[m.id]} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {matching.length > limit && (
                <div className="card-foot center">
                  <button type="button" className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE)}>
                    Show more ({matching.length - limit} more)
                  </button>
                </div>
              )}
            </section>

            {q && (
              <section className="card" aria-label={`Lines matching ${query.trim()}`}>
                <div className="card-title">
                  <strong>In transcripts · {searching ? 'searching…' : `${hits.length} line${hits.length === 1 ? '' : 's'}`}</strong>
                </div>
                {hits.length === 0 ? (
                  <p className="muted pad" role="status">
                    {searching ? 'Searching transcripts…' : 'No transcript matches.'}
                  </p>
                ) : (
                  <ul className="transcript flat">
                    {hits.map((h, i) => (
                      <li key={`${h.meetingId}-${i}`}>
                        <span className="ts">{formatClock(h.startMs / 1000)}</span>
                        <button
                          type="button"
                          className="hit-title"
                          onClick={() => go({ name: 'detail', id: h.meetingId, q: query.trim(), tab: 'transcript' })}
                        >
                          {h.title}
                        </button>{' '}
                        — {highlight(h.text, query)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/** `text` with every case-insensitive match of `query` in <mark>. */
export function highlight(text: string, query: string): React.ReactNode {
  const q = query.trim().toLowerCase();
  if (!q) return text;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, at)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push(<mark key={i}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}
