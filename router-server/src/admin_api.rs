use crate::grouping::GroupConfig;
use crate::output;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tower_http::cors::CorsLayer;

/// 어드민 REST API + 출력 WS 를 하나의 HTTP 서버(7300)로 제공
pub fn router(state: Arc<AppState>) -> Router {
    let web_dir = state.cfg.web_dir.clone();
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
        .route("/api/gateways/summary", get(gateways_summary))
        .route("/api/patches/{id}", get(patch_index))
        .route("/api/patches/{id}/verify", get(patch_verify))
        .route("/api/channels", get(list_channels))
        .route("/api/wave/{channel_id}/info", get(wave_info))
        .route("/api/wave/{channel_id}", get(wave_read))
        .route("/api/wave/{channel_id}/waves", get(wave_read_all))
        .route("/api/groups", get(list_groups))
        .route("/api/groups", post(create_group))
        .route("/api/groups/{id}", put(update_group))
        .route("/api/groups/{id}", delete(delete_group))
        .route("/api/ingest/sources", get(ingest_sources))
        .route("/api/ingest/allow", put(set_ingest_allow))
        .route("/ws", get(output::ws_handler))
        .route("/api/debug/sizes", get(debug_sizes))
        .route("/api/alarms", get(alarms_active))
        .route("/api/alarms/history", get(alarms_history))
        .route("/api/alarms/rules", get(alarm_rules).put(set_alarm_rules))
        .route("/api/alarms/{id}/ack", post(ack_alarm))
        .route("/api/emu/status", get(emu_status))
        .route("/api/emu/discovery", get(emu_discovery))
        .route("/api/emr/{*path}", get(emr_proxy))
        .layer(CorsLayer::permissive())
        .fallback_service(spa(&web_dir))
        .with_state(state)
}

/// 웹 콘솔(vite build 산출물) 서빙. 해시 라우팅이라 모르는 경로는 index.html 로.
fn spa(dir: &str) -> tower_http::services::ServeDir<tower_http::services::ServeFile> {
    let index = std::path::Path::new(dir).join("index.html");
    tower_http::services::ServeDir::new(dir).fallback(tower_http::services::ServeFile::new(index))
}

/// Sizes of every in-memory structure that could grow (leak hunting). Cheap; safe to poll each minute.
async fn debug_sizes(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (emr_n, emr_bytes) = {
        let c = state.emr_cache.lock().unwrap();
        (c.len(), c.values().map(|(_, b)| b.len()).sum::<usize>())
    };
    Json(serde_json::json!({
        "registry_rows": state.registry.len(),
        "registry_connected": state.registry.connected_count(),
        "registry_pending_packets": state.registry.pending_total(),
        "gateway_rows": state.gateways.len(),
        "gateway_resend_pending": state.gateways.resend_pending(),
        "alarms": state.alarms.sizes(),
        "events": state.events.lock().unwrap().len(),
        "emr_cache_entries": emr_n, "emr_cache_bytes": emr_bytes,
        "store_queue": state.store_tx.max_capacity() - state.store_tx.capacity(),
        "store_patch_bufs": crate::patch_store::STORE_BUFS.load(Ordering::Relaxed),
        "store_open_files": crate::patch_store::STORE_OPEN.load(Ordering::Relaxed),
        "store_buffered_bytes": crate::patch_store::STORE_BUFFERED.load(Ordering::Relaxed),
        "live_index_rows": crate::patch_store::LIVE_INDEX.len(),
        "ws_subscribers": state.out_tx.receiver_count(),
        "ingest_sources": state.ingest_sources.lock().unwrap().len(),
        "displays": state.displays.lock().unwrap().len(),
    }))
}

async fn alarms_active(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(serde_json::json!({"summary": state.alarms.summary(), "alarms": state.alarms.active()}))
}

#[derive(serde::Deserialize)]
struct LimitQ {
    limit: Option<usize>,
}

async fn alarms_history(State(state): State<Arc<AppState>>, Query(q): Query<LimitQ>) -> impl IntoResponse {
    Json(state.alarms.history(q.limit.unwrap_or(200).min(500)))
}

async fn alarm_rules(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.alarms.rules())
}

async fn set_alarm_rules(State(state): State<Arc<AppState>>, Json(r): Json<crate::alarms::Rules>) -> impl IntoResponse {
    state.alarms.set_rules(r.clone());
    state.push_event("alarm_rules", None, "알람 규칙 변경".into());
    Json(r)
}

async fn ack_alarm(State(state): State<Arc<AppState>>, Path(id): Path<u64>) -> impl IntoResponse {
    if state.alarms.ack(id) {
        Json(serde_json::json!({"ok": true})).into_response()
    } else {
        (StatusCode::NOT_FOUND, "no such active alarm").into_response()
    }
}

/// 에뮬레이터 EMR/상태 프록시. 에뮬레이터는 CORS 헤더가 없으므로 브라우저는 라우터만 본다.
/// 도면·게이트웨이 목록처럼 큰 정적 응답은 TTL 캐시로 에뮬레이터 부하를 막는다.
async fn emr_get(state: &Arc<AppState>, path: &str, ttl_ms: u64) -> axum::response::Response {
    let Some(addr) = state.cfg.emulator_addr.clone() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "ROUTER_EMULATOR_ADDR not set").into_response();
    };
    let now = crate::protocol::now_ms();
    if ttl_ms > 0 {
        if let Some((exp, body)) = state.emr_cache.lock().unwrap().get(path).cloned() {
            if exp > now {
                return body_with_type(body, ctype_of(path));
            }
        }
    }
    match crate::emu_link::request(&addr, "GET", path, None).await {
        Ok((200, body)) => {
            let body = Arc::new(body);
            if ttl_ms > 0 {
                let mut c = state.emr_cache.lock().unwrap();
                c.retain(|_, (exp, _)| *exp > now);
                c.insert(path.to_string(), (now + ttl_ms, body.clone()));
            }
            body_with_type(body, ctype_of(path))
        }
        Ok((code, body)) => (StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_GATEWAY), body).into_response(),
        Err(e) => (StatusCode::BAD_GATEWAY, format!("emulator unreachable: {e}")).into_response(),
    }
}

/// The emulator serves avatars as SVG; everything else on /api/v1 is JSON.
fn ctype_of(path: &str) -> &'static str {
    if path.split('?').next().unwrap_or("").ends_with(".svg") { "image/svg+xml" } else { "application/json; charset=utf-8" }
}

fn body_with_type(body: Arc<String>, ctype: &'static str) -> axum::response::Response {
    ([(axum::http::header::CONTENT_TYPE, ctype)], body.as_str().to_owned()).into_response()
}

async fn emr_proxy(State(state): State<Arc<AppState>>, Path(path): Path<String>, axum::extract::RawQuery(q): axum::extract::RawQuery) -> impl IntoResponse {
    let ttl = match path.split('/').next().unwrap_or("") {
        "layout" | "hospital" | "floors" | "wards" | "rooms" | "beds" | "staff" => 300_000,
        _ if path.ends_with(".svg") => 3_600_000,
        "gateways" | "admissions" | "patients" | "patches" | "devices" | "trips" | "schedules" => 10_000,
        _ => 3_000,
    };
    let full = match q {
        Some(q) => format!("/api/v1/emr/{path}?{q}"),
        None => format!("/api/v1/emr/{path}"),
    };
    emr_get(&state, &full, ttl).await
}

async fn emu_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    emr_get(&state, "/api/v1/status", 2_000).await
}

async fn emu_discovery(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    emr_get(&state, "/api/v1", 600_000).await
}

#[derive(Serialize)]
struct Health {
    ok: bool,
    analysis_connected: bool,
    /// 레지스트리 행 수 (끊긴 행 포함) / 현재 연결된 패치 수
    channel_count: usize,
    channels_connected: usize,
}

async fn health(State(state): State<Arc<AppState>>) -> Json<Health> {
    Json(Health {
        ok: true,
        analysis_connected: state.analysis_up(),
        channel_count: state.registry.len(),
        channels_connected: state.registry.connected_count(),
    })
}

/// The console polls /api/channels and /api/gateways from several pages (2,000 rows ≈ 1.6 MB JSON each):
/// one serialisation per second serves every client.
static SNAP_CACHE: std::sync::LazyLock<std::sync::Mutex<[(std::time::Instant, Arc<String>); 2]>> = std::sync::LazyLock::new(|| {
    let t = std::time::Instant::now() - std::time::Duration::from_secs(10);
    std::sync::Mutex::new([(t, Arc::new(String::new())), (t, Arc::new(String::new()))])
});

fn cached_json(slot: usize, build: impl FnOnce() -> String) -> axum::response::Response {
    let now = std::time::Instant::now();
    {
        let c = SNAP_CACHE.lock().unwrap();
        if now.duration_since(c[slot].0) < std::time::Duration::from_secs(1) {
            return body_with_type(c[slot].1.clone(), "application/json; charset=utf-8");
        }
    }
    let body = Arc::new(build());
    SNAP_CACHE.lock().unwrap()[slot] = (now, body.clone());
    body_with_type(body, "application/json; charset=utf-8")
}

async fn list_channels(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    cached_json(0, || serde_json::to_string(&state.registry.snapshot()).unwrap_or_else(|_| "[]".into()))
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
    /// 레지스트리 행 수 (끊긴 행 포함) / 현재 연결된 패치 수
    channel_count: usize,
    channels_connected: usize,
    /// 큐 포화로 드롭된 건수 (analysis / db / wave) — 정상 운영에선 0
    queue_dropped_analysis: u64,
    queue_dropped_db: u64,
    queue_dropped_wave: u64,
    /// 느린 WS 구독자 때문에 건너뛴 메시지 누적 (클라이언트가 못 따라온 양)
    ws_lagged: u64,
    /// 열린 출력 WS 세션 수 / 채널 단위로 구독된 패치 수 (세션 간 중복 제외)
    ws_sessions: u64,
    ws_subscribed_channels: usize,
    /// 저장 큐에 대기 중인 op 수 (상한 262,144; 0 근처가 정상)
    store_queue: usize,
    /// 라우터 프로세스 메모리 (working set)
    mem_process_bytes: u64,
    /// 시스템 물리 메모리 사용량/전체
    mem_sys_used_bytes: u64,
    mem_sys_total_bytes: u64,
    /// 시스템 전체 CPU 사용률 (%)
    cpu_percent: f32,
    /// 라우터 프로세스 CPU 사용률 (1코어 = 100 %)
    cpu_process_percent: f32,
    /// 스토리지 (라우터 드라이브) 전체/여유 바이트
    disk_total_bytes: u64,
    disk_free_bytes: u64,
    /// 저장된 파형 파일 전체 용량 (waves/, 30초 주기 집계)
    wave_store_bytes: u64,
    /// 저장소에 파일이 있는 패치 수
    store_patches: u64,
    /// v3 게이트웨이 표 요약 (프레임/레코드/NACK/이상 카운터)
    gateways: serde_json::Value,
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
        channel_count: state.registry.len(),
        channels_connected: state.registry.connected_count(),
        queue_dropped_analysis: state.dropped_analysis.load(Ordering::Relaxed),
        queue_dropped_db: state.dropped_db.load(Ordering::Relaxed),
        queue_dropped_wave: state.dropped_wave.load(Ordering::Relaxed),
        ws_lagged: state.ws_lagged.load(Ordering::Relaxed),
        ws_sessions: state.ws_sessions.load(Ordering::Relaxed),
        ws_subscribed_channels: state.sub_channels.len(),
        store_queue: state.store_tx.max_capacity() - state.store_tx.capacity(),
        mem_process_bytes: mem_process,
        mem_sys_used_bytes: mem_used,
        mem_sys_total_bytes: mem_total,
        cpu_percent: crate::sysmon::cpu_percent(),
        cpu_process_percent: crate::sysmon::proc_cpu_percent(),
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        wave_store_bytes: crate::patch_store::STORE_BYTES.load(Ordering::Relaxed),
        store_patches: crate::patch_store::STORE_PATCHES.load(Ordering::Relaxed),
        gateways: state.gateways.summary(),
    })
}

async fn events(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.recent_events(100))
}

async fn list_displays(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.list_displays())
}

/// 게이트웨이 표 (v3 ingest 링크 상태·카운터·GW_STATUS·NACK)
async fn gateways(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    cached_json(1, || serde_json::to_string(&state.gateways.snapshot()).unwrap_or_else(|_| "[]".into()))
}

async fn gateways_summary(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.gateways.summary())
}

fn patch_id_of(channel_id: &str) -> Option<u32> {
    channel_id.trim_start_matches(|c: char| !c.is_ascii_digit()).parse().ok()
}

/// 패치 저장소 인덱스 (첫/마지막 시각, 레코드·바이트·유실)
async fn patch_index(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let Some(pid) = patch_id_of(&id) else { return (StatusCode::BAD_REQUEST, "bad patch id").into_response() };
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let r = tokio::task::spawn_blocking(move || {
        crate::patch_store::read_index(&root, pid).map(|ix| {
            let files = crate::patch_store::list_files(&root, pid);
            serde_json::json!({ "index": ix, "files": files.iter().map(|(k, p, n)| serde_json::json!({"hour": k, "path": p, "bytes": n})).collect::<Vec<_>>() })
        })
    })
    .await
    .ok()
    .flatten();
    match r {
        Some(v) => Json(v).into_response(),
        None => (StatusCode::NOT_FOUND, "no stored records").into_response(),
    }
}

/// 패치 저장 파일 전체 CRC 검증 (디스크 무결성)
async fn patch_verify(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let Some(pid) = patch_id_of(&id) else { return (StatusCode::BAD_REQUEST, "bad patch id").into_response() };
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let r = tokio::task::spawn_blocking(move || crate::patch_store::verify_patch(&root, pid)).await;
    match r {
        Ok(v) => Json(v).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "verify failed").into_response(),
    }
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
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let r = tokio::task::spawn_blocking(move || {
        let pid = patch_id_of(&channel_id)?;
        let ix = crate::patch_store::read_index(&root, pid)?;
        Some((ix.first_ts_ms, ix.last_ts_ms, ix.bytes))
    })
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
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let Some(pid) = patch_id_of(&channel_id) else { return (StatusCode::BAD_REQUEST, "bad patch id").into_response() };

    if mode == "overview" {
        let buckets = getn("buckets", 600) as usize;
        let r = tokio::task::spawn_blocking(move || {
            crate::patch_store::overview(&root, pid, from, to, buckets)
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
    let sr = state.registry.sample_rate_of(&channel_id).unwrap_or(250);
    let r: Vec<(u64, u32, Vec<f32>)> = tokio::task::spawn_blocking(move || {
        crate::patch_store::read_ecg_range(&root, pid, from, to)
    }).await.unwrap_or_default().into_iter().map(|(ts, _seq, s)| (ts, sr, s)).collect();
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

/// 저장 파형 전 채널 조회 (이력 뷰어). 범위 최대 10분. 바이너리 응답:
///   [u8 0xB3][u32 header_len][header JSON][i16 blob]
///   header = {"from_ms","to_ms","records","segments":[{key,fs,axes,scale,t0_ms,n,off}],"pace":[[t_ms,mark],…]}
/// 세그먼트 = 연속 레코드 묶음(seq 연속 · 시간 간격 정상); n 은 축당 샘플 수, off 는 블롭의 i16 인덱스, 값 = raw × scale.
/// 레코드의 ts_ms 는 번들 마지막 샘플 시각(스트림/링 버퍼와 같은 규약)이므로 t0_ms = ts − (n−1)/fs, 페이스 t 도 절대 시각.
async fn wave_read_all(
    State(state): State<Arc<AppState>>,
    Path(channel_id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let now = crate::protocol::now_ms();
    let getn = |k: &str, d: u64| q.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let from = getn("from_ms", now.saturating_sub(60_000));
    let to = getn("to_ms", now).min(from + 600_000);
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let Some(pid) = patch_id_of(&channel_id) else { return (StatusCode::BAD_REQUEST, "bad patch id").into_response() };
    let recs = tokio::task::spawn_blocking(move || crate::patch_store::read_wave_range(&root, pid, from, to)).await.unwrap_or_default();
    // per-channel run detection: a new segment when the seq jumps or the time gap is not one bundle
    // each segment keeps its own samples (records interleave channels); the blob is laid out segment by segment
    struct Seg { key: &'static str, fs: u32, axes: usize, scale: f32, t0: u64, n: usize, data: Vec<i16>, last_seq: u32, last_end: u64 }
    let mut segs: Vec<Seg> = Vec::new();
    let mut open: std::collections::HashMap<u8, usize> = std::collections::HashMap::new(); // ch → index in segs
    let mut pace: Vec<serde_json::Value> = Vec::new();
    // bundle length per channel from the median record spacing (the store keeps no META); fs = n / bundle
    let mut spacing: std::collections::HashMap<u8, Vec<u64>> = std::collections::HashMap::new();
    let mut last_ts: std::collections::HashMap<u8, u64> = std::collections::HashMap::new();
    for r in &recs {
        for (ch, _, _) in &r.blocks {
            if let Some(p) = last_ts.get(ch) { if r.ts_ms > *p { spacing.entry(*ch).or_default().push(r.ts_ms - p) } }
            last_ts.insert(*ch, r.ts_ms);
        }
    }
    let bundle_of = |ch: u8| -> u64 {
        let mut v = spacing.get(&ch).cloned().unwrap_or_default();
        if v.is_empty() { return 200 }
        v.sort_unstable();
        v[v.len() / 2].max(1)
    };
    let ecg_fs: Option<u32> = recs.iter().flat_map(|r| r.blocks.iter()).find(|b| b.0 == crate::wire::CH_ECG).map(|b| (b.1 as u64 * 1000 / bundle_of(crate::wire::CH_ECG)) as u32);
    let bundles: std::collections::HashMap<u8, u64> = recs.iter().flat_map(|r| r.blocks.iter().map(|b| b.0)).collect::<std::collections::HashSet<_>>().into_iter().map(|ch| (ch, bundle_of(ch))).collect();
    for r in &recs {
        for (ch, n, data) in &r.blocks {
            let Some((key, scale)) = crate::wire::wave_info(*ch) else { continue };
            let axes = crate::wire::axes(*ch);
            let bundle = bundles.get(ch).copied().unwrap_or(200);
            let fs = ((*n as u64) * 1000 / bundle) as u32;
            let contiguous = open.get(ch).map(|&i| { let s = &segs[i]; r.seq.wrapping_sub(s.last_seq) <= 1 && r.ts_ms.abs_diff(s.last_end) <= bundle / 2 && s.fs == fs }).unwrap_or(false);
            if !contiguous {
                open.insert(*ch, segs.len());
                let t0 = r.ts_ms.saturating_sub(((*n as u64).saturating_sub(1)) * 1000 / fs.max(1) as u64);
                segs.push(Seg { key, fs, axes, scale, t0, n: 0, data: Vec::new(), last_seq: r.seq, last_end: r.ts_ms });
            }
            let i = open[ch];
            let s = &mut segs[i];
            s.data.extend_from_slice(data);
            s.n += *n as usize;
            s.last_seq = r.seq;
            s.last_end = r.ts_ms + bundle;
        }
        // pace offsets index this frame's ECG block, whose last sample is at ts_ms: t = ts − (n_ecg−1)/fs + off/fs
        if !r.pace.is_empty() {
            let bundle = bundles.get(&crate::wire::CH_ECG).copied().unwrap_or(200);
            let fs = ecg_fs.unwrap_or(250) as f64;
            let n_ecg = (bundle as f64 * fs / 1000.0).round().max(1.0);
            for m in &r.pace {
                let t = r.ts_ms as f64 - (n_ecg - 1.0) * 1000.0 / fs + ((m & 0x3fff) as f64) * 1000.0 / fs;
                pace.push(serde_json::json!([t.round() as u64, m]));
            }
        }
    }
    let mut blob: Vec<i16> = Vec::with_capacity(segs.iter().map(|s| s.data.len()).sum());
    let mut offs = Vec::with_capacity(segs.len());
    for s in &segs { offs.push(blob.len()); blob.extend_from_slice(&s.data); }
    let header = serde_json::json!({
        "channel_id": channel_id, "from_ms": from, "to_ms": to, "records": recs.len(),
        "segments": segs.iter().zip(offs.iter()).map(|(s, off)| serde_json::json!({"key": s.key, "fs": s.fs, "axes": s.axes, "scale": s.scale, "t0_ms": s.t0, "n": s.n, "off": off})).collect::<Vec<_>>(),
        "pace": pace,
    }).to_string();
    let mut body = Vec::with_capacity(5 + header.len() + blob.len() * 2);
    body.push(0xB3);
    body.extend_from_slice(&(header.len() as u32).to_le_bytes());
    body.extend_from_slice(header.as_bytes());
    for v in &blob { body.extend_from_slice(&v.to_le_bytes()); }
    ([(axum::http::header::CONTENT_TYPE, "application/octet-stream"), (axum::http::header::CACHE_CONTROL, "no-store")], body).into_response()
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
    state.send_store(crate::patch_store::StoreOp::Reset);
    state.push_event("wave_reset", None, "패치 저장소 리셋 — 저장 파일 전체 삭제".into());
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
