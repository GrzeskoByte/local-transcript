import { useEffect, useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import { modeLabel } from '../../domain/meeting';
import type { TranscriptionStage } from '../../asr/engine';
import {
  nativeAccuracyHint,
  describeNativeRuntime,
  NATIVE_LANGUAGE_OPTIONS,
} from '../../asr/model-manager';
import { searchSegments } from '../../domain/transcript';
import { deleteMeetingEverywhere, exportAudio, exportTranscript } from '../../features/meetings/exports';

export function MeetingDetail({ id }: { id: string }): React.JSX.Element {
  const {
    detailMeeting, detailSegments, detailTracks, loadDetail, go, refresh,
    txProgress, txStage, transcribe, cancelTranscription, modelMeta,
    selectModel, language, setLanguage, nativeStatus, installedModels,
    uploadToGitlab,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [gitlabBusy, setGitlabBusy] = useState(false);
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    void loadDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Only installed models are offered, so realign the selection if the active
  // model is no longer installed.
  useEffect(() => {
    if (installedModels.length === 0) return;
    if (!installedModels.some((opt) => opt.id === modelMeta.modelId)) {
      void selectModel(installedModels[0]!.id);
    }
  }, [installedModels, modelMeta.modelId, selectModel]);

  if (!detailMeeting) return <p className="muted">Loading…</p>;
  const m = detailMeeting;
  const progress = txProgress[m.id];
  const stage: TranscriptionStage = txStage[m.id] ?? 'transcribing';
  // Primary signal is the meeting status; the stage fallback covers the gap
  // between tapping Transcribe and the status write landing.
  const busy =
    m.transcriptionStatus === 'processing' ||
    (m.transcriptionStatus === 'not_started' && txStage[m.id] !== undefined);
  const stageLabel: Record<TranscriptionStage, string> = {
    'loading-model': 'Loading local model…',
    'decoding-audio': 'Decoding audio…',
    transcribing: 'Transcribing…',
    saving: 'Saving transcript…',
  };
  const filtered = filter.trim()
    ? searchSegments(detailSegments, filter).map((h) => h.segment)
    : detailSegments;

  return (
    <>
      <button className="backlink" onClick={() => go({ name: 'dashboard' })}>
        ← All meetings
      </button>

      <div className="mt-3">
        <h1>{m.title}</h1>
        <p className="muted">
          {formatDuration(m.durationMs)} · Recorded {new Date(m.createdAt).toLocaleString()}
        </p>
        <div className="pill-row">
          <span className={`pill pill-${m.mode}`}>{modeLabel(m.mode)}</span>
          <span className={`pill pill-${m.transcriptionStatus === 'not_started' ? 'processing' : m.transcriptionStatus}`}>
            {m.transcriptionStatus === 'not_started' ? 'not transcribed' : m.transcriptionStatus}
          </span>
        </div>
      </div>

      <section className="card" aria-label="Recording playback">
        {detailTracks.length === 0 ? (
          <p className="muted">Recording audio unavailable.</p>
        ) : detailTracks.length === 1 ? (
          <audio className="player" controls src={detailTracks[0]!.url} />
        ) : (
          <div className="player-stack">
            {detailTracks.map((t) => (
              <label key={t.track || 'recording'} className="track-player">
                <span className="track-label">{t.label}</span>
                <audio className="player" controls src={t.url} />
              </label>
            ))}
          </div>
        )}
      </section>

      <h2>Transcript</h2>
      {!busy && (
        <div className="card" aria-label="Transcription settings">
          <div className="row-selects">
            <label>
              Speech model
              {installedModels.length > 0 ? (
                <select
                  className="input"
                  aria-label="Speech model for this transcription"
                  value={modelMeta.modelId}
                  onChange={(e) => void selectModel(e.target.value)}
                >
                  {installedModels.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                      {opt.tier === 'S' ? ' · best' : ''} — {opt.detail}
                    </option>
                  ))}
                </select>
              ) : (
                <select className="input" aria-label="Speech model for this transcription" disabled>
                  <option>No model downloaded</option>
                </select>
              )}
            </label>
            <label>
              Language
              <select
                className="input"
                aria-label="Spoken language"
                value={language}
                onChange={(e) => void setLanguage(e.target.value)}
              >
                {NATIVE_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {installedModels.length === 0 && (
            <p className="muted" style={{ margin: '10px 0 0' }}>
              No speech model downloaded yet.{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings' })}>
                Open Settings
              </button>
            </p>
          )}
          <p className="muted" style={{ marginBottom: 0 }}>
            Desktop engine: models run natively and language auto-detection is available (whisper.cpp).
          </p>
          {nativeAccuracyHint(modelMeta.modelId) && (
            <p className="muted" style={{ marginBottom: 0 }}>
              {nativeAccuracyHint(modelMeta.modelId)}
            </p>
          )}
          <p className="muted" style={{ marginBottom: 0 }} aria-label="Acceleration">
            {describeNativeRuntime(nativeStatus)}
          </p>
        </div>
      )}
      {m.transcriptionStatus === 'not_started' && !busy && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Not transcribed yet. Transcription runs fully on this device.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              transcribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Transcribe
          </button>
        </div>
      )}

      {busy && (
        <div className="loader" role="status" aria-live="polite" aria-label="Transcription in progress">
          <div className="loader-head">
            <span className="spinner" aria-hidden="true" />
            <strong>{stageLabel[stage]}</strong>
            {progress !== undefined && <span className="muted">{Math.round(progress * 100)}%</span>}
          </div>
          {progress !== undefined ? (
            <progress value={progress} max={1} />
          ) : (
            <progress />
          )}
          <div className="btn-row">
            <button className="btn" onClick={() => void cancelTranscription(m.id)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {m.transcriptionStatus === 'failed' && !busy && (
        <div className="card">
          <p style={{ marginTop: 0 }}>
            <strong>Transcription failed.</strong>
          </p>
          <p className="muted">Your original recording is still safe.</p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              transcribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Retry
          </button>
        </div>
      )}

      {m.transcriptionStatus === 'completed' && !busy && (
        <div className="btn-row">
          <button
            className="btn"
            onClick={() => {
              setError(null);
              transcribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Re-transcribe
          </button>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {!busy && modelMeta.state !== 'ready' && (
        <p className="muted">Tip: download the local speech model from My Meetings for offline use.</p>
      )}

      {detailSegments.length > 0 && (
        <section style={{ marginTop: 8 }}>
          <input
            className="input"
            aria-label="Search transcript"
            placeholder="Search transcript…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <ul className="transcript">
            {filtered.map((s) => (
              <li key={s.id}>
                <span className="ts">
                  {String(Math.floor(s.startMs / 60000)).padStart(2, '0')}:
                  {String(Math.floor((s.startMs % 60000) / 1000)).padStart(2, '0')}
                </span>
                {s.speaker && <span className="who">{s.speaker}</span>}
                {s.text}
              </li>
            ))}
          </ul>
          {filtered.length === 0 && <p className="muted">No matches in this transcript.</p>}
        </section>
      )}

      <h2>Manage</h2>
      <div className="card">
        <div className="btn-row" style={{ marginTop: 0 }}>
          <button
            className="btn btn-primary"
            disabled={gitlabBusy || m.transcriptionStatus !== 'completed'}
            title={
              m.transcriptionStatus !== 'completed'
                ? 'Transcribe first — GitLab receives the transcript'
                : 'Publish this transcript to the configured GitLab project'
            }
            onClick={() => {
              setGitlabBusy(true);
              setGitlabMessage(null);
              uploadToGitlab(m.id)
                .then((r) => setGitlabMessage(`Published to GitLab (${r.target}).`))
                .catch((e: unknown) => {
                  const msg = e instanceof Error ? e.message : String(e);
                  setGitlabMessage(null);
                  setError(msg);
                })
                .finally(() => setGitlabBusy(false));
            }}
          >
            {gitlabBusy ? 'Uploading…' : 'Upload to GitLab'}
          </button>
          {m.gitlab && (
            <a className="btn" href={m.gitlab.url} target="_blank" rel="noreferrer">
              Open in GitLab
            </a>
          )}
        </div>
        {gitlabMessage && <p className="muted small" style={{ marginBottom: 0 }}>{gitlabMessage}</p>}
        {m.gitlab && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Last upload: {new Date(m.gitlab.uploadedAt).toLocaleString()} · {m.gitlab.target}
          </p>
        )}
        <div className="btn-row">
          <button className="btn" onClick={() => void exportTranscript(m.id, 'txt')}>
            TXT
          </button>
          <button className="btn" onClick={() => void exportTranscript(m.id, 'md')}>
            Markdown
          </button>
          <button className="btn" onClick={() => void exportTranscript(m.id, 'json')}>
            JSON
          </button>
          <button
            className="btn"
            onClick={() => exportAudio(m).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
          >
            Audio file
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (!window.confirm('Delete this meeting and all its local data?')) return;
              deleteMeetingEverywhere(m.id).then(() => {
                void refresh();
                go({ name: 'dashboard' });
              }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Delete meeting
          </button>
        </div>
      </div>
    </>
  );
}
