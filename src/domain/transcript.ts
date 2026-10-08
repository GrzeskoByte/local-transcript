import { agendaToJSON, agendaToMarkdown, agendaToText, type AgendaItem } from './agenda';

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence?: number;
  /** 'Me' | 'Others' for two-way recordings (track-derived); absent for single-track. */
  speaker?: string;
}

function withSpeaker(s: TranscriptSegment): string {
  return s.speaker ? `${s.speaker}: ${s.text.trim()}` : s.text.trim();
}

export function segmentsToText(segments: TranscriptSegment[], agenda: AgendaItem[] = []): string {
  const prefix = agenda.length ? `${agendaToText(agenda)}\nTranscript:\n` : '';
  return prefix + segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(withSpeaker)
    .filter(Boolean)
    .join('\n');
}

export function segmentsToMarkdown(
  title: string,
  recordedAt: number,
  segments: TranscriptSegment[],
  agenda: AgendaItem[] = [],
): string {
  const agendaMd = agenda.length ? `${agendaToMarkdown(agenda)}\n## Transcript\n\n` : '';
  const header = `# ${title}\n\nRecorded: ${new Date(recordedAt).toLocaleString()}\n\n${agendaMd}`;
  const body = segments
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((s) => {
      const mm = String(Math.floor(s.startMs / 60000)).padStart(2, '0');
      const ss = String(Math.floor((s.startMs % 60000) / 1000)).padStart(2, '0');
      const who = s.speaker ? ` ${s.speaker}:` : '';
      return `**[${mm}:${ss}]${who}** ${s.text.trim()}`;
    })
    .join('\n\n');
  return header + body + '\n';
}

export function segmentsToJSON(
  meetingId: string,
  title: string,
  segments: TranscriptSegment[],
  agenda: AgendaItem[] = [],
): string {
  return JSON.stringify(
    {
      meetingId,
      title,
      ...(agenda.length ? { agenda: agendaToJSON(agenda) } : {}),
      segments: segments
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map((s) => ({
          startMs: s.startMs,
          endMs: s.endMs,
          text: s.text,
          ...(s.speaker ? { speaker: s.speaker } : {}),
        })),
    },
    null,
    2,
  );
}

/** Simple full-text search over stored segments (MVP §21). No embeddings. */
export function searchSegments(
  segments: TranscriptSegment[],
  query: string,
  contextChars = 40,
): { segment: TranscriptSegment; snippet: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { segment: TranscriptSegment; snippet: string }[] = [];
  for (const segment of segments) {
    const lower = segment.text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx >= 0) {
      const start = Math.max(0, idx - contextChars);
      const end = Math.min(segment.text.length, idx + q.length + contextChars);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < segment.text.length ? '…' : '';
      out.push({ segment, snippet: `${prefix}${segment.text.slice(start, end)}${suffix}` });
    }
  }
  return out;
}

/** Index of the segment playing at `ms` (segments sorted by start), or -1. */
export function activeSegmentIndex(segments: TranscriptSegment[], ms: number): number {
  if (ms < 0) return -1;
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return -1;
  const s = segments[found]!;
  // Past this line's end and before the next one: nothing is "being said".
  return ms <= Math.max(s.endMs, s.startMs + 1000) ? found : -1;
}
