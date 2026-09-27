//! 전송 지연(travel time) 집계 — 에뮬레이터(게이트웨이) → 라우터.
//!
//! 프레임 헤더 `ts_ms`(송신 시각)와 라우터 수신 시각의 차이를 표본(8프레임에 1개)으로 링에 모아 p50/p95 를 낸다.
//! 시계는 세 장비(에뮬레이터·라우터·뷰어)가 모두 NTP 로 맞춰져 있다는 전제로 보정하지 않는다(사용자 결정 2026-09-28).
//! 재전송(NACK 응답)·keepalive 프레임은 제외 — 재생분은 실제 전송 지연이 아니다.
//! 라우터 → 뷰어 구간은 WS stream_batch 헤더의 `sent_ms` 로 브라우저가 계산한다(`web/console/src/ws.js`).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

const CAP: usize = 4096;
const EVERY: u64 = 8;

static RING: LazyLock<Mutex<VecDeque<i32>>> = LazyLock::new(|| Mutex::new(VecDeque::with_capacity(CAP)));
static CTR: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);
static LAST_MS: AtomicU64 = AtomicU64::new(0);

/// 프레임 하나의 나이(수신 − 송신, ms). 음수도 그대로(시계 차이).
pub fn record(age_ms: i64) {
    TOTAL.fetch_add(1, Ordering::Relaxed);
    if CTR.fetch_add(1, Ordering::Relaxed) % EVERY != 0 {
        return;
    }
    let v = age_ms.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
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
        return serde_json::json!({ "n": 0 });
    }
    v.sort_unstable();
    let n = v.len();
    let q = |p: f64| v[((n as f64 - 1.0) * p).round() as usize];
    let avg = v.iter().map(|x| *x as f64).sum::<f64>() / n as f64;
    serde_json::json!({
        "p50": q(0.5), "p95": q(0.95), "avg": (avg * 10.0).round() / 10.0, "min": v[0], "max": v[n - 1],
        "n": n, "frames": TOTAL.load(Ordering::Relaxed), "last_ms": LAST_MS.load(Ordering::Relaxed),
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
    fn percentiles() {
        reset();
        for i in 0..800 {
            record(i % 100); // 표본은 8개에 1개 → 0,8,16,…
        }
        let s = stats();
        assert_eq!(s["n"].as_u64(), Some(100));
        assert!(s["p50"].as_i64().unwrap() >= 40 && s["p50"].as_i64().unwrap() <= 56, "{}", s);
        assert!(s["p95"].as_i64().unwrap() >= 88, "{}", s);
    }
}
