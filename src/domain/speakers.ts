/**
 * Speakers: who said each transcript line. Turns come from the local
 * speaker-detection engine (sherpa-onnx, see src-tauri/src/diarize.rs);
 * each line gets the speaker it overlaps most. Names are per meeting
 * ("speaker_00" → "Greg"). Legacy two-track recordings keep "Me"/"Others".
 */
import type { TranscriptSegment } from './transcript';

export interface SpeakerTurn {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  /** Engine id: "speaker_00", "speaker_01", … */
  speaker: string;
}

/** Lines like "0.318 -- 6.865 speaker_00" (the CLI's output). */
export function parseDiarizationOutput(stdout: string): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+(?:\.\d+)?)\s+--\s+(\d+(?:\.\d+)?)\s+(speaker_\d+)$/);
    if (m) turns.push({ start: Number(m[1]), end: Number(m[2]), speaker: m[3]! });
  }
  return turns.sort((a, b) => a.start - b.start);
}

/** Each segment gets the speaker it overlaps most (or the nearest turn when none overlaps). */
export function assignSpeakers(segments: TranscriptSegment[], turns: SpeakerTurn[]): TranscriptSegment[] {
  if (turns.length === 0) return segments;
  return segments.map((s) => {
    const a = s.startMs / 1000;
    const b = Math.max(a, s.endMs / 1000);
    const overlap = new Map<string, number>();
    for (const t of turns) {
      const o = Math.min(b, t.end) - Math.max(a, t.start);
      if (o > 0) overlap.set(t.speaker, (overlap.get(t.speaker) ?? 0) + o);
    }
    let best: string | undefined;
    let bestO = 0;
    for (const [sp, o] of overlap) if (o > bestO) [best, bestO] = [sp, o];
    if (!best) {
      const mid = (a + b) / 2;
      best = turns.reduce((n, t) =>
        Math.min(Math.abs(t.start - mid), Math.abs(t.end - mid)) <
        Math.min(Math.abs(n.start - mid), Math.abs(n.end - mid))
          ? t
          : n,
      ).speaker;
    }
    return { ...s, speaker: best };
  });
}

/** Speakers in order of first appearance. */
export function speakersOf(segments: TranscriptSegment[]): string[] {
  const seen: string[] = [];
  for (const s of segments) if (s.speaker && !seen.includes(s.speaker)) seen.push(s.speaker);
  return seen;
}

/** Display name: the meeting's name for it, else "Speaker N". */
export function speakerName(id: string, names: Record<string, string> | undefined): string {
  const named = names?.[id]?.trim();
  if (named) return named;
  const n = id.match(/^speaker_(\d+)$/);
  return n ? `Speaker ${Number(n[1]) + 1}` : id;
}

/** Segments with display names in `speaker` (exports, the disk copy, GitLab). */
export function namedSegments(segments: TranscriptSegment[], names: Record<string, string> | undefined): TranscriptSegment[] {
  return segments.map((s) => (s.speaker ? { ...s, speaker: speakerName(s.speaker, names) } : s));
}
