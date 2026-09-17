use crate::grouping::GroupConfig;
use crate::output;
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

/// 어드민 REST API + 출력 WS 를 하나의 HTTP 서버(7300)로 제공
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/stats", get(stats))
        .route("/api/stats/reset", post(reset_stats))
        .route("/api/stats/reset_loss", post(reset_loss))
        .route("/api/wave/reset", post(wave_reset))
        .route("/api/channels/prune", post(prune_channels))
        .route("/api/events", get(events))
        .route("/api/displays", get(list_displays))
        .route("/api/displays/{id}", put(set_display))
        .route("/api/gateways", get(gateways))
        .route("/api/channels", get(list_channels))
        .route("/api/wave/{channel_id}/info", get(wave_info))
        .route("/api/wave/{channel_id}", get(wave_read))
        .route("/api/groups", get(list_groups))
        .route("/api/groups", post(create_group))
        .route("/api/groups/{id}", put(update_group))
        .route("/api/groups/{id}", delete(delete_group))
        .route("/api/ingest/sources", get(ingest_sources))
        .route("/api/ingest/allow", put(set_ingest_allow))
        .route("/ws", get(output::ws_handler))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    analysis_connected: bool,
    channel_count: usize,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        analysis_connected: state.analysis_up(),
        channel_count: state.registry.channel_ids().len(),
    })
}

async fn list_channels(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.registry.snapshot())
}

#[derive(Serialize)]
struct IngestSource {
    ip: String,
    connections: u64,
}

#[derive(Serialize)]
struct IngestSources {
    /// 허용목록 (null = 전체 허용). 루프백은 목록과 무관하게 항상 허용.
    allow: Option<Vec<String>>,
    /// 현재 연결 중인 소스 IP 별 회선 수
    sources: Vec<IngestSource>,
}

/// 입력 소스 현황: 소스 IP 별 활성 연결 수 + 허용목록 (어드민 입력 소스 패널)
async fn ingest_sources(State(state): State<Arc<AppState>>) -> Json<IngestSources> {
    let allow = state
        .ingest_allow
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.iter().map(|ip| ip.to_string()).collect());
    let mut sources: Vec<IngestSource> = state
        .ingest_sources
        .lock()
        .unwrap()
        .iter()
        .map(|(ip, n)| IngestSource { ip: ip.to_string(), connections: *n })
        .collect();
    sources.sort_by(|a, b| a.ip.cmp(&b.ip));
    Json(IngestSources { allow, sources })
}

#[derive(serde::Deserialize)]
struct AllowBody {
    /// null = 전체 허용, [] = 외부 전부 차단(루프백만), ["ip", ...] = 해당 IP 만
    ips: Option<Vec<String>>,
}

/// 입력 소스 허용목록 설정. 목록에서 빠진 소스의 기존 연결은 즉시 끊긴다.
async fn set_ingest_allow(
    State(state): State<Arc<AppState>>,
    Json(body): Json<AllowBody>,
) -> impl IntoResponse {
    let parsed = match body.ips {
        None => None,
        Some(list) => {
            let mut set = std::collections::HashSet::new();
            for s in &list {
                match s.parse::<std::net::IpAddr>() {
                    Ok(ip) => {
                        set.insert(ip);
                    }
                    Err(_) => {
                        return (StatusCode::BAD_REQUEST, format!("invalid ip: {s}"))
                            .into_response()
                    }
                }
            }
            Some(set)
        }
    };
    let desc = match &parsed {
        None => "전체 허용".to_string(),
        Some(s) if s.is_empty() => "외부 차단 (로컬만)".to_string(),
        Some(s) => {
            let mut v: Vec<String> = s.iter().map(|ip| ip.to_string()).collect();
            v.sort();
            v.join(", ")
        }
    };
    *state.ingest_allow.lock().unwrap() = parsed;
    state.push_event("ingest_allow", None, format!("입력 소스 허용 변경: {desc}"));
    Json(serde_json::json!({"ok": true})).into_response()
}

#[derive(Serialize)]
struct Stats {
    /// 현재 열려 있는 ingest 소켓 회선 수
    ingest_connections: u64,
    /// 누적 수신 바이트 (ingest 라인 기준)
    total_bytes: u64,
    /// 누적 송신 바이트 (출력 WS + 분석 서버 forward)
    total_tx_bytes: u64,
    /// 누적 수신 ECG 패킷 수
    total_packets: u64,
    /// seq 갭으로 감지한 유실 패킷 누적
    total_lost_packets: u64,
    uptime_s: u64,
    /// 분석 링크 연결 해제 누적 다운타임 (ms)
    downtime_ms: u64,
    analysis_connected: bool,
    channel_count: usize,
    /// 큐 포화로 드롭된 건수 (analysis / db / wave) — 정상 운영에선 0
    queue_dropped_analysis: u64,
    queue_dropped_db: u64,
    queue_dropped_wave: u64,
    /// 라우터 프로세스 메모리 (working set)
    mem_process_bytes: u64,
    /// 시스템 물리 메모리 사용량/전체
    mem_sys_used_bytes: u64,
    mem_sys_total_bytes: u64,
    /// 시스템 전체 CPU 사용률 (%)
    cpu_percent: f32,
    /// 스토리지 (라우터 드라이브) 전체/여유 바이트
    disk_total_bytes: u64,
    disk_free_bytes: u64,
    /// 저장된 파형 파일 전체 용량 (waves/, 30초 주기 집계)
    wave_store_bytes: u64,
}

/// (프로세스 working set, 시스템 사용, 시스템 전체) 바이트
fn memory_stats() -> (u64, u64, u64) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::ProcessStatus::{
            K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::SystemInformation::{
            GlobalMemoryStatusEx, MEMORYSTATUSEX,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;

        let mut pmc: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        pmc.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let proc_ws = if K32GetProcessMemoryInfo(GetCurrentProcess(), &mut pmc, pmc.cb) != 0 {
            pmc.WorkingSetSize as u64
        } else {
            0
        };
        let mut ms: MEMORYSTATUSEX = std::mem::zeroed();
        ms.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
        let (used, total) = if GlobalMemoryStatusEx(&mut ms) != 0 {
            (ms.ullTotalPhys - ms.ullAvailPhys, ms.ullTotalPhys)
        } else {
            (0, 0)
        };
        (proc_ws, used, total)
    }
    #[cfg(not(windows))]
    {
        // macOS: mach/sysctl 네이티브 수집 (그 외 플랫폼은 0)
        crate::sysmon::memory_stats_native()
    }
}

async fn stats(State(state): State<Arc<AppState>>) -> Json<Stats> {
    use std::sync::atomic::Ordering;
    let (mem_process, mem_used, mem_total) = memory_stats();
    let (disk_total, disk_free) = crate::sysmon::disk_stats();
    Json(Stats {
        ingest_connections: state.ingest_conns.load(Ordering::Relaxed),
        total_bytes: state.total_bytes.load(Ordering::Relaxed),
        total_tx_bytes: state.total_tx_bytes.load(Ordering::Relaxed),
        total_packets: state.total_packets.load(Ordering::Relaxed),
        total_lost_packets: state.total_lost_packets.load(Ordering::Relaxed),
        uptime_s: state.started_at.elapsed().as_secs(),
        downtime_ms: state.downtime_ms(),
        analysis_connected: state.analysis_up(),
        channel_count: state.registry.channel_ids().len(),
        queue_dropped_analysis: state.dropped_analysis.load(Ordering::Relaxed),
        queue_dropped_db: state.dropped_db.load(Ordering::Relaxed),
        queue_dropped_wave: state.dropped_wave.load(Ordering::Relaxed),
        mem_process_bytes: mem_process,
        mem_sys_used_bytes: mem_used,
        mem_sys_total_bytes: mem_total,
        cpu_percent: crate::sysmon::cpu_percent(),
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        wave_store_bytes: crate::wave_store::WAVE_STORE_BYTES
            .load(std::sync::atomic::Ordering::Relaxed),
    })
}

async fn events(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.recent_events(100))
}

async fn list_displays(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.list_displays())
}

#[derive(Serialize)]
struct GatewayStatus {
    known: u64,
    down: Vec<String>,
    updated_ts_ms: u64,
}

/// 게이트웨이 상태 (에뮬레이터가 데이터 경로로 push 한 최신 보고)
async fn gateways(State(state): State<Arc<AppState>>) -> Json<GatewayStatus> {
    let (known, down, ts) = state.gateway_status.lock().unwrap().clone();
    Json(GatewayStatus { known, down, updated_ts_ms: ts })
}

#[derive(serde::Deserialize)]
struct DisplayBody {
    group_id: String,
}

/// 디스플레이(센트럴 모니터)에 표시할 그룹 지정
async fn set_display(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(body): Json<DisplayBody>,
) -> impl IntoResponse {
    if state.groups.get(&body.group_id).is_none() {
        return (StatusCode::BAD_REQUEST, "no such group").into_response();
    }
    state.set_display(&id, &body.group_id);
    StatusCode::OK.into_response()
}

/// 레지스트리 정리: 해제 상태(비정상 종료 등으로 channel_close 를 받지 못한)
/// 채널을 완전히 제거하고 그룹에 leave 를 전파한다. (DB 리셋 후 어드민이 호출)
async fn prune_channels(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let ids = state.registry.disconnected_ids();
    for id in &ids {
        state.remove_channel(id);
    }
    if !ids.is_empty() {
        state.push_event(
            "registry_prune",
            None,
            format!("해제 채널 {}개 레지스트리에서 정리", ids.len()),
        );
    }
    Json(serde_json::json!({ "pruned": ids.len() }))
}

/// 저장 파형 가용 범위 (리포트 뷰어의 개요 스트립 범위)
async fn wave_info(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
) -> impl IntoResponse {
    let dir = state.cfg.wave_dir.clone();
    let r = tokio::task::spawn_blocking(move || crate::wave_store::info(&dir, &channel_id))
        .await
        .ok()
        .flatten();
    match r {
        Some((from, to, bytes)) => Json(serde_json::json!({
            "from_ms": from, "to_ms": to, "bytes": bytes,
        })).into_response(),
        None => (StatusCode::NOT_FOUND, "no stored waveform").into_response(),
    }
}

/// 저장 파형 조회.
/// mode=overview: 범위를 buckets 개 (t,min,max) 로 요약 (기본 600) — 장구간 개요
/// mode=raw: 원본 샘플 (범위는 최대 120초로 제한) — 상세 뷰
async fn wave_read(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let now = crate::protocol::now_ms();
    let getn = |k: &str, d: u64| q.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let from = getn("from_ms", now.saturating_sub(30_000));
    let to = getn("to_ms", now).min(now);
    let mode = q.get("mode").map(String::as_str).unwrap_or("raw");
    let dir = state.cfg.wave_dir.clone();

    if mode == "overview" {
        let buckets = getn("buckets", 600) as usize;
        let r = tokio::task::spawn_blocking(move || {
            crate::wave_store::overview(&dir, &channel_id, from, to, buckets)
        }).await.unwrap_or_default();
        let pts: Vec<serde_json::Value> = r.into_iter()
            .map(|(t, lo, hi)| serde_json::json!([t, lo, hi]))
            .collect();
        return Json(serde_json::json!({
            "from_ms": from, "to_ms": to, "buckets": pts,
        })).into_response();
    }

    // raw: 과도한 응답 방지를 위해 120초로 제한
    let to = to.min(from + 120_000);
    let r = tokio::task::spawn_blocking(move || {
        crate::wave_store::read_range(&dir, &channel_id, from, to)
    }).await.unwrap_or_default();
    // 레코드 간 seq 갭(미전송 구간)은 세그먼트 분리로 표현
    let mut segments: Vec<serde_json::Value> = Vec::new();
    let mut cur_t0 = 0u64;
    let mut cur_sr = 0u32;
    let mut cur_samples: Vec<f32> = Vec::new();
    let mut last_end = 0u64;
    for (ts, sr, samples) in r {
        let dur = samples.len() as u64 * 1000 / sr.max(1) as u64;
        if cur_samples.is_empty() || sr != cur_sr || ts > last_end + 500 {
            if !cur_samples.is_empty() {
                segments.push(serde_json::json!({
                    "t0": cur_t0, "sample_rate": cur_sr, "samples": cur_samples,
                }));
            }
            cur_t0 = ts;
            cur_sr = sr;
            cur_samples = samples;
        } else {
            cur_samples.extend(samples);
        }
        last_end = ts + dur;
    }
    if !cur_samples.is_empty() {
        segments.push(serde_json::json!({
            "t0": cur_t0, "sample_rate": cur_sr, "samples": cur_samples,
        }));
    }
    Json(serde_json::json!({ "from_ms": from, "to_ms": to, "segments": segments }))
        .into_response()
}

/// 수신/송신/패킷 누적 카운터 리셋 (어드민 채널 초기화 시 함께 호출)
async fn reset_stats(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;
    state.total_bytes.store(0, Ordering::Relaxed);
    state.total_tx_bytes.store(0, Ordering::Relaxed);
    state.total_packets.store(0, Ordering::Relaxed);
    state.total_lost_packets.store(0, Ordering::Relaxed);
    state.push_event("stats_reset", None, "수신/송신 데이터 카운터 초기화".into());
    StatusCode::OK
}

/// 미전송(유실) 카운터만 리셋 — 패킷/바이트 누계는 유지
async fn reset_loss(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    use std::sync::atomic::Ordering;
    state.total_lost_packets.store(0, Ordering::Relaxed);
    state.push_event("stats_reset", None, "미전송(유실) 카운터 초기화".into());
    StatusCode::OK
}

/// 파형 저장소 리셋 — 기록 태스크가 핸들을 닫고 저장 파일 전체를 삭제한다.
/// 삭제 후 유입되는 파형부터 새 파일로 저장이 이어진다 (리포트 과거 구간은 사라짐).
async fn wave_reset(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let next = *state.wave_reset.borrow() + 1;
    let _ = state.wave_reset.send(next);
    state.push_event("wave_reset", None, "파형 저장소 리셋 — 저장 파일 전체 삭제".into());
    Json(serde_json::json!({"ok": true}))
}

#[derive(Serialize)]
struct GroupWithCount {
    #[serde(flatten)]
    config: GroupConfig,
    member_count: usize,
}

async fn list_groups(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let groups: Vec<GroupWithCount> = state
        .groups
        .list()
        .into_iter()
        .map(|g| {
            let member_count = state.registry.member_count(&g.id);
            GroupWithCount { config: g, member_count }
        })
        .collect();
    Json(groups)
}

async fn create_group(
    State(state): State<Arc<AppState>>,
    Json(cfg): Json<GroupConfig>,
) -> impl IntoResponse {
    if cfg.id.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "group id required").into_response();
    }
    if state.groups.get(&cfg.id).is_some() {
        return (StatusCode::CONFLICT, "group id already exists").into_response();
    }
    state.groups.upsert(cfg);
    // 그룹 변경은 즉시 전 채널 멤버십 재계산 → join/leave 이벤트로 매끄럽게 전파
    state.recompute_all();
    StatusCode::CREATED.into_response()
}

async fn update_group(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(mut cfg): Json<GroupConfig>,
) -> impl IntoResponse {
    if state.groups.get(&id).is_none() {
        return (StatusCode::NOT_FOUND, "no such group").into_response();
    }
    cfg.id = id;
    state.groups.upsert(cfg);
    state.recompute_all();
    StatusCode::OK.into_response()
}

async fn delete_group(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> impl IntoResponse {
    if id == "all" {
        // 전체 채널 그룹은 붙박이 기본 그룹 — 삭제 불가
        return (StatusCode::FORBIDDEN, "default group 'all' cannot be deleted").into_response();
    }
    if !state.groups.remove(&id) {
        return (StatusCode::NOT_FOUND, "no such group").into_response();
    }
    state.recompute_all();
    StatusCode::OK.into_response()
}
