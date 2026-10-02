import { describe, expect, it } from 'vitest';
import { repairFragmentedMp4 } from './mp4-repair';

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
