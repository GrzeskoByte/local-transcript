import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getPref, setPref } from '../../platform/prefs';
import { useApp, formatDuration } from '../store.tsx';
import { CHUNK_MS, modeLabel } from '../../domain/meeting';
import type { TranscriptionStage } from '../../asr/engine';
import {
  nativeAccuracyHint,
  describeNativeRuntime,
  NATIVE_LANGUAGE_OPTIONS,
} from '../../asr/model-manager';
import { activeSegmentIndex, searchSegments, segmentsToText, type TranscriptSegment } from '../../domain/transcript';
import {
  exportAgenda,
  exportAudio,
  exportTranscript,
  revealExport,
  type ExportResult,
} from '../../features/meetings/exports';
import { actionItemsOf, summaryMarkdown } from '../../integrations/gitlab';
import { AgendaEditor, AgendaList } from '../components/Agenda.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda';
import { isDesktopApp, openExternalUrl } from '../../platform/desktop';
import { actionItemEventDraft, extractEventDraft, validateCalendarConfig } from '../../integrations/calendar';
import type { CalendarEventDraft } from '../../integrations/calendar';
import { claudeResumeCommand, llmConfigProblem } from '../../integrations/llm';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';
import { applyPlaybackOutput } from '../../audio/devices';
import { formatClock, playbackContext } from '../../audio/player';
import { AudioPlayer, type AudioPlayerHandle } from '../components/AudioPlayer.tsx';
import { AudioCheckCard } from '../components/AudioCheck.tsx';
import { Section, setSectionsOpen, useCollapsedSections } from '../components/Section.tsx';
import { CopyButton } from '../components/CopyButton.tsx';

export function MeetingDetail({ id, query }: { id: string; query?: string }): React.JSX.Element {
  const {
    detailMeeting, detailSegments, detailTracks, loadDetail, go, deleteMeeting, renameMeeting,
    txProgress, txStage, setupAndTranscribe, modelDownload, firstRunModel, cancelTranscription, modelMeta,
    selectModel, language, setLanguage, nativeStatus, installedModels,
    uploadToGitlab, uploadSummaryToGitlab, summarizeMeeting, createCalendarEvent,
    saveAgenda, uploadAgendaToGitlab, gitlabConfig, createGitlabActionIssues, calendarConfig, summarizing, llmConfig, returnTo,
  } = useApp();
  const [error, setError] = useState<string | null>(null);
  const collapsedSections = useCollapsedSections();
  /** Completed meetings hide the model/language pickers until asked. */
  const [showTxSettings, setShowTxSettings] = useState(false);
  /** Title being edited (null = not renaming). */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  /** Transcript follows the player (highlight + scroll). */
  const [follow, setFollow] = useState(() => getPref(FOLLOW_PREF) !== 'false');
  /** Which GitLab upload is running (one at a time). */
  const [gitlabBusy, setGitlabBusy] = useState<'transcript' | 'summary' | 'agenda' | null>(null);
  const [gitlabMessage, setGitlabMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [calDraft, setCalDraft] = useState<CalendarEventDraft | null>(null);
  const [calBusy, setCalBusy] = useState(false);
  const [calMessage, setCalMessage] = useState<string | null>(null);
  /** Action items picked for calendar events (their text); null = default selection. */
  /** One editable draft per picked action item, before approval. */
  const [calDrafts, setCalDrafts] = useState<{ item: string; draft: CalendarEventDraft }[] | null>(null);
  /** Agenda being edited (null = viewing). */
  const [agendaDraft, setAgendaDraft] = useState<AgendaItem[] | null>(null);
  const [agendaBusy, setAgendaBusy] = useState(false);
  /** Action items picked for GitLab issues (their text); null = default selection. */
  const [itemPick, setItemPick] = useState<string[] | null>(null);
  const [issueBusy, setIssueBusy] = useState(false);
  const [issueMessage, setIssueMessage] = useState<string | null>(null);
  /** Files the last export wrote (desktop: in Downloads). */
  const [exported, setExported] = useState<string[]>([]);
  /** Which export is running (its button says Exporting…). */
  const [exportBusy, setExportBusy] = useState<string | null>(null);
  const runExport = (what: string, work: () => Promise<ExportResult | ExportResult[]>): void => {
    setError(null);
    setExported([]);
    setExportBusy(what);
    work()
      .then((result) => {
        const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => !!p);
        setExported(paths);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setExportBusy(null));
  };
  /** One player per track; transcript timestamps seek the matching one. */
  const players = useRef(new Map<string, AudioPlayerHandle>());
  const playSegment = useCallback(
    (startMs: number, speaker?: string): void => {
      const track = detailTracks.find((t) => speaker && t.label === speaker) ?? detailTracks[0];
      if (track) players.current.get(track.track)?.playFrom(startMs / 1000);
    },
    [detailTracks],
  );

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
    setFilter(query ?? '');
    setShowTxSettings(false);
    setTitleDraft(null);
    void loadDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, query]);

  // Ctrl/Cmd+F jumps to the transcript search instead of the webview's find bar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Space / ← / → drive the player, unless the user is typing or on a control.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target)) {
        const player = players.current.values().next().value as AudioPlayerHandle | undefined;
        if (player && (e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          if (e.key === ' ' && (e.target as HTMLElement | null)?.closest?.('button, a, summary')) return;
          e.preventDefault();
          if (e.key === ' ') player.toggle();
          else player.skip(e.key === 'ArrowLeft' ? -15 : 15);
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'f') return;
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search transcript"]');
      if (!input) return;
      e.preventDefault();
      setSectionsOpen(['transcript'], true);
      input.focus();
      input.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!detailMeeting) return <p className="muted">Loading…</p>;
  const m = detailMeeting;
  // GitLab issues from action items: offered once a project + token are set up.
  const gitlabConnected = !!(gitlabConfig.url.trim() && gitlabConfig.project.trim() && gitlabConfig.token.trim());
  const actionItems = actionItemsOf(m);
  const issueFor = (text: string) => m.gitlabActionIssues?.find((i) => i.item === text);
  const pending = actionItems.filter((a) => !issueFor(a.text));
  // Calendar events from action items: one per item, never twice.
  const eventFor = (text: string) => m.calendarEvents?.find((e) => e.item === text);
  const calPending = actionItems.filter((a) => !eventFor(a.text));
  const calendarReady = validateCalendarConfig(calendarConfig) === null;
  const llmBusy = !!summarizing[m.id];
  const llmProblem = llmConfigProblem(llmConfig);
  // A summary older than the transcript describes an earlier version of it.
  const summaryStale = !!(m.summary && m.transcriptSource && m.summary.createdAt < m.transcriptSource.createdAt);
  // One action-item list for both targets: a row is open while it still
  // lacks an issue (GitLab set up) or an event (calendar set up).
  const openFor = (text: string): boolean =>
    (gitlabConnected && !issueFor(text)) || (calendarReady && !eventFor(text));
  const openItems = actionItems.filter((a) => openFor(a.text));
  const selected = (itemPick ?? openItems.map((a) => a.text)).filter((t) => openItems.some((a) => a.text === t));
  const issueTargets = pending.filter((a) => selected.includes(a.text));
  const eventTargets = calPending.filter((a) => selected.includes(a.text));
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
      setItemPick(null);
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
      <button className="backlink" onClick={() => go({ name: returnTo })}>
        {returnTo === 'calendar' ? '← Calendar' : '← All meetings'}
      </button>

      <div className="page-head detail-head tint-peach">
        {titleDraft === null ? (
          <h1>{m.title}</h1>
        ) : (
          <form
            className="title-row"
            onSubmit={(e) => {
              e.preventDefault();
              renameMeeting(m.id, titleDraft)
                .then(() => setTitleDraft(null))
                .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
            }}
          >
            <input
              className="input title-input"
              aria-label="Meeting title"
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setTitleDraft(null);
              }}
            />
            <button type="submit" className="btn btn-primary btn-sm">Save</button>
            <button type="button" className="btn btn-sm" onClick={() => setTitleDraft(null)}>Cancel</button>
          </form>
        )}
        <p className="muted">
          {m.durationEstimated ? '≈ ' : ''}{formatDuration(m.durationMs)} · Recorded {new Date(m.createdAt).toLocaleString()}
          {m.durationEstimated ? ' · recovered after an interruption' : ''}
          {titleDraft === null && (
            <>
              {' · '}
              <button type="button" className="link-btn" onClick={() => setTitleDraft(m.title)}>
                Rename
              </button>
            </>
          )}
        </p>
        <div className="pill-row">
          <span className={`pill pill-${m.mode}`}>{modeLabel(m.mode)}</span>
          <span className={`pill pill-${m.transcriptionStatus === 'not_started' ? 'idle' : m.transcriptionStatus}`}>
            {m.transcriptionStatus === 'not_started' ? 'not transcribed' : m.transcriptionStatus}
          </span>
        </div>
      </div>

      <SectionNav
        sections={[
          { id: 'playback', label: 'Recording' },
          ...(m.agenda?.items.length || agendaDraft ? [{ id: 'agenda', label: 'Agenda' }] : []),
          ...(m.summary ? [{ id: 'summary', label: 'Summary' }] : []),
          ...(m.summary ? [{ id: 'calendar', label: 'Calendar' }] : []),
          ...(detailSegments.length > 0 ? [{ id: 'transcript', label: 'Transcript' }] : []),
          ...(m.diagnostics ? [{ id: 'audio-check', label: 'Audio check' }] : []),
          { id: 'manage', label: 'Export & share' },
        ]}
        collapsed={collapsedSections}
      />

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
      <Section id="playback" title="Recording" label="Recording playback">
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
                  onTime={setPlayhead}
                />
              </div>
            ))}
          </div>
        )}
        {detailTracks.length > 0 && (
          <AudioDevicePickers playback onPlaybackChange={() => void applyPlaybackOutput(playbackContext())} />
        )}
      </Section>

      <h2>Transcript</h2>
      {!busy && (m.transcriptionStatus !== 'completed' || showTxSettings) && (
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
          {m.transcriptionError && (
            <p className="muted small" aria-label="Failure reason">
              Reason: {m.transcriptionError}
            </p>
          )}
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
              if (
                m.summary &&
                !window.confirm('Re-transcribe this meeting? The summary stays, but it was made from the current transcript.')
              )
                return;
              setError(null);
              setupAndTranscribe(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            Re-transcribe
          </button>
          <button
            type="button"
            className="link-btn"
            aria-expanded={showTxSettings}
            onClick={() => setShowTxSettings((v) => !v)}
          >
            {showTxSettings ? 'Hide model & language' : 'Model & language…'}
          </button>
          <button
            className="btn"
            disabled={llmBusy || !!llmProblem}
            title={
              llmProblem
                ? `Set up the AI assistant first (${llmProblem})`
                : 'Summarize with your configured AI assistant (Settings → AI assistant)'
            }
            onClick={() => {
              setError(null);
              summarizeMeeting(m.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
            }}
          >
            {llmBusy ? 'Summarizing…' : m.summary ? 'Re-summarize' : 'Summarize with LLM'}
          </button>
          {llmProblem && (
            <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'ai' })}>
              Set up the AI assistant
            </button>
          )}
        </div>
      )}

      {m.summary && (
        <Section
          id="summary"
          title="Summary"
          label="Meeting summary"
          badge={<span className="badge">{m.summary.model}</span>}
          peek={m.summary.text}
          actions={<CopyButton label="Copy summary" text={() => summaryMarkdown(m)} />}
        >
          {summaryStale && (
            <p className="muted small" role="note">
              Made from an earlier transcript — Re-summarize to match the current one.
            </p>
          )}
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
              {(gitlabConnected || calendarReady) && actionItems.length > 0 ? (
                <>
                  <ul className="transcript" aria-label="Action items">
                    {actionItems.map((a) => {
                      const issue = issueFor(a.text);
                      const ev = eventFor(a.text);
                      const done = (
                        <>
                          {issue && (
                            <>
                              {' '}
                              <a
                                className="item-tag"
                                href={issue.url}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => openGitlabLink(e, issue.url)}
                              >
                                {issue.iid !== undefined ? `Issue #${issue.iid}` : 'Issue'}
                              </a>
                              {issue.assignee ? ` @${issue.assignee}` : ''}
                            </>
                          )}
                          {ev && <span className="item-tag">Event {ev.startIso.replace('T', ' ')}</span>}
                        </>
                      );
                      return (
                        <li key={a.text}>
                          {openFor(a.text) ? (
                            <label className="issue-pick">
                              <input
                                type="checkbox"
                                checked={selected.includes(a.text)}
                                disabled={issueBusy || calBusy}
                                onChange={(e) =>
                                  setItemPick(e.target.checked ? [...selected, a.text] : selected.filter((t) => t !== a.text))
                                }
                              />
                              <span>
                                {a.text}
                                {done}
                              </span>
                            </label>
                          ) : (
                            <>
                              ✓ {a.text}
                              {done}
                            </>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {openItems.length > 0 && (
                    <div className="btn-row">
                      {gitlabConnected && pending.length > 0 && (
                        <button
                          className="btn"
                          disabled={issueBusy || issueTargets.length === 0}
                          title={`Create one issue per selected action item in ${gitlabConfig.project}`}
                          onClick={() => {
                            setIssueBusy(true);
                            setIssueMessage(null);
                            setError(null);
                            createGitlabActionIssues(m.id, issueTargets.map((a) => a.text))
                              .then((created) => {
                                setItemPick(null);
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
                            : `Create GitLab issue${issueTargets.length === 1 ? '' : 's'} (${issueTargets.length})`}
                        </button>
                      )}
                      {calendarReady && calPending.length > 0 && (
                        <button
                          className="btn"
                          disabled={calBusy || eventTargets.length === 0 || !!calDrafts}
                          title="One editable calendar event per selected action item; nothing is sent until you approve"
                          onClick={() => {
                            setCalMessage(null);
                            setCalDraft(null);
                            setCalDrafts(eventTargets.map((a) => ({ item: a.text, draft: actionItemEventDraft(m, a) })));
                            setSectionsOpen(['calendar'], true);
                            requestAnimationFrame(() =>
                              document.getElementById('sec-calendar')?.scrollIntoView({ block: 'start' }),
                            );
                          }}
                        >
                          {`Prepare calendar event${eventTargets.length === 1 ? '' : 's'} (${eventTargets.length})`}
                        </button>
                      )}
                    </div>
                  )}
                  {issueMessage && (
                    <p className="muted small mb-0" role="status">
                      {issueMessage}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <ul className="transcript" aria-label="Action items">
                    {m.summary.actionItems!.map((a, i) => (
                      <li key={i}>☐ {a}</li>
                    ))}
                  </ul>
                  <p className="muted small mb-0">
                    Turn action items into{' '}
                    <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'sharing' })}>
                      GitLab issues
                    </button>{' '}
                    or{' '}
                    <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'calendar' })}>
                      calendar events
                    </button>
                    .
                  </p>
                </>
              )}
            </>
          )}
          {m.summary.sessionId && <ClaudeSessionHint sessionId={m.summary.sessionId} />}
        </Section>
      )}

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {detailSegments.length > 0 && (
        <Section
          id="transcript"
          title="Transcript"
          label="Transcript text"
          badge={<span className="badge">{detailSegments.length} {detailSegments.length === 1 ? 'line' : 'lines'}</span>}
          peek={detailSegments[0]?.text}
          actions={
            <>
              <label className="check-row follow-toggle" title="Highlight and scroll to the line being played">
                <input
                  type="checkbox"
                  checked={follow}
                  onChange={(e) => {
                    setFollow(e.target.checked);
                    setPref(FOLLOW_PREF, e.target.checked ? 'true' : 'false');
                  }}
                />
                Follow playback
              </label>
              <CopyButton label="Copy transcript" text={() => segmentsToText(detailSegments)} />
            </>
          }
        >
          <div className="transcript-search">
            <input
              className="input"
              aria-label="Search transcript"
              placeholder="Search transcript…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter.trim() && (
              <span className="muted small" role="status">
                {filtered.length} of {detailSegments.length} lines
              </span>
            )}
          </div>
          <TranscriptList
            segments={filtered}
            query={filter}
            canSeek={detailTracks.length > 0}
            onSeek={playSegment}
            follow={follow}
          />
          {filtered.length === 0 && <p className="muted">No matches in this transcript.</p>}
        </Section>
      )}

      {m.summary && (
        <Section
          id="calendar"
          title="Calendar event"
          badge={m.calendarEvents?.length ? <span className="badge">{m.calendarEvents.length} created</span> : undefined}
        >
          <div className="muted">
            Pick action items in the summary and press <strong>Prepare calendar events</strong>, or prepare a
            custom event. Nothing is sent until you approve the drafts.
          </div>
          {!calendarReady && (
            <p className="muted small mb-0">
              No company calendar is set up yet.{' '}
              <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'calendar' })}>
                Set up the calendar
              </button>
            </p>
          )}
          {calendarReady && (
          <>
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
        </Section>
      )}

      {(agendaDraft || m.agenda?.items.length) ? (
      <Section
        id="agenda"
        title="Agenda"
        label="Meeting agenda"
        badge={m.agenda?.items.length ? <span className="badge">{m.agenda.items.length} topics</span> : undefined}
      >
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
      </Section>
      ) : null}

      {m.diagnostics && <AudioCheckCard diagnostics={m.diagnostics} stopTrace={m.stopTrace} />}

      <Section id="manage" title="Export & share" label="Manage meeting">
        <p className="field-label">Export</p>
        <div className="btn-row mt-0">
          <button className="btn" disabled={!!exportBusy} onClick={() => runExport('txt', () => exportTranscript(m.id, 'txt'))}>
            {exportBusy === 'txt' ? 'Exporting…' : 'TXT'}
          </button>
          <button className="btn" disabled={!!exportBusy} onClick={() => runExport('md', () => exportTranscript(m.id, 'md'))}>
            {exportBusy === 'md' ? 'Exporting…' : 'Markdown'}
          </button>
          <button className="btn" disabled={!!exportBusy} onClick={() => runExport('json', () => exportTranscript(m.id, 'json'))}>
            {exportBusy === 'json' ? 'Exporting…' : 'JSON'}
          </button>
          {m.agenda?.items.length ? (
            <button className="btn" disabled={!!exportBusy} onClick={() => runExport('agenda', () => exportAgenda(m))}>
              {exportBusy === 'agenda' ? 'Exporting…' : 'Agenda file'}
            </button>
          ) : null}
          <button className="btn" disabled={!!exportBusy} onClick={() => runExport('audio', () => exportAudio(m))}>
            {exportBusy === 'audio' ? 'Exporting…' : 'Audio file'}
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
        <p className="field-label">GitLab</p>
        {gitlabConnected ? (
          <>
        <div className="btn-row">
            <button
              className="btn"
              disabled={!!gitlabBusy || m.transcriptionStatus !== 'completed'}
              title={
                m.transcriptionStatus !== 'completed'
                  ? 'Transcribe first — GitLab receives the transcript'
                  : 'Publish this transcript to the configured GitLab project'
              }
              onClick={() => {
                setGitlabBusy('transcript');
                setGitlabMessage(null);
                uploadToGitlab(m.id)
                  .then((r) => setGitlabMessage(`Published to GitLab (${r.target}).`))
                  .catch((e: unknown) => {
                    const msg = e instanceof Error ? e.message : String(e);
                    setGitlabMessage(null);
                    setError(msg);
                  })
                  .finally(() => setGitlabBusy(null));
              }}
            >
              {gitlabBusy === 'transcript' ? 'Uploading…' : 'Upload transcript'}
            </button>
            <button
              className="btn"
              disabled={!!gitlabBusy || !m.summary}
              title={
                m.summary
                  ? 'Publish the summary + key points into the meeting folder on GitLab'
                  : 'Summarize the meeting first — GitLab receives summary.md'
              }
              onClick={() => {
                setGitlabBusy('summary');
                setGitlabMessage(null);
                uploadSummaryToGitlab(m.id)
                  .then((r) => setGitlabMessage(`Summary published to GitLab (${r.target}).`))
                  .catch((e: unknown) => {
                    const msg = e instanceof Error ? e.message : String(e);
                    setGitlabMessage(null);
                    setError(msg);
                  })
                  .finally(() => setGitlabBusy(null));
              }}
            >
              {gitlabBusy === 'summary' ? 'Uploading…' : 'Upload summary'}
            </button>
            <button
              className="btn"
              disabled={!!gitlabBusy || !m.agenda?.items.length}
              title={
                m.agenda?.items.length
                  ? 'Publish the agenda to GitLab (agenda.md, wiki page or issue)'
                  : 'Create an agenda first'
              }
              onClick={() => {
                setGitlabBusy('agenda');
                setGitlabMessage(null);
                uploadAgendaToGitlab(m.id)
                  .then((r) => setGitlabMessage(`Agenda published to GitLab (${r.target}).`))
                  .catch((e: unknown) => {
                    setGitlabMessage(null);
                    setError(e instanceof Error ? e.message : String(e));
                  })
                  .finally(() => setGitlabBusy(null));
              }}
            >
              {gitlabBusy === 'agenda' ? 'Uploading…' : 'Upload agenda'}
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
          </>
        ) : (
          <p className="muted mb-0">
            Share transcripts, summaries and action items with your team.{' '}
            <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'sharing' })}>
              Set up GitLab sharing
            </button>
          </p>
        )}
        {!m.agenda?.items.length && !agendaDraft && (
          <>
            <p className="field-label">Agenda</p>
            <div className="btn-row mt-0">
              <button
                className="btn"
                onClick={() => {
                  setAgendaDraft([newAgendaItem()]);
                  setSectionsOpen(['agenda'], true);
                }}
              >
                Add agenda
              </button>
            </div>
          </>
        )}
      </Section>

      <section className="card danger-zone" aria-label="Delete meeting">
        <strong>Delete</strong>
        <p className="muted mt-0">Removes the recording, transcript and summary from this device. This cannot be undone.</p>
        <div className="btn-row">
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
      </section>
    </>
  );
}

/** Sticky "jump to" bar: scrolls to a section (opening it) and folds/unfolds them all. */
function SectionNav({
  sections,
  collapsed,
}: {
  sections: Array<{ id: string; label: string }>;
  collapsed: ReadonlySet<string>;
}): React.JSX.Element {
  const ids = sections.map((s) => s.id);
  const anyOpen = ids.some((id) => !collapsed.has(id));
  return (
    <nav className="section-nav" aria-label="Meeting sections">
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          className="link-btn"
          aria-label={`Jump to ${s.label.toLowerCase()}`}
          onClick={() => {
            setSectionsOpen([s.id], true);
            requestAnimationFrame(() =>
              document.getElementById(`sec-${s.id}`)?.scrollIntoView({ block: 'start' }),
            );
          }}
        >
          {s.label}
        </button>
      ))}
      <span className="section-nav-end">
        <button type="button" className="btn btn-sm" onClick={() => setSectionsOpen(ids, !anyOpen)}>
          {anyOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </span>
    </nav>
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

/** `text` with every case-insensitive match of `query` in <mark>. */
function highlight(text: string, query: string): React.ReactNode {
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

const FOLLOW_PREF = 'transcript-follow';
/** Rows rendered at first; more load as the end comes into view. */
const PAGE = 400;

/** Typing in a field (or on a select) keeps its keys. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Playhead shared by the player and the transcript (outside React state: no page re-render per tick). */
const playhead = { ms: -1, playing: false, listeners: new Set<() => void>() };
function setPlayhead(seconds: number, playing: boolean): void {
  playhead.ms = Math.round(seconds * 1000);
  playhead.playing = playing;
  playhead.listeners.forEach((l) => l());
}
function subscribePlayhead(listener: () => void): () => void {
  playhead.listeners.add(listener);
  return () => playhead.listeners.delete(listener);
}


/**
 * The transcript rows. Memoised (Meeting Detail re-renders on every store
 * tick), rendered in pages of 400 so a very long meeting opens instantly,
 * and following the player: the line being played is highlighted and, with
 * Follow on, scrolled into view.
 */
const TranscriptList = memo(function TranscriptList({
  segments,
  query,
  canSeek,
  onSeek,
  follow,
}: {
  segments: TranscriptSegment[];
  query: string;
  canSeek: boolean;
  onSeek: (startMs: number, speaker?: string) => void;
  follow: boolean;
}): React.JSX.Element {
  const ms = useSyncExternalStore(subscribePlayhead, () => playhead.ms);
  const playing = useSyncExternalStore(subscribePlayhead, () => playhead.playing);
  const active = activeSegmentIndex(segments, ms);
  const [limit, setLimit] = useState(PAGE);
  const shown = Math.min(segments.length, Math.max(limit, active + 50));
  const listRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    const el = moreRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + PAGE);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, segments.length]);

  useEffect(() => {
    if (!follow || !playing || active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`li[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, follow, playing]);

  return (
    <ul className="transcript" ref={listRef}>
      {segments.slice(0, shown).map((s, i) => (
        <li key={s.id} data-index={i} className={i === active ? 'active' : undefined} aria-current={i === active ? 'true' : undefined}>
          <button
            type="button"
            className="ts ts-seek"
            title="Play from here"
            disabled={!canSeek}
            onClick={() => onSeek(s.startMs, s.speaker)}
          >
            {formatClock(s.startMs / 1000)}
          </button>
          {s.speaker && <span className="who">{s.speaker}</span>}
          {highlight(s.text, query)}
        </li>
      ))}
      {shown < segments.length && (
        <li ref={moreRef} className="transcript-more">
          <button type="button" className="link-btn" onClick={() => setLimit(segments.length)}>
            Show all {segments.length} lines
          </button>
        </li>
      )}
    </ul>
  );
});
