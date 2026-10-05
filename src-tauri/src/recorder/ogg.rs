//! Minimal Ogg Opus writer and reader (RFC 3533 + RFC 7845), std only.
//!
//! The recorder writes one logical Ogg stream split into chunk files at page
//! boundaries, so the chunks concatenate (in name order) into a valid `.ogg`
//! at any time — also after a crash, when the final EOS page is missing.

/// Opus always runs its granule clock at 48 kHz.
pub const OPUS_RATE: u32 = 48_000;
/// Samples per packet: 20 ms at 48 kHz.
pub const FRAME: usize = 960;

const CRC_TABLE: [u32; 256] = crc_table();

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut r = (i as u32) << 24;
        let mut k = 0;
        while k < 8 {
            r = if r & 0x8000_0000 != 0 { (r << 1) ^ 0x04c1_1db7 } else { r << 1 };
            k += 1;
        }
        table[i] = r;
        i += 1;
    }
    table
}

fn crc32(data: &[u8]) -> u32 {
    data.iter().fold(0u32, |crc, &b| (crc << 8) ^ CRC_TABLE[(((crc >> 24) as u8) ^ b) as usize])
}

const FLAG_CONTINUED: u8 = 0x01;
const FLAG_BOS: u8 = 0x02;
const FLAG_EOS: u8 = 0x04;

/// Builds the pages of one Ogg stream.
pub struct OggWriter {
    serial: u32,
    sequence: u32,
}

impl OggWriter {
    pub fn new(serial: u32) -> Self {
        Self { serial, sequence: 0 }
    }

    /// The two header pages: OpusHead (BOS) and OpusTags.
    pub fn headers(&mut self, pre_skip: u16, input_rate: u32) -> Vec<u8> {
        let mut head = Vec::with_capacity(19);
        head.extend_from_slice(b"OpusHead");
        head.push(1); // version
        head.push(1); // mono
        head.extend_from_slice(&pre_skip.to_le_bytes());
        head.extend_from_slice(&input_rate.to_le_bytes());
        head.extend_from_slice(&0i16.to_le_bytes()); // output gain
        head.push(0); // channel mapping family 0
        let vendor = b"Local Transcribe (libopus)";
        let mut tags = Vec::new();
        tags.extend_from_slice(b"OpusTags");
        tags.extend_from_slice(&(vendor.len() as u32).to_le_bytes());
        tags.extend_from_slice(vendor);
        tags.extend_from_slice(&0u32.to_le_bytes());
        let mut out = self.page(&[head.as_slice()], 0, FLAG_BOS);
        out.extend(self.page(&[tags.as_slice()], 0, 0));
        out
    }

    /// Audio pages for `packets` (each `FRAME` samples long); `granule` is
    /// the stream position (48 kHz samples, pre-skip included) at the end of
    /// the last packet. `last` marks the end of the stream (EOS).
    pub fn audio(&mut self, packets: &[Vec<u8>], granule: u64, last: bool) -> Vec<u8> {
        let mut out = Vec::new();
        if packets.is_empty() {
            if last {
                out.extend(self.page(&[], granule, FLAG_EOS));
            }
            return out;
        }
        // A page holds at most 255 lacing values: split long runs between
        // packets. Each page's granule is the position after its last packet.
        let mut start = 0;
        while start < packets.len() {
            let mut segs = 0usize;
            let mut end = start;
            while end < packets.len() {
                let need = packets[end].len() / 255 + 1;
                if segs + need > 255 && end > start {
                    break;
                }
                segs += need;
                end += 1;
            }
            let remaining = (packets.len() - end) as u64;
            let page_granule = granule.saturating_sub(remaining * FRAME as u64);
            let flags = if end == packets.len() && last { FLAG_EOS } else { 0 };
            let refs: Vec<&[u8]> = packets[start..end].iter().map(|p| p.as_slice()).collect();
            out.extend(self.page(&refs, page_granule, flags));
            start = end;
        }
        out
    }

    fn page(&mut self, packets: &[&[u8]], granule: u64, flags: u8) -> Vec<u8> {
        let mut lacing = Vec::new();
        let mut body = Vec::new();
        for p in packets {
            let mut n = p.len();
            while n >= 255 {
                lacing.push(255u8);
                n -= 255;
            }
            lacing.push(n as u8);
            body.extend_from_slice(p);
        }
        let mut page = Vec::with_capacity(27 + lacing.len() + body.len());
        page.extend_from_slice(b"OggS");
        page.push(0);
        page.push(flags);
        page.extend_from_slice(&granule.to_le_bytes());
        page.extend_from_slice(&self.serial.to_le_bytes());
        page.extend_from_slice(&self.sequence.to_le_bytes());
        page.extend_from_slice(&[0, 0, 0, 0]);
        page.push(lacing.len() as u8);
        page.extend_from_slice(&lacing);
        page.extend_from_slice(&body);
        let crc = crc32(&page);
        page[22..26].copy_from_slice(&crc.to_le_bytes());
        self.sequence += 1;
        page
    }
}

/// An Ogg Opus stream read back: header fields and the audio packets.
#[derive(Debug, Default)]
pub struct OpusStream {
    pub pre_skip: u16,
    pub packets: Vec<Vec<u8>>,
}

/// Parse an Ogg Opus file (or concatenated chunks). Stops at the first torn
/// or corrupt page, keeping everything before it (a crash-cut recording).
pub fn read_opus(data: &[u8]) -> Result<OpusStream, String> {
    let mut pos = 0usize;
    let mut packets: Vec<Vec<u8>> = Vec::new();
    let mut partial: Vec<u8> = Vec::new();
    let mut serial: Option<u32> = None;
    while pos + 27 <= data.len() {
        if &data[pos..pos + 4] != b"OggS" {
            break;
        }
        let flags = data[pos + 5];
        let page_serial = u32::from_le_bytes(data[pos + 14..pos + 18].try_into().unwrap());
        let nsegs = data[pos + 26] as usize;
        let lacing_end = pos + 27 + nsegs;
        if lacing_end > data.len() {
            break;
        }
        let lacing = &data[pos + 27..lacing_end];
        let body_len: usize = lacing.iter().map(|&l| l as usize).sum();
        let end = lacing_end + body_len;
        if end > data.len() {
            break;
        }
        let mut check = data[pos..end].to_vec();
        check[22..26].copy_from_slice(&[0, 0, 0, 0]);
        let stored = u32::from_le_bytes(data[pos + 22..pos + 26].try_into().unwrap());
        if crc32(&check) != stored {
            break;
        }
        // Only the first logical stream (we never chain streams).
        if *serial.get_or_insert(page_serial) != page_serial {
            pos = end;
            continue;
        }
        if flags & FLAG_CONTINUED == 0 && !partial.is_empty() {
            partial.clear();
        }
        let mut at = lacing_end;
        for &l in lacing {
            partial.extend_from_slice(&data[at..at + l as usize]);
            at += l as usize;
            if l < 255 {
                packets.push(std::mem::take(&mut partial));
            }
        }
        pos = end;
    }
    if packets.len() < 2 || !packets[0].starts_with(b"OpusHead") || packets[0].len() < 19 {
        return Err("Not an Ogg Opus recording".into());
    }
    if !packets[1].starts_with(b"OpusTags") {
        return Err("Ogg Opus recording without tags header".into());
    }
    let pre_skip = u16::from_le_bytes([packets[0][10], packets[0][11]]);
    packets.drain(0..2);
    Ok(OpusStream { pre_skip, packets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_matches_the_ogg_reference() {
        // CRC of "OggS" with the Ogg polynomial (no reflection, init 0).
        assert_eq!(crc32(b"OggS"), 0x5fb0a94f);
    }

    #[test]
    fn pages_round_trip_including_long_packets_and_chunk_splits() {
        let mut w = OggWriter::new(7);
        let mut file = w.headers(312, 48_000);
        let packets: Vec<Vec<u8>> = (0..300).map(|i| vec![(i % 251) as u8; 40 + (i * 7) % 700]).collect();
        // Written in two "chunks"; the second ends the stream.
        file.extend(w.audio(&packets[..120], 120 * 960, false));
        file.extend(w.audio(&packets[120..], 300 * 960, true));
        let stream = read_opus(&file).unwrap();
        assert_eq!(stream.pre_skip, 312);
        assert_eq!(stream.packets, packets);
    }

    #[test]
    fn a_torn_tail_keeps_the_complete_pages() {
        let mut w = OggWriter::new(1);
        let mut file = w.headers(312, 48_000);
        let first: Vec<Vec<u8>> = vec![vec![1; 100]; 10];
        file.extend(w.audio(&first, 10 * 960, false));
        let mut tail = w.audio(&[vec![2; 100]], 11 * 960, false);
        tail.truncate(tail.len() - 5);
        file.extend(tail);
        assert_eq!(read_opus(&file).unwrap().packets, first);
    }

    #[test]
    fn rejects_other_files() {
        assert!(read_opus(b"RIFF....WAVE").is_err());
        assert!(read_opus(&[]).is_err());
    }
}
