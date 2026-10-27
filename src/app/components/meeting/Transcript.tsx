import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { activeSegmentIndex, type TranscriptSegment } from '../../../domain/transcript';
import type { AgendaItem } from '../../../domain/agenda';
import type { Moment } from '../../../domain/meeting';
import { formatClock } from '../../../audio/player';
import { speakerName } from '../../../domain/speakers';
import { highlight } from '../../screens/Library.tsx';

/** Playhead shared by the player and the transcript (outside React state: no page re-render per tick). */
const playhead = { ms: -1, playing: false, listeners: new Set<() => void>() };
export function setPlayhead(seconds: number, playing: boolean): void {
  playhead.ms = Math.round(seconds * 1000);
  playhead.playing = playing;
  playhead.listeners.forEach((l) => l());
}
function subscribePlayhead(listener: () => void): () => void {
  playhead.listeners.add(listener);
  return () => playhead.listeners.delete(listener);
}

/** Rows rendered at first; more load as the end comes into view. */
const PAGE = 400;

type Row =
  | { kind: 'line'; seg: TranscriptSegment; index: number }
  | { kind: 'chapter'; n: number; item: AgendaItem }
  | { kind: 'moment'; moment: Moment };

/**
 * The transcript rows: agenda chapters and moments in between, the line
 * being played highlighted (and followed), every line editable ("edit any
 * line to fix it"). Memoised and paged, so a long meeting opens instantly.
 */
export const TranscriptList = memo(function TranscriptList({
  segments,
  query,
  canSeek,
  onSeek,
  follow,
  agenda,
  moments,
  speakerNames,
  onEdit,
}: {
  segments: TranscriptSegment[];
  query: string;
  canSeek: boolean;
  onSeek: (startMs: number, speaker?: string) => void;
  follow: boolean;
  agenda: AgendaItem[];
  moments: Moment[];
  speakerNames?: Record<string, string>;
  onEdit?: (segmentId: string, text: string) => void;
}): React.JSX.Element {
  const ms = useSyncExternalStore(subscribePlayhead, () => playhead.ms);
  const playing = useSyncExternalStore(subscribePlayhead, () => playhead.playing);
  const active = activeSegmentIndex(segments, ms);
  const [limit, setLimit] = useState(PAGE);
  const [editing, setEditing] = useState<string | null>(null);
  const shown = Math.min(segments.length, Math.max(limit, active + 50));
  const listRef = useRef<HTMLUListElement>(null);
  const moreRef = useRef<HTMLLIElement>(null);

  // Lines interleaved with the agenda chapters (by when each topic started) and moments.
  const rows = useMemo(() => {
    const chapters = agenda
      .map((item, i) => ({ item, n: i + 1 }))
      .filter((c) => c.item.startedMs !== undefined)
      .sort((a, b) => a.item.startedMs! - b.item.startedMs!);
    const marks = [...moments].sort((a, b) => a.atMs - b.atMs);
    const out: Row[] = [];
    let c = 0;
    let k = 0;
    segments.slice(0, shown).forEach((seg, index) => {
      while (c < chapters.length && chapters[c]!.item.startedMs! <= seg.startMs) {
        out.push({ kind: 'chapter', n: chapters[c]!.n, item: chapters[c]!.item });
        c++;
      }
      while (k < marks.length && marks[k]!.atMs <= seg.startMs) out.push({ kind: 'moment', moment: marks[k++]! });
      out.push({ kind: 'line', seg, index });
    });
    if (shown >= segments.length) while (k < marks.length) out.push({ kind: 'moment', moment: marks[k++]! });
    return out;
  }, [segments, shown, agenda, moments]);

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
    listRef.current?.querySelector<HTMLElement>(`li[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, follow, playing]);

  return (
    <ul className="transcript" ref={listRef}>
      {rows.map((r) =>
        r.kind === 'chapter' ? (
          <li key={`c-${r.item.id}`} className="sect">
            <b>{r.n}</b> {r.item.title}
            <span className="sect-time">{formatClock((r.item.startedMs ?? 0) / 1000)}</span>
          </li>
        ) : r.kind === 'moment' ? (
          <li key={`m-${r.moment.id}`} className="moment-row">
            <span className="who">✚ Moment</span>
            <button type="button" className="ts ts-seek" disabled={!canSeek} onClick={() => onSeek(r.moment.atMs)}>
              {formatClock(r.moment.atMs / 1000)}
            </button>
            <strong>{r.moment.label || 'Marked while recording'}</strong>
          </li>
        ) : (
          <li
            key={r.seg.id}
            data-index={r.index}
            className={`seg${r.index === active ? ' active' : ''}`}
            aria-current={r.index === active ? 'true' : undefined}
          >
            {r.seg.speaker && <span className="who">{speakerName(r.seg.speaker, speakerNames)}</span>}
            <span className="txt">
              <button
                type="button"
                className="ts ts-seek"
                title="Play from here"
                disabled={!canSeek}
                onClick={() => onSeek(r.seg.startMs, r.seg.speaker)}
              >
                {formatClock(r.seg.startMs / 1000)}
              </button>
              {editing === r.seg.id && onEdit ? (
                <LineEditor
                  text={r.seg.text}
                  onDone={(text) => {
                    setEditing(null);
                    if (text !== null && text.trim() && text.trim() !== r.seg.text.trim()) onEdit(r.seg.id, text);
                  }}
                />
              ) : onEdit ? (
                <span
                  className="line-text"
                  role="button"
                  tabIndex={0}
                  title="Click to fix this line"
                  onClick={() => setEditing(r.seg.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      setEditing(r.seg.id);
                    }
                  }}
                >
                  {highlight(r.seg.text, query)}
                </span>
              ) : (
                highlight(r.seg.text, query)
              )}
            </span>
          </li>
        ),
      )}
      {shown < segments.length && (
        <li ref={moreRef} className="transcript-more">
          <button type="button" className="btn btn-sm" onClick={() => setLimit(segments.length)}>
            Show all {segments.length} lines
          </button>
        </li>
      )}
    </ul>
  );
});

function LineEditor({ text, onDone }: { text: string; onDone: (text: string | null) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(text);
  return (
    <textarea
      className="input line-edit"
      aria-label="Edit line"
      autoFocus
      rows={Math.min(6, Math.max(2, Math.ceil(text.length / 80)))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onDone(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDone(null);
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onDone(draft);
        }
      }}
    />
  );
}
