import { describe, expect, it } from 'vitest';
import { aggregateWer, computeWer, normalizeTranscript, tokenizeWords } from './wer';

describe('normalizeTranscript', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeTranscript('  Hello,   World!  ')).toBe('hello world');
  });

  it('normalizes curly apostrophes', () => {
    expect(normalizeTranscript('Mister Quilter\u2019s manner')).toBe("mister quilter's manner");
  });

  it('drops digits-adjacent punctuation but keeps digits and apostrophes', () => {
    expect(normalizeTranscript("It's 2026.")).toBe("it's 2026");
  });
});

describe('tokenizeWords', () => {
  it('returns [] for empty input', () => {
    expect(tokenizeWords('')).toEqual([]);
  });

  it('splits on single spaces', () => {
    expect(tokenizeWords('a b c')).toEqual(['a', 'b', 'c']);
  });
});

describe('computeWer', () => {
  it('is 0 for an exact match', () => {
    const r = computeWer('the quick brown fox', 'the quick brown fox');
    expect(r.wer).toBe(0);
    expect(r.substitutions + r.deletions + r.insertions).toBe(0);
  });

  it('counts a substitution', () => {
    const r = computeWer('the quick brown fox', 'the quick brown box');
    expect(r.substitutions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(r.insertions).toBe(0);
    expect(r.wer).toBeCloseTo(1 / 4);
  });

  it('counts a deletion', () => {
    const r = computeWer('the quick brown fox', 'the quick fox');
    expect(r.deletions).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 4);
  });

  it('counts an insertion', () => {
    const r = computeWer('the quick fox', 'the quick brown fox');
    expect(r.insertions).toBe(1);
    expect(r.hypWords).toBe(4);
    expect(r.wer).toBeCloseTo(1 / 3);
  });

  it('ignores case and punctuation differences', () => {
    const r = computeWer('Mister Quilter is here.', 'MISTER QUILTER IS HERE');
    expect(r.wer).toBe(0);
  });

  it('reports hallucinated words when the reference is empty', () => {
    const r = computeWer('', 'you');
    expect(r.refWords).toBe(0);
    expect(r.wer).toBe(1);
    expect(r.insertions).toBe(1);
  });

  it('is 0 for empty reference and empty hypothesis', () => {
    expect(computeWer('', '').wer).toBe(0);
  });
});

describe('aggregateWer', () => {
  it('pools error counts across cases', () => {
    const r = aggregateWer([
      { reference: 'a b c d', hypothesis: 'a b c d' },
      { reference: 'a b c d', hypothesis: 'a b c x' },
    ]);
    expect(r.refWords).toBe(8);
    expect(r.substitutions).toBe(1);
    expect(r.wer).toBeCloseTo(1 / 8);
  });

  it('treats hallucinated words on empty references as inserts', () => {
    const r = aggregateWer([{ reference: '', hypothesis: 'thank you' }]);
    expect(r.wer).toBe(2);
  });
});
