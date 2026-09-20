//! Long-term operating statistics for a 24/7/365 service.
//!
//! A collector thread samples the router every 2 s (cheap counters only: atomics, a queue length and the
//! CPU/memory values the admin API already computes) and writes **one row per minute** into the router's
//! SQLite database. Minute rows are rolled up into hour rows and pruned after 14 days, so a year costs a few
//! MB and the page can plot a day, week, month, quarter or year without touching the hot path.
//!
//! Tables (in `ROUTER_DB_PATH`):
//!   metrics_min  — one row per minute: gauges (avg/max over the minute) and counter deltas for that minute
//!   metrics_hour — one row per hour: the same, aggregated
//!   incidents    — router restarts, store stalls, WS lag bursts, queue drops, disk pressure
//!
//! Counters (rx/tx bytes, records, lost, ws lag, drops) are stored as per-interval deltas, so summing any
//! range is exact even across restarts.

use crate::state::AppState;
use rusqlite::{params, Connection};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

const SAMPLE_MS: u64 = 2_000;
const MIN_KEEP_DAYS: i64 = 14;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS metrics_min (
  ts INTEGER PRIMARY KEY, uptime_s INTEGER NOT NULL DEFAULT 0,
  cpu_proc REAL, cpu_proc_max REAL, cpu_sys REAL,
  mem_proc INTEGER, mem_used INTEGER, mem_total INTEGER,
  disk_used INTEGER, disk_total INTEGER, store_bytes INTEGER, store_patches INTEGER,
  patches INTEGER, connected INTEGER, gw_total INTEGER, gw_connected INTEGER,
  ingest_conns INTEGER, ws_sessions INTEGER, ws_subs INTEGER, alarms_active INTEGER,
  store_q_max INTEGER,
  d_rx INTEGER, d_tx INTEGER, d_records INTEGER, d_lost INTEGER, d_lag INTEGER, d_drops INTEGER
);
CREATE TABLE IF NOT EXISTS metrics_hour (
  ts INTEGER PRIMARY KEY, samples INTEGER,
  cpu_proc REAL, cpu_proc_max REAL, cpu_sys REAL,
  mem_proc INTEGER, mem_proc_max INTEGER, mem_used INTEGER, mem_total INTEGER,
  disk_used INTEGER, disk_total INTEGER, store_bytes INTEGER, store_patches INTEGER,
  patches INTEGER, connected INTEGER, connected_min INTEGER, gw_total INTEGER, gw_connected INTEGER,
  ingest_conns INTEGER, ws_sessions INTEGER, ws_subs INTEGER, alarms_active INTEGER,
  store_q_max INTEGER,
  d_rx INTEGER, d_tx INTEGER, d_records INTEGER, d_lost INTEGER, d_lag INTEGER, d_drops INTEGER
);
CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', value INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS incidents_ts ON incidents(ts);
";

pub fn now_s() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Handle used by the API to read what the collector wrote.
pub struct Metrics {
    pub db: Mutex<Connection>,
}

impl Metrics {
    pub fn open(path: &str) -> Self {
        let db = Connection::open(path).unwrap_or_else(|e| {
            warn!("metrics db {} open failed ({}); using in-memory db", path, e);
            Connection::open_in_memory().expect("in-memory sqlite")
        });
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("metrics schema: {}", e);
        }
        Self { db: Mutex::new(db) }
    }

    pub fn incident(&self, kind: &str, detail: &str, value: i64) {
        if let Ok(db) = self.db.lock() {
            let _ = db.execute(
                "INSERT INTO incidents (ts, kind, detail, value) VALUES (?1,?2,?3,?4)",
                params![now_s(), kind, detail, value],
            );
        }
    }
}

#[derive(Default, Clone, Copy)]
struct Counters {
    rx: u64,
    tx: u64,
    records: u64,
    lost: u64,
    lag: u64,
    drops: u64,
}

fn counters(state: &AppState) -> Counters {
    Counters {
        rx: state.total_bytes.load(Ordering::Relaxed),
        tx: state.total_tx_bytes.load(Ordering::Relaxed),
        records: state.total_packets.load(Ordering::Relaxed),
        lost: state.total_lost_packets.load(Ordering::Relaxed),
        lag: state.ws_lagged.load(Ordering::Relaxed),
        drops: state.dropped_wave.load(Ordering::Relaxed),
    }
}

/// Collector thread: 2 s sampling, one row per minute, hourly rollup, daily prune.
pub fn run(state: Arc<AppState>) {
    let m = &state.metrics;
    // a gap between the last stored minute and now is downtime — record it as a restart incident
    let last_ts: i64 = m
        .db
        .lock()
        .ok()
        .and_then(|db| db.query_row("SELECT MAX(ts) FROM metrics_min", [], |r| r.get::<_, Option<i64>>(0)).ok().flatten())
        .unwrap_or(0);
    let gap = if last_ts > 0 { now_s() - last_ts } else { 0 };
    m.incident("restart", if gap > 90 { "재시작 (수집 공백)" } else { "재시작" }, gap.max(0));
    info!("metrics collector started (previous sample {} s ago)", gap);

    let mut prev = counters(&state);
    let mut minute = now_s() / 60;
    let mut last_hour_rolled = 0i64;
    let mut last_prune = 0i64;
    // per-minute accumulators
    let (mut n, mut cpu_sum, mut cpu_max, mut sys_sum, mut q_max) = (0u32, 0f64, 0f64, 0f64, 0i64);
    let mut stall_open = false;

    loop {
        std::thread::sleep(Duration::from_millis(SAMPLE_MS));
        let cpu = crate::sysmon::proc_cpu_percent() as f64;
        let sys = crate::sysmon::cpu_percent() as f64;
        let q = (state.store_tx.max_capacity() - state.store_tx.capacity()) as i64;
        n += 1;
        cpu_sum += cpu;
        sys_sum += sys;
        if cpu > cpu_max {
            cpu_max = cpu;
        }
        if q > q_max {
            q_max = q;
        }
        // a backlog building up means the disk stalled; log it once per stall with its peak
        if q > 5_000 && !stall_open {
            stall_open = true;
        } else if stall_open && q < 500 {
            stall_open = false;
            m.incident("store_stall", "저장 큐 적체 (디스크 지연)", q_max);
        }

        let cur_minute = now_s() / 60;
        if cur_minute == minute {
            continue;
        }
        let ts = minute * 60;
        minute = cur_minute;
        let c = counters(&state);
        let d = |now: u64, was: u64| now.saturating_sub(was) as i64;
        let (mem_proc, mem_used, mem_total) = crate::sysmon::memory_stats_native();
        let (disk_total, disk_free) = crate::sysmon::disk_stats();
        let gw = state.gateways.summary();
        let gwv = |k: &str| gw.get(k).and_then(|v| v.as_u64()).unwrap_or(0) as i64;
        let row = params![
            ts,
            state.started_at.elapsed().as_secs() as i64,
            cpu_sum / n.max(1) as f64,
            cpu_max,
            sys_sum / n.max(1) as f64,
            mem_proc as i64,
            mem_used as i64,
            mem_total as i64,
            (disk_total - disk_free) as i64,
            disk_total as i64,
            crate::patch_store::STORE_BYTES.load(Ordering::Relaxed) as i64,
            crate::patch_store::STORE_PATCHES.load(Ordering::Relaxed) as i64,
            state.registry.len() as i64,
            state.registry.connected_count() as i64,
            gwv("gateways"),
            gwv("connected"),
            state.ingest_conns.load(Ordering::Relaxed) as i64,
            state.ws_sessions.load(Ordering::Relaxed) as i64,
            state.sub_channels.len() as i64,
            state.alarms.summary().get("active").and_then(|v| v.as_u64()).unwrap_or(0) as i64,
            q_max,
            d(c.rx, prev.rx),
            d(c.tx, prev.tx),
            d(c.records, prev.records),
            d(c.lost, prev.lost),
            d(c.lag, prev.lag),
            d(c.drops, prev.drops),
        ];
        if let Ok(db) = m.db.lock() {
            if let Err(e) = db.execute(
                "INSERT OR REPLACE INTO metrics_min VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27)",
                row,
            ) {
                warn!("metrics insert: {}", e);
            }
        }
        // incidents worth keeping out of the charts' noise
        if d(c.drops, prev.drops) > 0 {
            m.incident("queue_drop", "저장 큐 포화로 레코드 드롭", d(c.drops, prev.drops));
        }
        if d(c.lag, prev.lag) > 5_000 {
            m.incident("ws_lag", "WS 구독자 지연 (건너뛴 메시지)", d(c.lag, prev.lag));
        }
        if disk_total > 0 && disk_free * 10 < disk_total {
            m.incident("disk_low", "디스크 여유 10 % 미만", (disk_free / 1_048_576) as i64);
        }
        prev = c;
        n = 0;
        cpu_sum = 0.0;
        cpu_max = 0.0;
        sys_sum = 0.0;
        q_max = 0;

        let hour = ts / 3600;
        if hour != last_hour_rolled {
            last_hour_rolled = hour;
            rollup(m, (hour - 1) * 3600);
        }
        let day = ts / 86400;
        if day != last_prune {
            last_prune = day;
            prune(m);
        }
    }
}

/// Aggregate one hour of minute rows into `metrics_hour`.
fn rollup(m: &Metrics, hour_ts: i64) {
    let Ok(db) = m.db.lock() else { return };
    let r = db.execute(
        "INSERT OR REPLACE INTO metrics_hour
         SELECT ?1, COUNT(*), AVG(cpu_proc), MAX(cpu_proc_max), AVG(cpu_sys),
                AVG(mem_proc), MAX(mem_proc), AVG(mem_used), MAX(mem_total),
                MAX(disk_used), MAX(disk_total), MAX(store_bytes), MAX(store_patches),
                AVG(patches), AVG(connected), MIN(connected), MAX(gw_total), AVG(gw_connected),
                AVG(ingest_conns), AVG(ws_sessions), AVG(ws_subs), AVG(alarms_active),
                MAX(store_q_max), SUM(d_rx), SUM(d_tx), SUM(d_records), SUM(d_lost), SUM(d_lag), SUM(d_drops)
         FROM metrics_min WHERE ts >= ?1 AND ts < ?1 + 3600",
        params![hour_ts],
    );
    if let Err(e) = r {
        warn!("metrics rollup: {}", e);
    }
}

fn prune(m: &Metrics) {
    let Ok(db) = m.db.lock() else { return };
    let cut = now_s() - MIN_KEEP_DAYS * 86400;
    if let Err(e) = db.execute("DELETE FROM metrics_min WHERE ts < ?1", params![cut]) {
        warn!("metrics prune: {}", e);
    }
    let _ = db.execute("DELETE FROM incidents WHERE ts < ?1", params![now_s() - 400 * 86400]);
}

/// Range presets the page offers.
fn range_spec(range: &str) -> (i64, bool, i64) {
    // (seconds back, use minute table, bucket seconds)
    match range {
        "day" => (86_400, true, 300),            // 24 h, 5-min points
        "week" => (7 * 86_400, false, 3_600),    // 7 d, hourly
        "month" => (30 * 86_400, false, 4 * 3_600),
        "quarter" => (91 * 86_400, false, 86_400 / 2),
        "year" => (365 * 86_400, false, 86_400),
        _ => (3_600, true, 60), // "hour"
    }
}

/// Time series + totals for the ops page.
pub fn series(m: &Metrics, range: &str) -> serde_json::Value {
    let (back, use_min, bucket) = range_spec(range);
    let from = now_s() - back;
    let table = if use_min { "metrics_min" } else { "metrics_hour" };
    let Ok(db) = m.db.lock() else { return serde_json::json!({ "points": [] }) };
    // rollup the current (incomplete) hour so long ranges include the last minutes too
    if !use_min {
        let h = now_s() / 3600 * 3600;
        let _ = db.execute(
            "INSERT OR REPLACE INTO metrics_hour
             SELECT ?1, COUNT(*), AVG(cpu_proc), MAX(cpu_proc_max), AVG(cpu_sys),
                    AVG(mem_proc), MAX(mem_proc), AVG(mem_used), MAX(mem_total),
                    MAX(disk_used), MAX(disk_total), MAX(store_bytes), MAX(store_patches),
                    AVG(patches), AVG(connected), MIN(connected), MAX(gw_total), AVG(gw_connected),
                    AVG(ingest_conns), AVG(ws_sessions), AVG(ws_subs), AVG(alarms_active),
                    MAX(store_q_max), SUM(d_rx), SUM(d_tx), SUM(d_records), SUM(d_lost), SUM(d_lag), SUM(d_drops)
             FROM metrics_min WHERE ts >= ?1",
            params![h],
        );
    }
    // NOTE: read every aggregate as f64 — the rollup table stores averages, and SQLite column affinity makes
    // the same column come back INTEGER or REAL depending on the value, which fails a typed i64 read.
    let sql = format!(
        "SELECT (ts / {b}) * {b} AS bt,
                AVG(cpu_proc), MAX(cpu_proc_max), AVG(cpu_sys), AVG(mem_proc), MAX(mem_proc),
                AVG(mem_used), MAX(mem_total), MAX(disk_used), MAX(disk_total), MAX(store_bytes),
                AVG(patches), AVG(connected), MIN(connected), AVG(gw_connected), MAX(gw_total),
                AVG(ws_sessions), AVG(ws_subs), AVG(alarms_active), MAX(store_q_max),
                SUM(d_rx), SUM(d_tx), SUM(d_records), SUM(d_lost), SUM(d_lag), SUM(d_drops), COUNT(*)
         FROM {t} WHERE ts >= ?1 GROUP BY bt ORDER BY bt",
        b = bucket,
        t = table
    );
    let Ok(mut st) = db.prepare(&sql) else { return serde_json::json!({ "points": [] }) };
    let rows = st.query_map(params![from], |r| {
        Ok(serde_json::json!({
            "t": r.get::<_, i64>(0)?,
            "cpu": r.get::<_, Option<f64>>(1)?, "cpu_max": r.get::<_, Option<f64>>(2)?, "cpu_sys": r.get::<_, Option<f64>>(3)?,
            "mem": r.get::<_, Option<f64>>(4)?, "mem_max": r.get::<_, Option<f64>>(5)?,
            "mem_used": r.get::<_, Option<f64>>(6)?, "mem_total": r.get::<_, Option<f64>>(7)?,
            "disk_used": r.get::<_, Option<f64>>(8)?, "disk_total": r.get::<_, Option<f64>>(9)?, "store": r.get::<_, Option<f64>>(10)?,
            "patches": r.get::<_, Option<f64>>(11)?, "connected": r.get::<_, Option<f64>>(12)?, "connected_min": r.get::<_, Option<f64>>(13)?,
            "gw": r.get::<_, Option<f64>>(14)?, "gw_total": r.get::<_, Option<f64>>(15)?,
            "ws": r.get::<_, Option<f64>>(16)?, "subs": r.get::<_, Option<f64>>(17)?, "alarms": r.get::<_, Option<f64>>(18)?,
            "store_q": r.get::<_, Option<f64>>(19)?,
            "rx": r.get::<_, Option<f64>>(20)?, "tx": r.get::<_, Option<f64>>(21)?, "records": r.get::<_, Option<f64>>(22)?,
            "lost": r.get::<_, Option<f64>>(23)?, "lag": r.get::<_, Option<f64>>(24)?, "drops": r.get::<_, Option<f64>>(25)?,
            "samples": r.get::<_, i64>(26)?,
        }))
    });
    let points: Vec<serde_json::Value> = rows.map(|it| it.flatten().collect()).unwrap_or_default();

    // totals over the whole range, straight from the minute table when it covers it
    let tot_sql = format!(
        "SELECT SUM(d_rx), SUM(d_tx), SUM(d_records), SUM(d_lost), SUM(d_lag), SUM(d_drops), COUNT(*),
                AVG(cpu_proc), MAX(cpu_proc_max), AVG(mem_proc), MAX(mem_proc), MIN(connected), MAX(connected), AVG(connected)
         FROM {t} WHERE ts >= ?1",
        t = table
    );
    let totals = db
        .query_row(&tot_sql, params![from], |r| {
            Ok(serde_json::json!({
                "rx": r.get::<_, Option<f64>>(0)?, "tx": r.get::<_, Option<f64>>(1)?, "records": r.get::<_, Option<f64>>(2)?,
                "lost": r.get::<_, Option<f64>>(3)?, "lag": r.get::<_, Option<f64>>(4)?, "drops": r.get::<_, Option<f64>>(5)?,
                "rows": r.get::<_, i64>(6)?,
                "cpu_avg": r.get::<_, Option<f64>>(7)?, "cpu_max": r.get::<_, Option<f64>>(8)?,
                "mem_avg": r.get::<_, Option<f64>>(9)?, "mem_max": r.get::<_, Option<f64>>(10)?,
                "patients_min": r.get::<_, Option<f64>>(11)?, "patients_max": r.get::<_, Option<f64>>(12)?, "patients_avg": r.get::<_, Option<f64>>(13)?,
            }))
        })
        .unwrap_or(serde_json::json!({}));

    // coverage: minutes actually sampled vs expected (a 24/7 service should sit at 100 %)
    let expected_min = back / 60;
    let have_min: i64 = db
        .query_row("SELECT COUNT(*) FROM metrics_min WHERE ts >= ?1", params![from], |r| r.get(0))
        .unwrap_or(0);
    let covered = if use_min {
        have_min
    } else {
        db.query_row("SELECT COALESCE(SUM(samples),0) FROM metrics_hour WHERE ts >= ?1", params![from], |r| r.get(0))
            .unwrap_or(0)
    };
    let incidents: Vec<serde_json::Value> = db
        .prepare("SELECT ts, kind, detail, value FROM incidents WHERE ts >= ?1 ORDER BY ts DESC LIMIT 200")
        .and_then(|mut s| {
            let it = s.query_map(params![from], |r| {
                Ok(serde_json::json!({ "ts": r.get::<_, i64>(0)?, "kind": r.get::<_, String>(1)?, "detail": r.get::<_, String>(2)?, "value": r.get::<_, i64>(3)? }))
            })?;
            Ok(it.flatten().collect())
        })
        .unwrap_or_default();
    let counts = db
        .prepare("SELECT kind, COUNT(*) FROM incidents WHERE ts >= ?1 GROUP BY kind")
        .and_then(|mut s| {
            let it = s.query_map(params![from], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
            Ok(it.flatten().collect::<Vec<_>>())
        })
        .unwrap_or_default();
    let mut by_kind = serde_json::Map::new();
    for (k, v) in counts {
        by_kind.insert(k, serde_json::json!(v));
    }

    serde_json::json!({
        "range": range, "from": from, "to": now_s(), "bucket_s": bucket, "source": table,
        "points": points, "totals": totals,
        "coverage": { "expected_minutes": expected_min, "sampled_minutes": covered,
                      "percent": if expected_min > 0 { (covered as f64 / expected_min as f64 * 100.0).min(100.0) } else { 0.0 } },
        "incidents": incidents, "incident_counts": by_kind,
    })
}

/// Oldest sample, row counts and db size — shown on the page header.
pub fn info(m: &Metrics, db_path: &str) -> serde_json::Value {
    let Ok(db) = m.db.lock() else { return serde_json::json!({}) };
    let g = |sql: &str| db.query_row(sql, [], |r| r.get::<_, Option<i64>>(0)).ok().flatten().unwrap_or(0);
    let bytes = std::fs::metadata(db_path).map(|m| m.len()).unwrap_or(0)
        + std::fs::metadata(format!("{db_path}-wal")).map(|m| m.len()).unwrap_or(0);
    serde_json::json!({
        "first_ts": g("SELECT MIN(ts) FROM metrics_hour"),
        "first_min_ts": g("SELECT MIN(ts) FROM metrics_min"),
        "minute_rows": g("SELECT COUNT(*) FROM metrics_min"),
        "hour_rows": g("SELECT COUNT(*) FROM metrics_hour"),
        "incidents": g("SELECT COUNT(*) FROM incidents"),
        "db_bytes": bytes as i64,
        "keep_days": MIN_KEEP_DAYS,
    })
}

/// Wipe the collected statistics (the page's reset button). Live counters keep running.
pub fn reset(m: &Metrics) -> bool {
    let Ok(db) = m.db.lock() else { return false };
    let ok = db
        .execute_batch("DELETE FROM metrics_min; DELETE FROM metrics_hour; DELETE FROM incidents;")
        .is_ok();
    let _ = db.execute_batch("VACUUM;");
    if ok {
        let _ = db.execute(
            "INSERT INTO incidents (ts, kind, detail, value) VALUES (?1, 'reset', '운영 통계 초기화', 0)",
            params![now_s()],
        );
        info!("metrics reset");
    }
    ok
}

/// Start the collector on its own thread (SQLite writes must not sit on the async runtime).
pub fn spawn(state: Arc<AppState>) {
    std::thread::Builder::new()
        .name("metrics".into())
        .spawn(move || {
            // let the router settle (counters, first CPU sample) before the first row
            std::thread::sleep(Duration::from_secs(5));
            let _ = Instant::now();
            run(state)
        })
        .expect("metrics thread");
}
