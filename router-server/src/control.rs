//! 서비스 제어 (운영관리 › 서비스 제어): 라우터의 주요 서비스를 한 곳에서 멈추고 다시 켠다.
//!
//! | 서비스     | 멈추면                                                            |
//! |-----------|------------------------------------------------------------------|
//! | ingest    | 게이트웨이 새 연결을 받지 않고 열린 연결을 끊는다(게이트웨이는 재접속을 시도) |
//! | store     | 파형 기록을 건너뛴다(수신·표시·알람은 계속)                              |
//! | stream    | 실시간 파형 전송(웹소켓)을 멈춘다 — 중앙 모니터·뷰어 파형이 멈춘다           |
//! | backup    | 백업 중단(전송 중인 파일까지 끊음) — 백업 정책의 일시 중지와 같다            |
//! | emr       | EMR 바이탈 전송 회차를 건너뛴다(재원 명단·입퇴원 수신은 계속)               |
//! | sync      | 에뮬레이터 EMR 동기화(입원 목록·환자 정보)를 멈춘다                       |
//! | alarm     | 알림 억제: 판정·기록은 계속, 화면 알림만 최대 60분(위험 등급은 선택)          |
//!
//! 상태는 router.db `settings`(key `control`)에 남아 재시작 뒤에도 유지된다 — 알람 억제만 재시작하면 풀린다.
//! `until_ms` 가 지나면 자동으로 다시 켠다(`run` 루프, 5초). 모든 변경은 감사 기록·이벤트로 남는다.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;
use tracing::{info, warn};

use crate::state::AppState;

pub static INGEST_ON: AtomicBool = AtomicBool::new(true);
pub static STORE_ON: AtomicBool = AtomicBool::new(true);
pub static STREAM_ON: AtomicBool = AtomicBool::new(true);
pub static EMR_ON: AtomicBool = AtomicBool::new(true);
pub static SYNC_ON: AtomicBool = AtomicBool::new(true);
/// 알람 알림 억제가 끝나는 시각(ms, 0 = 억제 없음)
pub static ALARM_MUTE_UNTIL: AtomicU64 = AtomicU64::new(0);
/// 억제 중에도 위험(critical) 알람은 알린다
pub static ALARM_MUTE_KEEP_CRITICAL: AtomicBool = AtomicBool::new(true);

pub const SERVICES: [(&str, &str); 7] = [
    ("ingest", "게이트웨이 수신"),
    ("store", "파형 저장"),
    ("stream", "실시간 스트리밍 (중앙 모니터·뷰어)"),
    ("alarm", "알람 알림"),
    ("backup", "백업"),
    ("emr", "EMR 전송"),
    ("sync", "에뮬레이터 동기화"),
];
pub const ALARM_MAX_MIN: u64 = 60;

/// 멈춘 서비스의 기록 (켜져 있으면 표에 없음)
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stop {
    pub by: String,
    pub at_ms: u64,
    pub reason: String,
    /// 자동 재개 시각 (0 = 수동으로 켤 때까지)
    #[serde(default)]
    pub until_ms: u64,
    /// 유지보수 모드로 멈춘 것
    #[serde(default)]
    pub maintenance: bool,
}

static BOOK: LazyLock<Mutex<BTreeMap<String, Stop>>> = LazyLock::new(|| Mutex::new(BTreeMap::new()));
static DB_PATH: LazyLock<Mutex<String>> = LazyLock::new(|| Mutex::new(String::new()));

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

fn flag(svc: &str) -> Option<&'static AtomicBool> {
    match svc {
        "ingest" => Some(&INGEST_ON),
        "store" => Some(&STORE_ON),
        "stream" => Some(&STREAM_ON),
        "emr" => Some(&EMR_ON),
        "sync" => Some(&SYNC_ON),
        _ => None,
    }
}

pub fn label(svc: &str) -> &'static str {
    SERVICES.iter().find(|s| s.0 == svc).map(|s| s.1).unwrap_or("알 수 없음")
}

fn save() {
    let path = DB_PATH.lock().unwrap().clone();
    if path.is_empty() {
        return;
    }
    // 알람 억제는 재시작하면 풀려야 하므로 저장하지 않는다
    let book: BTreeMap<String, Stop> = BOOK.lock().unwrap().iter().filter(|(k, _)| k.as_str() != "alarm").map(|(k, v)| (k.clone(), v.clone())).collect();
    match Connection::open(&path) {
        Ok(db) => {
            let _ = db.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)", []);
            let _ = db.execute(
                "INSERT INTO settings (key, value) VALUES ('control', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![serde_json::to_string(&book).unwrap_or_default()],
            );
        }
        Err(e) => warn!("control: save failed: {}", e),
    }
}

/// 시작 때: 저장된 멈춤 상태를 불러와 플래그에 반영 (backup 은 백업 정책의 paused 가 원본)
pub fn load(db_path: &str) {
    *DB_PATH.lock().unwrap() = db_path.to_string();
    let Ok(db) = Connection::open(db_path) else { return };
    let saved: Option<String> = db.query_row("SELECT value FROM settings WHERE key = 'control'", [], |r| r.get(0)).ok();
    let book: BTreeMap<String, Stop> = saved.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    for (svc, _) in book.iter() {
        if let Some(f) = flag(svc) {
            f.store(false, Ordering::Relaxed);
        }
    }
    if !book.is_empty() {
        info!("control: stopped at start — {}", book.keys().cloned().collect::<Vec<_>>().join(", "));
    }
    *BOOK.lock().unwrap() = book;
}

/// 알람 알림을 지금 억제하는가 (위험 등급은 keep_critical 이면 제외)
pub fn alarm_muted(now: u64) -> bool {
    ALARM_MUTE_UNTIL.load(Ordering::Relaxed) > now
}

/// 화면용 요약: 멈춘 서비스 목록 + 알람 억제
pub fn status(state: &AppState) -> serde_json::Value {
    let now = now_ms();
    let book = BOOK.lock().unwrap().clone();
    let backup_paused = state.backup.paused();
    let services: Vec<serde_json::Value> = SERVICES
        .iter()
        .map(|(k, l)| {
            let on = match *k {
                "backup" => !backup_paused,
                "alarm" => !alarm_muted(now),
                s => flag(s).map(|f| f.load(Ordering::Relaxed)).unwrap_or(true),
            };
            let stop = book.get(*k);
            serde_json::json!({
                "service": k, "label": l, "on": on,
                "by": stop.map(|s| s.by.clone()), "at_ms": stop.map(|s| s.at_ms), "reason": stop.map(|s| s.reason.clone()),
                "until_ms": if *k == "alarm" { Some(ALARM_MUTE_UNTIL.load(Ordering::Relaxed)).filter(|&u| u > now) } else { stop.map(|s| s.until_ms).filter(|&u| u > 0) },
                "maintenance": stop.map(|s| s.maintenance).unwrap_or(false),
            })
        })
        .collect();
    let stopped = services.iter().filter(|s| s["on"] == false).count();
    serde_json::json!({
        "services": services,
        "stopped": stopped,
        "alarm_mute": { "until_ms": ALARM_MUTE_UNTIL.load(Ordering::Relaxed), "keep_critical": ALARM_MUTE_KEEP_CRITICAL.load(Ordering::Relaxed), "max_min": ALARM_MAX_MIN },
        "maintenance": book.values().any(|s| s.maintenance),
        // 개발 모드면 사유 없이 켜고 끌 수 있다 (운영 모드 = 사유 필수)
        "dev_mode": state.auth.dev_mode(),
    })
}

#[derive(Debug, Deserialize)]
pub struct SetReq {
    pub on: bool,
    #[serde(default)]
    pub reason: String,
    /// 자동 재개(분). 알람 억제는 필수이고 최대 60.
    #[serde(default)]
    pub minutes: Option<u64>,
    /// 알람 억제 중 위험 등급은 계속 알림 (기본 true)
    #[serde(default)]
    pub keep_critical: Option<bool>,
}

/// 서비스 하나를 켜거나 멈춘다
pub fn set(state: &AppState, who: &str, svc: &str, req: &SetReq, maintenance: bool) -> Result<(), String> {
    if !SERVICES.iter().any(|s| s.0 == svc) {
        return Err(format!("알 수 없는 서비스: {svc}"));
    }
    let now = now_ms();
    // 개발 모드(auth.dev_mode)에서는 사유 없이 자유롭게 켜고 끈다 — 기록에는 "개발 모드"로 남긴다
    let dev = state.auth.dev_mode();
    let reason = if req.reason.trim().is_empty() && dev && !req.on { "개발 모드".to_string() } else { req.reason.trim().to_string() };
    if !req.on && reason.is_empty() {
        return Err("멈추는 사유를 적어 주세요".into());
    }
    let until = match (req.on, svc) {
        (true, _) => 0,
        (false, "alarm") => {
            let m = req.minutes.unwrap_or(30).clamp(1, ALARM_MAX_MIN);
            now + m * 60_000
        }
        (false, _) => req.minutes.filter(|&m| m > 0).map(|m| now + m.min(24 * 60) * 60_000).unwrap_or(0),
    };
    match svc {
        "backup" => {
            if req.on {
                let mut p = state.backup.policy();
                p.paused = false;
                state.backup.set_policy(p)?;
            } else {
                state.backup.abort()?;
            }
        }
        "alarm" => {
            ALARM_MUTE_UNTIL.store(if req.on { 0 } else { until }, Ordering::Relaxed);
            ALARM_MUTE_KEEP_CRITICAL.store(req.keep_critical.unwrap_or(true), Ordering::Relaxed);
        }
        s => {
            if let Some(f) = flag(s) {
                f.store(req.on, Ordering::Relaxed);
            }
        }
    }
    {
        let mut b = BOOK.lock().unwrap();
        if req.on {
            b.remove(svc);
        } else {
            b.insert(svc.to_string(), Stop { by: who.to_string(), at_ms: now, reason: reason.clone(), until_ms: until, maintenance });
        }
    }
    save();
    let what = if req.on { "다시 켬" } else { "멈춤" };
    let detail = if req.on {
        label(svc).to_string()
    } else {
        format!("{} — {}{}", label(svc), reason, if until > 0 { format!(" (자동 재개 {}분 뒤)", (until - now) / 60_000) } else { String::new() })
    };
    state.auth.audit(who, "", if req.on { "control_start" } else { "control_stop" }, &detail);
    state.push_event("control", None, format!("서비스 {what}: {detail} · {who}"));
    info!("control: {} {} by {}", svc, what, who);
    Ok(())
}

/// 유지보수 모드: 백업·EMR 전송을 멈추고 알람 알림을 억제(최대 60분) — 끄면 셋 다 다시 켠다
pub fn maintenance(state: &AppState, who: &str, req: &SetReq) -> Result<(), String> {
    for svc in ["backup", "emr", "alarm"] {
        let r = SetReq { on: req.on, reason: req.reason.clone(), minutes: req.minutes, keep_critical: req.keep_critical };
        set(state, who, svc, &r, true)?;
    }
    Ok(())
}

/// 자동 재개: 5초마다 until 이 지난 멈춤을 다시 켠다
pub async fn run(state: Arc<AppState>) {
    let mut tick = tokio::time::interval(Duration::from_secs(5));
    loop {
        tick.tick().await;
        let now = now_ms();
        let due: Vec<String> = BOOK.lock().unwrap().iter().filter(|(_, s)| s.until_ms > 0 && s.until_ms <= now).map(|(k, _)| k.clone()).collect();
        for svc in due {
            let _ = set(&state, "자동 재개", &svc, &SetReq { on: true, reason: String::new(), minutes: None, keep_critical: None }, false);
        }
        // 알람 억제가 끝났는데 기록이 남아 있으면 정리
        if !alarm_muted(now) && BOOK.lock().unwrap().contains_key("alarm") {
            BOOK.lock().unwrap().remove("alarm");
            state.push_event("control", None, "알람 알림 억제 종료 (자동)".into());
        }
    }
}
