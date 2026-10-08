import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store.tsx';
import { formatDuration, modeLabel } from '../../domain/meeting.ts';
import { searchSegments } from '../../domain/transcript.ts';
import { dayGroupLabel } from '../../domain/dates.ts';
import { getSegments } from '../../storage/transcripts.ts';
import { describeNativeRuntime } from '../../asr/model-manager.ts';
import { MicIcon, PlusIcon, SearchIcon } from '../components/icons.tsx';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { isDesktopApp } from '../../platform/desktop.ts';

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_BATCH = 8;
const MAX_HITS = 30;
/** The search survives a trip to a meeting and back. */
let lastQuery = '';


export function Dashboard(): React.JSX.Element {
  const {
    meetings, go, unfinished, recoverUnfinished, discardUnfinished, modelMeta, nativeStatus,
    installedModels, downloadModel, modelDownload, firstRunModel, databaseError, resetDatabase,
  } = useApp();
  const [resetState, setResetState] = useState<'idle' | 'confirm' | 'working'>('idle');
  const [resetError, setResetError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [query, setQueryState] = useState(() => lastQuery);
  const setQuery = (q: string): void => {
    lastQuery = q;
    setQueryState(q);
  };
  const [hits, setHits] = useState<{ meetingId: string; title: string; snippet: string }[]>([]);
  const [searching, setSearching] = useState(false);
  /** Recovery entry awaiting a second click on Delete. */
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);
  // Titles and summaries match at once; transcripts follow (debounced, below).
  const titleHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return meetings.filter(
      (m) => m.title.toLowerCase().includes(q) || (m.summary?.text ?? '').toLowerCase().includes(q),
    );
  }, [query, meetings]);
  const groups = useMemo(() => {
    const out: { label: string; items: typeof meetings }[] = [];
    for (const m of meetings) {
      const label = dayGroupLabel(m.createdAt);
      const last = out[out.length - 1];
      if (last && last.label === label) last.items.push(m);
      else out.push({ label, items: [m] });
    }
    return out;
  }, [meetings]);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    // Debounced: search once typing pauses, not on every keystroke. Segments
    // are read in parallel batches and a newer query abandons this one.
    const timer = window.setTimeout(() => void run(), SEARCH_DEBOUNCE_MS);
    async function run(): Promise<void> {
      const out: { meetingId: string; title: string; snippet: string }[] = [];
      const done = meetings.filter((m) => m.transcriptionStatus === 'completed');
      for (let i = 0; i < done.length && out.length < MAX_HITS; i += SEARCH_BATCH) {
        const batch = done.slice(i, i + SEARCH_BATCH);
        const segs = await Promise.all(batch.map((m) => getSegments(m.id).catch(() => [])));
        if (cancelled) return;
        batch.forEach((m, k) => {
          for (const h of searchSegments(segs[k]!, q)) {
            if (out.length >= MAX_HITS) break;
            out.push({ meetingId: m.id, title: m.title, snippet: h.snippet });
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

  const totalMs = meetings.reduce((sum, m) => sum + m.durationMs, 0);
  const transcribed = meetings.filter((m) => m.transcriptionStatus === 'completed').length;
  const modelReady = modelMeta.state === 'ready';

  return (
    <>
      <div className="page-head tint-sky">
        <div>
          <h1>My Meetings</h1>
          <p className="muted">Your recording and transcript stay on this device.</p>
        </div>
        <button className="btn btn-primary" onClick={() => go({ name: 'new' })}>
          <PlusIcon /> New Meeting
        </button>
      </div>

      {databaseError && (
        <section className="banner" role="alert" aria-label="Database problem">
          <strong>Your meetings list could not be loaded.</strong>
          <p className="muted mt-2">
            {databaseError} This usually means the app data was written by a different build of
            the app (for example a newer system WebKit than the one inside the AppImage). Your
            settings are kept separately and are safe, and finished meetings are also saved in
            your Local Transcribe documents folder.
          </p>
          {isDesktopApp() && (
            <div className="btn-row">
              {resetState === 'confirm' ? (
                <>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      setResetState('working');
                      setResetError(null);
                      resetDatabase().catch((err: unknown) => {
                        setResetError(err instanceof Error ? err.message : String(err));
                        setResetState('idle');
                      });
                    }}
                  >
                    Move old database aside &amp; restart
                  </button>
                  <button className="btn" onClick={() => setResetState('idle')}>Cancel</button>
                </>
              ) : (
                <button
                  className="btn"
                  disabled={resetState === 'working'}
                  onClick={() => setResetState('confirm')}
                >
                  {resetState === 'working' ? 'Restarting…' : 'Start with a fresh database'}
                </button>
              )}
            </div>
          )}
          {resetState === 'confirm' && (
            <p className="muted mt-2">
              The unreadable database is moved to a backup folder (not deleted) and the app restarts
              with an empty meetings list.
            </p>
          )}
          {resetError && <p className="error mt-2">{resetError}</p>}
        </section>
      )}

      {unfinished.length > 0 && (
        <section className="banner" aria-label="Unfinished recording">
          <strong>An unfinished recording was found.</strong>
          {unfinished.map((m) => (
            <div key={m.id} className="mt-2">
              <div className="muted">
                Started {new Date(m.startedAt).toLocaleString()} · approximately{' '}
                {formatDuration(m.durationMs)} saved
              </div>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={() => void recoverUnfinished(m.id)}>
                  Recover Recording
                </button>
                {confirmDiscard === m.id ? (
                  <>
                    <button
                      className="btn btn-danger"
                      onClick={() => {
                        setConfirmDiscard(null);
                        void discardUnfinished(m.id);
                      }}
                    >
                      Yes, delete this audio
                    </button>
                    <button className="btn" onClick={() => setConfirmDiscard(null)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="btn btn-danger" onClick={() => setConfirmDiscard(m.id)}>
                    Delete
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {!modelReady && nativeStatus?.available && installedModels.length === 0 && (
        <section className="cta-red" aria-label="Local speech model">
          <span className="cta-title">Set up on-device transcription</span>
          <div>
            One click downloads the speech model ({firstRunModel}) once. Recording already works without it.
          </div>
          <p className="mt-2 mb-0" aria-label="Acceleration">
            {describeNativeRuntime(nativeStatus)}
          </p>
          {modelDownload ? (
            <div className="mt-3">
              <ModelDownloadProgress />
            </div>
          ) : (
            <div className="btn-row">
              <button
                className="btn btn-primary btn-lg"
                onClick={() => {
                  setSetupError(null);
                  downloadModel(firstRunModel).catch((e: unknown) =>
                    setSetupError(e instanceof Error ? e.message : String(e)),
                  );
                }}
              >
                Set up transcription
              </button>
              <button className="btn btn-lg" onClick={() => go({ name: 'settings' })}>
                Choose another model
              </button>
            </div>
          )}
          {setupError && <p className="banner mt-3 mb-0">{setupError}</p>}
        </section>
      )}

      {nativeStatus && !nativeStatus.available && (
        <section className="card" aria-label="Local speech model">
          <strong>Transcription engine not found</strong>
          <p className="muted mb-0">{describeNativeRuntime(nativeStatus)} Recording works without it.</p>
        </section>
      )}

      <div className="stats">
        <div className="stat">
          <div className="k">Meetings</div>
          <div className="v">{meetings.length}</div>
        </div>
        <div className="stat">
          <div className="k">Recorded</div>
          <div className="v">{formatDuration(totalMs)}</div>
        </div>
        <div className="stat">
          <div className="k">Transcribed</div>
          <div className="v">{transcribed}</div>
        </div>
      </div>

      <div className="search-wrap">
        <span className="icon">
          <SearchIcon />
        </span>
        <input
          className="input"
          aria-label="Search meetings"
          placeholder="Search meetings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {query.trim() ? (
        <section className="mt-2" aria-label="Search results">
          {titleHits.length > 0 && (
            <>
              <h2>Meetings</h2>
              <ul className="meeting-list">
                {titleHits.map((m) => (
                  <li key={m.id}>
                    <button className="meeting-item" onClick={() => go({ name: 'detail', id: m.id })}>
                      <span className="body">
                        <span className="title">{m.title}</span>
                        <span className="meta">
                          {dayGroupLabel(m.createdAt)} · {formatDuration(m.durationMs)}
                          {m.summary?.text ? ` · ${m.summary.text}` : ''}
                        </span>
                      </span>
                      <span className="chev">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h2>In transcripts</h2>
          {hits.length === 0 ? (
            <p className="muted" role="status">{searching ? 'Searching transcripts…' : 'No transcript matches.'}</p>
          ) : (
            <ul className="meeting-list">
              {hits.map((h, i) => (
                <li key={`${h.meetingId}-${i}`}>
                  <button className="meeting-item" onClick={() => go({ name: 'detail', id: h.meetingId, q: query.trim() })}>
                    <span className="body">
                      <span className="title">{h.title}</span>
                      <span className="meta">“…{h.snippet}…”</span>
                    </span>
                    <span className="chev">›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : meetings.length === 0 ? (
        <div className="card empty">
          <div className="art">
            <MicIcon size={28} />
          </div>
          <h3>No meetings yet</h3>
          <p className="muted">
            Record your first meeting — pick the microphone or device audio. You can transcribe it later, fully offline.
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => go({ name: 'new' })}>
            <PlusIcon /> New Meeting
          </button>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.label} aria-label={g.label}>
              <h2>{g.label}</h2>
              <ul className="meeting-list">
                {g.items.map((m) => (
                  <li key={m.id}>
                    <button className={`meeting-item mode-${m.mode}`} onClick={() => go({ name: 'detail', id: m.id })}>
                      <span className="body">
                        <span className="title">{m.title}</span>
                        <span className="meta">
                          {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ·{' '}
                          {formatDuration(m.durationMs)}
                          {m.summary?.text ? ` · ${m.summary.text}` : ''}
                        </span>
                      </span>
                      <span className="pills">
                        <span className={`pill pill-${m.mode}`}>
                          {modeLabel(m.mode)}
                        </span>
                        <span className={`pill pill-${m.transcriptionStatus === 'not_started' ? 'idle' : m.transcriptionStatus}`}>
                          {m.transcriptionStatus === 'not_started' ? 'not transcribed' : m.transcriptionStatus}
                        </span>
                      </span>
                      <span className="chev">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}
