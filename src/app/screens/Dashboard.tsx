import { useEffect, useState } from 'react';
import { useApp } from '../store.tsx';
import { formatDuration, modeLabel } from '../../domain/meeting.ts';
import { searchSegments } from '../../domain/transcript.ts';
import { getSegments } from '../../storage/transcripts.ts';
import { describeNativeRuntime } from '../../asr/model-manager.ts';
import { MicIcon, PlusIcon, SearchIcon, WaveIcon } from '../components/icons.tsx';

export function Dashboard(): React.JSX.Element {
  const { meetings, go, unfinished, recoverUnfinished, discardUnfinished, modelMeta, nativeStatus } = useApp();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ meetingId: string; title: string; snippet: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      const q = query.trim();
      if (!q) {
        setHits([]);
        return;
      }
      const out: { meetingId: string; title: string; snippet: string }[] = [];
      for (const m of meetings) {
        if (m.transcriptionStatus !== 'completed') continue;
        const segs = await getSegments(m.id);
        for (const h of searchSegments(segs, q)) {
          out.push({ meetingId: m.id, title: m.title, snippet: h.snippet });
          if (out.length >= 30) break;
        }
        if (out.length >= 30) break;
      }
      if (!cancelled) setHits(out);
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [query, meetings]);

  const totalMs = meetings.reduce((sum, m) => sum + m.durationMs, 0);
  const transcribed = meetings.filter((m) => m.transcriptionStatus === 'completed').length;
  const modelReady = modelMeta.state === 'ready';

  return (
    <>
      <div className="page-head">
        <div>
          <h1>My Meetings</h1>
          <p className="muted">Your recording and transcript stay on this device.</p>
        </div>
        <button className="btn btn-primary" onClick={() => go({ name: 'new' })}>
          <PlusIcon /> New Meeting
        </button>
      </div>

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
                <button className="btn btn-danger" onClick={() => void discardUnfinished(m.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {!modelReady && (
        <section className="card" aria-label="Local speech model">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
            <div className="media-art">
              <WaveIcon />
            </div>
            <div style={{ flex: 1 }}>
              <strong>Enable on-device transcription</strong>
              <div className="muted">
                Choose and download a speech model in Settings. Recording works without one.
              </div>
              <p className="muted" style={{ marginTop: 8, marginBottom: 0 }} aria-label="Acceleration">
                {describeNativeRuntime(nativeStatus)}
              </p>
              <div className="btn-row">
                <button className="btn btn-primary" onClick={() => go({ name: 'settings' })}>
                  Manage models
                </button>
              </div>
            </div>
          </div>
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
        <section className="mt-2">
          {hits.length === 0 ? (
            <p className="muted">No transcript matches.</p>
          ) : (
            <ul className="meeting-list">
              {hits.map((h, i) => (
                <li key={`${h.meetingId}-${i}`}>
                  <button className="meeting-item" onClick={() => go({ name: 'detail', id: h.meetingId })}>
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
          <h2>Recent recordings</h2>
          <ul className="meeting-list">
            {meetings.map((m) => (
              <li key={m.id}>
                <button className="meeting-item" onClick={() => go({ name: 'detail', id: m.id })}>
                  <span className="body">
                    <span className="title">{m.title}</span>
                    <span className="meta">
                      {new Date(m.createdAt).toLocaleString()} · {formatDuration(m.durationMs)}
                    </span>
                  </span>
                  <span className="pills">
                    <span className={`pill pill-${m.mode}`}>
                      {modeLabel(m.mode)}
                    </span>
                    <span className={`pill pill-${m.transcriptionStatus === 'not_started' ? 'processing' : m.transcriptionStatus}`}>
                      {m.transcriptionStatus === 'not_started' ? 'audio only' : m.transcriptionStatus}
                    </span>
                  </span>
                  <span className="chev">›</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
