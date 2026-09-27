//! 전송 지연(travel time) 집계 — 에뮬레이터(게이트웨이) → 라우터.
//!
//! 프레임 헤더 `ts_ms`(송신 시각)와 라우터 수신 시각의 차이를 표본(8프레임에 1개)으로 링에 모아 p50/p95 를 낸다.
//! 시계는 세 장비(에뮬레이터·라우터·뷰어)가 모두 NTP 로 맞춰져 있다는 전제로 보정하지 않는다(사용자 결정 2026-09-28).
//! 재전송(NACK 응답)·keepalive 프레임은 제외 — 재생분은 실제 전송 지연이 아니다.
//! 라우터 → 뷰어 구간은 WS stream_batch 헤더의 `sent_ms` 로 브라우저가 계산한다(`web/console/src/ws.js`).

//! **시계 보정값**: 에뮬레이터 시계가 앞서 있으면 나이가 음수로 나온다. 음수가 보일 때마다 그 절대값이 지금 보정값보다
//! 크면 보정값을 올리고(단조 증가), 모든 나이에 보정값을 더해 쓴다. 보정값은 `router.db` 에 남고 **가동 초기화** 또는
//! 네트워크 설정의 **지연시간 계산 리셋** 에서만 0 으로 돌아간다(사용자 결정 2026-09-28).

use rusqlite::{params, Connection};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use tracing::info;

const CAP: usize = 4096;
const EVERY: u64 = 8;

static RING: LazyLock<Mutex<VecDeque<i32>>> = LazyLock::new(|| Mutex::new(VecDeque::with_capacity(CAP)));
static CTR: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);
static LAST_MS: AtomicU64 = AtomicU64::new(0);
/// 시계 보정값(ms, ≥ 0): 관측된 음수 나이의 최대 절대값
static OFFSET_MS: AtomicI64 = AtomicI64::new(0);
/// 마지막 리셋 시각(ms) — 뷰어가 자기 브라우저 보정값을 함께 버리는 기준(WS 헤더 `lat_epoch`)
static RESET_MS: AtomicU64 = AtomicU64::new(0);
const K_RESET: &str = "latency_reset_ms";
static DB_PATH: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));
const K_OFFSET: &str = "latency_offset_ms";

/// 시작 때: 저장된 보정값을 불러온다
pub fn init(db_path: &str) {
    *DB_PATH.lock().unwrap() = db_path.to_string();
    if let Ok(db) = Connection::open(db_path) {
        let _ = db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []);
        if let Ok(v) = db.query_row("SELECT value FROM settings WHERE key = ?1", params![K_OFFSET], |r| r.get::<_, String>(0)) {
            if let Ok(n) = v.parse::<i64>() {
                OFFSET_MS.store(n.max(0), Ordering::Relaxed);
            }
        }
        if let Ok(v) = db.query_row("SELECT value FROM settings WHERE key = ?1", params![K_RESET], |r| r.get::<_, String>(0)) {
            if let Ok(n) = v.parse::<u64>() {
                RESET_MS.store(n, Ordering::Relaxed);
            }
        }
    }
    let o = OFFSET_MS.load(Ordering::Relaxed);
    if o > 0 {
        info!("latency: clock correction {} ms (from db)", o);
    }
}

fn persist_offset(v: i64) {
    let path = DB_PATH.lock().unwrap().clone();
    if path.is_empty() {
        return;
    }
    if let Ok(db) = Connection::open(&path) {
        let _ = db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![K_OFFSET, v.to_string()]);
    }
}

pub fn offset_ms() -> i64 {
    OFFSET_MS.load(Ordering::Relaxed)
}

pub fn reset_epoch() -> u64 {
    RESET_MS.load(Ordering::Relaxed)
}

/// 보정값과 표본을 0 으로 (가동 초기화 · 네트워크 설정 › 지연시간 계산 리셋)
pub fn reset_offset() {
    OFFSET_MS.store(0, Ordering::Relaxed);
    persist_offset(0);
    let now = crate::protocol::now_ms();
    RESET_MS.store(now, Ordering::Relaxed);
    let path = DB_PATH.lock().unwrap().clone();
    if !path.is_empty() {
        if let Ok(db) = Connection::open(&path) {
            let _ = db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![K_RESET, now.to_string()]);
        }
    }
    reset();
    info!("latency: clock correction reset to 0");
}

/// 프레임 하나의 나이(수신 − 송신, ms). 음수면 그만큼 보정값을 올리고(최대값 유지), 보정값을 더한 값을 표본으로 둔다.
pub fn record(age_ms: i64) {
    TOTAL.fetch_add(1, Ordering::Relaxed);
    let mut off = OFFSET_MS.load(Ordering::Relaxed);
    if age_ms < 0 && -age_ms > off {
        // 더 큰 음수가 보였다: 보정값 갱신 (여러 스레드가 동시에 와도 큰 값이 남는다)
        off = OFFSET_MS.fetch_max(-age_ms, Ordering::Relaxed).max(-age_ms);
        persist_offset(off);
        info!("latency: clock correction -> {} ms (frame age {} ms)", off, age_ms);
    }
    if CTR.fetch_add(1, Ordering::Relaxed) % EVERY != 0 {
        return;
    }
    let v = (age_ms + off).clamp(i32::MIN as i64, i32::MAX as i64) as i32;
    let mut r = RING.lock().unwrap();
    if r.len() >= CAP {
        r.pop_front();
    }
    r.push_back(v);
    LAST_MS.store(crate::protocol::now_ms(), Ordering::Relaxed);
}

/// {p50, p95, avg, min, max, n, frames, last_ms} — 최근 표본 4096개(초당 5k 프레임이면 약 6초 창)
pub fn stats() -> serde_json::Value {
    let mut v: Vec<i32> = RING.lock().unwrap().iter().copied().collect();
    if v.is_empty() {
        return serde_json::json!({ "n": 0, "offset_ms": OFFSET_MS.load(Ordering::Relaxed), "reset_epoch": RESET_MS.load(Ordering::Relaxed) });
    }
    v.sort_unstable();
    let n = v.len();
    let q = |p: f64| v[((n as f64 - 1.0) * p).round() as usize];
    let avg = v.iter().map(|x| *x as f64).sum::<f64>() / n as f64;
    serde_json::json!({
        "p50": q(0.5), "p95": q(0.95), "avg": (avg * 10.0).round() / 10.0, "min": v[0], "max": v[n - 1],
        "n": n, "frames": TOTAL.load(Ordering::Relaxed), "last_ms": LAST_MS.load(Ordering::Relaxed),
        "offset_ms": OFFSET_MS.load(Ordering::Relaxed), "reset_epoch": RESET_MS.load(Ordering::Relaxed),
    })
}

pub fn reset() {
    RING.lock().unwrap().clear();
    TOTAL.store(0, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn negative_age_raises_correction_monotonically() {
        reset_offset();
        record(-120); // 에뮬레이터 시계가 120 ms 앞섬
        assert_eq!(offset_ms(), 120);
        record(-40); // 더 작은 음수는 보정값을 낮추지 않는다
        assert_eq!(offset_ms(), 120);
        record(-300);
        assert_eq!(offset_ms(), 300);
        reset();
        for _ in 0..8 {
            record(-300); // 보정 뒤 0
        }
        assert_eq!(stats()["p50"].as_i64(), Some(0));
        reset_offset();
        assert_eq!(offset_ms(), 0);
    }

    #[test]
    fn percentiles() {
        reset_offset();
        for i in 0..800 {
            record(i % 100); // 표본은 8개에 1개 → 0,8,16,…
        }
        let s = stats();
        assert_eq!(s["n"].as_u64(), Some(100));
        assert!(s["p50"].as_i64().unwrap() >= 40 && s["p50"].as_i64().unwrap() <= 56, "{}", s);
        assert!(s["p95"].as_i64().unwrap() >= 88, "{}", s);
    }
}
