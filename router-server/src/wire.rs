//! Protocol v3 wire format (gateway → router), byte-exact with the emulator's `emulator/runtime/protocol.py`.
//!
//! Frame:  header 26 B `<HBBIIQHI` + payload + CRC-32 trailer (zlib CRC over header+payload).
//! Payload order: [GW_STATUS 11 B] [META u32 len + JSON] [records × n_rec].
//! Record: `<IIIBBbB` (patch_id, patient_id, seq, flags, battery, rssi, n_ch) then n_ch channel blocks
//! `<BBH>` (ch_id, dtype, n) + data (n × axes × itemsize).  Control frames (router → gateway, F_CTRL) carry `<BII>`.

use std::collections::VecDeque;

pub const MAGIC: u16 = 0x4742;
pub const VERSION: u8 = 3;
pub const HEADER_LEN: usize = 26;
pub const CRC_LEN: usize = 4;
pub const GWSTAT_LEN: usize = 11;
pub const REC_HDR_LEN: usize = 16;
pub const CH_HDR_LEN: usize = 4;
pub const CTRL_LEN: usize = 9;
/// Largest payload accepted (a 32-patch gateway bundle is ~40 KB; META with 32 patches ~20 KB).
pub const MAX_PAYLOAD: usize = 4 << 20;

pub const F_META: u8 = 0x01;
pub const F_GWSTAT: u8 = 0x02;
pub const F_KEEPALIVE: u8 = 0x04;
pub const F_CTRL: u8 = 0x08;
pub const CTRL_NACK: u8 = 1;

/// Record flag bits (patch state).
pub const R_LEAD_OFF: u8 = 0x01;
pub const R_MOTION: u8 = 0x02;
pub const R_LOW_BATTERY: u8 = 0x04;
pub const R_SPO2_OFF: u8 = 0x08;
pub const R_PACEMAKER: u8 = 0x10;
pub const R_CHARGING: u8 = 0x20;
pub const R_NEW_PATCH: u8 = 0x40;

pub const CH_ECG: u8 = 1;
pub const CH_HR: u8 = 2;
pub const CH_TEMP: u8 = 3;
pub const CH_RESP: u8 = 4;
pub const CH_SPO2: u8 = 5;
pub const CH_GLUCOSE: u8 = 6;
pub const CH_ACCEL: u8 = 7;
pub const CH_PPG: u8 = 8;
pub const CH_RESP_WAVE: u8 = 9;
pub const CH_PACE: u8 = 10;

/// Waveform channels (int16 samples): key and physical scale from the emulator's channel table.
pub fn wave_info(ch: u8) -> Option<(&'static str, f32)> {
    match ch {
        CH_ECG => Some(("ecg", 0.001)),
        CH_ACCEL => Some(("accel", 0.001)),
        CH_PPG => Some(("ppg", 0.001)),
        CH_RESP_WAVE => Some(("resp_wave", 0.001)),
        _ => None,
    }
}

/// Bytes per sample for a dtype code (1 int16, 2 uint8, 3 uint16, 4 int8, 5 float32); 0 = unknown.
pub fn item_size(dtype: u8) -> usize {
    match dtype {
        1 | 3 => 2,
        2 | 4 => 1,
        5 => 4,
        _ => 0,
    }
}

/// Axes per sample: the accelerometer carries XYZ, everything else one value.
pub fn axes(ch: u8) -> usize {
    if ch == CH_ACCEL {
        3
    } else {
        1
    }
}

pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub flags: u8,
    pub gw_id: u32,
    pub seq: u32,
    pub ts_ms: u64,
    pub n_rec: u16,
    pub payload_len: u32,
}

impl Header {
    /// Parse 26 bytes; `None` when the magic does not match.
    pub fn parse(b: &[u8]) -> Option<Header> {
        if b.len() < HEADER_LEN || u16::from_le_bytes([b[0], b[1]]) != MAGIC {
            return None;
        }
        Some(Header {
            version: b[2],
            flags: b[3],
            gw_id: u32::from_le_bytes(b[4..8].try_into().unwrap()),
            seq: u32::from_le_bytes(b[8..12].try_into().unwrap()),
            ts_ms: u64::from_le_bytes(b[12..20].try_into().unwrap()),
            n_rec: u16::from_le_bytes(b[20..22].try_into().unwrap()),
            payload_len: u32::from_le_bytes(b[22..26].try_into().unwrap()),
        })
    }

    pub fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&MAGIC.to_le_bytes());
        out.push(self.version);
        out.push(self.flags);
        out.extend_from_slice(&self.gw_id.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.ts_ms.to_le_bytes());
        out.extend_from_slice(&self.n_rec.to_le_bytes());
        out.extend_from_slice(&self.payload_len.to_le_bytes());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct GwStatus {
    pub cpu: u8,
    pub mem: u8,
    pub net: u8,
    pub wan_rssi: i8,
    pub n_conn: u8,
    pub status: u8,
    pub uptime_s: u32,
    pub temp_c: u8,
}

impl GwStatus {
    pub fn parse(b: &[u8]) -> Option<GwStatus> {
        if b.len() < GWSTAT_LEN {
            return None;
        }
        Some(GwStatus {
            cpu: b[0],
            mem: b[1],
            net: b[2],
            wan_rssi: b[3] as i8,
            n_conn: b[4],
            status: b[5],
            uptime_s: u32::from_le_bytes(b[6..10].try_into().unwrap()),
            temp_c: b[10],
        })
    }
}

/// One channel block inside a record. `data` borrows the frame buffer.
#[derive(Debug, Clone)]
pub struct ChannelBlock<'a> {
    pub ch: u8,
    pub dtype: u8,
    pub n: u16,
    pub data: &'a [u8],
}

#[derive(Debug, Clone)]
pub struct Record<'a> {
    pub patch_id: u32,
    pub patient_id: u32,
    pub seq: u32,
    pub flags: u8,
    pub battery: u8,
    pub rssi: i8,
    pub channels: Vec<ChannelBlock<'a>>,
    /// The record bytes exactly as received (header + channel blocks) — stored verbatim.
    pub raw: &'a [u8],
}

/// A fully parsed, CRC-verified frame.
#[derive(Debug, Clone)]
pub struct Frame<'a> {
    pub hdr: Header,
    pub gw_status: Option<GwStatus>,
    pub meta_json: Option<&'a [u8]>,
    pub records: Vec<Record<'a>>,
    pub ctrl: Option<(u8, u32, u32)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    Truncated,
    BadChannel,
}

/// Decode a payload (header already parsed, CRC already checked).
pub fn parse_payload<'a>(hdr: Header, payload: &'a [u8]) -> Result<Frame<'a>, ParseError> {
    let mut off = 0usize;
    let mut gw_status = None;
    let mut meta_json = None;
    let mut ctrl = None;
    if hdr.flags & F_CTRL != 0 {
        if payload.len() < CTRL_LEN {
            return Err(ParseError::Truncated);
        }
        ctrl = Some((
            payload[0],
            u32::from_le_bytes(payload[1..5].try_into().unwrap()),
            u32::from_le_bytes(payload[5..9].try_into().unwrap()),
        ));
        return Ok(Frame { hdr, gw_status, meta_json, records: Vec::new(), ctrl });
    }
    if hdr.flags & F_GWSTAT != 0 {
        gw_status = Some(GwStatus::parse(&payload[off..]).ok_or(ParseError::Truncated)?);
        off += GWSTAT_LEN;
    }
    if hdr.flags & F_META != 0 {
        if payload.len() < off + 4 {
            return Err(ParseError::Truncated);
        }
        let n = u32::from_le_bytes(payload[off..off + 4].try_into().unwrap()) as usize;
        off += 4;
        if payload.len() < off + n {
            return Err(ParseError::Truncated);
        }
        meta_json = Some(&payload[off..off + n]);
        off += n;
    }
    let mut records = Vec::with_capacity(hdr.n_rec as usize);
    for _ in 0..hdr.n_rec {
        let start = off;
        if payload.len() < off + REC_HDR_LEN {
            return Err(ParseError::Truncated);
        }
        let b = &payload[off..off + REC_HDR_LEN];
        let patch_id = u32::from_le_bytes(b[0..4].try_into().unwrap());
        let patient_id = u32::from_le_bytes(b[4..8].try_into().unwrap());
        let seq = u32::from_le_bytes(b[8..12].try_into().unwrap());
        let flags = b[12];
        let battery = b[13];
        let rssi = b[14] as i8;
        let n_ch = b[15] as usize;
        off += REC_HDR_LEN;
        let mut channels = Vec::with_capacity(n_ch);
        for _ in 0..n_ch {
            if payload.len() < off + CH_HDR_LEN {
                return Err(ParseError::Truncated);
            }
            let ch = payload[off];
            let dtype = payload[off + 1];
            let n = u16::from_le_bytes([payload[off + 2], payload[off + 3]]);
            off += CH_HDR_LEN;
            let isz = item_size(dtype);
            if isz == 0 {
                return Err(ParseError::BadChannel);
            }
            let size = n as usize * axes(ch) * isz;
            if payload.len() < off + size {
                return Err(ParseError::Truncated);
            }
            channels.push(ChannelBlock { ch, dtype, n, data: &payload[off..off + size] });
            off += size;
        }
        records.push(Record { patch_id, patient_id, seq, flags, battery, rssi, channels, raw: &payload[start..off] });
    }
    Ok(Frame { hdr, gw_status, meta_json, records, ctrl })
}

/// Build a complete frame (header + payload + CRC trailer).
pub fn encode_frame(gw_id: u32, seq: u32, ts_ms: u64, n_rec: u16, payload: &[u8], flags: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + payload.len() + CRC_LEN);
    Header { version: VERSION, flags, gw_id, seq, ts_ms, n_rec, payload_len: payload.len() as u32 }.write(&mut out);
    out.extend_from_slice(payload);
    let c = crc32(&out);
    out.extend_from_slice(&c.to_le_bytes());
    out
}

/// Router → gateway control frame (NACK etc.).
pub fn ctrl_frame(gw_id: u32, kind: u8, seq_from: u32, seq_to: u32, ts_ms: u64) -> Vec<u8> {
    let mut p = Vec::with_capacity(CTRL_LEN);
    p.push(kind);
    p.extend_from_slice(&seq_from.to_le_bytes());
    p.extend_from_slice(&seq_to.to_le_bytes());
    encode_frame(gw_id, 0, ts_ms, 0, &p, F_CTRL)
}

/// What the decoder hands back for each unit it pulls off the stream.
#[derive(Debug)]
pub enum Item {
    /// A verified frame: (header, payload). Caller runs `parse_payload`.
    Frame(Header, Vec<u8>),
    /// CRC mismatch: the header is still readable, so the caller can NACK that seq.
    BadCrc(Header),
}

/// Stream decoder: byte buffer → frames, with resync after garbage.
#[derive(Debug, Default)]
pub struct Decoder {
    buf: Vec<u8>,
    pub bad_magic: u64,
    pub bad_version: u64,
    pub oversize: u64,
    pub garbage_bytes: u64,
    pub resync: u64,
}

impl Decoder {
    pub fn new() -> Self {
        Self { buf: Vec::with_capacity(1 << 16), ..Default::default() }
    }

    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// Append bytes and pull every complete frame out.
    pub fn feed(&mut self, data: &[u8], out: &mut VecDeque<Item>) {
        self.buf.extend_from_slice(data);
        let mut off = 0usize;
        loop {
            if self.buf.len() - off < HEADER_LEN {
                break;
            }
            let hdr = match Header::parse(&self.buf[off..]) {
                Some(h) => h,
                None => {
                    self.bad_magic += 1;
                    off = self.resync_from(off + 1);
                    continue;
                }
            };
            if hdr.version < 2 || hdr.version > VERSION {
                self.bad_version += 1;
                off = self.resync_from(off + 1);
                continue;
            }
            let plen = hdr.payload_len as usize;
            if plen > MAX_PAYLOAD {
                self.oversize += 1;
                off = self.resync_from(off + 1);
                continue;
            }
            let trailer = if hdr.version >= 3 { CRC_LEN } else { 0 };
            let total = HEADER_LEN + plen + trailer;
            if self.buf.len() - off < total {
                break;
            }
            let body = &self.buf[off..off + HEADER_LEN + plen];
            if trailer > 0 {
                let want = u32::from_le_bytes(self.buf[off + HEADER_LEN + plen..off + total].try_into().unwrap());
                if crc32(body) != want {
                    out.push_back(Item::BadCrc(hdr));
                    off = self.resync_from(off + 1);
                    continue;
                }
            }
            out.push_back(Item::Frame(hdr, body[HEADER_LEN..].to_vec()));
            off += total;
        }
        if off > 0 {
            self.buf.drain(..off);
        }
    }

    /// Find the next plausible header at or after `from`; counts skipped bytes as garbage.
    fn resync_from(&mut self, from: usize) -> usize {
        self.resync += 1;
        let m = MAGIC.to_le_bytes();
        let n = self.buf.len();
        let start = from - 1;
        let pos = (from..n.saturating_sub(1))
            .find(|&i| self.buf[i] == m[0] && self.buf[i + 1] == m[1])
            .unwrap_or(n.saturating_sub(1).max(start));
        self.garbage_bytes += (pos - start) as u64;
        pos
    }
}

/// Human-readable channel key for a channel id (mirrors the emulator catalog).
pub fn channel_key(ch: u8) -> &'static str {
    match ch {
        1 => "ecg",
        2 => "hr",
        3 => "temp",
        4 => "resp",
        5 => "spo2",
        6 => "glucose",
        7 => "accel",
        8 => "ppg",
        9 => "resp_wave",
        10 => "pace",
        _ => "?",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(patch: u32, patient: u32, seq: u32, n_ecg: u16) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&patch.to_le_bytes());
        b.extend_from_slice(&patient.to_le_bytes());
        b.extend_from_slice(&seq.to_le_bytes());
        b.extend_from_slice(&[0u8, 97, (-55i8) as u8, 2]);
        b.extend_from_slice(&[1, 1]);
        b.extend_from_slice(&n_ecg.to_le_bytes());
        for i in 0..n_ecg {
            b.extend_from_slice(&((i as i16) * 3).to_le_bytes());
        }
        b.extend_from_slice(&[2, 2, 1, 0, 72]);
        b
    }

    #[test]
    fn roundtrip_frame_with_all_blocks() {
        let mut payload = vec![10, 20, 30, (-40i8) as u8, 2, 0, 0xE8, 0x03, 0, 0, 45];
        let meta = br#"{"gw":"GW-7","patches":[{"patch_id":1001}]}"#;
        payload.extend_from_slice(&(meta.len() as u32).to_le_bytes());
        payload.extend_from_slice(meta);
        payload.extend_from_slice(&record(1001, 55, 1, 50));
        payload.extend_from_slice(&record(1002, 56, 9, 50));
        let f = encode_frame(7, 1, 1000, 2, &payload, F_GWSTAT | F_META);
        assert_eq!(f.len(), HEADER_LEN + payload.len() + CRC_LEN);
        let mut dec = Decoder::new();
        let mut out = VecDeque::new();
        dec.feed(&f[..10], &mut out);
        assert!(out.is_empty());
        dec.feed(&f[10..], &mut out);
        let Some(Item::Frame(h, p)) = out.pop_front() else { panic!("frame expected") };
        assert_eq!(h.gw_id, 7);
        assert_eq!(h.n_rec, 2);
        let fr = parse_payload(h, &p).unwrap();
        let s = fr.gw_status.unwrap();
        assert_eq!((s.cpu, s.wan_rssi, s.uptime_s, s.temp_c), (10, -40, 1000, 45));
        assert_eq!(fr.meta_json.unwrap(), meta);
        assert_eq!(fr.records.len(), 2);
        let r = &fr.records[1];
        assert_eq!((r.patch_id, r.patient_id, r.seq, r.battery, r.rssi), (1002, 56, 9, 97, -55));
        assert_eq!(r.channels[0].ch, 1);
        assert_eq!(r.channels[0].n, 50);
        assert_eq!(r.channels[0].data.len(), 100);
        assert_eq!(r.channels[1].data, &[72]);
        assert_eq!(r.raw.len(), REC_HDR_LEN + 4 + 100 + 4 + 1);
        assert_eq!(dec.buffered(), 0);
    }

    #[test]
    fn bad_crc_reports_header_and_resyncs() {
        let a = encode_frame(9, 6, 2000, 1, &record(3001, 88, 6, 10), 0);
        let b = encode_frame(9, 7, 2200, 1, &record(3001, 88, 7, 10), 0);
        let mut bad = a.clone();
        bad[HEADER_LEN + 2] ^= 0xFF;
        let mut stream = bad;
        stream.extend_from_slice(&b);
        let mut dec = Decoder::new();
        let mut out = VecDeque::new();
        dec.feed(&stream, &mut out);
        assert!(matches!(out.pop_front(), Some(Item::BadCrc(h)) if h.seq == 6));
        assert!(matches!(out.pop_front(), Some(Item::Frame(h, _)) if h.seq == 7));
        assert!(out.is_empty());
        assert!(dec.resync >= 1);
    }

    #[test]
    fn garbage_before_frame_is_skipped() {
        let b = encode_frame(1, 1, 0, 0, &[], F_KEEPALIVE);
        let mut stream = vec![0u8; 13];
        stream.extend_from_slice(&b);
        let mut dec = Decoder::new();
        let mut out = VecDeque::new();
        dec.feed(&stream, &mut out);
        assert!(matches!(out.pop_front(), Some(Item::Frame(h, _)) if h.flags == F_KEEPALIVE));
        assert_eq!(dec.garbage_bytes, 13);
    }

    #[test]
    fn ctrl_frame_parses() {
        let f = ctrl_frame(9, CTRL_NACK, 3, 4, 5);
        let h = Header::parse(&f).unwrap();
        assert_eq!(h.flags, F_CTRL);
        let fr = parse_payload(h, &f[HEADER_LEN..f.len() - CRC_LEN]).unwrap();
        assert_eq!(fr.ctrl, Some((CTRL_NACK, 3, 4)));
    }
}
