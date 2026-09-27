//! 가동 초기화 (운영관리 › 서비스 제어 › 가동 초기화).
//!
//! 라우터의 모든 동작을 멈춘 상태에서 로컬 파형 저장소를 지우고, 설정된 원격 백업 대상의 파일(`patches/`)을 모두 지운 뒤,
//! 카운터·운영 통계·알람·패치/게이트웨이 표를 비우고 서비스를 다시 켠다. 백그라운드 스레드 하나가 순서대로 진행하고,
//! 진행 상태는 `/api/control/status` 의 `reset` 에 실린다. 한 번에 하나만 실행된다.
//!
//! 순서: 멈춤(수신·스트리밍·저장·EMR·동기화·백업) → 연결 정리 → 로컬 저장소 삭제 → 원격 백업 삭제(대상별) →
//! 카운터·통계·알람·표 비움 → 다시 켬. 원격 삭제가 실패해도 남은 단계는 계속하고 서비스는 다시 켠다(실패는 결과에 남김).

use crate::state::AppState;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};
use tracing::{info, warn};

pub const CONFIRM: &str = "가동 초기화";

#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub key: &'static str,
    pub label: &'static str,
    /// wait | run | ok | fail | skip
    pub state: &'static str,
    pub detail: String,
    pub at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Progress {
    pub running: bool,
    pub by: String,
    pub reason: String,
    pub started_ms: u64,
    pub done_ms: u64,
    pub steps: Vec<Step>,
    pub error: Option<String>,
}

static PROGRESS: LazyLock<Mutex<Progress>> = LazyLock::new(|| Mutex::new(Progress::default()));

const STEPS: [(&str, &str); 6] = [
    ("stop", "서비스 멈춤 (수신·스트리밍·저장·EMR·동기화·백업)"),
    ("drain", "게이트웨이 연결 정리"),
    ("local", "로컬 파형 저장소 삭제"),
    ("remote", "원격 백업 파일 삭제"),
    ("counters", "통계 초기화 — 수신·송신·유실 카운터, 게이트웨이 누계, 백업 통계, 운영 통계, 알람, 패치/게이트웨이 표"),
    ("start", "서비스 다시 켬"),
];

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

/// 화면용: 진행 상태 + 지워질 백업 대상 목록
pub fn status(state: &AppState) -> serde_json::Value {
    let p = PROGRESS.lock().unwrap().clone();
    let targets: Vec<serde_json::Value> = state
        .backup
        .targets()
        .into_iter()
        .map(|t| serde_json::json!({ "id": t.id, "name": t.name, "kind": t.kind, "enabled": t.enabled }))
        .collect();
    serde_json::json!({
        "running": p.running, "by": p.by, "reason": p.reason, "started_ms": p.started_ms, "done_ms": p.done_ms,
        "steps": p.steps, "error": p.error, "confirm": CONFIRM, "targets": targets,
    })
}

fn set_step(key: &str, state: &'static str, detail: impl Into<String>) {
    let mut p = PROGRESS.lock().unwrap();
    if let Some(s) = p.steps.iter_mut().find(|s| s.key == key) {
        s.state = state;
        s.detail = detail.into();
        s.at_ms = now_ms();
    }
}

/// 시작: 확인 문구·사유·중복 실행 검사 뒤 스레드로 진행.
/// 개발 모드(auth.dev_mode)에서는 서비스 제어와 같이 사유·확인 문구 없이 실행된다(기록에는 "개발 모드").
pub fn start(state: Arc<AppState>, who: &str, reason: &str, confirm: &str) -> Result<(), String> {
    let dev = state.auth.dev_mode();
    if !dev && confirm.trim() != CONFIRM {
        return Err(format!("확인 문구가 다릅니다 — \"{CONFIRM}\" 를 그대로 입력하세요"));
    }
    let reason = reason.trim().to_string();
    if reason.is_empty() && !dev {
        return Err("사유를 적어 주세요".into());
    }
    {
        let mut p = PROGRESS.lock().unwrap();
        if p.running {
            return Err("가동 초기화가 이미 진행 중입니다".into());
        }
        *p = Progress {
            running: true,
            by: who.to_string(),
            reason: reason.clone(),
            started_ms: now_ms(),
            done_ms: 0,
            steps: STEPS.iter().map(|(k, l)| Step { key: k, label: l, state: "wait", detail: String::new(), at_ms: 0 }).collect(),
            error: None,
        };
    }
    state.auth.audit(who, "", "full_reset", &format!("가동 초기화 시작 — {}", if reason.is_empty() { "개발 모드" } else { &reason }));
    state.push_event("control", None, format!("가동 초기화 시작 · {who}"));
    let who = who.to_string();
    std::thread::Builder::new()
        .name("full-reset".into())
        .spawn(move || {
            let r = run(&state, &who, &reason);
            let mut p = PROGRESS.lock().unwrap();
            p.running = false;
            p.done_ms = now_ms();
            if let Err(e) = &r {
                p.error = Some(e.clone());
            }
            drop(p);
            match &r {
                Ok(()) => {
                    state.auth.audit(&who, "", "full_reset", "가동 초기화 완료");
                    state.push_event("control", None, format!("가동 초기화 완료 · {who}"));
                    info!("full reset: done ({})", who);
                }
                Err(e) => {
                    state.auth.audit(&who, "", "full_reset", &format!("가동 초기화 일부 실패 — {e}"));
                    state.push_event("control", None, format!("가동 초기화 일부 실패: {e}"));
                    warn!("full reset: {}", e);
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn ctl(state: &AppState, who: &str, svc: &str, on: bool, reason: &str) -> Result<(), String> {
    let req = crate::control::SetReq { on, reason: reason.to_string(), minutes: None, keep_critical: None };
    crate::control::set(state, who, svc, &req, false)
}

fn run(state: &Arc<AppState>, who: &str, reason: &str) -> Result<(), String> {
    let why = if reason.is_empty() { "가동 초기화".to_string() } else { format!("가동 초기화 — {reason}") };
    let mut failures: Vec<String> = Vec::new();

    // 1. 멈춤 — 바깥(EMR·동기화·백업)부터, 수신·저장은 마지막
    set_step("stop", "run", "");
    let mut stopped = Vec::new();
    for svc in ["emr", "sync", "backup", "stream", "ingest", "store"] {
        match ctl(state, who, svc, false, &why) {
            Ok(()) => stopped.push(crate::control::label(svc)),
            Err(e) => failures.push(format!("{} 멈춤 실패: {e}", crate::control::label(svc))),
        }
    }
    set_step("stop", if failures.is_empty() { "ok" } else { "fail" }, stopped.join(" · "));

    // 2. 연결 정리 — 수신이 꺼지면 열린 소켓이 닫힌다. 최대 20 s 기다린다
    set_step("drain", "run", "");
    let t0 = Instant::now();
    while state.ingest_conns.load(Ordering::Relaxed) > 0 && t0.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(250));
    }
    let left = state.ingest_conns.load(Ordering::Relaxed);
    set_step("drain", if left == 0 { "ok" } else { "fail" }, if left == 0 { format!("{:.1} s", t0.elapsed().as_secs_f32()) } else { format!("연결 {left}개가 아직 열려 있음") });

    // 3. 로컬 저장소 — 기록 스레드가 큐에 남은 것을 처리한 뒤 전부 지우고 알려 준다
    set_step("local", "run", "");
    let before = crate::patch_store::STORE_BYTES.load(Ordering::Relaxed);
    let (tx, rx) = std::sync::mpsc::channel();
    state.send_store(crate::patch_store::StoreOp::ResetWait(tx));
    match rx.recv_timeout(Duration::from_secs(300)) {
        Ok(()) => set_step("local", "ok", format!("{} MB 삭제", before >> 20)),
        Err(_) => {
            failures.push("로컬 저장소 삭제가 5분 안에 끝나지 않음".into());
            set_step("local", "fail", "시간 초과");
        }
    }

    // 4. 원격 백업 — 설정된 모든 대상(꺼진 것 포함)의 patches/ 를 지운다. 대상별로 순서대로, 실패해도 다음 대상 계속
    set_step("remote", "run", "");
    let targets = state.backup.targets();
    if targets.is_empty() {
        set_step("remote", "skip", "백업 대상 없음");
    } else {
        let mut lines = Vec::new();
        let mut any_fail = false;
        for t in &targets {
            set_step("remote", "run", format!("{} 삭제 중 … ({})", t.name, lines.join(", ")));
            match state.backup.purge_target(&t.id) {
                Err(e) => {
                    any_fail = true;
                    lines.push(format!("{}: 시작 실패 ({e})", t.name));
                    continue;
                }
                Ok(()) => {}
            }
            let t1 = Instant::now();
            loop {
                std::thread::sleep(Duration::from_millis(500));
                let st = state.backup.purge_state(&t.id);
                let running = st.as_ref().and_then(|v| v["running"].as_bool()).unwrap_or(false);
                if !running {
                    match st.as_ref().and_then(|v| v["error"].as_str()) {
                        Some(e) => {
                            any_fail = true;
                            lines.push(format!("{}: {e}", t.name));
                        }
                        None => lines.push(format!("{}: {}개 삭제", t.name, st.as_ref().and_then(|v| v["deleted"].as_u64()).unwrap_or(0))),
                    }
                    break;
                }
                if t1.elapsed() > Duration::from_secs(3600) {
                    any_fail = true;
                    lines.push(format!("{}: 1시간 안에 끝나지 않음", t.name));
                    break;
                }
            }
        }
        if any_fail {
            failures.push(format!("원격 백업 삭제: {}", lines.join(" / ")));
        }
        set_step("remote", if any_fail { "fail" } else { "ok" }, lines.join(" · "));
    }

    // 5. 카운터·통계·알람·표
    set_step("counters", "run", "");
    for a in [
        &state.total_bytes,
        &state.total_tx_bytes,
        &state.total_packets,
        &state.total_lost_packets,
        &state.dropped_analysis,
        &state.dropped_db,
        &state.dropped_wave,
        &state.ws_lagged,
        &state.ws_ctrl_dropped,
        &state.analysis_downtime_ms,
        &state.last_store_drop_ms,
    ] {
        a.store(0, Ordering::Relaxed);
    }
    state.backup.reset_stats();
    let metrics_ok = crate::metrics::reset(&state.metrics);
    crate::admin_api::clear_series_cache();
    state.alarms.clear();
    let ids = state.registry.channel_ids();
    for id in &ids {
        state.remove_channel(id);
    }
    state.registry.clear_all_pending();
    let gws = state.gateways.clear();
    state.events.lock().unwrap().clear();
    set_step("counters", if metrics_ok { "ok" } else { "fail" }, format!("패치 {}개 · 게이트웨이 {}개(누계 포함) · 백업 통계 · 카운터 · 운영 통계 {}", ids.len(), gws, if metrics_ok { "삭제" } else { "삭제 실패" }));
    if !metrics_ok {
        failures.push("운영 통계 삭제 실패".into());
    }

    // 6. 다시 켬 — 받을 준비(저장·동기화) → 수신 → 스트리밍 → EMR → 백업
    set_step("start", "run", "");
    let mut started = Vec::new();
    for svc in ["store", "sync", "ingest", "stream", "emr", "backup"] {
        match ctl(state, who, svc, true, "") {
            Ok(()) => started.push(crate::control::label(svc)),
            Err(e) => failures.push(format!("{} 켜기 실패: {e}", crate::control::label(svc))),
        }
    }
    set_step("start", if started.len() == 6 { "ok" } else { "fail" }, started.join(" · "));

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join(" ; "))
    }
}
