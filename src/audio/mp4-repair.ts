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

/** An incomplete box larger than this is not a fragment: stop repairing. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

/**
 * Incremental `repairFragmentedMp4` for a recording written chunk by chunk
 * (the live disk mirror). Feed chunks in order with `push`, then `end`; the
 * concatenated output equals the batch repair for a well-formed recording.
 * Complete boxes pass through as soon as they are known to be kept; a `moof`
 * waits for the next box (kept only before an `mdat`). Input that is not an
 * MP4, or a box structure it cannot follow, passes through unchanged.
 */
export class Mp4StreamRepair {
  private buffer = new Uint8Array(0);
  private heldMoof: Uint8Array | null = null;
  private seenFtyp = false;
  private started = false;
  private passthrough = false;

  push(chunk: Uint8Array): Uint8Array {
    if (this.passthrough) return chunk;
    this.buffer = concat([this.buffer, chunk]);
    const out: Uint8Array[] = [];
    if (!this.started) {
      if (this.buffer.length < 8) return new Uint8Array(0);
      this.started = true;
      if (fourcc(this.buffer, 4) !== 'ftyp') return this.giveUp(out);
    }
    for (;;) {
      if (this.buffer.length < 8) break;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      let size = view.getUint32(0);
      if (size === 1) {
        if (this.buffer.length < 16) break;
        size = Number(view.getBigUint64(8));
      } else if (size === 0) {
        return this.giveUp(out);
      }
      if (size < 8) return this.giveUp(out);
      if (size > this.buffer.length) {
        if (this.buffer.length > MAX_PENDING_BYTES) return this.giveUp(out);
        break;
      }
      const box = this.buffer.slice(0, size);
      this.buffer = this.buffer.slice(size);
      this.accept(fourcc(box, 4), box, out);
    }
    return concat(out);
  }

  /** Remaining bytes: a trailing incomplete box is kept as-is. */
  end(): Uint8Array {
    if (this.passthrough) return new Uint8Array(0);
    // A trailing moof with no mdat is dropped, as in the batch repair; one
    // followed by a cut-off box (its truncated mdat) is kept with it.
    const rest = this.heldMoof && this.buffer.length ? concat([this.heldMoof, this.buffer]) : this.buffer;
    this.heldMoof = null;
    this.buffer = new Uint8Array(0);
    return rest;
  }

  private accept(type: string, box: Uint8Array, out: Uint8Array[]): void {
    if (this.heldMoof) {
      if (type === 'mdat') out.push(this.heldMoof);
      this.heldMoof = null;
    }
    if (type === 'ftyp') {
      if (this.seenFtyp) return;
      this.seenFtyp = true;
    }
    if (type === 'moof') {
      this.heldMoof = box;
      return;
    }
    out.push(box);
  }

  private giveUp(out: Uint8Array[]): Uint8Array {
    this.passthrough = true;
    if (this.heldMoof) out.push(this.heldMoof);
    out.push(this.buffer);
    this.heldMoof = null;
    this.buffer = new Uint8Array(0);
    return concat(out);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
