import { describe, expect, it } from 'vitest';
import { Mp4StreamRepair, repairFragmentedMp4 } from './mp4-repair';

function box(type: string, payload = 4): Uint8Array {
  const b = new Uint8Array(8 + payload);
  new DataView(b.buffer).setUint32(0, b.length);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  b.fill(type.charCodeAt(0), 8);
  return b;
}
const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};
const types = (b: Uint8Array) => {
  const out: string[] = [];
  for (let pos = 0; pos < b.length; ) {
    const size = new DataView(b.buffer, b.byteOffset).getUint32(pos);
    out.push(String.fromCharCode(...b.subarray(pos + 4, pos + 8)));
    pos += size;
  }
  return out;
};

describe('repairFragmentedMp4', () => {
  it('drops a moof without mdat (pause) and the duplicate ftyp', () => {
    const rec = join(box('ftyp'), box('ftyp'), box('moov'), box('moof'), box('mdat'), box('moof'), box('moof'), box('mdat'));
    expect(types(repairFragmentedMp4(rec))).toEqual(['ftyp', 'moov', 'moof', 'mdat', 'moof', 'mdat']);
  });

  it('drops a trailing moof with no data', () => {
    const rec = join(box('ftyp'), box('moov'), box('moof'), box('mdat'), box('moof'));
    expect(types(repairFragmentedMp4(rec))).toEqual(['ftyp', 'moov', 'moof', 'mdat']);
  });

  it('returns valid files unchanged (same instance)', () => {
    const rec = join(box('ftyp'), box('moov'), box('moof'), box('mdat'));
    expect(repairFragmentedMp4(rec)).toBe(rec);
  });

  it('leaves non-MP4 and unparseable data alone', () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 1, 2]);
    expect(repairFragmentedMp4(webm)).toBe(webm);
    const truncated = join(box('ftyp'), box('moof')).subarray(0, 20);
    expect(repairFragmentedMp4(truncated)).toBe(truncated);
  });
});

/** Feed `bytes` in pieces of `step` bytes through the streaming repair. */
function streamed(bytes: Uint8Array, step: number): Uint8Array {
  const repair = new Mp4StreamRepair();
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += step) out.push(repair.push(bytes.subarray(at, at + step)));
  out.push(repair.end());
  return join(...out);
}

describe('Mp4StreamRepair', () => {
  const paused = join(box('ftyp'), box('ftyp'), box('moov'), box('moof'), box('mdat', 40), box('moof'), box('moof'), box('mdat', 40), box('moof'));

  it('matches the batch repair however the recording is chunked', () => {
    const batch = repairFragmentedMp4(paused);
    for (const step of [1, 3, 7, 12, 25, paused.length]) {
      expect(streamed(paused, step)).toEqual(batch);
    }
  });

  it('passes valid recordings through unchanged', () => {
    const rec = join(box('ftyp'), box('moov'), box('moof'), box('mdat', 30));
    expect(streamed(rec, 5)).toEqual(rec);
  });

  it('passes non-MP4 data through unchanged', () => {
    const webm = new Uint8Array(50).map((_, i) => (i * 37) & 0xff);
    webm.set([0x1a, 0x45, 0xdf, 0xa3]);
    expect(streamed(webm, 4)).toEqual(webm);
  });

  it('keeps a trailing incomplete box (recording cut short)', () => {
    const rec = join(box('ftyp'), box('moov'), box('moof'), box('mdat', 30));
    const cut = rec.subarray(0, rec.length - 10);
    expect(streamed(cut, 6)).toEqual(cut);
  });
});

describe('Mp4StreamRepair.pushParts', () => {
  it('returns views: a clean recording pushed at once is a single view, no copy', () => {
    const rec = join(box('ftyp'), box('moov'), box('moof'), box('mdat', 30), box('moof'), box('mdat', 30));
    const parts = new Mp4StreamRepair().pushParts(rec);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.buffer).toBe(rec.buffer);
    expect(parts[0]).toEqual(rec);
  });

  it('handles thousands of fragments in one push in linear time', () => {
    const frags: Uint8Array[] = [box('ftyp'), box('moov')];
    for (let i = 0; i < 20000; i++) frags.push(box('moof'), box('mdat', 60));
    frags.push(box('moof')); // pause: empty fragment
    for (let i = 0; i < 20000; i++) frags.push(box('moof'), box('mdat', 60));
    const rec = join(...frags);
    const t0 = performance.now();
    const repair = new Mp4StreamRepair();
    const out = join(...repair.pushParts(rec), repair.end());
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.length).toBe(rec.length - 12);
    // Byte compare without vitest's (slow) element-wise deep equality.
    expect(Buffer.compare(out, repairFragmentedMp4(rec))).toBe(0);
  });
});
