/**
 * Repairs fragmented MP4 recordings from WebKitGTK's GStreamer 1.20
 * MediaRecorder (the AppImage). Pausing makes it emit a `moof` with no `mdat`
 * after it; the next fragment's header is then read as Opus packets
 * ("corrupted stream") and decodeAudioData rejects the whole file, so paused
 * recordings could neither play nor transcribe. The first chunk also carries a
 * duplicate `ftyp`. Dropping both leaves a valid fragmented MP4.
 *
 * Returns the input unchanged when it is not an MP4, needs no repair, or the
 * box structure cannot be parsed (never makes a recording worse).
 */
export function repairFragmentedMp4(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 8 || fourcc(bytes, 4) !== 'ftyp') return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: { type: string; start: number; end: number }[] = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    let size = view.getUint32(pos);
    if (size === 1) {
      if (pos + 16 > bytes.length) return bytes;
      size = Number(view.getBigUint64(pos + 8));
    } else if (size === 0) {
      size = bytes.length - pos;
    }
    if (size < 8 || pos + size > bytes.length) return bytes;
    boxes.push({ type: fourcc(bytes, pos + 4), start: pos, end: pos + size });
    pos += size;
  }
  if (pos !== bytes.length) return bytes;

  let seenFtyp = false;
  const keep = boxes.filter((box, i) => {
    if (box.type === 'ftyp') {
      if (seenFtyp) return false;
      seenFtyp = true;
    }
    return box.type !== 'moof' || boxes[i + 1]?.type === 'mdat';
  });
  if (keep.length === boxes.length) return bytes;

  const out = new Uint8Array(keep.reduce((n, b) => n + (b.end - b.start), 0));
  let at = 0;
  for (const box of keep) {
    out.set(bytes.subarray(box.start, box.end), at);
    at += box.end - box.start;
  }
  return out;
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}
