//! Per-patch record store (all channels, raw as received, entry CRC), byte-compatible with the Python draft
//! `router/store.py` so `verify_file()` there reads these files too.
//!
//! Layout:  `<root>/patches/<patch_id 8 digits>/<YYYYMMDD-HH>.rec[.gz]`  hourly append-only files (UTC hour of ts_ms)
//!          `<root>/patches/<patch_id>/index.json`                        first/last ts, record & byte counts, lost packets
//!          `<root>/meta/gw_<gw_id>.json`                                 last META block of every gateway (written on change)
//!
//! Entry:  `[ts_ms u64][gw_id u32][patient_id u32][seq u32][flags u8][battery u8][rssi i8][n_ch u8]` + channel blocks + `[crc32 u32]`
//! (crc32 = zlib CRC-32 over the entry before it).  The record bytes after `patch_id` are stored exactly as received.
//!
//! Writes are buffered per patch and flushed once a second (one write per patch per second instead of one per frame:
//! SD/SSD friendly); open handles live in a small LRU.  Closed hour files are gzip-compressed in the background and the
//! store is pruned oldest-hour-first when it grows past the configured cap.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tracing::{info, warn};

use crate::wire::{self, CH_ECG};

pub const ENTRY_HDR_LEN: usize = 24;
/// Open hour-file handles. Must cover the patch count (2,000–2,500 here) or every 1 s flush reopens most files.
const MAX_OPEN: usize = 4096;
const FLUSH_EVERY: Duration = Duration::from_secs(1);
const INDEX_EVERY: Duration = Duration::from_secs(60);
/// index.json writes per 1 s flush (2,000 patches → each index lands within ~20 s of coming due).
const INDEX_PER_FLUSH: usize = 100;

/// Total bytes on disk (rec + rec.gz), maintained incrementally and rescanned every 10 minutes.
pub static STORE_BYTES: AtomicU64 = AtomicU64::new(0);
pub static STORE_PATCHES: AtomicU64 = AtomicU64::new(0);
/// Debug gauges set by the writer thread each flush: patch buffers held, open file handles, bytes buffered.
pub static STORE_BUFS: AtomicU64 = AtomicU64::new(0);
pub static STORE_OPEN: AtomicU64 = AtomicU64::new(0);
pub static STORE_BUFFERED: AtomicU64 = AtomicU64::new(0);
/// Live per-patch index (updated by the writer thread on every flush) so the API does not wait for index.json.
pub static LIVE_INDEX: std::sync::LazyLock<dashmap::DashMap<u32, PatchIndex>> = std::sync::LazyLock::new(dashmap::DashMap::new);

/// Work sent to the writer thread.
pub enum StoreOp {
    /// `raw` = record bytes as received: `[patch_id u32]` + the rest (patient_id, seq, flags, battery, rssi, n_ch, blocks).
    Record { ts_ms: u64, gw_id: u32, raw: Vec<u8> },
    Meta { gw_id: u32, json: Vec<u8> },
    /// Flush everything and write every index (shutdown / test).
    Flush,
    /// Delete the whole store (admin test > storage reset) and start empty.
    Reset,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PatchIndex {
    pub patch_id: u32,
    pub patient_id: u32,
    pub gw_id: u32,
    pub first_ts_ms: u64,
    pub last_ts_ms: u64,
    pub last_seq: u32,
    pub records: u64,
    pub bytes: u64,
    /// Packets missing by the patch's own seq counter (a gap = lost between patch and router).
    pub lost: u64,
    pub files: u32,
}

struct PatchBuf {
    buf: Vec<u8>,
    hour: String,
    file: Option<File>,
    last_used: Instant,
    index: PatchIndex,
    index_written: Instant,
    index_dirty: bool,
}

pub struct PatchStore {
    root: PathBuf,
    max_bytes: u64,
    patches: HashMap<u32, PatchBuf>,
    open: usize,
    last_flush: Instant,
    last_scan: Instant,
    meta_seen: HashMap<u32, u64>,
    gzip_tx: std::sync::mpsc::Sender<PathBuf>,
}

pub fn patch_dir(root: &Path, patch_id: u32) -> PathBuf {
    root.join("patches").join(format!("{patch_id:08}"))
}

/// UTC hour key `YYYYMMDD-HH` for a unix-ms timestamp (no timezone crate: civil-from-days algorithm).
pub fn hour_key(ts_ms: u64) -> String {
    let secs = ts_ms / 1000;
    let days = (secs / 86_400) as i64;
    let hour = (secs % 86_400) / 3600;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}-{hour:02}")
}

/// Build one on-disk entry from a received record (`raw` starts with patch_id).
pub fn encode_entry(ts_ms: u64, gw_id: u32, raw: &[u8]) -> Vec<u8> {
    let mut e = Vec::with_capacity(ENTRY_HDR_LEN + raw.len() - 4 + 4);
    e.extend_from_slice(&ts_ms.to_le_bytes());
    e.extend_from_slice(&gw_id.to_le_bytes());
    e.extend_from_slice(&raw[4..]);
    let c = wire::crc32(&e);
    e.extend_from_slice(&c.to_le_bytes());
    e
}

/// A decoded store entry (owned).
#[derive(Debug, Clone)]
pub struct Entry {
    pub ts_ms: u64,
    pub gw_id: u32,
    pub patient_id: u32,
    pub seq: u32,
    pub flags: u8,
    pub battery: u8,
    pub rssi: i8,
    /// (ch, dtype, n, data)
    pub channels: Vec<(u8, u8, u16, Vec<u8>)>,
}

/// Walk a buffer of entries. Returns (entries, bad_crc). `f` receives every entry whose CRC verifies.
pub fn walk_entries(buf: &[u8], mut f: impl FnMut(&Entry)) -> (u64, u64) {
    let (mut ok, mut bad) = (0u64, 0u64);
    let mut off = 0usize;
    while off + ENTRY_HDR_LEN <= buf.len() {
        let start = off;
        let b = &buf[off..off + ENTRY_HDR_LEN];
        let ts_ms = u64::from_le_bytes(b[0..8].try_into().unwrap());
        let gw_id = u32::from_le_bytes(b[8..12].try_into().unwrap());
        let patient_id = u32::from_le_bytes(b[12..16].try_into().unwrap());
        let seq = u32::from_le_bytes(b[16..20].try_into().unwrap());
        let flags = b[20];
        let battery = b[21];
        let rssi = b[22] as i8;
        let n_ch = b[23] as usize;
        off += ENTRY_HDR_LEN;
        let mut channels = Vec::with_capacity(n_ch);
        let mut truncated = false;
        for _ in 0..n_ch {
            if off + wire::CH_HDR_LEN > buf.len() {
                truncated = true;
                break;
            }
            let ch = buf[off];
            let dt = buf[off + 1];
            let n = u16::from_le_bytes([buf[off + 2], buf[off + 3]]);
            off += wire::CH_HDR_LEN;
            let size = n as usize * wire::axes(ch) * wire::item_size(dt);
            if off + size > buf.len() {
                truncated = true;
                break;
            }
            channels.push((ch, dt, n, buf[off..off + size].to_vec()));
            off += size;
        }
        if truncated || off + 4 > buf.len() {
            bad += 1;
            break;
        }
        let want = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap());
        let body_end = off;
        off += 4;
        if wire::crc32(&buf[start..body_end]) == want {
            ok += 1;
            f(&Entry { ts_ms, gw_id, patient_id, seq, flags, battery, rssi, channels });
        } else {
            bad += 1;
        }
    }
    (ok + bad, bad)
}

/// Read a `.rec` or `.rec.gz` file fully into memory.
pub fn read_file(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut raw = Vec::new();
    File::open(path)?.read_to_end(&mut raw)?;
    if path.extension().map(|e| e == "gz").unwrap_or(false) {
        let mut out = Vec::with_capacity(raw.len() * 3);
        flate2::read::GzDecoder::new(&raw[..]).read_to_end(&mut out)?;
        return Ok(out);
    }
    Ok(raw)
}

/// Hour files of a patch, sorted by hour key: (hour_key, path, size).
pub fn list_files(root: &Path, patch_id: u32) -> Vec<(String, PathBuf, u64)> {
    let mut v = Vec::new();
    if let Ok(rd) = fs::read_dir(patch_dir(root, patch_id)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(key) = name.strip_suffix(".rec").or_else(|| name.strip_suffix(".rec.gz")) {
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                v.push((key.to_string(), e.path(), size));
            }
        }
    }
    v.sort();
    v
}

#[derive(Debug, Default, Serialize)]
pub struct VerifyReport {
    pub patch_id: u32,
    pub files: u32,
    pub entries: u64,
    pub bad: u64,
    pub bytes: u64,
    pub ok: bool,
}

pub fn verify_patch(root: &Path, patch_id: u32) -> VerifyReport {
    let mut r = VerifyReport { patch_id, ok: true, ..Default::default() };
    for (_, path, size) in list_files(root, patch_id) {
        r.files += 1;
        r.bytes += size;
        match read_file(&path) {
            Ok(buf) => {
                let (n, bad) = walk_entries(&buf, |_| {});
                r.entries += n;
                r.bad += bad;
            }
            Err(_) => r.bad += 1,
        }
    }
    r.ok = r.bad == 0;
    r
}

pub fn read_index(root: &Path, patch_id: u32) -> Option<PatchIndex> {
    if let Some(ix) = LIVE_INDEX.get(&patch_id) {
        return Some(ix.clone());
    }
    let s = fs::read_to_string(patch_dir(root, patch_id).join("index.json")).ok()?;
    serde_json::from_str(&s).ok()
}

/// ECG samples of a patch in [from_ms, to_ms): (ts_ms, seq, samples in mV).
pub fn read_ecg_range(root: &Path, patch_id: u32, from_ms: u64, to_ms: u64) -> Vec<(u64, u32, Vec<f32>)> {
    let mut out = Vec::new();
    let from_key = hour_key(from_ms);
    let to_key = hour_key(to_ms);
    for (key, path, _) in list_files(root, patch_id) {
        if key < from_key || key > to_key {
            continue;
        }
        let Ok(buf) = read_file(&path) else { continue };
        walk_entries(&buf, |e| {
            if e.ts_ms < from_ms || e.ts_ms >= to_ms {
                return;
            }
            if let Some((_, dt, _, data)) = e.channels.iter().find(|c| c.0 == CH_ECG) {
                if *dt == 1 {
                    let s: Vec<f32> = data
                        .chunks_exact(2)
                        .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 * 0.001)
                        .collect();
                    out.push((e.ts_ms, e.seq, s));
                }
            }
        });
    }
    out
}

/// (t, min, max) buckets of the ECG over a range — long-span overview.
pub fn overview(root: &Path, patch_id: u32, from_ms: u64, to_ms: u64, buckets: usize) -> Vec<(u64, f32, f32)> {
    let buckets = buckets.clamp(1, 20_000);
    let span = to_ms.saturating_sub(from_ms).max(1);
    let mut acc: Vec<(f32, f32, bool)> = vec![(f32::MAX, f32::MIN, false); buckets];
    for (ts, _, samples) in read_ecg_range(root, patch_id, from_ms, to_ms) {
        let i = (((ts - from_ms) as u128 * buckets as u128) / span as u128) as usize;
        let i = i.min(buckets - 1);
        for v in samples {
            let a = &mut acc[i];
            a.0 = a.0.min(v);
            a.1 = a.1.max(v);
            a.2 = true;
        }
    }
    acc.into_iter()
        .enumerate()
        .filter(|(_, a)| a.2)
        .map(|(i, a)| (from_ms + (span * i as u64) / buckets as u64, a.0, a.1))
        .collect()
}

pub fn scan_bytes(root: &Path) -> (u64, u64) {
    let (mut total, mut patches) = (0u64, 0u64);
    if let Ok(rd) = fs::read_dir(root.join("patches")) {
        for d in rd.flatten() {
            patches += 1;
            if let Ok(files) = fs::read_dir(d.path()) {
                for f in files.flatten() {
                    total += f.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
        }
    }
    (total, patches)
}

impl PatchStore {
    pub fn new(root: PathBuf, max_bytes: u64) -> Self {
        fs::create_dir_all(root.join("patches")).ok();
        fs::create_dir_all(root.join("meta")).ok();
        let (total, patches) = scan_bytes(&root);
        STORE_BYTES.store(total, Ordering::Relaxed);
        STORE_PATCHES.store(patches, Ordering::Relaxed);
        let (gzip_tx, gzip_rx) = std::sync::mpsc::channel::<PathBuf>();
        std::thread::Builder::new()
            .name("store-gzip".into())
            .spawn(move || gzip_worker(gzip_rx))
            .expect("gzip thread");
        // Hour files left open by a previous run are compressed now.
        let store = Self {
            root,
            max_bytes,
            patches: HashMap::new(),
            open: 0,
            last_flush: Instant::now(),
            last_scan: Instant::now(),
            meta_seen: HashMap::new(),
            gzip_tx,
        };
        store.queue_stale_rec_files();
        store
    }

    fn queue_stale_rec_files(&self) {
        let now_key = hour_key(crate::protocol::now_ms());
        if let Ok(rd) = fs::read_dir(self.root.join("patches")) {
            for d in rd.flatten() {
                if let Ok(files) = fs::read_dir(d.path()) {
                    for f in files.flatten() {
                        let name = f.file_name().to_string_lossy().to_string();
                        if let Some(key) = name.strip_suffix(".rec") {
                            if key < now_key.as_str() {
                                let _ = self.gzip_tx.send(f.path());
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn handle(&mut self, op: StoreOp) {
        match op {
            StoreOp::Record { ts_ms, gw_id, raw } => self.record(ts_ms, gw_id, &raw),
            StoreOp::Meta { gw_id, json } => self.meta(gw_id, &json),
            StoreOp::Flush => self.flush(true),
            StoreOp::Reset => self.reset(),
        }
        if self.last_flush.elapsed() >= FLUSH_EVERY {
            self.flush(false);
        }
    }

    fn record(&mut self, ts_ms: u64, gw_id: u32, raw: &[u8]) {
        if raw.len() < wire::REC_HDR_LEN {
            return;
        }
        let patch_id = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        let patient_id = u32::from_le_bytes(raw[4..8].try_into().unwrap());
        let seq = u32::from_le_bytes(raw[8..12].try_into().unwrap());
        let key = hour_key(ts_ms);
        let root = self.root.clone();
        let pb = self.patches.entry(patch_id).or_insert_with(|| {
            let existing = read_index(&root, patch_id);
            let mut index = existing.clone().unwrap_or_default();
            index.patch_id = patch_id;
            if index.files == 0 {
                index.files = list_files(&root, patch_id).len() as u32;
            }
            if existing.is_none() && index.files == 0 {
                STORE_PATCHES.fetch_add(1, Ordering::Relaxed); // a patch never seen on disk before
            }
            PatchBuf {
                buf: Vec::with_capacity(8192),
                hour: String::new(),
                file: None,
                last_used: Instant::now(),
                index,
                index_written: Instant::now(),
                index_dirty: true,
            }
        });
        if pb.hour != key {
            // Hour rollover: flush what belongs to the old file first (records are appended in arrival order).
            if !pb.buf.is_empty() {
                Self::write_buf(&root, patch_id, pb, &mut self.open);
            }
            if let Some(f) = pb.file.take() {
                drop(f);
                self.open = self.open.saturating_sub(1);
                if !pb.hour.is_empty() {
                    let _ = self.gzip_tx.send(patch_dir(&root, patch_id).join(format!("{}.rec", pb.hour)));
                }
            }
            pb.hour = key;
            pb.index.files += 1;
        }
        let e = encode_entry(ts_ms, gw_id, raw);
        let ix = &mut pb.index;
        if ix.records > 0 && ix.last_seq != 0 {
            let d = seq.wrapping_sub(ix.last_seq);
            if d > 1 && d < 1 << 24 {
                ix.lost += (d - 1) as u64;
            }
        }
        if ix.records == 0 || ts_ms < ix.first_ts_ms {
            ix.first_ts_ms = ts_ms;
        }
        ix.last_ts_ms = ix.last_ts_ms.max(ts_ms);
        ix.last_seq = seq;
        ix.records += 1;
        ix.bytes += e.len() as u64;
        ix.patient_id = patient_id;
        ix.gw_id = gw_id;
        pb.index_dirty = true;
        pb.buf.extend_from_slice(&e);
        pb.last_used = Instant::now();
    }

    fn write_buf(root: &Path, patch_id: u32, pb: &mut PatchBuf, open: &mut usize) {
        if pb.buf.is_empty() {
            return;
        }
        if pb.file.is_none() {
            let dir = patch_dir(root, patch_id);
            if fs::create_dir_all(&dir).is_err() {
                return;
            }
            match OpenOptions::new().create(true).append(true).open(dir.join(format!("{}.rec", pb.hour))) {
                Ok(f) => {
                    pb.file = Some(f);
                    *open += 1;
                }
                Err(e) => {
                    warn!("store: open patch {} failed: {}", patch_id, e);
                    pb.buf.clear();
                    return;
                }
            }
        }
        if let Some(f) = pb.file.as_mut() {
            match f.write_all(&pb.buf) {
                Ok(()) => {
                    STORE_BYTES.fetch_add(pb.buf.len() as u64, Ordering::Relaxed);
                }
                Err(e) => warn!("store: write patch {} failed: {}", patch_id, e),
            }
        }
        pb.buf.clear();
        // A replay burst can grow a patch buffer to hundreds of KB; keep the steady-state capacity small
        // (≈1.5 KB/s per patch) so 2,000+ buffers do not pin tens of MB.
        if pb.buf.capacity() > 8 * 1024 {
            pb.buf.shrink_to(4 * 1024);
        }
    }

    /// Write buffered entries, rotate index files, evict idle handles, prune over the cap.
    pub fn flush(&mut self, force: bool) {
        let t0 = Instant::now();
        self.last_flush = t0;
        let mut n_files = 0usize;
        let root = self.root.clone();
        let mut open = self.open;
        let now = Instant::now();
        // index.json writes are spread over flushes (≤ INDEX_PER_FLUSH each): after a restart every patch's index
        // comes due at the same second, and 2,000 small write+rename pairs stall the writer for seconds on SD.
        let mut index_writes = 0usize;
        for (pid, pb) in self.patches.iter_mut() {
            if !pb.buf.is_empty() {
                n_files += 1;
            }
            Self::write_buf(&root, *pid, pb, &mut open);
            if pb.index_dirty {
                LIVE_INDEX.insert(*pid, pb.index.clone());
            }
            if pb.index_dirty && (force || (index_writes < INDEX_PER_FLUSH && now.duration_since(pb.index_written) >= INDEX_EVERY)) {
                index_writes += 1;
                if let Ok(s) = serde_json::to_string(&pb.index) {
                    let dir = patch_dir(&root, *pid);
                    let tmp = dir.join("index.json.tmp");
                    if fs::write(&tmp, s).and_then(|_| fs::rename(&tmp, dir.join("index.json"))).is_ok() {
                        pb.index_dirty = false;
                        pb.index_written = now;
                    }
                }
            }
        }
        let t_write = t0.elapsed();
        // Idle handles close every flush (a retired patch must not hold a file forever); patches silent for
        // 15 min drop their buffer entirely (the registry prunes them on the same clock).
        let mut gone: Vec<u32> = Vec::new();
        for (pid, pb) in self.patches.iter_mut() {
            let idle = now.duration_since(pb.last_used);
            if pb.file.is_some() && idle > Duration::from_secs(300) {
                pb.file = None;
                open -= 1;
            }
            if pb.file.is_none() && pb.buf.is_empty() && !pb.index_dirty && idle > Duration::from_secs(900) {
                gone.push(*pid);
            }
        }
        for pid in gone {
            self.patches.remove(&pid);
            LIVE_INDEX.remove(&pid);
        }
        // LRU: keep at most MAX_OPEN handles; close the least recently used.
        if open > MAX_OPEN || force {
            let mut by_age: Vec<(Instant, u32)> =
                self.patches.iter().filter(|(_, p)| p.file.is_some()).map(|(k, p)| (p.last_used, *k)).collect();
            by_age.sort();
            let excess = open.saturating_sub(MAX_OPEN / 2);
            for (i, (t, pid)) in by_age.into_iter().enumerate() {
                if i < excess || force || now.duration_since(t) > Duration::from_secs(300) {
                    if let Some(pb) = self.patches.get_mut(&pid) {
                        if pb.file.take().is_some() {
                            open -= 1;
                        }
                    }
                }
            }
        }
        self.open = open;
        STORE_BUFS.store(self.patches.len() as u64, Ordering::Relaxed);
        STORE_OPEN.store(open as u64, Ordering::Relaxed);
        STORE_BUFFERED.store(self.patches.values().map(|p| p.buf.capacity() as u64).sum(), Ordering::Relaxed);
        let t_evict = t0.elapsed();
        let mut scanned = false;
        if self.last_scan.elapsed() >= Duration::from_secs(600) {
            self.last_scan = Instant::now();
            let (total, patches) = scan_bytes(&self.root);
            STORE_BYTES.store(total, Ordering::Relaxed);
            STORE_PATCHES.store(patches, Ordering::Relaxed);
            scanned = true;
        }
        if self.max_bytes > 0 && STORE_BYTES.load(Ordering::Relaxed) > self.max_bytes {
            self.prune();
        }
        let total = t0.elapsed();
        if total > Duration::from_millis(300) {
            warn!(
                "store: slow flush {} ms (write {} ms / {} files, {} index, evict {} ms, scan {}, prune {})",
                total.as_millis(), t_write.as_millis(), n_files, index_writes, (t_evict - t_write).as_millis(), scanned,
                self.max_bytes > 0 && STORE_BYTES.load(Ordering::Relaxed) > self.max_bytes
            );
        }
    }

    /// Delete the oldest hour files (across all patches) until the store is under 90% of the cap.
    fn prune(&mut self) {
        let target = self.max_bytes / 10 * 9;
        let mut files: BTreeMap<(String, u32), (PathBuf, u64)> = BTreeMap::new();
        if let Ok(rd) = fs::read_dir(self.root.join("patches")) {
            for d in rd.flatten() {
                let pid: u32 = d.file_name().to_string_lossy().parse().unwrap_or(0);
                for (key, path, size) in list_files(&self.root, pid) {
                    files.insert((key, pid), (path, size));
                }
            }
        }
        let mut total = STORE_BYTES.load(Ordering::Relaxed);
        let mut removed = 0u64;
        for ((key, pid), (path, size)) in files {
            if total <= target {
                break;
            }
            if let Some(pb) = self.patches.get(&pid) {
                if pb.hour == key {
                    continue; // never delete the file being written
                }
            }
            if fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
                removed += size;
            }
        }
        STORE_BYTES.store(total, Ordering::Relaxed);
        if removed > 0 {
            info!("store: pruned {} MB (cap {} MB)", removed >> 20, self.max_bytes >> 20);
        }
    }

    fn meta(&mut self, gw_id: u32, json: &[u8]) {
        // The emulator stamps every META with a version `v`; only a changed block is written.
        let v = serde_json::from_slice::<serde_json::Value>(json)
            .ok()
            .and_then(|m| m.get("v").and_then(|x| x.as_u64()))
            .unwrap_or_else(|| wire::crc32(json) as u64);
        if self.meta_seen.get(&gw_id) == Some(&v) {
            return;
        }
        self.meta_seen.insert(gw_id, v);
        let path = self.root.join("meta").join(format!("gw_{gw_id}.json"));
        let tmp = self.root.join("meta").join(format!(".gw_{gw_id}.tmp"));
        if fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &path)).is_err() {
            warn!("store: meta write for gw {} failed", gw_id);
        }
    }

    fn reset(&mut self) {
        self.patches.clear();
        self.open = 0;
        self.meta_seen.clear();
        LIVE_INDEX.clear();
        let _ = fs::remove_dir_all(self.root.join("patches"));
        let _ = fs::remove_dir_all(self.root.join("meta"));
        fs::create_dir_all(self.root.join("patches")).ok();
        fs::create_dir_all(self.root.join("meta")).ok();
        STORE_BYTES.store(0, Ordering::Relaxed);
        STORE_PATCHES.store(0, Ordering::Relaxed);
        info!("store: reset");
    }
}

fn gzip_worker(rx: std::sync::mpsc::Receiver<PathBuf>) {
    while let Ok(path) = rx.recv() {
        if !path.exists() {
            continue;
        }
        let gz = path.with_extension("rec.gz");
        let tmp = path.with_extension("rec.gz.tmp");
        let res = (|| -> std::io::Result<(u64, u64)> {
            let mut src = File::open(&path)?;
            let before = src.metadata()?.len();
            let mut enc = flate2::write::GzEncoder::new(File::create(&tmp)?, flate2::Compression::new(3));
            std::io::copy(&mut src, &mut enc)?;
            let out = enc.finish()?;
            out.sync_all()?;
            fs::rename(&tmp, &gz)?;
            let after = fs::metadata(&gz)?.len();
            fs::remove_file(&path)?;
            Ok((before, after))
        })();
        match res {
            Ok((before, after)) => {
                STORE_BYTES.fetch_add(after, Ordering::Relaxed);
                STORE_BYTES.fetch_sub(before.min(STORE_BYTES.load(Ordering::Relaxed)), Ordering::Relaxed);
            }
            Err(e) => {
                warn!("store: gzip {} failed: {}", path.display(), e);
                let _ = fs::remove_file(&tmp);
            }
        }
    }
}

/// Writer thread: drains the store queue; flushes every second even when idle.
pub fn run_writer(root: PathBuf, max_bytes: u64, mut rx: tokio::sync::mpsc::Receiver<StoreOp>) {
    let mut store = PatchStore::new(root, max_bytes);
    info!("patch store: {} (cap {} GB)", store.root.display(), max_bytes >> 30);
    loop {
        match rx.blocking_recv() {
            Some(op) => store.handle(op),
            None => {
                store.flush(true);
                return;
            }
        }
        // Idle flush: nothing arriving for a second still lands on disk.
        while let Ok(op) = rx.try_recv() {
            store.handle(op);
        }
        if store.last_flush.elapsed() >= FLUSH_EVERY {
            store.flush(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(patch: u32, patient: u32, seq: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(&patch.to_le_bytes());
        b.extend_from_slice(&patient.to_le_bytes());
        b.extend_from_slice(&seq.to_le_bytes());
        b.extend_from_slice(&[0u8, 90, (-60i8) as u8, 1]);
        b.extend_from_slice(&[1, 1, 4, 0]);
        for i in 0..4i16 {
            b.extend_from_slice(&(i * 100).to_le_bytes());
        }
        b
    }

    #[test]
    fn hour_keys() {
        assert_eq!(hour_key(0), "19700101-00");
        assert_eq!(hour_key(1_726_567_200_000), "20240917-10");
    }

    #[test]
    fn entries_roundtrip_and_detect_corruption() {
        let dir = std::env::temp_dir().join(format!("pstore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut st = PatchStore::new(dir.clone(), 0);
        let t0 = 1_726_567_200_000u64;
        for s in 1..=5u32 {
            st.record(t0 + s as u64 * 200, 7, &raw(3001, 88, s));
        }
        st.record(t0 + 3_600_000, 7, &raw(3001, 88, 9)); // next hour, seq gap 6..8
        st.flush(true);
        let files = list_files(&dir, 3001);
        assert_eq!(files.len(), 2);
        let v = verify_patch(&dir, 3001);
        assert!(v.ok && v.entries == 6, "{v:?}");
        let ix = read_index(&dir, 3001).unwrap();
        assert_eq!((ix.records, ix.lost, ix.patient_id, ix.gw_id, ix.files), (6, 3, 88, 7, 2));
        let ecg = read_ecg_range(&dir, 3001, t0, t0 + 2000);
        assert_eq!(ecg.len(), 5);
        assert_eq!(ecg[0].2, vec![0.0, 0.1, 0.2, 0.3]);
        // flip a bit on disk
        let p = &files[0].1;
        let mut b = fs::read(p).unwrap();
        b[40] ^= 1;
        fs::write(p, b).unwrap();
        let v2 = verify_patch(&dir, 3001);
        assert!(!v2.ok && v2.bad >= 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
