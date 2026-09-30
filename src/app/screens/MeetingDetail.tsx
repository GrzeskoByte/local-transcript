import { useEffect, useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import { CHUNK_MS, modeLabel } from '../../domain/meeting';
import type { TranscriptionStage } from '../../asr/engine';
import {
  nativeAccuracyHint,
  describeNativeRuntime,
  NATIVE_LANGUAGE_OPTIONS,
} from '../../asr/model-manager';
import { searchSegments } from '../../domain/transcript';
import { exportAgenda, exportAudio, exportTranscript } from '../../features/meetings/exports';
import { AgendaEditor, AgendaList } from '../components/Agenda.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda';
import { isDesktopApp, openExternalUrl } from '../../platform/desktop';
import { extractEventDraft } from '../../integrations/calendar';
import type { CalendarEventDraft } from '../../integrations/calendar';
import { claudeResumeCommand } from '../../integrations/llm';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';

export function MeetingDetail({ id }: { id: string }): React.JSX.Element {
  const {
    detailMeeting, detailSegments, detailTracks, loadDetail, go, deleteMeeting,
    txProgress, txStage, setupAndTranscribe, modelDownload, firstRunModel, cancelTranscription, modelMeta,
    selectModel, language, setLanguage, nativeStatus, installedModels,
    uploadToGitlab, uploadSummaryToGitlab, summarizeMeeting, createCalendarEvent,
    saveAgenda, uploadAgendaToGitlab,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [gitlabBusy, setGitlabBusy] = useState(false);
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [calDraft, setCalDraft] = useState<CalendarEventDraft | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMessage, setCalMessage] = useState<string | null>(null);
  /** Agenda being edited (null = viewing). */
  const [agendaDraft, setAgendaDraft] = useState<AgendaItem[] | null>(null);
  const [agendaBusy, setAgendaBusy] = useState(false);

  /** Desktop webview swallows target="_blank": open GitLab links externally. */
  const openGitlabLink = (e: React.MouseEvent, url: string): void => {
    if (!isDesktopApp()) return;
    e.preventDefault();
    openExternalUrl(url).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  };

  useEffect(() => {
    setAgendaDraft(null);
    void loadDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
    queued: 'Waiting for the current transcription to finish…',
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
          {m.durationEstimated ? '≈ ' : ''}{formatDuration(m.durationMs)} · Recorded {new Date(m.createdAt).toLocaleString()}
          {m.durationEstimated ? ' · recovered after an interruption' : ''}
        </p>
        <div className="pill-row">
          <span className={`pill pill-${m.mode}`}>{modeLabel(m.mode)}</span>
          <span className={`pill pill-${m.transcriptionStatus === 'not_started' ? 'processing' : m.transcriptionStatus}`}>
            {m.transcriptionStatus === 'not_started' ? 'not transcribed' : m.transcriptionStatus}
          </span>
        </div>
      </div>

      {(m.unsavedChunks ?? 0) > 0 && (
        <section className="banner mt-3" role="alert" aria-label="Recording has gaps">
          <strong>Part of this recording could not be saved.</strong>
          <p className="muted mb-0">
            Up to {formatDuration(Math.min((m.unsavedChunks ?? 0) * CHUNK_MS, m.durationMs))} of audio failed
            to write to disk and is missing. Everything else was stored normally.
          </p>
        </section>
      )}

      {/* preload="none": WebKitGTK builds a GStreamer pipeline per preloaded
          player and, on the AppImage's GStreamer 1.20, tearing a prerolled
          WAV/FLAC pipeline down later can deadlock the page. Only build one
          when the user presses play. */}
      <section className="card" aria-label="Recording playback">
        {detailTracks.length === 0 ? (
          <p className="muted">Recording audio unavailable.</p>
        ) : detailTracks.length === 1 ? (
          <audio className="player" controls preload="none" src={detailTracks[0]!.url} />
        ) : (
          <div className="player-stack">
            {detailTracks.map((t) => (
              <label key={t.track || 'recording'} className="track-player">
                <span className="track-label">{t.label}</span>
                <audio className="player" controls preload="none" src={t.url} />
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="card" aria-label="Meeting agenda">
        <div className="model-title" style={{ marginBottom: 4 }}>
          <strong>Agenda</strong>
          {m.agenda && <span className="badge">{m.agenda.items.length} topics</span>}
        </div>
        {agendaDraft ? (
          <>
            <AgendaEditor items={agendaDraft} onChange={setAgendaDraft} />
            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={agendaBusy}
                onClick={() => {
                  setAgendaBusy(true);
                  setError(null);
                  saveAgenda(m.id, agendaDraft)
                    .then(() => setAgendaDraft(null))
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                    .finally(() => setAgendaBusy(false));
                }}
              >
                {agendaBusy ? 'Saving…' : 'Save agenda'}
              </button>
              <button className="btn" disabled={agendaBusy} onClick={() => setAgendaDraft(null)}>
                Cancel
              </button>
            </div>
          </>
        ) : m.agenda?.items.length ? (
          <>
            <AgendaList items={m.agenda.items} />
            <div className="btn-row">
              <button className="btn" onClick={() => setAgendaDraft(m.agenda?.items ?? [])}>
                Edit agenda
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              Plan the topics for this meeting. The agenda is included in transcript exports and can be
              uploaded to GitLab.
            </p>
            <div className="btn-row" style={{ marginTop: 0 }}>
              <button className="btn" onClick={() => setAgendaDraft([newAgendaItem()])}>
                Create agenda
              </button>
            </div>
          </>
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
          {installedModels.length === 0 && nativeStatus?.available && (
            <p className="muted" style={{ margin: '10px 0 0' }}>
              Your first transcription downloads the speech model ({firstRunModel}) once — about{' '}
              {firstRunModel.includes('q5') ? '550 MB' : '1.6 GB'}. Other models live in{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings' })}>
                Settings
              </button>
              .
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
      <ModelDownloadProgress />
      {m.transcriptionStatus === 'not_started' && !busy && !modelDownload && (
        <div className="card">
          <p className="muted" style={{ marginTop: 0 }}>
            Not transcribed yet. Transcription runs fully on this device.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => {
              setError(null);
              setupAndTranscribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {installedModels.length > 0 ? 'Transcribe' : 'Download model & transcribe'}
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
              setupAndTranscribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
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
              setupAndTranscribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Re-transcribe
          </button>
          <button
            className="btn"
            disabled={llmBusy}
            title="Summarize with your configured LLM provider (Settings → LLM provider)"
            onClick={() => {
              setLlmBusy(true);
              setError(null);
              summarizeMeeting(m.id)
                .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                .finally(() => setLlmBusy(false));
            }}
          >
            {llmBusy ? 'Summarizing…' : m.summary ? 'Re-summarize' : 'Summarize with LLM'}
          </button>
        </div>
      )}

      {m.summary && (
        <section className="card" aria-label="Meeting summary">
          <div className="model-title" style={{ marginBottom: 4 }}>
            <strong>Summary</strong>
            <span className="badge">{m.summary.model}</span>
          </div>
          <p className="muted" style={{ whiteSpace: 'pre-wrap' }}>{m.summary.text}</p>
          {m.summary.keyPoints.length > 0 && (
            <>
              <strong>Key points</strong>
              <ul className="transcript">
                {m.summary.keyPoints.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </>
          )}
          {m.summary.sessionId && <ClaudeSessionHint sessionId={m.summary.sessionId} />}
        </section>
      )}

      {m.summary && (
        <section className="card" aria-label="Calendar event">
          <div className="model-title" style={{ marginBottom: 4 }}>
            <strong>Calendar event</strong>
          </div>
          <div className="muted">
            Create follow-up events on your company calendar from this summary.
            Nothing is sent until you approve the draft. Configure the server
            under Settings → Calendar.
          </div>
          {!calDraft ? (
            <div className="btn-row">
              <button
                className="btn"
                onClick={() =>
                  setCalDraft(
                    extractEventDraft(
                      m.summary?.text ?? '',
                      m.summary?.keyPoints ?? [],
                      m.title,
                      m.startedAt,
                    ),
                  )
                }
              >
                {m.calendarEvents?.length ? 'Prepare another event' : 'Prepare event from summary'}
              </button>
            </div>
          ) : (
            <>
              <label className="field-label" htmlFor="cal-title">Title</label>
              <input
                id="cal-title"
                className="input"
                value={calDraft.title}
                onChange={(e) => setCalDraft({ ...calDraft, title: e.target.value })}
              />
              <div className="row-selects">
                <label>
                  Starts
                  <input
                    className="input"
                    type="datetime-local"
                    aria-label="Event start"
                    value={calDraft.startIso}
                    onChange={(e) => setCalDraft({ ...calDraft, startIso: e.target.value })}
                  />
                </label>
                <label>
                  Ends
                  <input
                    className="input"
                    type="datetime-local"
                    aria-label="Event end"
                    value={calDraft.endIso}
                    onChange={(e) => setCalDraft({ ...calDraft, endIso: e.target.value })}
                  />
                </label>
              </div>
              <label className="field-label" htmlFor="cal-description">Description</label>
              <textarea
                id="cal-description"
                className="input"
                rows={5}
                value={calDraft.description}
                onChange={(e) => setCalDraft({ ...calDraft, description: e.target.value })}
              />
              <label className="field-label" htmlFor="cal-location">Location (optional)</label>
              <input
                id="cal-location"
                className="input"
                value={calDraft.location}
                onChange={(e) => setCalDraft({ ...calDraft, location: e.target.value })}
                placeholder="Room, link…"
              />
              {calMessage && <p className="muted small" style={{ marginBottom: 0 }}>{calMessage}</p>}
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  disabled={calBusy || !calDraft.title.trim()}
                  onClick={() => {
                    setCalBusy(true);
                    setCalMessage(null);
                    createCalendarEvent(m.id, calDraft)
                      .then(() => {
                        setCalMessage('Event created on the company calendar.');
                        setCalDraft(null);
                      })
                      .catch((e: unknown) =>
                        setCalMessage(e instanceof Error ? e.message : String(e)),
                      )
                      .finally(() => setCalBusy(false));
                  }}
                >
                  {calBusy ? 'Creating…' : 'Approve & create on server'}
                </button>
                <button className="btn" disabled={calBusy} onClick={() => setCalDraft(null)}>
                  Discard
                </button>
              </div>
            </>
          )}
          {m.calendarEvents && m.calendarEvents.length > 0 ? (
            <>
              <p className="muted small" style={{ marginBottom: 0 }}>Events created from this meeting</p>
              <ul className="model-list" aria-label="Created calendar events">
                {m.calendarEvents.map((ev) => (
                  <li key={ev.uid} className="model-row">
                    <div className="model-main">
                      <span className="model-name">{ev.title}</span>
                      <span className="muted small">
                        {ev.startIso.replace('T', ' ')} · {ev.provider} · created {new Date(ev.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            m.calendarEvent && (
              <p className="muted small" style={{ marginBottom: 0 }}>
                Last event created: {new Date(m.calendarEvent.createdAt).toLocaleString()} · {m.calendarEvent.provider}
              </p>
            )
          )}
        </section>
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
          <button
            className="btn"
            disabled={gitlabBusy || !m.summary}
            title={
              m.summary
                ? 'Publish the summary + key points into the meeting folder on GitLab'
                : 'Summarize the meeting first — GitLab receives summary.md'
            }
            onClick={() => {
              setGitlabBusy(true);
              setGitlabMessage(null);
              uploadSummaryToGitlab(m.id)
                .then((r) => setGitlabMessage(`Summary published to GitLab (${r.target}).`))
                .catch((e: unknown) => {
                  const msg = e instanceof Error ? e.message : String(e);
                  setGitlabMessage(null);
                  setError(msg);
                })
                .finally(() => setGitlabBusy(false));
            }}
          >
            {gitlabBusy ? 'Uploading…' : 'Upload summary'}
          </button>
          <button
            className="btn"
            disabled={gitlabBusy || !m.agenda?.items.length}
            title={
              m.agenda?.items.length
                ? 'Publish the agenda to GitLab (agenda.md, wiki page or issue)'
                : 'Create an agenda first'
            }
            onClick={() => {
              setGitlabBusy(true);
              setGitlabMessage(null);
              uploadAgendaToGitlab(m.id)
                .then((r) => setGitlabMessage(`Agenda published to GitLab (${r.target}).`))
                .catch((e: unknown) => {
                  setGitlabMessage(null);
                  setError(e instanceof Error ? e.message : String(e));
                })
                .finally(() => setGitlabBusy(false));
            }}
          >
            {gitlabBusy ? 'Uploading…' : 'Upload agenda'}
          </button>
          {m.gitlab?.url ? (
            <a
              className="btn"
              href={m.gitlab.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => openGitlabLink(e, m.gitlab?.url ?? '')}
            >
              Open in GitLab
            </a>
          ) : (
            m.gitlab && (
              <span className="muted small" style={{ alignSelf: 'center' }}>
                Re-upload to get a working link.
              </span>
            )
          )}
          {m.gitlabSummary?.url && (
            <a
              className="btn"
              href={m.gitlabSummary.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => openGitlabLink(e, m.gitlabSummary?.url ?? '')}
            >
              Open summary in GitLab
            </a>
          )}
          {m.gitlabAgenda?.url && (
            <a
              className="btn"
              href={m.gitlabAgenda.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => openGitlabLink(e, m.gitlabAgenda?.url ?? '')}
            >
              Open agenda in GitLab
            </a>
          )}
        </div>
        {gitlabMessage && <p className="muted small" style={{ marginBottom: 0 }}>{gitlabMessage}</p>}
        {m.gitlab && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Last upload: {new Date(m.gitlab.uploadedAt).toLocaleString()} · {m.gitlab.target}
          </p>
        )}
        {m.gitlabAgenda && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Last agenda upload: {new Date(m.gitlabAgenda.uploadedAt).toLocaleString()} · {m.gitlabAgenda.target}
          </p>
        )}
        {m.gitlabSummary && (
          <p className="muted small" style={{ marginBottom: 0 }}>
            Last summary upload: {new Date(m.gitlabSummary.uploadedAt).toLocaleString()} · {m.gitlabSummary.target}
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
          {m.agenda?.items.length ? (
            <button
              className="btn"
              onClick={() => {
                try {
                  exportAgenda(m);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Agenda
            </button>
          ) : null}
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
              deleteMeeting(m.id).then(() => {
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

/** Summary made by the Claude Code provider: how to continue its session. */
function ClaudeSessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const command = claudeResumeCommand(sessionId);
  return (
    <p className="muted small" style={{ marginBottom: 0 }}>
      Ask follow-up questions in Claude Code:{' '}
      <code style={{ userSelect: 'all' }}>{command}</code>{' '}
      <button
        type="button"
        className="link-btn"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(command)
            .then(() => setCopied(true))
            .catch(() => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  );
}
