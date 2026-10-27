import { formatDuration, modeLabel, type Meeting } from '../../domain/meeting';
import { actionItemsOf } from '../../domain/action-items';
import { dayGroupLabel } from '../../domain/dates';

/** "[x] transcribed" / "transcribing" / "[!] failed" / "[ ] not transcribed" as a status tag. */
export function StatusPill({ m, progress }: { m: Meeting; progress?: number }): React.JSX.Element {
  const st = progress !== undefined ? 'processing' : m.transcriptionStatus;
  const label =
    st === 'not_started'
      ? 'not transcribed'
      : st === 'processing'
        ? progress !== undefined
          ? `transcribing ${Math.round(progress * 100)}%`
          : 'transcribing'
        : st === 'completed'
          ? 'transcribed'
          : 'failed';
  return <span className={`pill pill-${st === 'not_started' ? 'idle' : st}`}>{label}</span>;
}

export function SourcePill({ mode }: { mode: Meeting['mode'] }): React.JSX.Element {
  return <span className={`pill pill-${mode}`}>{modeLabel(mode)}</span>;
}

/** "Today 09:47 · 34:12 · <summary>" */
export function meetingMeta(m: Meeting): string {
  const time = new Date(m.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return [`${dayGroupLabel(m.createdAt)} ${time}`, `${m.durationEstimated ? '≈ ' : ''}${formatDuration(m.durationMs)}`, m.summary?.text]
    .filter(Boolean)
    .join(' · ');
}

/** A meeting as a framed row: caps title, meta line, tags, ink chevron. */
export function MeetingRow({
  m,
  progress,
  onOpen,
}: {
  m: Meeting;
  progress?: number;
  onOpen: () => void;
}): React.JSX.Element {
  const open = actionItemsOf(m).length;
  return (
    <button type="button" className="meeting-item" onClick={onOpen}>
      <span className="body">
        <span className="title">{m.title}</span>
        <span className="meta">{meetingMeta(m)}</span>
      </span>
      <span className="pills">
        <SourcePill mode={m.mode} />
        <StatusPill m={m} progress={progress} />
        {open > 0 && <span className="pill pill-actions">{open} action{open === 1 ? '' : 's'}</span>}
      </span>
      <span className="chev" aria-hidden="true">
        ›
      </span>
    </button>
  );
}
