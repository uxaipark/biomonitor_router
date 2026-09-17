//! Gateway table: one row per `gw_id` seen on the ingest port — link state, frame/record counters, GW_STATUS,
//! META summary, NACK bookkeeping (protocol v3 resend requests) and the per-gateway sequence checker.

use crate::wire::{self, GwStatus};
use dashmap::DashMap;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// NACK policy (mirrors the Python draft): one request per gateway per 0.5 s, a seq asked at most 3 times,
/// at most 200 frames per request, unanswered requests expire after 10 s.
const NACK_MIN_GAP: Duration = Duration::from_millis(500);
const NACK_MAX_TRIES: u8 = 3;
const NACK_MAX_RANGE: u32 = 200;
const NACK_EXPIRE: Duration = Duration::from_secs(10);
/// A gateway whose socket is up but sent nothing for this long is flagged `silent`.
const SILENCE: Duration = Duration::from_secs(10);
/// A seq this far behind the last one (~200 s of frames at 200 ms) is not a late frame but a restarted counter
/// (emulator/gateway restart): re-base instead of counting every following frame as a reorder. A seq behind the
/// last one on the first frame of a new socket is treated the same way regardless of distance.
pub const SEQ_RESTART_BACK: u32 = 1024;

#[derive(Debug, Clone, Default, Serialize)]
pub struct GwLocation {
    pub building: String,
    pub floor: i64,
    pub room: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug)]
pub struct GwEntry {
    pub gw_id: u32,
    pub conn: Option<u64>,
    pub addr: String,
    pub tx: Option<mpsc::Sender<Vec<u8>>>,
    pub connected: bool,
    pub first_seen: Instant,
    pub last_seen: Instant,
    pub last_seq: Option<u32>,
    pub last_ts_ms: u64,
    pub frames: u64,
    pub records: u64,
    pub keepalive: u64,
    pub dup_conn: u64,
    pub status: Option<GwStatus>,
    pub meta_at: Option<Instant>,
    pub meta_v: Option<u64>,
    pub name: String,
    pub gw_type: String,
    pub location: GwLocation,
    pub patches: Vec<u32>,
    pub recovered: u64,
    pub nack_tx: u64,
    pub resend_lost: u64,
    pub seq_gap: u64,
    pub seq_dup: u64,
    pub seq_reorder: u64,
    pub seq_restart: u64,
    pub bad_crc: u64,
    pub silent: bool,
    pending: HashMap<u32, (Instant, u8)>,
    last_nack: Option<Instant>,
}

impl GwEntry {
    fn new(gw_id: u32) -> Self {
        let now = Instant::now();
        Self {
            gw_id,
            conn: None,
            addr: String::new(),
            tx: None,
            connected: false,
            first_seen: now,
            last_seen: now,
            last_seq: None,
            last_ts_ms: 0,
            frames: 0,
            records: 0,
            keepalive: 0,
            dup_conn: 0,
            status: None,
            meta_at: None,
            meta_v: None,
            name: String::new(),
            gw_type: String::new(),
            location: GwLocation::default(),
            patches: Vec::new(),
            recovered: 0,
            nack_tx: 0,
            resend_lost: 0,
            seq_gap: 0,
            seq_dup: 0,
            seq_reorder: 0,
            seq_restart: 0,
            bad_crc: 0,
            silent: false,
            pending: HashMap::new(),
            last_nack: None,
        }
    }
}

/// Admin/API view of one gateway.
#[derive(Debug, Clone, Serialize)]
pub struct GwInfo {
    pub gw_id: u32,
    pub name: String,
    #[serde(rename = "type")]
    pub gw_type: String,
    pub connected: bool,
    pub silent: bool,
    pub addr: String,
    pub conn: Option<u64>,
    pub uptime_s: u64,
    pub since_last_s: f64,
    pub last_seq: Option<u32>,
    pub last_ts_ms: u64,
    pub frames: u64,
    pub records: u64,
    pub keepalive: u64,
    pub dup_conn: u64,
    pub status: Option<GwStatus>,
    pub meta_age_s: Option<f64>,
    pub patches: usize,
    pub location: GwLocation,
    pub recovered: u64,
    pub nack_tx: u64,
    pub resend_pending: usize,
    pub resend_lost: u64,
    pub seq_gap: u64,
    pub seq_dup: u64,
    pub seq_reorder: u64,
    pub seq_restart: u64,
    pub bad_crc: u64,
}

/// What `on_frame` decided about a frame's sequence number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeqVerdict {
    Ok,
    /// Missing frames before this one (count); a NACK was sent when the gap was small enough.
    Gap(u32),
    Dup,
    Reorder,
    /// This frame answers a pending NACK.
    Recovered,
}

/// Aggregate counters across all gateways (exposed on /api/stats).
#[derive(Debug, Default)]
pub struct Totals {
    pub frames: AtomicU64,
    pub records: AtomicU64,
    pub keepalive: AtomicU64,
    pub meta: AtomicU64,
    pub meta_bad_json: AtomicU64,
    pub bad_crc: AtomicU64,
    pub bad_payload: AtomicU64,
    pub bad_magic: AtomicU64,
    pub bad_version: AtomicU64,
    pub oversize: AtomicU64,
    pub garbage_bytes: AtomicU64,
    pub resync: AtomicU64,
    pub seq_gap: AtomicU64,
    pub seq_missing: AtomicU64,
    pub seq_dup: AtomicU64,
    pub seq_reorder: AtomicU64,
    pub seq_restart: AtomicU64,
    pub patch_seq_gap: AtomicU64,
    pub patch_seq_missing: AtomicU64,
    pub patch_seq_dup: AtomicU64,
    pub patch_seq_reorder: AtomicU64,
    pub patch_seq_restart: AtomicU64,
    /// Same-seq continuation records (pace marks split off by the emulator) — informational, not an anomaly.
    pub patch_cont: AtomicU64,
    pub nack_tx: AtomicU64,
    pub recovered: AtomicU64,
    pub resend_lost: AtomicU64,
    pub dup_gw: AtomicU64,
    pub ctrl_rx: AtomicU64,
}

macro_rules! inc {
    ($t:expr, $f:ident) => {
        $t.$f.fetch_add(1, Ordering::Relaxed)
    };
    ($t:expr, $f:ident, $n:expr) => {
        $t.$f.fetch_add($n as u64, Ordering::Relaxed)
    };
}

pub struct GatewayTable {
    gws: DashMap<u32, GwEntry>,
    pub totals: Totals,
}

impl Default for GatewayTable {
    fn default() -> Self {
        Self::new()
    }
}

impl GatewayTable {
    pub fn new() -> Self {
        Self { gws: DashMap::new(), totals: Totals::default() }
    }

    pub fn len(&self) -> usize {
        self.gws.len()
    }

    pub fn is_empty(&self) -> bool {
        self.gws.is_empty()
    }

    pub fn connected_count(&self) -> usize {
        self.gws.iter().filter(|g| g.connected).count()
    }

    /// Record a frame header from connection `conn`. Returns the seq verdict and whether this gateway is new
    /// (or moved to a new connection) so the caller can log it.
    pub fn on_frame(
        &self,
        conn: u64,
        addr: &str,
        tx: &mpsc::Sender<Vec<u8>>,
        hdr: &wire::Header,
    ) -> (SeqVerdict, bool) {
        let t = &self.totals;
        inc!(t, frames);
        let mut g = self.gws.entry(hdr.gw_id).or_insert_with(|| GwEntry::new(hdr.gw_id));
        let mut link_changed = false;
        let new_conn = g.conn != Some(conn);
        if g.conn.is_none() {
            link_changed = true;
        } else if g.conn != Some(conn) && g.connected {
            // The same gw_id is alive on another socket (emulator drill `dup_id`, or a replacement unit still
            // carrying the old number): count it and follow the newest socket.
            g.dup_conn += 1;
            inc!(t, dup_gw);
            link_changed = g.dup_conn == 1;
        }
        if g.conn != Some(conn) {
            g.conn = Some(conn);
            g.addr = addr.to_string();
            g.tx = Some(tx.clone());
            g.connected = true;
            link_changed = true;
        }
        g.frames += 1;
        g.silent = false;
        g.last_seen = Instant::now();
        g.last_ts_ms = g.last_ts_ms.max(hdr.ts_ms);
        if hdr.flags & wire::F_KEEPALIVE != 0 {
            g.keepalive += 1;
            inc!(t, keepalive);
        }
        let verdict = self.track_seq(&mut g, hdr.seq, new_conn);
        (verdict, link_changed)
    }

    fn track_seq(&self, g: &mut GwEntry, seq: u32, new_conn: bool) -> SeqVerdict {
        let t = &self.totals;
        if g.pending.remove(&seq).is_some() {
            g.recovered += 1;
            inc!(t, recovered);
            return SeqVerdict::Recovered;
        }
        let Some(last) = g.last_seq else {
            g.last_seq = Some(seq);
            return SeqVerdict::Ok;
        };
        let d = seq.wrapping_sub(last);
        if d == 1 {
            g.last_seq = Some(seq);
            SeqVerdict::Ok
        } else if d == 0 {
            g.seq_dup += 1;
            inc!(t, seq_dup);
            SeqVerdict::Dup
        } else if d < 1 << 31 {
            g.seq_gap += 1;
            inc!(t, seq_gap);
            inc!(t, seq_missing, d - 1);
            let missing = d - 1;
            if missing <= NACK_MAX_RANGE {
                self.nack(g, last.wrapping_add(1), seq.wrapping_sub(1));
            } else {
                // Beyond the gateway keep buffer: ask for the most recent window only.
                self.nack(g, seq.wrapping_sub(NACK_MAX_RANGE), seq.wrapping_sub(1));
            }
            g.last_seq = Some(seq);
            SeqVerdict::Gap(missing)
        } else if new_conn || last.wrapping_sub(seq) > SEQ_RESTART_BACK {
            // Behind on the first frame of a new socket = the sender restarted (store-and-forward replay after a
            // reconnect continues *after* the last seq), however short its previous run was.
            g.last_seq = Some(seq);
            g.pending.clear();
            g.seq_restart += 1;
            inc!(t, seq_restart);
            SeqVerdict::Ok
        } else {
            g.seq_reorder += 1;
            inc!(t, seq_reorder);
            SeqVerdict::Reorder
        }
    }

    /// A frame with a bad CRC: the header is trusted enough to ask for that seq again.
    pub fn on_corrupt(&self, conn: u64, addr: &str, tx: &mpsc::Sender<Vec<u8>>, hdr: &wire::Header) {
        inc!(self.totals, bad_crc);
        let mut g = self.gws.entry(hdr.gw_id).or_insert_with(|| GwEntry::new(hdr.gw_id));
        if g.conn != Some(conn) {
            g.conn = Some(conn);
            g.addr = addr.to_string();
            g.tx = Some(tx.clone());
            g.connected = true;
        }
        g.bad_crc += 1;
        g.last_seen = Instant::now();
        self.nack(&mut g, hdr.seq, hdr.seq);
    }

    /// Ask the gateway (on its own socket) to resend seq_from..seq_to (inclusive, wrapping).
    fn nack(&self, g: &mut GwEntry, seq_from: u32, seq_to: u32) {
        let now = Instant::now();
        let span = seq_to.wrapping_sub(seq_from).min(NACK_MAX_RANGE - 1);
        let mut fresh: Vec<u32> = Vec::new();
        for i in 0..=span {
            let q = seq_from.wrapping_add(i);
            if g.pending.get(&q).map(|p| p.1).unwrap_or(0) < NACK_MAX_TRIES {
                fresh.push(q);
            }
        }
        if fresh.is_empty() || g.last_nack.map(|t| now.duration_since(t) < NACK_MIN_GAP).unwrap_or(false) {
            return;
        }
        let (a, b) = (fresh[0], *fresh.last().unwrap());
        for q in &fresh {
            let e = g.pending.entry(*q).or_insert((now, 0));
            e.1 += 1;
        }
        g.last_nack = Some(now);
        if let Some(tx) = &g.tx {
            let frame = wire::ctrl_frame(g.gw_id, wire::CTRL_NACK, a, b, crate::protocol::now_ms());
            if tx.try_send(frame).is_ok() {
                g.nack_tx += 1;
                inc!(self.totals, nack_tx);
            }
        }
    }

    pub fn on_status(&self, gw_id: u32, st: GwStatus) {
        if let Some(mut g) = self.gws.get_mut(&gw_id) {
            g.status = Some(st);
        }
    }

    /// Store the META summary. Returns true when the block differs from the last one seen (by its `v` stamp).
    pub fn on_meta(&self, gw_id: u32, meta: &serde_json::Value) -> bool {
        inc!(self.totals, meta);
        let Some(mut g) = self.gws.get_mut(&gw_id) else { return false };
        let v = meta.get("v").and_then(|x| x.as_u64());
        g.meta_at = Some(Instant::now());
        let changed = v.is_none() || g.meta_v != v;
        g.meta_v = v;
        if changed {
            g.name = meta.get("gw").and_then(|x| x.as_str()).unwrap_or("").to_string();
            g.gw_type = meta.get("type").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if let Some(l) = meta.get("location") {
                g.location = GwLocation {
                    building: l.get("building").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    floor: l.get("floor").and_then(|x| x.as_i64()).unwrap_or(0),
                    room: l.get("room").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    x: l.get("x").and_then(|x| x.as_f64()).unwrap_or(0.0),
                    y: l.get("y").and_then(|x| x.as_f64()).unwrap_or(0.0),
                };
            }
            g.patches = meta
                .get("patches")
                .and_then(|p| p.as_array())
                .map(|a| a.iter().filter_map(|p| p.get("patch_id").and_then(|x| x.as_u64()).map(|x| x as u32)).collect())
                .unwrap_or_default();
        }
        changed
    }

    pub fn add_records(&self, gw_id: u32, n: usize) {
        inc!(self.totals, records, n);
        if let Some(mut g) = self.gws.get_mut(&gw_id) {
            g.records += n as u64;
        }
    }

    /// Socket `conn` closed: mark its gateways disconnected. Returns their ids.
    pub fn on_conn_closed(&self, conn: u64) -> Vec<u32> {
        let mut out = Vec::new();
        for mut g in self.gws.iter_mut() {
            if g.conn == Some(conn) {
                g.connected = false;
                g.conn = None;
                g.tx = None;
                g.silent = false;
                g.pending.clear();
                out.push(g.gw_id);
            }
        }
        out
    }

    pub fn location_of(&self, gw_id: u32) -> Option<(String, GwLocation)> {
        self.gws.get(&gw_id).map(|g| (g.name.clone(), g.location.clone()))
    }

    /// Housekeeping (1 Hz): expire unanswered NACKs, flag silent gateways. Returns newly silent gateway ids.
    pub fn housekeeping(&self) -> Vec<u32> {
        let now = Instant::now();
        let mut newly_silent = Vec::new();
        for mut g in self.gws.iter_mut() {
            let before = g.pending.len();
            g.pending.retain(|_, (t0, _)| now.duration_since(*t0) < NACK_EXPIRE);
            let expired = (before - g.pending.len()) as u64;
            if expired > 0 {
                g.resend_lost += expired;
                inc!(self.totals, resend_lost, expired);
            }
            if g.connected && !g.silent && now.duration_since(g.last_seen) > SILENCE {
                g.silent = true;
                newly_silent.push(g.gw_id);
            }
        }
        newly_silent
    }

    pub fn resend_pending(&self) -> usize {
        self.gws.iter().map(|g| g.pending.len()).sum()
    }

    pub fn snapshot(&self) -> Vec<GwInfo> {
        let now = Instant::now();
        let mut v: Vec<GwInfo> = self
            .gws
            .iter()
            .map(|g| GwInfo {
                gw_id: g.gw_id,
                name: g.name.clone(),
                gw_type: g.gw_type.clone(),
                connected: g.connected,
                silent: g.silent,
                addr: g.addr.clone(),
                conn: g.conn,
                uptime_s: now.duration_since(g.first_seen).as_secs(),
                since_last_s: now.duration_since(g.last_seen).as_secs_f64(),
                last_seq: g.last_seq,
                last_ts_ms: g.last_ts_ms,
                frames: g.frames,
                records: g.records,
                keepalive: g.keepalive,
                dup_conn: g.dup_conn,
                status: g.status,
                meta_age_s: g.meta_at.map(|t| now.duration_since(t).as_secs_f64()),
                patches: g.patches.len(),
                location: g.location.clone(),
                recovered: g.recovered,
                nack_tx: g.nack_tx,
                resend_pending: g.pending.len(),
                resend_lost: g.resend_lost,
                seq_gap: g.seq_gap,
                seq_dup: g.seq_dup,
                seq_reorder: g.seq_reorder,
                seq_restart: g.seq_restart,
                bad_crc: g.bad_crc,
            })
            .collect();
        v.sort_by_key(|g| g.gw_id);
        v
    }

    /// Aggregate view for /api/stats and the status report.
    pub fn summary(&self) -> serde_json::Value {
        let t = &self.totals;
        let l = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let mut anomalies = serde_json::Map::new();
        for (k, a) in [
            ("bad_crc", &t.bad_crc),
            ("bad_payload", &t.bad_payload),
            ("bad_magic", &t.bad_magic),
            ("bad_version", &t.bad_version),
            ("oversize", &t.oversize),
            ("garbage_bytes", &t.garbage_bytes),
            ("resync", &t.resync),
            ("seq_gap", &t.seq_gap),
            ("seq_missing", &t.seq_missing),
            ("seq_dup", &t.seq_dup),
            ("seq_reorder", &t.seq_reorder),
            ("seq_restart", &t.seq_restart),
            ("patch_seq_gap", &t.patch_seq_gap),
            ("patch_seq_missing", &t.patch_seq_missing),
            ("patch_seq_dup", &t.patch_seq_dup),
            ("patch_seq_reorder", &t.patch_seq_reorder),
            ("patch_seq_restart", &t.patch_seq_restart),
            ("meta_bad_json", &t.meta_bad_json),
            ("ctrl_rx", &t.ctrl_rx),
        ] {
            let v = l(a);
            if v > 0 {
                anomalies.insert(k.into(), v.into());
            }
        }
        let (mut down, mut degraded, mut silent) = (0u64, 0u64, 0u64);
        for g in self.gws.iter() {
            if !g.connected {
                down += 1;
            } else if g.silent {
                silent += 1;
            } else if g.status.map(|s| s.status).unwrap_or(0) != 0 {
                degraded += 1;
            }
        }
        serde_json::json!({
            "gateways": self.gws.len(),
            "connected": self.gws.len() as u64 - down,
            "down": down, "degraded": degraded, "silent": silent,
            "frames": l(&t.frames), "records": l(&t.records), "keepalive": l(&t.keepalive), "meta_blocks": l(&t.meta),
            "continuation_records": l(&t.patch_cont),
            "nack_tx": l(&t.nack_tx), "recovered": l(&t.recovered), "resend_lost": l(&t.resend_lost),
            "resend_pending": self.resend_pending(), "dup_gw_frames": l(&t.dup_gw),
            "anomalies": anomalies,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr(gw_id: u32, seq: u32) -> wire::Header {
        wire::Header { version: 1, flags: 0, gw_id, seq, ts_ms: 0, n_rec: 0, payload_len: 0 }
    }

    #[test]
    fn restarted_gateway_counter_is_rebased_not_reordered_forever() {
        let t = GatewayTable::new();
        let (tx, _rx) = mpsc::channel(64);
        for s in 50_000..50_010 {
            assert_eq!(t.on_frame(1, "a", &tx, &hdr(7, s)).0, SeqVerdict::Ok);
        }
        // A late frame a few seqs back is still a reorder.
        assert_eq!(t.on_frame(1, "a", &tx, &hdr(7, 50_005)).0, SeqVerdict::Reorder);
        // The emulator restarts: seq starts over on a new socket.
        assert_eq!(t.on_frame(2, "b", &tx, &hdr(7, 0)).0, SeqVerdict::Ok);
        for s in 1..100 {
            assert_eq!(t.on_frame(2, "b", &tx, &hdr(7, s)).0, SeqVerdict::Ok);
        }
        assert_eq!(t.totals.seq_restart.load(Ordering::Relaxed), 1);
        assert_eq!(t.totals.seq_reorder.load(Ordering::Relaxed), 1);
        // Gap detection works again after the restart.
        assert_eq!(t.on_frame(2, "b", &tx, &hdr(7, 103)).0, SeqVerdict::Gap(3));
        // A second restart after a short run (only ~100 seqs back) on a new socket is also a restart.
        assert_eq!(t.on_frame(3, "c", &tx, &hdr(7, 0)).0, SeqVerdict::Ok);
        assert_eq!(t.on_frame(3, "c", &tx, &hdr(7, 1)).0, SeqVerdict::Ok);
        assert_eq!(t.totals.seq_restart.load(Ordering::Relaxed), 2);
        // Store-and-forward replay after a reconnect continues after the last seq: an ordinary gap/ok.
        assert_eq!(t.on_frame(4, "d", &tx, &hdr(7, 2)).0, SeqVerdict::Ok);
        assert_eq!(t.totals.seq_reorder.load(Ordering::Relaxed), 1);
    }
}
