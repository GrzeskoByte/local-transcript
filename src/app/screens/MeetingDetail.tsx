import { useEffect, useRef, useState } from 'react';
import { useApp, formatDuration } from '../store.tsx';
import { CHUNK_MS, modeLabel } from '../../domain/meeting';
import type { TranscriptionStage } from '../../asr/engine';
import {
  nativeAccuracyHint,
  describeNativeRuntime,
  NATIVE_LANGUAGE_OPTIONS,
} from '../../asr/model-manager';
import { searchSegments } from '../../domain/transcript';
import {
  exportAgenda,
  exportAudio,
  exportTranscript,
  revealExport,
  type ExportResult,
} from '../../features/meetings/exports';
import { actionItemsOf } from '../../integrations/gitlab';
import { AgendaEditor, AgendaList } from '../components/Agenda.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda';
import { isDesktopApp, openExternalUrl } from '../../platform/desktop';
import { actionItemEventDraft, extractEventDraft, validateCalendarConfig } from '../../integrations/calendar';
import type { CalendarEventDraft } from '../../integrations/calendar';
import { claudeResumeCommand } from '../../integrations/llm';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';
import { applyPlaybackOutput } from '../../audio/devices';
import { playbackContext } from '../../audio/player';
import { AudioPlayer, type AudioPlayerHandle } from '../components/AudioPlayer.tsx';
import { AudioCheckCard } from '../components/AudioCheck.tsx';

export function MeetingDetail({ id }: { id: string }): React.JSX.Element {
  const {
    detailMeeting, detailSegments, detailTracks, loadDetail, go, deleteMeeting,
    txProgress, txStage, setupAndTranscribe, modelDownload, firstRunModel, cancelTranscription, modelMeta,
    selectModel, language, setLanguage, nativeStatus, installedModels,
    uploadToGitlab, uploadSummaryToGitlab, summarizeMeeting, createCalendarEvent,
    saveAgenda, uploadAgendaToGitlab, gitlabConfig, createGitlabActionIssues, calendarConfig,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [gitlabBusy, setGitlabBusy] = useState(false);
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null);
  const [llmBusy, setLlmBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [calDraft, setCalDraft] = useState<CalendarEventDraft | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMessage, setCalMessage] = useState<string | null>(null);
  /** Action items picked for calendar events (their text); null = default selection. */
  const [calPick, setCalPick] = useState<string[] | null>(null);
  /** One editable draft per picked action item, before approval. */
  const [calDrafts, setCalDrafts] = useState<{ item: string; draft: CalendarEventDraft }[] | null>(null);
  /** Agenda being edited (null = viewing). */
  const [agendaDraft, setAgendaDraft] = useState<AgendaItem[] | null>(null);
  const [agendaBusy, setAgendaBusy] = useState(false);
  /** Action items picked for GitLab issues (their text); null = default selection. */
  const [issuePick, setIssuePick] = useState<string[] | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueMessage, setIssueMessage] = useState<string | null>(null);
  /** Files the last export wrote (desktop: in Downloads). */
  const [exported, setExported] = useState<string[]>([]);
  const [exportBusy, setExportBusy] = useState(false);
  const runExport = (work: () => Promise<ExportResult | ExportResult[]>): void => {
    setError(null);
    setExported([]);
    setExportBusy(true);
    work()
      .then((result) => {
        const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => !!p);
        setExported(paths);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExportBusy(false));
  };
  /** One player per track; transcript timestamps seek the matching one. */
  const players = useRef(new Map<string, AudioPlayerHandle>());
  const playSegment = (startMs: number, speaker?: string): void => {
    const track = detailTracks.find((t) => speaker && t.label === speaker) ?? detailTracks[0];
    if (track) players.current.get(track.track)?.playFrom(startMs / 1000);
  };

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
  // GitLab issues from action items: offered once a project + token are set up.
  const gitlabConnected = !!(gitlabConfig.url.trim() && gitlabConfig.project.trim() && gitlabConfig.token.trim());
  const actionItems = actionItemsOf(m);
  const issueFor = (text: string) => m.gitlabActionIssues?.find((i) => i.item === text);
  const pending = actionItems.filter((a) => !issueFor(a.text));
  const picked = (issuePick ?? pending.map((a) => a.text)).filter((t) => pending.some((a) => a.text === t));
  // Calendar events from action items: one per item, never twice.
  const eventFor = (text: string) => m.calendarEvents?.find((e) => e.item === text);
  const calPending = actionItems.filter((a) => !eventFor(a.text));
  const calPicked = (calPick ?? calPending.map((a) => a.text)).filter((t) => calPending.some((a) => a.text === t));
  const calendarReady = validateCalendarConfig(calendarConfig) === null;
  const editCalDraft = (i: number, patch: Partial<CalendarEventDraft>): void =>
    setCalDrafts((ds) => ds && ds.map((d, j) => (j === i ? { ...d, draft: { ...d.draft, ...patch } } : d)));
  const createActionEvents = async (drafts: { item: string; draft: CalendarEventDraft }[]): Promise<void> => {
    setCalBusy(true);
    setCalMessage(null);
    let created = 0;
    try {
      for (const d of drafts) {
        await createCalendarEvent(m.id, d.draft, d.item);
        created += 1;
      }
      setCalDrafts(null);
      setCalPick(null);
      setCalMessage(`Created ${created} calendar event${created === 1 ? '' : 's'}.`);
    } catch (e: unknown) {
      // Keep only the drafts that were not created, so a retry never duplicates.
      setCalDrafts(drafts.slice(created));
      setCalMessage(
        `${created ? `Created ${created} event${created === 1 ? '' : 's'}, then: ` : ''}${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setCalBusy(false);
    }
  };
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

      <div className="page-head detail-head tint-peach">
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

      {/* Web Audio player, not <audio>: in the AppImage every <audio> is a
          GStreamer playbin whose teardown can deadlock the page (see
          src/audio/player.ts). */}
      <section className="card" aria-label="Recording playback">
        {detailTracks.length === 0 ? (
          <p className="muted">Recording audio unavailable.</p>
        ) : (
          <div className="player-stack">
            {detailTracks.map((t) => (
              <div key={`${m.id}:${t.track}`} className="track-player">
                {detailTracks.length > 1 && <span className="track-label">{t.label}</span>}
                <AudioPlayer
                  ref={(h) => {
                    if (h) players.current.set(t.track, h);
                    else players.current.delete(t.track);
                  }}
                  load={t.load}
                  label={detailTracks.length > 1 ? t.label : 'Recording'}
                  durationHintMs={m.durationMs}
                />
              </div>
            ))}
          </div>
        )}
        {detailTracks.length > 0 && (
          <AudioDevicePickers playback onPlaybackChange={() => void applyPlaybackOutput(playbackContext())} />
        )}
      </section>

      {m.diagnostics && <AudioCheckCard diagnostics={m.diagnostics} stopTrace={m.stopTrace} />}

      <section className="card" aria-label="Meeting agenda">
        <div className="model-title">
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
            <p className="muted mt-0">
              Plan the topics for this meeting. The agenda is included in transcript exports and can be
              uploaded to GitLab.
            </p>
            <div className="btn-row mt-0">
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
            <p className="muted mt-2 mb-0">
              Your first transcription downloads the speech model ({firstRunModel}) once — about{' '}
              {firstRunModel.includes('q5') ? '550 MB' : '1.6 GB'}. Other models live in{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings' })}>
                Settings
              </button>
              .
            </p>
          )}
          <p className="muted mb-0">
            Desktop engine: models run natively and language auto-detection is available (whisper.cpp).
          </p>
          {nativeAccuracyHint(modelMeta.modelId) && (
            <p className="muted mb-0">
              {nativeAccuracyHint(modelMeta.modelId)}
            </p>
          )}
          <p className="muted mb-0" aria-label="Acceleration">
            {describeNativeRuntime(nativeStatus)}
          </p>
        </div>
      )}
      <ModelDownloadProgress />
      {m.transcriptionStatus === 'not_started' && !busy && !modelDownload && (
        <div className="card">
          <p className="muted mt-0">
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
          <p className="mt-0">
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

      {m.transcriptionStatus === 'completed' && !busy && m.transcriptSource?.kind === 'live' && (
        <p className="muted" aria-label="Transcript source">
          Live transcript ({m.transcriptSource.model}), made
          while recording. Re-transcribe redoes it from the whole recording with {modelMeta.modelId} for the best
          accuracy.
        </p>
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
          <div className="model-title">
            <strong>Summary</strong>
            <span className="badge">{m.summary.model}</span>
          </div>
          {m.summary.text && <p className="pre-wrap">{m.summary.text}</p>}
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
          {(m.summary.actionItems?.length ?? 0) > 0 && (
            <>
              <strong>Action items</strong>
              {gitlabConnected && actionItems.length > 0 ? (
                <>
                  <ul className="transcript" aria-label="Action items">
                    {actionItems.map((a) => {
                      const issue = issueFor(a.text);
                      return (
                        <li key={a.text}>
                          {issue ? (
                            <>
                              ✓ {a.text} —{' '}
                              <a href={issue.url} target="_blank" rel="noreferrer" onClick={(e) => openGitlabLink(e, issue.url)}>
                                {issue.iid !== undefined ? `Issue #${issue.iid}` : 'Issue'}
                              </a>
                              {issue.assignee ? ` · @${issue.assignee}` : ''}
                            </>
                          ) : (
                            <label className="issue-pick">
                              <input
                                type="checkbox"
                                checked={picked.includes(a.text)}
                                disabled={issueBusy}
                                onChange={(e) =>
                                  setIssuePick(e.target.checked ? [...picked, a.text] : picked.filter((t) => t !== a.text))
                                }
                              />
                              {a.text}
                            </label>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {pending.length > 0 && (
                    <div className="btn-row">
                      <button
                        className="btn"
                        disabled={issueBusy || picked.length === 0}
                        title={`Create one issue per selected action item in ${gitlabConfig.project}`}
                        onClick={() => {
                          setIssueBusy(true);
                          setIssueMessage(null);
                          setError(null);
                          createGitlabActionIssues(m.id, picked)
                            .then((created) => {
                              setIssuePick(null);
                              setIssueMessage(
                                `Created ${created.length} GitLab issue${created.length === 1 ? '' : 's'} in ${gitlabConfig.project}.`,
                              );
                            })
                            .catch((e: unknown) => {
                              const created = (e as { created?: unknown[] }).created?.length ?? 0;
                              setError(
                                `${created ? `Created ${created} issue${created === 1 ? '' : 's'}, then: ` : ''}${
                                  e instanceof Error ? e.message : String(e)
                                }`,
                              );
                            })
                            .finally(() => setIssueBusy(false));
                        }}
                      >
                        {issueBusy
                          ? 'Creating issues…'
                          : `Create GitLab issue${picked.length === 1 ? '' : 's'} (${picked.length})`}
                      </button>
                    </div>
                  )}
                  {issueMessage && (
                    <p className="muted small mb-0" role="status">
                      {issueMessage}
                    </p>
                  )}
                </>
              ) : (
                <ul className="transcript" aria-label="Action items">
                  {m.summary.actionItems!.map((a, i) => (
                    <li key={i}>☐ {a}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {m.summary.sessionId && <ClaudeSessionHint sessionId={m.summary.sessionId} />}
        </section>
      )}

      {m.summary && (
        <section className="card" aria-label="Calendar event">
          <div className="model-title">
            <strong>Calendar event</strong>
          </div>
          <div className="muted">
            Put the summary&apos;s action items on your company calendar, one event each,
            or prepare a custom event. Nothing is sent until you approve the drafts.
          </div>
          {!calendarReady && (
            <p className="muted small mb-0">Set up the calendar server under Settings → Calendar first.</p>
          )}
          {actionItems.length > 0 && !calDrafts && !calDraft && (
              <ul className="transcript" aria-label="Items to schedule">
                {actionItems.map((a) => {
                  const ev = eventFor(a.text);
                  return (
                    <li key={a.text}>
                      {ev ? (
                        <>✓ {a.text} — {ev.startIso.replace('T', ' ')}</>
                      ) : (
                        <label className="issue-pick">
                          <input
                            type="checkbox"
                            checked={calPicked.includes(a.text)}
                            disabled={calBusy}
                            onChange={(e) =>
                              setCalPick(e.target.checked ? [...calPicked, a.text] : calPicked.filter((t) => t !== a.text))
                            }
                          />
                          {a.text}
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
          )}
          {calDrafts ? (
            <>
              {calDrafts.map((d, i) => (
                <fieldset key={d.item} className="event-draft" aria-label={`Event for ${d.item}`}>
                  <legend className="field-label">Event {i + 1} of {calDrafts.length}</legend>
                  <input
                    className="input"
                    aria-label="Event title"
                    value={d.draft.title}
                    onChange={(e) => editCalDraft(i, { title: e.target.value })}
                  />
                  <div className="row-selects">
                    <label>
                      Starts
                      <input
                        className="input"
                        type="datetime-local"
                        aria-label="Event start"
                        value={d.draft.startIso}
                        onChange={(e) => editCalDraft(i, { startIso: e.target.value })}
                      />
                    </label>
                    <label>
                      Ends
                      <input
                        className="input"
                        type="datetime-local"
                        aria-label="Event end"
                        value={d.draft.endIso}
                        onChange={(e) => editCalDraft(i, { endIso: e.target.value })}
                      />
                    </label>
                  </div>
                  <textarea
                    className="input"
                    aria-label="Event description"
                    rows={3}
                    value={d.draft.description}
                    onChange={(e) => editCalDraft(i, { description: e.target.value })}
                  />
                </fieldset>
              ))}
              <div className="btn-row">
                <button
                  className="btn btn-primary"
                  disabled={calBusy || calDrafts.some((d) => !d.draft.title.trim())}
                  onClick={() => void createActionEvents(calDrafts)}
                >
                  {calBusy
                    ? 'Creating…'
                    : `Approve & create ${calDrafts.length} event${calDrafts.length === 1 ? '' : 's'}`}
                </button>
                <button className="btn" disabled={calBusy} onClick={() => setCalDrafts(null)}>
                  Discard
                </button>
              </div>
            </>
          ) : !calDraft ? (
            <div className="btn-row">
              {calPending.length > 0 && (
                <button
                  className="btn"
                  disabled={calPicked.length === 0}
                  onClick={() => {
                    setCalMessage(null);
                    setCalDrafts(
                      calPending
                        .filter((a) => calPicked.includes(a.text))
                        .map((a) => ({ item: a.text, draft: actionItemEventDraft(m, a) })),
                    );
                  }}
                >
                  {`Prepare event${calPicked.length === 1 ? '' : 's'} from action items (${calPicked.length})`}
                </button>
              )}
              <button
                className="btn"
                onClick={() => {
                  setCalMessage(null);
                  setCalDraft(
                    extractEventDraft(
                      m.summary?.text ?? '',
                      m.summary?.keyPoints ?? [],
                      m.title,
                      m.startedAt,
                    ),
                  );
                }}
              >
                Prepare custom event
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
          {calMessage && (
            <p className="muted small mb-0" role="status">
              {calMessage}
            </p>
          )}
          {m.calendarEvents && m.calendarEvents.length > 0 ? (
            <>
              <p className="muted small mb-0">Events created from this meeting</p>
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
              <p className="muted small mb-0">
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
        <section className="mt-2">
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
                <button
                  type="button"
                  className="ts ts-seek"
                  title="Play from here"
                  disabled={detailTracks.length === 0}
                  onClick={() => playSegment(s.startMs, s.speaker)}
                >
                  {String(Math.floor(s.startMs / 60000)).padStart(2, '0')}:
                  {String(Math.floor((s.startMs % 60000) / 1000)).padStart(2, '0')}
                </button>
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
        <div className="btn-row mt-0">
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
              <span className="muted small self-center">
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
        {gitlabMessage && <p className="muted small mb-0">{gitlabMessage}</p>}
        {m.gitlab && (
          <p className="muted small mb-0">
            Last upload: {new Date(m.gitlab.uploadedAt).toLocaleString()} · {m.gitlab.target}
          </p>
        )}
        {m.gitlabAgenda && (
          <p className="muted small mb-0">
            Last agenda upload: {new Date(m.gitlabAgenda.uploadedAt).toLocaleString()} · {m.gitlabAgenda.target}
          </p>
        )}
        {m.gitlabSummary && (
          <p className="muted small mb-0">
            Last summary upload: {new Date(m.gitlabSummary.uploadedAt).toLocaleString()} · {m.gitlabSummary.target}
          </p>
        )}
        <div className="btn-row">
          <button className="btn" disabled={exportBusy} onClick={() => runExport(() => exportTranscript(m.id, 'txt'))}>
            TXT
          </button>
          <button className="btn" disabled={exportBusy} onClick={() => runExport(() => exportTranscript(m.id, 'md'))}>
            Markdown
          </button>
          <button className="btn" disabled={exportBusy} onClick={() => runExport(() => exportTranscript(m.id, 'json'))}>
            JSON
          </button>
          {m.agenda?.items.length ? (
            <button className="btn" disabled={exportBusy} onClick={() => runExport(() => exportAgenda(m))}>
              Agenda
            </button>
          ) : null}
          <button className="btn" disabled={exportBusy} onClick={() => runExport(() => exportAudio(m))}>
            {exportBusy ? 'Exporting…' : 'Audio file'}
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
        {exported.length > 0 && (
          <p className="muted small mb-0" role="status" aria-label="Export saved">
            Saved to {exported.join(', ')}{' '}
            <button type="button" className="link-btn" onClick={() => void revealExport(exported[0]!).catch(() => undefined)}>
              Show in folder
            </button>
          </p>
        )}
      </div>
    </>
  );
}

/** Summary made by the Claude Code provider: how to continue its session. */
function ClaudeSessionHint({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const command = claudeResumeCommand(sessionId);
  return (
    <p className="muted small mb-0">
      Ask follow-up questions in Claude Code:{' '}
      <code className="select-all">{command}</code>{' '}
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
