import { useEffect, useRef, useState } from 'react';
import type { LiveSnapshot } from '../../asr/live';
import { useApp, ElapsedClock, useElapsedMs } from '../store.tsx';
import { modeLabel, type Moment } from '../../domain/meeting';
import { LiveAudioWarnings } from '../components/AudioCheck.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { LevelBars } from '../components/LevelMeter.tsx';
import { Keys, useShortcuts } from '../App.tsx';
import { formatClock } from '../../audio/player';
import { recordingPrefs } from '../preferences';

/** Opus 48 kbps mono ≈ 6 kB per second of recording. */
const BYTES_PER_SECOND = 6000;

/**
 * The live recording room (DESIGN.md: the ink field). Timer, per-input
 * levels, Pause / Mark moment / Stop & save, the agenda with what is
 * running now, moments, and the live draft transcript when it is on.
 */
export function RecordingRoom(): React.JSX.Element {
  const {
    activeMeeting, recordingState, recordingError, recordingErrorKind, pauseRecording, resumeRecording, retrySaving,
    stopRecording, stopping, recordingIssues, live, addMoment, recordingLevels,
  } = useApp();
  const keys = useShortcuts();
  const [retrying, setRetrying] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [levels, setLevels] = useState<Array<{ role: string; level: number }>>([]);

  // Level bars: polled from the recorder (no store re-render per tick).
  useEffect(() => {
    if (recordingState !== 'RECORDING') {
      setLevels((l) => l.map((x) => ({ ...x, level: 0 })));
      return;
    }
    const t = setInterval(() => setLevels(recordingLevels()), 150);
    return () => clearInterval(t);
  }, [recordingState, recordingLevels]);

  if (!activeMeeting) return <p className="muted">No active recording.</p>;
  const m = activeMeeting;
  const paused = recordingState === 'PAUSED';
  // Storage failed: never claim the audio is safe while chunks are unsaved (§19).
  const failing = recordingState === 'ERROR';
  // A lost source (unplugged mic, stopped screen share) cannot be retried.
  const sourceLost = failing && recordingErrorKind === 'source';
  const prefs = recordingPrefs();
  const inputs = m.mode === 'dual' ? 'mic + system sound' : m.mode === 'device' ? 'system sound' : 'microphone';

  return (
    <div className="room">
      <section className="rec-hero room-main" aria-label="Recording in progress">
        <div className="row wrap">
          <span className="src">
            {m.mode === 'dual' ? '◐' : m.mode === 'device' ? '▣' : '●'} {modeLabel(m.mode)} · {inputs}
          </span>
          {m.calendarSource && <span className="src-outline">Calendar: {m.calendarSource.title}</span>}
        </div>
        <h1>{m.title}</h1>
        <div className="rec-readout">
          <div className={`rec-orb${paused ? ' paused' : ''}`} aria-hidden="true" />
          <div className="timer" aria-label="Elapsed time">
            <ElapsedClock />
          </div>
        </div>
        <div className="rec-state">
          {stopping ? 'Saving' : sourceLost ? 'Audio source lost' : failing ? 'Recording — not saving' : paused ? 'Paused' : 'Recording'}
        </div>
        {levels.length > 0 && (
          <div className="room-levels" aria-label="Live audio level">
            {levels.map((l) => (
              <div key={l.role} className="room-level">
                <span className="room-level-label">{l.role === 'microphone' ? 'You' : m.mode === 'dual' ? 'Call' : 'Computer'}</span>
                <LevelBars level={l.level} cells={40} label={l.role === 'microphone' ? 'Your microphone' : 'System sound'} onInk />
              </div>
            ))}
          </div>
        )}
        {m.mode === 'dual' && prefs.consentReminder && (
          <p className="consent-line on-ink" role="note">
            Tell everyone on the call they are being recorded — many places require their consent.
          </p>
        )}
        {stopping ? (
          <div className="loader rec-saving" role="status" aria-live="polite" aria-label="Saving recording">
            <div className="loader-head">
              <span className="spinner" aria-hidden="true" />
              <strong>Saving recording…</strong>
            </div>
            <p className="muted small mb-0">Finishing the audio file. The meeting opens as soon as it is saved.</p>
          </div>
        ) : sourceLost ? (
          <div className="rec-alert" role="alert">
            <strong>Recording interrupted.</strong>
            <p>
              {recordingError ?? 'The audio source stopped.'} Everything recorded until then is saved — stop now to keep
              it, then start a new recording if the meeting continues.
            </p>
            <div className="btn-row">
              <button className="btn btn-primary" onClick={() => void stopRecording()}>
                Stop &amp; keep what was saved
              </button>
            </div>
          </div>
        ) : failing ? (
          <div className="rec-alert" role="alert">
            <strong>Some audio could not be saved to disk.</strong>
            <p>
              {recordingError ?? 'Storage write failed.'} Unsaved audio is held in memory. Free up space, then retry — or
              stop now to keep everything that was saved.
            </p>
            <div className="btn-row">
              <button
                className="btn btn-primary"
                disabled={retrying}
                onClick={() => {
                  setRetrying(true);
                  void retrySaving().finally(() => setRetrying(false));
                }}
              >
                {retrying ? 'Retrying…' : 'Retry saving'}
              </button>
              <button className="btn btn-ghostlight" onClick={() => void stopRecording()}>
                Stop &amp; keep what was saved
              </button>
            </div>
          </div>
        ) : (
          <div className="btn-row">
            {paused ? (
              <button className="btn-ghostlight btn" title={`Resume (${keys.pause})`} onClick={() => void resumeRecording()}>
                Resume <Keys binding={keys.pause} />
              </button>
            ) : (
              <button className="btn-ghostlight btn" title={`Pause (${keys.pause})`} onClick={() => void pauseRecording()}>
                Pause <Keys binding={keys.pause} />
              </button>
            )}
            <button
              type="button"
              className="btn btn-moment"
              disabled={paused}
              onClick={() =>
                void addMoment().then(() =>
                  requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.moment-label:last-of-type')?.focus()),
                )
              }
            >
              ✚ Mark moment <Keys binding={keys.moment} />
            </button>
            <ConfirmButton
              className="btn btn-stop"
              prompt="Stop and save this recording?"
              confirmLabel="Yes, stop & save"
              onConfirm={() => void stopRecording().catch((e: unknown) => setStopError(e instanceof Error ? e.message : String(e)))}
            >
              ■ Stop &amp; save
            </ConfirmButton>
          </div>
        )}
        {stopError && (
          <div className="rec-alert" role="alert">
            <strong>Could not stop the recording.</strong>
            <p>{stopError}</p>
          </div>
        )}
        {!failing && <SavedLine tracks={m.mode === 'dual' ? 2 : 1} />}
      </section>

      <aside className="room-side">
        {!failing && prefs.audioWarnings && <LiveAudioWarnings issues={recordingIssues} />}
        {m.agenda?.items.length ? <RoomAgenda /> : null}
        <RoomMoments meetingId={m.id} moments={m.moments ?? []} momentKey={keys.moment} />
        {live && <LiveDraft live={live} />}
        <p className="room-note">You can leave this screen — recording continues.</p>
      </aside>
    </div>
  );
}

function SavedLine({ tracks }: { tracks: number }): React.JSX.Element {
  const ms = useElapsedMs();
  const mb = (ms / 1000) * BYTES_PER_SECOND / 1e6;
  return (
    <p className="saved-note">
      <span className="saved-mark">[x]</span> Audio chunks are being saved on this device · every 5 seconds ·{' '}
      {tracks === 2 ? 'mic + system mixed' : '1 track'} · {mb < 1 ? '<1' : Math.round(mb)} MB · you can leave this screen,
      recording continues
    </p>
  );
}

/** The agenda while recording: start a topic, tick it off, see what runs now. */
function RoomAgenda(): React.JSX.Element | null {
  const { activeMeeting, markAgenda } = useApp();
  const items = activeMeeting?.agenda?.items ?? [];
  if (items.length === 0) return null;
  const done = items.filter((i) => i.doneMs !== undefined).length;
  const current = items.find((i) => i.startedMs !== undefined && i.doneMs === undefined);
  return (
    <section className="card room-card" aria-label="Meeting agenda">
      <div className="card-title">
        <strong>
          Agenda · {done} of {items.length}
        </strong>
      </div>
      <ol className="room-agenda">
        {items.map((i, n) => {
          const now = current?.id === i.id;
          const isDone = i.doneMs !== undefined;
          return (
            <li key={i.id} className={now ? 'now' : isDone ? 'done' : undefined}>
              <span className="agenda-n">{n + 1}</span>
              <span className="agenda-t">
                {i.title}
                {(i.owner || i.minutes) && (
                  <span className="small muted"> {[i.owner ? `@${i.owner}` : '', i.minutes ? `${i.minutes} min` : ''].filter(Boolean).join(' · ')}</span>
                )}
              </span>
              <span className="agenda-s">
                {isDone ? (
                  <button type="button" className="mark-btn" title="Not done yet" onClick={() => void markAgenda(i.id, 'undo')}>
                    [x] {formatClock((i.startedMs ?? 0) / 1000)}
                  </button>
                ) : now ? (
                  <button type="button" className="btn btn-sm" onClick={() => void markAgenda(i.id, 'done')}>
                    now · Done
                  </button>
                ) : (
                  <button type="button" className="btn btn-sm" aria-label={`Start ${i.title}`} onClick={() => void markAgenda(i.id, 'start')}>
                    Start
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function RoomMoments({ meetingId, moments, momentKey }: { meetingId: string; moments: Moment[]; momentKey: string }): React.JSX.Element {
  const { labelMoment } = useApp();
  return (
    <section className="card room-card" aria-label="Moments">
      <div className="card-title">
        <strong>Moments · press {momentKey} to add</strong>
      </div>
      {moments.length === 0 ? (
        <p className="muted small pad">Mark decisions and to-dos as they happen; they show on the timeline and in the transcript.</p>
      ) : (
        <ul className="moment-list">
          {moments.map((mo) => (
            <MomentRow key={mo.id} moment={mo} save={(label) => void labelMoment(meetingId, mo.id, label)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function MomentRow({ moment, save }: { moment: Moment; save: (label: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(moment.label);
  useEffect(() => setDraft(moment.label), [moment.label]);
  return (
    <li>
      <span className="ts">{formatClock(moment.atMs / 1000)}</span>
      <input
        className="input moment-label"
        aria-label={`Label for the moment at ${formatClock(moment.atMs / 1000)}`}
        placeholder="Add a label, or leave it"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft !== moment.label && save(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </li>
  );
}

/** Text transcribed while recording; new lines scroll into view. */
function LiveDraft({ live }: { live: LiveSnapshot }): React.JSX.Element {
  const listRef = useRef<HTMLUListElement>(null);
  const count = live.segments.length;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);
  const state =
    live.status === 'failed' ? 'Stopped' : live.pending > 0 ? `Transcribing… (${live.pending} waiting)` : 'Listening';
  return (
    <section className="card room-card" aria-label="Live transcript">
      <div className="card-title">
        <strong>Live draft · {live.model} · final runs after</strong>
        <span className={`badge ${live.status === 'failed' ? 'pill-failed' : 'badge-ok'}`}>{state}</span>
      </div>
      {live.status === 'failed' ? (
        <p className="warn mb-0" role="alert">
          Live transcription stopped: {live.error ?? 'the engine failed.'} The recording is not affected — transcribe it
          after stopping.
        </p>
      ) : (
        live.error && <p className="warn mb-0">{live.error}</p>
      )}
      {count === 0 ? (
        live.status !== 'failed' && <p className="muted mb-0">Text appears here a few seconds after each sentence.</p>
      ) : (
        <ul className="transcript live-transcript" ref={listRef} aria-live="polite">
          {live.segments.map((s, i) => (
            <li key={s.id} className={i === count - 1 ? 'active' : undefined}>
              <span className="ts">{formatClock(s.startMs / 1000)}</span>
              {s.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
