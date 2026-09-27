/**
 * Word error rate scoring for the bench harness.
 *
 * Kept in `src/` (not `bench/`) so it is typechecked and covered by Vitest;
 * `bench/run.mjs` imports it via Node's TypeScript type stripping.
 */

export interface WerResult {
  /** Errors / reference words. When the reference is empty this is the raw
   *  number of inserted (hallucinated) words. */
  wer: number;
  refWords: number;
  hypWords: number;
  substitutions: number;
  deletions: number;
  insertions: number;
}

const CURLY_APOSTROPHE = /[\u2018\u2019\u02BC\u00B4`]/g;

/**
 * Lowercase, normalize apostrophes/quotes, drop punctuation, collapse spaces.
 * Matches how Whisper output and LibriSpeech ground truth differ superficially.
 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(CURLY_APOSTROPHE, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeWords(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ');
}

function editCounts(
  ref: string[],
  hyp: string[],
): { substitutions: number; deletions: number; insertions: number } {
  const n = ref.length;
  const m = hyp.length;
  const d: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) d[i]![0] = i;
  for (let j = 0; j <= m; j++) d[0]![j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
    }
  }

  let i = n;
  let j = m;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  while (i > 0 && j > 0) {
    const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
    if (d[i]![j] === d[i - 1]![j - 1]! + cost) {
      if (cost === 1) substitutions++;
      i--;
      j--;
    } else if (d[i]![j] === d[i - 1]![j]! + 1) {
      deletions++;
      i--;
    } else {
      insertions++;
      j--;
    }
  }
  deletions += i; // leftover reference words
  insertions += j; // leftover hypothesis words
  return { substitutions, deletions, insertions };
}

export function computeWer(reference: string, hypothesis: string): WerResult {
  const ref = tokenizeWords(normalizeTranscript(reference));
  const hyp = tokenizeWords(normalizeTranscript(hypothesis));
  const { substitutions, deletions, insertions } = editCounts(ref, hyp);
  const errors = substitutions + deletions + insertions;
  const wer = ref.length > 0 ? errors / ref.length : errors;
  return { wer, refWords: ref.length, hypWords: hyp.length, substitutions, deletions, insertions };
}

/** Corpus-level WER: error counts are pooled across cases before dividing. */
export function aggregateWer(pairs: Array<{ reference: string; hypothesis: string }>): WerResult {
  let refWords = 0;
  let hypWords = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;
  for (const { reference, hypothesis } of pairs) {
    const r = computeWer(reference, hypothesis);
    refWords += r.refWords;
    hypWords += r.hypWords;
    substitutions += r.substitutions;
    deletions += r.deletions;
    insertions += r.insertions;
  }
  const errors = substitutions + deletions + insertions;
  return {
    wer: refWords > 0 ? errors / refWords : errors,
    refWords,
    hypWords,
    substitutions,
    deletions,
    insertions,
  };
}
