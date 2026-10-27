import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, formatDuration, type MeetingTab } from '../store.tsx';
import { CHUNK_MS, modeLabel } from '../../domain/meeting';
import type { TranscriptionStage } from '../../asr/engine';
import { describeNativeRuntime, nativeAccuracyHint, NATIVE_LANGUAGE_OPTIONS } from '../../asr/model-manager';
import { searchSegments, segmentsToText } from '../../domain/transcript';
import { speakerName, speakersOf } from '../../domain/speakers';
import { actionItemsOf } from '../../domain/action-items';
import { issueStateKey, pendingTargets, wrapLeftover } from '../../domain/wrapup';
import { exportAgenda, exportAudio, exportTranscript, revealExport, type ExportResult } from '../../features/meetings/exports';
import { AgendaEditor, AgendaList } from '../components/Agenda.tsx';
import { newAgendaItem, type AgendaItem } from '../../domain/agenda';
import { ModelDownloadProgress } from '../components/ModelDownload.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { AudioDevicePickers } from '../components/AudioDevices.tsx';
import { applyPlaybackOutput } from '../../audio/devices';
import { playbackContext } from '../../audio/player';
import { AudioPlayer, type AudioPlayerHandle, type PlayerMarker } from '../components/AudioPlayer.tsx';
import { AudioCheckCard } from '../components/AudioCheck.tsx';
import { CopyButton } from '../components/CopyButton.tsx';
import { SourcePill, StatusPill } from '../components/MeetingRow.tsx';
import { TranscriptList, setPlayhead } from '../components/meeting/Transcript.tsx';
import { SummaryStep, gitlabReady, openLink } from '../components/wrap/SummaryStep.tsx';
import { Popover } from '../components/Popover.tsx';
import { ParticipantsCard } from '../components/meeting/Participants.tsx';
import { IssuesStep } from '../components/wrap/IssuesStep.tsx';
import { EventsStep } from '../components/wrap/EventsStep.tsx';
import { ExportStep } from '../components/wrap/ExportStep.tsx';
import { getPref, setPref } from '../../platform/prefs';
import { diarizeStatus } from '../../platform/system';
import { isTypingTarget, matches } from '../shortcuts';
import { useShortcuts } from '../App.tsx';
import { enabledWrapSteps, usePrefsVersion, wrapPrefs } from '../preferences';
import { validateCalendarConfig } from '../../integrations/calendar';
import { remoteAsrActive, remoteAsrLabel } from '../../integrations/remote-asr';

const FOLLOW_PREF = 'transcript-follow';

/**
 * A meeting (DESIGN.md "Meeting — read, play, act" + "Revisit — same steps
 * as tabs"): header with Rename / Export / Share to GitLab, the player with
 * agenda chapters and moments, then the wrap-up steps as tabs.
 */
export function MeetingScreen({ id, query, tab: routeTab }: { id: string; query?: string; tab?: MeetingTab }): React.JSX.Element {
  const app = useApp();
  const {
    detailMeeting, detailSegments, detailTracks, loadDetail, go, renameMeeting, returnTo, txProgress, uploadToGitlab, gitlabConfig,
    calendarConfig, setWrapUp, issueStates, refreshIssueStates,
  } = app;
  usePrefsVersion();
  const keys = useShortcuts();
  const [error, setError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [exported, setExported] = useState<string[]>([]);
  const [sharing, setSharing] = useState(false);
  const [follow, setFollow] = useState(() => getPref(FOLLOW_PREF) !== 'false');
  const [tab, setTabState] = useState<MeetingTab | null>(routeTab ?? null);
  const players = useRef(new Map<string, AudioPlayerHandle>());
  const fail = useCallback((e: unknown) => setError(e instanceof Error ? e.message : String(e)), []);

  useEffect(() => {
    setTitleDraft(null);
    setExported([]);
    setTabState(routeTab ?? null);
    void loadDetail(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (routeTab) setTabState(routeTab);
  }, [routeTab]);

  // Issue states for the GitLab tab / Summary tags (once per open, when connected).
  useEffect(() => {
    if (detailMeeting?.id === id && gitlabReady(gitlabConfig) && (detailMeeting.gitlabActionIssues?.length ?? 0) > 0 && !issueStates[id]) {
      void refreshIssueStates(id).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailMeeting?.id, gitlabConfig]);

  const playSegment = useCallback(
    (startMs: number, speaker?: string): void => {
      const track = detailTracks.find((t) => speaker && t.label === speaker) ?? detailTracks[0];
      if (track) players.current.get(track.track)?.playFrom(startMs / 1000);
    },
    [detailTracks],
  );

  // Space / ← / → drive the player (rebindable); Ctrl+F searches the transcript.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!isTypingTarget(e.target)) {
        const player = players.current.values().next().value as AudioPlayerHandle | undefined;
        const onControl = !!(e.target as HTMLElement | null)?.closest?.('button, a, summary, [role="button"]');
        if (player && matches(e, keys.play) && !onControl) {
          e.preventDefault();
          player.toggle();
          return;
        }
        if (player && (matches(e, keys.back) || matches(e, keys.forward)) && !(e.target as HTMLElement | null)?.closest?.('button, [role="tab"]')) {
          e.preventDefault();
          player.skip(matches(e, keys.back) ? -15 : 15);
          return;
        }
      }
      if (matches(e, keys.search)) {
        e.preventDefault();
        setTabState('transcript');
        requestAnimationFrame(() => {
          const input = document.querySelector<HTMLInputElement>('input[aria-label="Search transcript"]');
          input?.focus();
          input?.select();
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);

  const m = detailMeeting && detailMeeting.id === id ? detailMeeting : null;
  const markers = useMemo<PlayerMarker[]>(() => {
    if (!m) return [];
    const chapters = (m.agenda?.items ?? [])
      .map((i, n) => ({ i, n }))
      .filter(({ i }) => i.startedMs !== undefined)
      .map(({ i, n }) => ({ atMs: i.startedMs!, label: `${n + 1} ${i.title.split(' ').slice(0, 2).join(' ')}`, kind: 'chapter' as const }));
    const moments = (m.moments ?? []).map((x) => ({ atMs: x.atMs, label: x.label, kind: 'moment' as const }));
    return [...chapters, ...moments];
  }, [m]);

  if (!m) return <p className="muted">Loading…</p>;
  const prefs = wrapPrefs();
  const enabled = enabledWrapSteps(prefs);
  const leftover = prefs.banner ? wrapLeftover(m, enabled, prefs.pretick) : null;
  const speakers = speakersOf(detailSegments);
  const items = actionItemsOf(m);
  const pending = pendingTargets(m, prefs.pretick);
  const glReady = gitlabReady(gitlabConfig);
  const calReady = validateCalendarConfig(calendarConfig) === null;
  const issues = m.gitlabActionIssues ?? [];
  const openIssues = issues.filter((i) => i.iid !== undefined && issueStates[m.id]?.states[issueStateKey(i, gitlabConfig.project)] !== 'closed').length;
  const progress = txProgress[m.id];
  const defaultTab: MeetingTab = m.summary ? 'summary' : 'transcript';
  const current = tab ?? defaultTab;
  const setTab = (t: MeetingTab): void => {
    setTabState(t);
    go({ name: 'detail', id: m.id, tab: t });
  };
  const savedFiles = Object.keys(m.exports ?? {}).length;

  const tabs: Array<{ id: MeetingTab; name: string; status: string; todo?: boolean }> = [
    {
      id: 'transcript',
      name: 'Transcript',
      status:
        m.transcriptionStatus === 'completed'
          ? `${detailSegments.length} line${detailSegments.length === 1 ? '' : 's'}`
          : progress !== undefined
            ? `${Math.round(progress * 100)}%`
            : m.transcriptionStatus === 'failed'
              ? '[!] failed'
              : '[ ] not yet',
      todo: m.transcriptionStatus !== 'completed',
    },
    {
      id: 'summary',
      name: 'Summary',
      status: m.summary ? (m.summary.reviewedAt ? '[x] reviewed' : `${items.length} action${items.length === 1 ? '' : 's'}`) : '[ ] to write',
      todo: !m.summary,
    },
    {
      id: 'gitlab',
      name: 'GitLab',
      status: !glReady
        ? 'not set up'
        : issues.length
          ? `[x] ${issues.length} issue${issues.length === 1 ? '' : 's'}${issueStates[m.id] ? ` · ${openIssues} open` : ''}`
          : pending.gitlab.length
            ? `[ ] ${pending.gitlab.length} to create`
            : '—',
      todo: glReady && pending.gitlab.length > 0,
    },
    {
      id: 'calendar',
      name: 'Calendar',
      status: !calReady
        ? 'not set up'
        : (m.calendarEvents?.length ?? 0) > 0 && pending.calendar.length === 0
          ? `[x] ${m.calendarEvents!.length} event${m.calendarEvents!.length === 1 ? '' : 's'}`
          : pending.calendar.length
            ? `[ ] ${pending.calendar.length} ${m.wrapUp?.steps.calendar === 'skipped' ? 'skipped' : 'to add'}`
            : m.wrapUp?.dismissed
              ? 'not needed'
              : '—',
      todo: calReady && pending.calendar.length > 0 && !m.wrapUp?.dismissed,
    },
    { id: 'export', name: 'Export', status: savedFiles ? `[x] ${savedFiles} file${savedFiles === 1 ? '' : 's'}` : 'files & wiki' },
  ];

  const runExport = (work: () => Promise<ExportResult | ExportResult[]>): void => {
    setError(null);
    setExported([]);
    work()
      .then((r) => setExported((Array.isArray(r) ? r : [r]).filter((p): p is string => !!p)))
      .catch(fail);
  };

  return (
    <>
      <header className="page-head detail-head">
        <div className="detail-main">
          <button className="backlink" onClick={() => go(returnTo === 'month' ? { name: 'library', view: 'month' } : { name: returnTo })}>
            ← {returnTo === 'home' ? 'Home' : 'Library'}
          </button>
          {titleDraft === null ? (
            <h1>{m.title}</h1>
          ) : (
            <form
              className="title-row"
              onSubmit={(e) => {
                e.preventDefault();
                renameMeeting(m.id, titleDraft)
                  .then(() => setTitleDraft(null))
                  .catch(fail);
              }}
            >
              <input
                className="input title-input"
                aria-label="Meeting title"
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setTitleDraft(null)}
              />
              <button type="submit" className="btn btn-primary btn-sm">
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setTitleDraft(null)}>
                Cancel
              </button>
            </form>
          )}
          <div className="detail-meta">
            <span>
              {new Date(m.createdAt).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} ·{' '}
              {m.durationEstimated ? '≈ ' : ''}
              {formatDuration(m.durationMs)}
              {speakers.length > 1 ? ` · ${speakers.length} speakers` : ''}
              {m.durationEstimated ? ' · recovered after an interruption' : ''}
            </span>
            <SourcePill mode={m.mode} />
            <StatusPill m={m} progress={progress} />
            {m.transcriptSource && <span className="pill">{m.transcriptSource.model}{m.transcriptSource.kind === 'live' ? ' · live' : ''}</span>}
          </div>
        </div>
        <div className="detail-actions">
          {titleDraft === null && (
            <button type="button" className="btn" onClick={() => setTitleDraft(m.title)}>
              Rename
            </button>
          )}
          <Popover trigger="Export ▾" label="Export">
            {(close) => (
              <>
                {(['txt', 'md', 'json'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="menuitem"
                    className="btn btn-sm"
                    onClick={() => {
                      close();
                      runExport(() => exportTranscript(m.id, f));
                    }}
                  >
                    {f === 'md' ? 'Markdown' : f.toUpperCase()}
                  </button>
                ))}
                {m.agenda?.items.length ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="btn btn-sm"
                    onClick={() => {
                      close();
                      runExport(() => exportAgenda(m));
                    }}
                  >
                    Agenda file
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="btn btn-sm"
                  disabled={!!m.audioRemovedAt}
                  onClick={() => {
                    close();
                    runExport(() => exportAudio(m));
                  }}
                >
                  Audio file
                </button>
              </>
            )}
          </Popover>
          <button
            type="button"
            className="btn btn-primary"
            disabled={sharing || (glReady && m.transcriptionStatus !== 'completed')}
            title={glReady ? `Upload the transcript to ${gitlabConfig.project}` : 'Set up GitLab sharing'}
            onClick={() => {
              if (!glReady) return go({ name: 'settings', tab: 'integrations' });
              setSharing(true);
              uploadToGitlab(m.id)
                .then(() => setTab('gitlab'))
                .catch(fail)
                .finally(() => setSharing(false));
            }}
          >
            {sharing ? 'Sharing…' : 'Share to GitLab'}
          </button>
        </div>
      </header>

      {exported.length > 0 && (
        <p className="muted small" role="status" aria-label="Export saved">
          Saved to {exported.join(', ')}{' '}
          <button type="button" className="link-btn" onClick={() => void revealExport(exported[0]!).catch(() => undefined)}>
            Show in folder
          </button>
        </p>
      )}
      {(m.unsavedChunks ?? 0) > 0 && (
        <section className="banner" role="alert" aria-label="Recording has gaps">
          <strong>Part of this recording could not be saved.</strong>
          <p className="muted mb-0">
            Up to {formatDuration(Math.min((m.unsavedChunks ?? 0) * CHUNK_MS, m.durationMs))} of audio failed to write to disk
            and is missing. Everything else was stored normally.
          </p>
        </section>
      )}

      <section className="card player-card" aria-label="Recording playback">
        {m.audioRemovedAt ? (
          <p className="muted mb-0">
            The audio was removed on {new Date(m.audioRemovedAt).toLocaleDateString()} to save space (Settings → Storage &amp;
            privacy). The transcript stays.
          </p>
        ) : detailTracks.length === 0 ? (
          <p className="muted mb-0">Recording audio unavailable.</p>
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
                  markers={markers}
                  extra={
                    <label className="check-row follow-toggle" title="Highlight and scroll to the line being played">
                      <input
                        type="checkbox"
                        checked={follow}
                        onChange={(e) => {
                          setFollow(e.target.checked);
                          setPref(FOLLOW_PREF, e.target.checked ? 'true' : 'false');
                        }}
                      />
                      Follow
                    </label>
                  }
                />
              </div>
            ))}
          </div>
        )}
        {detailTracks.length > 0 && !m.audioRemovedAt && (
          <AudioDevicePickers playback onPlaybackChange={() => void applyPlaybackOutput(playbackContext())} />
        )}
      </section>

      {leftover && (
        <div className="leftover" role="status" aria-label="Wrap-up not finished">
          <span>
            <span className="mark">[ ]</span> Wrap-up not finished: {leftover}.
          </span>
          <span className="row">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setTab(pending.calendar.length ? 'calendar' : pending.gitlab.length ? 'gitlab' : !m.summary ? 'summary' : 'export')}
            >
              Add them now
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void setWrapUp(m.id, (w) => ({ ...w, dismissed: true }))}>
              Not needed
            </button>
          </span>
        </div>
      )}

      <div className="tabs meeting-tabs" role="tablist" aria-label="Meeting">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={current === t.id}
            aria-controls={`panel-${t.id}`}
            className={`tab${current === t.id ? ' active' : ''}${t.todo ? ' todo' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="tab-name">{t.name}</span>
            <span className="tab-status">{t.status}</span>
          </button>
        ))}
      </div>

      <div className="tab-panel" role="tabpanel" id={`panel-${current}`} aria-labelledby={`tab-${current}`}>
        {current === 'transcript' && (
          <TranscriptTab
            initialQuery={query}
            playSegment={playSegment}
            follow={follow}
            onError={fail}
          />
        )}
        {current === 'summary' && (
          <>
            <section className="card" aria-label="Meeting summary">
              <div className="card-title">
                <strong>Summary</strong>
              </div>
              <SummaryStep m={m} onError={(e) => setError(e)} />
            </section>
            <ParticipantsCard m={m} />
            <AgendaCard />
          </>
        )}
        {current === 'gitlab' && <GitlabTab onError={(e) => setError(e)} />}
        {current === 'calendar' && (
          <section className="card" aria-label="Calendar event">
            <div className="card-title">
              <strong>Calendar{calReady ? ` · ${calendarConfig.provider === 'caldav' ? 'company CalDAV' : calendarConfig.provider}` : ''}</strong>
            </div>
            {!m.summary && calReady ? (
              <p className="muted mb-0">Write the summary first — its action items become events.</p>
            ) : (
              <EventsStep m={m} onError={(e) => setError(e)} onCreated={() => void setWrapUp(m.id, (w) => ({ ...w, steps: { ...w.steps, calendar: 'done' } }))} />
            )}
          </section>
        )}
        {current === 'calendar' && calReady && (
          <ParticipantsCard m={m} />
        )}
        {current === 'export' && (
          <>
            <section className="card" aria-label="Export">
              <div className="card-title">
                <strong>
                  Export
                  {Object.values(m.exports ?? {}).length
                    ? ` · last saved ${new Date(Math.max(...Object.values(m.exports ?? {}).map((x) => x?.at ?? 0))).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                    : ''}
                </strong>
              </div>
              <ExportStep m={m} onError={(e) => setError(e)} onSaved={() => void setWrapUp(m.id, (w) => ({ ...w, steps: { ...w.steps, export: 'done' } }))} />
            </section>
            <DangerZone onError={fail} />
          </>
        )}
      </div>

      {error && (
        <div className="error-toast" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn-sm" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

function TranscriptTab({
  initialQuery,
  playSegment,
  follow,
  onError,
}: {
  initialQuery?: string;
  playSegment: (ms: number, speaker?: string) => void;
  follow: boolean;
  onError: (e: unknown) => void;
}): React.JSX.Element | null {
  const {
    detailMeeting: m, detailSegments, detailTracks, txProgress, txStage, setupAndTranscribe, modelDownload, cancelTranscription,
    installedModels, modelMeta, selectModel, language, setLanguage, nativeStatus, firstRunModel, go, editSegment, remoteAsrConfig,
    renameSpeaker, detectSpeakers, diarizing,
  } = useApp();
  const [filter, setFilter] = useState(initialQuery ?? '');
  const [speaker, setSpeaker] = useState<string | null>(null);
  const [showTxSettings, setShowTxSettings] = useState(false);
  const [diarizeAvailable, setDiarizeAvailable] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [speakerCount, setSpeakerCount] = useState(0);
  useEffect(() => setFilter(initialQuery ?? ''), [initialQuery]);
  useEffect(() => {
    void diarizeStatus().then((s) => setDiarizeAvailable(s.available));
  }, []);
  if (!m) return null;

  // Transcribe goes to the user's server instead of the local model.
  const remote = remoteAsrActive(remoteAsrConfig) ? remoteAsrLabel(remoteAsrConfig) : null;
  const progress = txProgress[m.id];
  const stage: TranscriptionStage = (txStage[m.id] as TranscriptionStage) ?? 'transcribing';
  const busy = m.transcriptionStatus === 'processing' || (m.transcriptionStatus === 'not_started' && txStage[m.id] !== undefined);
  const stageLabel: Record<TranscriptionStage, string> = {
    queued: 'Waiting for the current transcription to finish…',
    'loading-model': remote ? 'Connecting to the transcription server…' : 'Loading local model…',
    'decoding-audio': 'Decoding audio…',
    transcribing: 'Transcribing…',
    saving: 'Saving transcript…',
  };
  const speakers = speakersOf(detailSegments);
  const bySpeaker = speaker ? detailSegments.filter((s) => s.speaker === speaker) : detailSegments;
  const filtered = filter.trim() ? searchSegments(bySpeaker, filter).map((h) => h.segment) : bySpeaker;
  const run = (): void => void setupAndTranscribe(m.id).catch(onError);
  const diarizeProgress = diarizing[m.id];
  const canDiarize = diarizeAvailable && detailTracks.length === 1 && m.transcriptionStatus === 'completed' && !m.audioRemovedAt;

  return (
    <>
      {!busy && (m.transcriptionStatus !== 'completed' || showTxSettings) && (
        <section className="card" aria-label="Transcription settings">
          <div className="row-selects mt-0">
            <label>
              Speech model
              {remote ? (
                <select className="input" aria-label="Speech model for this transcription" disabled>
                  <option>{remote}</option>
                </select>
              ) : installedModels.length > 0 ? (
                <select className="input" aria-label="Speech model for this transcription" value={modelMeta.modelId} onChange={(e) => void selectModel(e.target.value)}>
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
              <select className="input" aria-label="Spoken language" value={language} onChange={(e) => void setLanguage(e.target.value)}>
                {NATIVE_LANGUAGE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {remote && (
            <p className="muted mt-2 mb-0">
              The recording&apos;s speech is sent to your transcription server. Change it in{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings', tab: 'models' })}>
                Settings
              </button>
              .
            </p>
          )}
          {!remote && installedModels.length === 0 && nativeStatus?.available && (
            <p className="muted mt-2 mb-0">
              Your first transcription downloads the speech model ({firstRunModel}) once — about{' '}
              {firstRunModel.includes('q5') ? '550 MB' : '1.6 GB'}. Other models live in{' '}
              <button className="link-btn" onClick={() => go({ name: 'settings', tab: 'models' })}>
                Settings
              </button>
              .
            </p>
          )}
          {!remote && nativeAccuracyHint(modelMeta.modelId) && <p className="muted mb-0">{nativeAccuracyHint(modelMeta.modelId)}</p>}
          {!remote && (
            <p className="muted mb-0" aria-label="Acceleration">
              {describeNativeRuntime(nativeStatus)}
            </p>
          )}
        </section>
      )}
      <ModelDownloadProgress />
      {m.transcriptionStatus === 'not_started' && !busy && !modelDownload && (
        <section className="card">
          <p className="muted mt-0">
            {m.audioRemovedAt ? 'The audio was removed, so this meeting cannot be transcribed.' : remote
                ? `Not transcribed yet. Transcription runs on your server: ${remote}.`
                : 'Not transcribed yet. Transcription runs fully on this device.'}
          </p>
          {!m.audioRemovedAt && (
            <button className="btn btn-primary" onClick={run}>
              {installedModels.length > 0 || remote ? 'Transcribe' : 'Download model & transcribe'}
            </button>
          )}
        </section>
      )}
      {busy && (
        <div className="loader" role="status" aria-live="polite" aria-label="Transcription in progress">
          <div className="loader-head">
            <span className="spinner" aria-hidden="true" />
            <strong>{stageLabel[stage]}</strong>
            {progress !== undefined && <span className="muted">{Math.round(progress * 100)}%</span>}
          </div>
          {progress !== undefined ? <progress value={progress} max={1} /> : <progress />}
          <div className="btn-row">
            <button className="btn" onClick={() => void cancelTranscription(m.id)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {m.transcriptionStatus === 'failed' && !busy && (
        <section className="card">
          <p className="mt-0">
            <strong>Transcription failed.</strong>
          </p>
          {m.transcriptionError && (
            <p className="muted small" aria-label="Failure reason">
              Reason: {m.transcriptionError}
            </p>
          )}
          <p className="muted">Your original recording is still safe.</p>
          <button className="btn btn-primary" onClick={run}>
            Retry
          </button>
        </section>
      )}

      {detailSegments.length > 0 && (
        <section className="card transcript-card" aria-label="Transcript text">
          <div className="card-title">
            <strong>Transcript</strong>
            <span className="muted">
              {detailSegments.length} {detailSegments.length === 1 ? 'line' : 'lines'} · click a line to fix it
            </span>
            <span className="collapse-actions">
              <CopyButton
                label="Copy transcript"
                text={() =>
                  segmentsToText(detailSegments.map((s) => (s.speaker ? { ...s, speaker: speakerName(s.speaker, m.speakerNames) } : s)))
                }
              />
            </span>
          </div>
          {m.transcriptSource?.kind === 'live' && (
            <p className="muted small" aria-label="Transcript source">
              Live transcript ({m.transcriptSource.model}), made while recording. Re-transcribe redoes it from the whole recording
              with {modelMeta.modelId} for the best accuracy.
            </p>
          )}
          <div className="transcript-search">
            <input className="input" aria-label="Search transcript" placeholder="Search this meeting…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            {speakers.length > 0 && (
              <div className="tabs speaker-tabs" role="group" aria-label="Speakers">
                <button type="button" className={`tab${speaker === null ? ' active' : ''}`} aria-pressed={speaker === null} onClick={() => setSpeaker(null)}>
                  All
                </button>
                {speakers.map((sp) => (
                  <button
                    key={sp}
                    type="button"
                    className={`tab${speaker === sp ? ' active' : ''}`}
                    aria-pressed={speaker === sp}
                    onClick={() => setSpeaker(sp)}
                    onDoubleClick={() => sp.startsWith('speaker_') && setRenaming({ id: sp, name: speakerName(sp, m.speakerNames) })}
                    title={sp.startsWith('speaker_') ? 'Double-click to name this speaker' : undefined}
                  >
                    {speakerName(sp, m.speakerNames)}
                  </button>
                ))}
              </div>
            )}
            {filter.trim() && (
              <span className="muted small" role="status">
                {filtered.length} of {detailSegments.length} lines
              </span>
            )}
          </div>
          {renaming && (
            <form
              className="row wrap speaker-rename"
              onSubmit={(e) => {
                e.preventDefault();
                void renameSpeaker(m.id, renaming.id, renaming.name).then(() => setRenaming(null));
              }}
            >
              <label className="small" htmlFor="speaker-name">
                Name for {speakerName(renaming.id, undefined)}
              </label>
              <input id="speaker-name" className="input" autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
              <button type="submit" className="btn btn-sm btn-primary">
                Save
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setRenaming(null)}>
                Cancel
              </button>
            </form>
          )}
          {speakers.some((s) => s.startsWith('speaker_')) && !renaming && (
            <p className="muted small mt-2 mb-0">
              Name the speakers:{' '}
              {speakers
                .filter((s) => s.startsWith('speaker_'))
                .map((sp) => (
                  <button key={sp} type="button" className="link-btn speaker-name-btn" onClick={() => setRenaming({ id: sp, name: speakerName(sp, m.speakerNames) })}>
                    {speakerName(sp, m.speakerNames)}
                  </button>
                ))}
            </p>
          )}
          <TranscriptList
            segments={filtered}
            query={filter}
            canSeek={detailTracks.length > 0 && !m.audioRemovedAt}
            onSeek={playSegment}
            follow={follow}
            agenda={filter.trim() || speaker ? [] : m.agenda?.items ?? []}
            moments={filter.trim() || speaker ? [] : m.moments ?? []}
            speakerNames={m.speakerNames}
            onEdit={(segId, text) => void editSegment(segId, text).catch(onError)}
          />
          {filtered.length === 0 && <p className="muted">No matches in this transcript.</p>}
        </section>
      )}

      {m.transcriptionStatus === 'completed' && !busy && (
        <div className="btn-row">
          <ConfirmButton
            prompt="Re-transcribe? The summary stays, but it was made from the current transcript."
            confirmLabel="Yes, re-transcribe"
            skipConfirm={!m.summary}
            onConfirm={run}
          >
            Re-transcribe
          </ConfirmButton>
          <button type="button" className="link-btn" aria-expanded={showTxSettings} onClick={() => setShowTxSettings((v) => !v)}>
            {showTxSettings ? 'Hide model & language' : 'Model & language…'}
          </button>
          {canDiarize && (
            <span className="row">
              <button
                type="button"
                className="btn"
                disabled={diarizeProgress !== undefined}
                onClick={() => void detectSpeakers(m.id, speakerCount).catch(onError)}
              >
                {diarizeProgress !== undefined
                  ? `Finding speakers… ${Math.round(diarizeProgress * 100)}%`
                  : m.diarization
                    ? 'Detect speakers again'
                    : 'Detect speakers'}
              </button>
              <select className="input input-sm" aria-label="How many speakers" value={speakerCount} onChange={(e) => setSpeakerCount(Number(e.target.value))}>
                <option value={0}>Count: auto</option>
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} speakers
                  </option>
                ))}
              </select>
            </span>
          )}
        </div>
      )}
      {m.diarization?.error && <p className="warn">Speaker detection failed: {m.diarization.error}</p>}
      {m.diagnostics && <AudioCheckCard diagnostics={m.diagnostics} stopTrace={m.stopTrace} />}
    </>
  );
}

function AgendaCard(): React.JSX.Element | null {
  const { detailMeeting: m, saveAgenda } = useApp();
  const [draft, setDraft] = useState<AgendaItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  return (
    <section className="card" aria-label="Meeting agenda">
      <div className="card-title">
        <strong>Agenda{m.agenda?.items.length ? ` · ${m.agenda.items.length} topics` : ''}</strong>
      </div>
      {draft ? (
        <>
          <AgendaEditor items={draft} onChange={setDraft} />
          <div className="btn-row">
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                saveAgenda(m.id, draft)
                  .then(() => setDraft(null))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? 'Saving…' : 'Save agenda'}
            </button>
            <button className="btn" disabled={busy} onClick={() => setDraft(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : m.agenda?.items.length ? (
        <>
          <AgendaList items={m.agenda.items} />
          <div className="btn-row">
            <button className="btn" onClick={() => setDraft(m.agenda?.items ?? [])}>
              Edit agenda
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted mt-0">Plan the topics. The agenda goes into exports and can be uploaded to GitLab.</p>
          <button className="btn" onClick={() => setDraft([newAgendaItem()])}>
            Add agenda
          </button>
        </>
      )}
    </section>
  );
}

function GitlabTab({ onError }: { onError: (e: string) => void }): React.JSX.Element | null {
  const { detailMeeting: m, gitlabConfig, uploadToGitlab, uploadSummaryToGitlab, uploadAgendaToGitlab, postSummaryToWiki, go, setWrapUp } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (!m) return null;
  const ready = gitlabReady(gitlabConfig);
  const run = (what: string, work: () => Promise<{ target: string }>, done: string): void => {
    setBusy(what);
    setMessage(null);
    work()
      .then((r) => setMessage(`${done} (${r.target}).`))
      .catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <section className="card" aria-label="GitLab">
      <div className="card-title">
        <strong>GitLab{ready ? ` · ${gitlabConfig.project}` : ''}</strong>
      </div>
      {!ready ? (
        <p className="muted mb-0">
          Share transcripts, summaries and action items with your team.{' '}
          <button type="button" className="link-btn" onClick={() => go({ name: 'settings', tab: 'integrations' })}>
            Set up GitLab sharing
          </button>
        </p>
      ) : (
        <>
          {!m.summary ? (
            <p className="muted mt-0">Write the summary first — its action items become issues.</p>
          ) : (
            <IssuesStep m={m} onError={onError} onCreated={() => void setWrapUp(m.id, (w) => ({ ...w, steps: { ...w.steps, gitlab: 'done' } }))} />
          )}
          <h4 className="sub-head">Publish</h4>
          <div className="btn-row mt-0">
            <button className="btn" disabled={!!busy || m.transcriptionStatus !== 'completed'} onClick={() => run('transcript', () => uploadToGitlab(m.id), 'Published to GitLab')}>
              {busy === 'transcript' ? 'Uploading…' : 'Upload transcript'}
            </button>
            <button className="btn" disabled={!!busy || !m.summary} onClick={() => run('wiki', () => postSummaryToWiki(m.id), 'Summary posted to the wiki')}>
              {busy === 'wiki' ? 'Posting…' : 'Post summary to wiki'}
            </button>
            {gitlabConfig.target === 'file' && (
              <button className="btn" disabled={!!busy || !m.summary} onClick={() => run('summary', () => uploadSummaryToGitlab(m.id), 'Summary published')}>
                {busy === 'summary' ? 'Uploading…' : 'Upload summary'}
              </button>
            )}
            <button className="btn" disabled={!!busy || !m.agenda?.items.length} onClick={() => run('agenda', () => uploadAgendaToGitlab(m.id), 'Agenda published to GitLab')}>
              {busy === 'agenda' ? 'Uploading…' : 'Upload agenda'}
            </button>
          </div>
          {message && (
            <p className="muted small mb-0" role="status">
              {message}
            </p>
          )}
          <div className="row wrap mt-3">
            {m.gitlab?.url && (
              <a className="btn btn-sm" href={m.gitlab.url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, m.gitlab?.url ?? '')}>
                Open in GitLab
              </a>
            )}
            {m.gitlabSummary?.url && (
              <a className="btn btn-sm" href={m.gitlabSummary.url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, m.gitlabSummary?.url ?? '')}>
                Open summary in GitLab
              </a>
            )}
            {m.gitlabAgenda?.url && (
              <a className="btn btn-sm" href={m.gitlabAgenda.url} target="_blank" rel="noreferrer" onClick={(e) => openLink(e, m.gitlabAgenda?.url ?? '')}>
                Open agenda in GitLab
              </a>
            )}
          </div>
          {m.gitlab && (
            <p className="muted small mb-0">
              Last upload: {new Date(m.gitlab.uploadedAt).toLocaleString()} · {m.gitlab.target}
            </p>
          )}
        </>
      )}
    </section>
  );
}

function DangerZone({ onError }: { onError: (e: unknown) => void }): React.JSX.Element | null {
  const { detailMeeting: m, deleteMeeting, go } = useApp();
  if (!m) return null;
  return (
    <section className="card danger-zone" aria-label="Delete meeting">
      <div className="model-title">
        <strong>Delete</strong>
      </div>
      <p className="muted mt-0">
        Removes the recording ({modeLabel(m.mode).toLowerCase()}), transcript and summary from this device. Issues and events
        already created stay where they are. This cannot be undone.
      </p>
      <div className="btn-row">
        <ConfirmButton
          className="btn btn-danger"
          prompt="Delete this meeting and all its local data?"
          confirmLabel="Yes, delete"
          onConfirm={() => {
            deleteMeeting(m.id)
              .then(() => go({ name: 'library' }))
              .catch(onError);
          }}
        >
          Delete meeting
        </ConfirmButton>
      </div>
    </section>
  );
}
