use crate::grouping::GroupConfig;
use crate::output;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{delete, get, post, put};
use axum::{Extension, Json, Router};
use crate::auth::{mask_json, mask_name, Principal};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;

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
        .route("/api/wave/recent", get(wave_recent))
        .route("/api/ecg/engine", get(ecg_engine_status))
        .route("/api/ecg/engine/reload", post(ecg_engine_reload))
        .route("/api/ecg/config", get(ecg_config_get).put(ecg_config_set))
        .route("/api/reports/daily", get(rep_daily))
        .route("/api/ecg/report-source", get(rep_source_get).put(rep_source_set))
        .route("/api/reports/days", get(rep_days))
        .route("/api/reports/patients", get(rep_patients))
        .route("/api/inventory", get(inv_summary))
        .route("/api/inventory/sku", put(inv_sku))
        .route("/api/inventory/{tenant}", get(inv_detail))
        .route("/api/inventory/{tenant}/policy", put(inv_policy))
        .route("/api/inventory/{tenant}/receive", post(inv_receive))
        .route("/api/inventory/{tenant}/adjust", post(inv_adjust))
        .route("/api/inventory/{tenant}/po", post(inv_po_create))
        .route("/api/inventory/{tenant}/po/{id}", put(inv_po_update).delete(inv_po_delete))
        .route("/api/inventory/{tenant}/po/{id}/approve", post(inv_po_approve))
        .route("/api/inventory/{tenant}/po/{id}/ship", post(inv_po_ship))
        .route("/api/inventory/{tenant}/po/{id}/receive", post(inv_po_receive))
        .route("/api/inventory/{tenant}/contract", put(inv_contract))
        .route("/api/inventory/{tenant}/count", post(inv_count))
        .route("/api/inventory/{tenant}/statement", get(inv_statement))
        .route("/api/inventory-transfer", post(inv_transfer))
        .route("/api/inventory-trace", get(inv_trace))
        .route("/api/ecg/versions", get(ecg_versions))
        .route("/api/ecg/versions/{key}/activate", post(ecg_version_activate))
        .route("/api/ecg/versions/{key}", delete(ecg_version_delete))
        .route("/api/ecg/versions/{key}/doc/{name}", get(ecg_version_doc))
        .route("/api/ecg/history", get(ecg_history))
        .route("/api/ecg/summary", get(ecg_summary))
        .route("/api/ecg/bench", post(ecg_bench))
        .route("/api/ecg/eval", get(ecg_eval_get).post(ecg_eval_run))
        .route("/api/ecg/criteria", get(ecg_criteria_get).put(ecg_criteria_set).delete(ecg_criteria_reset))
        .route("/api/ecg/{channel_id}", get(ecg_row))
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
        .route("/api/metrics", get(metrics_series))
        .route("/api/metrics/info", get(metrics_info))
        .route("/api/metrics/reset", post(metrics_reset))
        .route("/api/alarms", get(alarms_active))
        .route("/api/alarms/history", get(alarms_history))
        .route("/api/alarms/rules", get(alarm_rules).put(set_alarm_rules))
        .route("/api/alarms/{id}/ack", post(ack_alarm))
        .route("/api/emu/status", get(emu_status))
        .route("/api/emu/discovery", get(emu_discovery))
        .route("/api/emr/{*path}", get(emr_proxy))
        .route("/api/backup", get(backup_status))
        .route("/api/backup/policy", put(backup_policy))
        .route("/api/backup/targets", post(backup_create))
        .route("/api/backup/targets/{id}", put(backup_update).delete(backup_delete))
        .route("/api/backup/order", put(backup_order))
        .route("/api/backup/test", post(backup_test))
        .route("/api/backup/scan", post(backup_scan))
        .route("/api/backup/catalog/{id}", get(backup_catalog))
        .route("/api/backup/catalog/{id}/sync", post(backup_catalog_sync))
        .route("/api/backup/catalog/{id}/purge", post(backup_catalog_purge))
        .route("/api/backup/abort", post(backup_abort))
        .route("/api/backup/migration", get(backup_migration_get).put(backup_migration_set))
        .route("/api/backup/mirror/kick", post(backup_mirror_kick))
        .route("/api/control/status", get(control_status))
        .route("/api/control", get(control_status))
        .route("/api/control/maintenance", post(control_maintenance))
        .route("/api/control/reset", post(control_reset))
        .route("/api/control/{svc}", post(control_set))
        .route("/api/settings/network", get(net_get).put(net_put))
        .route("/api/settings/network/test", post(net_test))
        .route("/api/settings/network/latency_reset", post(latency_reset))
        .route("/api/time", get(|| async { Json(serde_json::json!({ "now_ms": crate::protocol::now_ms() })) }))
        .route("/api/security", get(security_view))
        .route("/api/security/settings", put(security_settings))
        .route("/api/security/block", post(security_block))
        .route("/api/security/block/{ip}", delete(security_unblock))
        .route("/api/security/clear", post(security_clear))
        .merge(crate::auth_api::routes())
        .merge(crate::emr_api::routes())
        // 로그인·병원 접근·경로별 권한 (모든 /api/*·/ws). CORS 는 쿠키 인증이라 같은 출처만 — permissive 제거.
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::auth::guard))
        // 콘솔은 새로 빌드하면 파일 이름(해시)이 바뀌므로 index.html 이 캐시되면 옛 화면이 남는다 — 매번 재검증(ETag 304 는 싸다)
        .fallback_service(
            axum::Router::new()
                .fallback_service(spa(&web_dir))
                .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-cache"))),
        )
        // 보안 운영: 차단 IP 는 어떤 경로든 403, 나머지는 응답 뒤 스캐닝 분류 — 가장 바깥(정적 파일 포함)
        .layer(axum::middleware::from_fn_with_state(state.clone(), crate::security::guard))
        .with_state(state)
}

/// 네트워크 설정 › 지연시간 계산 리셋: 시계 보정값과 표본을 0 으로
async fn latency_reset(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let before = crate::latency::offset_ms();
    crate::latency::reset_offset();
    state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "latency_reset", &format!("시계 보정값 {before} ms → 0"));
    state.push_event("latency_reset", None, format!("지연시간 계산 리셋 (보정값 {before} ms → 0) · {}", p.username));
    Json(crate::latency::stats())
}

// ---------------------------------------------------------------- 보안 운영 (운영관리 › 보안 운영)

async fn security_view(axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>) -> impl IntoResponse {
    let mut v = crate::security::SEC.view();
    if let Some(o) = v.as_object_mut() {
        o.insert("client_ip".into(), addr.ip().to_string().into()); // 설정 모달의 '지금 접속한 IP → 신뢰 IP 에 추가'
    }
    Json(v)
}

async fn security_settings(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(s): Json<crate::security::Settings>) -> impl IntoResponse {
    let r = crate::security::SEC.set_settings(s).map(|_| crate::security::SEC.view());
    if r.is_ok() {
        state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "security_settings", "보안 운영 설정 변경");
    }
    bk_result(r)
}

#[derive(serde::Deserialize)]
struct BlockBody {
    ip: String,
    #[serde(default)]
    reason: String,
    /// 시간 (0 = 수동 해제까지)
    #[serde(default)]
    hours: u32,
}
async fn security_block(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<BlockBody>) -> impl IntoResponse {
    let Ok(ip) = b.ip.trim().parse::<std::net::IpAddr>() else { return bk_result(Err("IP 형식이 아닙니다".into())) };
    let reason = if b.reason.trim().is_empty() { "수동 차단".to_string() } else { b.reason.trim().to_string() };
    let r = crate::security::SEC.block(ip, "manual", &reason, "", b.hours, &p.username).map(|_| crate::security::SEC.view());
    if r.is_ok() {
        state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "security_block", &format!("{ip} — {reason} (수동)"));
        state.push_event("security", None, format!("IP 차단(수동): {ip} — {reason} · {}", p.username));
    }
    bk_result(r)
}

async fn security_unblock(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(ip): Path<String>) -> impl IntoResponse {
    let Ok(ip) = ip.trim().parse::<std::net::IpAddr>() else { return bk_result(Err("IP 형식이 아닙니다".into())) };
    let had = crate::security::SEC.unblock(ip);
    state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "security_unblock", &ip.to_string());
    state.push_event("security", None, format!("IP 차단 해제: {ip} · {}", p.username));
    bk_result(Ok(serde_json::json!({ "ok": true, "had": had })))
}

#[derive(serde::Deserialize)]
struct ClearBody {
    #[serde(default)]
    ip: String,
    /// scan | login | all
    #[serde(default = "d_all")]
    what: String,
}
fn d_all() -> String {
    "all".into()
}
async fn security_clear(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<ClearBody>) -> impl IntoResponse {
    let ip = if b.ip.trim().is_empty() { None } else { match b.ip.trim().parse::<std::net::IpAddr>() { Ok(i) => Some(i), Err(_) => return bk_result(Err("IP 형식이 아닙니다".into())) } };
    crate::security::SEC.clear(ip, &b.what);
    state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "security_clear", &format!("{} {}", ip.map(|i| i.to_string()).unwrap_or_else(|| "전체".into()), b.what));
    bk_result(Ok(crate::security::SEC.view()))
}

/// 웹 콘솔(vite build 산출물) 서빙. 해시 라우팅이라 모르는 경로는 index.html 로.
fn spa(dir: &str) -> tower_http::services::ServeDir<tower_http::services::ServeFile> {
    let index = std::path::Path::new(dir).join("index.html");
    tower_http::services::ServeDir::new(dir).fallback(tower_http::services::ServeFile::new(index))
}

/// Sizes of every in-memory structure that could grow (leak hunting). Cheap; safe to poll each minute.
async fn debug_sizes(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    // per session: how many packets it could not take, what it watches and how full its queue is — a single
    // struggling viewer shows up here instead of only in the global counter
    let session_detail = {
        let mut v: Vec<serde_json::Value> = state
            .sessions
            .iter()
            .map(|s| {
                let subs = s.subs.read().unwrap();
                serde_json::json!({
                    "id": *s.key(),
                    "age_s": s.opened_at.elapsed().as_secs(),
                    "channels": subs.channels.len(),
                    "groups": subs.groups.len(),
                    "gateways": subs.gws.len(),
                    "lagged": s.lagged.load(Ordering::Relaxed),
                    "queued": s.tx.max_capacity() - s.tx.capacity(),
                })
            })
            .collect();
        v.sort_by_key(|x| std::cmp::Reverse(x["lagged"].as_u64().unwrap_or(0)));
        v.truncate(12);
        serde_json::Value::Array(v)
    };
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
        "ws_subscribers": state.sessions.len(),
        "ws_session_detail": session_detail,
        "ingest_sources": state.ingest_sources.lock().unwrap().len(),
        "displays": state.displays.lock().unwrap().len(),
    }))
}

async fn alarms_active(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let mut v = serde_json::json!({"summary": state.alarms.summary(), "alarms": state.alarms.active()});
    if !p.phi() || !p.bio() {
        mask_alarm_values(&mut v["alarms"], p.phi(), p.bio());
    }
    Json(v)
}

/// 알람 목록 마스킹: 이름·환자번호는 개인정보, 값·문구의 수치는 생체신호
fn mask_alarm_values(v: &mut serde_json::Value, phi: bool, bio: bool) {
    mask_json(v, phi, true);
    if !bio {
        if let Some(a) = v.as_array_mut() {
            for x in a {
                if x.get("channel_id").and_then(|c| c.as_str()).map(|c| !c.is_empty()).unwrap_or(false) {
                    x["value"] = serde_json::json!("●●");
                    if let Some(m) = x.get("message").and_then(|m| m.as_str()) {
                        x["message"] = serde_json::json!(crate::auth::mask_numbers(m));
                    }
                }
            }
        }
    }
}

#[derive(serde::Deserialize)]
struct LimitQ {
    limit: Option<usize>,
}

async fn alarms_history(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Query(q): Query<LimitQ>) -> impl IntoResponse {
    let mut v = serde_json::to_value(state.alarms.history(q.limit.unwrap_or(200).min(500))).unwrap_or_default();
    if !p.phi() || !p.bio() {
        mask_alarm_values(&mut v, p.phi(), p.bio());
    }
    Json(v)
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
    let Some(addr) = state.net.emulator() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "에뮬레이터 주소가 설정되지 않았습니다 — 운영관리 › 네트워크 설정에서 지정하거나 ROUTER_EMULATOR_ADDR 로 실행하세요",
        )
            .into_response();
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
            let body = axum::body::Bytes::from(body);
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

/// `Bytes` is refcounted, so a cached body is shared with every response instead of copied per request
/// (42 viewer tabs polling the 1 MB channel snapshot used to allocate ~46 MB per poll round).
fn body_with_type(body: axum::body::Bytes, ctype: &'static str) -> axum::response::Response {
    ([(axum::http::header::CONTENT_TYPE, ctype)], body).into_response()
}

/// EMR 경로 중 환자 개인정보가 들어 있는 것 (개인정보 권한이 없으면 마스킹)
fn emr_is_phi(path: &str) -> bool {
    matches!(path.split('/').next().unwrap_or(""), "patients" | "admissions" | "patches" | "trips" | "schedules" | "devices")
}

async fn emr_proxy(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(path): Path<String>, axum::extract::RawQuery(q): axum::extract::RawQuery) -> impl IntoResponse {
    if emr_is_phi(&path) && !p.phi() {
        if path.ends_with(".svg") {
            return (StatusCode::FORBIDDEN, "개인정보 권한이 필요합니다").into_response();
        }
        let full = match &q { Some(q) => format!("/api/v1/emr/{path}?{q}"), None => format!("/api/v1/emr/{path}") };
        let resp = emr_get(&state, &full, 10_000).await;
        if !resp.status().is_success() {
            return resp;
        }
        let bytes = axum::body::to_bytes(resp.into_body(), 64 << 20).await.unwrap_or_default();
        let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return (StatusCode::FORBIDDEN, "개인정보 권한이 필요합니다").into_response();
        };
        mask_json(&mut v, false, p.bio());
        return Json(v).into_response();
    }
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
static SNAP_CACHE: std::sync::LazyLock<std::sync::Mutex<[(std::time::Instant, axum::body::Bytes); 5]>> = std::sync::LazyLock::new(|| {
    let t = std::time::Instant::now() - std::time::Duration::from_secs(10);
    std::sync::Mutex::new(std::array::from_fn(|_| (t, axum::body::Bytes::new())))
});

fn cached_json(slot: usize, build: impl FnOnce() -> String) -> axum::response::Response {
    let now = std::time::Instant::now();
    {
        let c = SNAP_CACHE.lock().unwrap();
        if now.duration_since(c[slot].0) < std::time::Duration::from_secs(1) {
            return body_with_type(c[slot].1.clone(), "application/json; charset=utf-8");
        }
    }
    let body = axum::body::Bytes::from(build());
    SNAP_CACHE.lock().unwrap()[slot] = (now, body.clone());
    body_with_type(body, "application/json; charset=utf-8")
}

/// `/api/channels` — the whole registry (1 s cache), or just the rows of a viewer's scope when the same query
/// params the viewer URL uses are passed: ward, room, gw, ids, doctor, nurse, dept, dx, group, region, paced.
async fn list_channels(
    State(state): State<Arc<AppState>>,
    Extension(p): Extension<Principal>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    const KEYS: [&str; 11] = ["ward", "room", "gw", "ids", "doctor", "nurse", "dept", "dx", "group", "region", "paced"];
    let (phi, bio) = (p.phi(), p.bio());
    if !KEYS.iter().any(|k| q.contains_key(*k)) {
        if phi && bio {
            return cached_json(0, || serde_json::to_string(&attach_ana(&state, state.registry.snapshot())).unwrap_or_else(|_| "[]".into()));
        }
        // 마스킹본은 권한 조합별로 따로 1초 캐시 (2 = 개인정보만 가림, 3 = 생체신호만, 4 = 둘 다)
        let slot = match (phi, bio) { (false, true) => 2, (true, false) => 3, _ => 4 };
        return cached_json(slot, || {
            let mut v = serde_json::to_value(attach_ana(&state, state.registry.snapshot())).unwrap_or_default();
            mask_json(&mut v, phi, bio);
            serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())
        });
    }
    let get = |k: &str| q.get(k).map(|s| s.as_str()).filter(|s| !s.is_empty());
    let ids: Option<std::collections::HashSet<&str>> = get("ids").map(|v| v.split(',').collect());
    let rows = state.registry.snapshot_where(|id, st| {
        if let Some(set) = &ids {
            if !set.contains(id) {
                return false;
            }
        }
        if let Some(g) = get("gw") {
            if st.gateway_id != g {
                return false;
            }
        }
        if let Some(g) = get("group") {
            if !st.groups.iter().any(|x| x == g) {
                return false;
            }
        }
        if get("paced").is_some() && st.flags & crate::wire::R_PACEMAKER == 0 {
            return false;
        }
        let p = st.patient.as_ref();
        let field = |v: Option<&str>, f: fn(&crate::protocol::Patient) -> &String| match v {
            None => true,
            Some(want) => p.map(|p| f(p) == want).unwrap_or(false),
        };
        if !field(get("ward"), |p| &p.ward)
            || !field(get("doctor"), |p| &p.doctor)
            || !field(get("nurse"), |p| &p.nurse)
            || !field(get("dept"), |p| &p.department)
            || !field(get("dx"), |p| &p.diagnosis)
            || !field(get("region"), |p| &p.home_region)
        {
            return false;
        }
        if let Some(room) = get("room") {
            let ok = p.map(|p| p.room == room).unwrap_or(false) || st.space == room;
            if !ok {
                return false;
            }
        }
        true
    });
    let rows = attach_ana(&state, rows);
    let body = if phi && bio {
        serde_json::to_string(&rows).unwrap_or_else(|_| "[]".into())
    } else {
        let mut v = serde_json::to_value(&rows).unwrap_or_default();
        mask_json(&mut v, phi, bio);
        serde_json::to_string(&v).unwrap_or_else(|_| "[]".into())
    };
    body_with_type(axum::body::Bytes::from(body), "application/json; charset=utf-8")
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
    /// 알람·멤버십 큐가 가득 차 버린 메시지 누적 (0 이 정상)
    ws_ctrl_dropped: u64,
    /// 열린 출력 WS 세션 수 / 채널 단위로 구독된 패치 수 (세션 간 중복 제외)
    ws_sessions: u64,
    ws_subscribed_channels: usize,
    ws_subscribed_groups: usize,
    ws_subscribed_gateways: usize,
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
    /// 최근 2 s 평균 CPU 클럭 (MHz, 사용 시간 가중; cpufreq 없으면 0)
    cpu_mhz: f32,
    /// 기준 클럭(`cpu_ref_mhz`)으로 환산한 라우터 CPU (1코어@기준클럭 = 100 %; 클럭 정보 없으면 0)
    cpu_process_percent_norm: f32,
    cpu_ref_mhz: u64,
    /// 스토리지 (라우터 드라이브) 전체/여유 바이트
    disk_total_bytes: u64,
    disk_free_bytes: u64,
    /// 저장된 파형 파일 전체 용량 (waves/, 30초 주기 집계)
    wave_store_bytes: u64,
    /// 저장소에 파일이 있는 패치 수
    store_patches: u64,
    /// v3 게이트웨이 표 요약 (프레임/레코드/NACK/이상 카운터)
    gateways: serde_json::Value,
    /// 전송 지연 에뮬레이터→라우터 (프레임 ts_ms 대비 수신 시각, ms): p50/p95/avg/min/max/n
    latency: serde_json::Value,
    /// 라우터 현재 시각 (브라우저가 자기 시계와의 차이·HTTP 편도 지연을 볼 때)
    now_ms: u64,
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
        uptime_s: state.uptime_s(),
        downtime_ms: state.downtime_ms(),
        analysis_connected: state.analysis_up(),
        channel_count: state.registry.len(),
        channels_connected: state.registry.connected_count(),
        queue_dropped_analysis: state.dropped_analysis.load(Ordering::Relaxed),
        queue_dropped_db: state.dropped_db.load(Ordering::Relaxed),
        queue_dropped_wave: state.dropped_wave.load(Ordering::Relaxed),
        ws_lagged: state.ws_lagged.load(Ordering::Relaxed),
        ws_ctrl_dropped: state.ws_ctrl_dropped.load(Ordering::Relaxed),
        ws_sessions: state.ws_sessions.load(Ordering::Relaxed),
        ws_subscribed_channels: state.sub_channels.len(),
        ws_subscribed_groups: state.sub_groups.len(),
        ws_subscribed_gateways: state.sub_gateways.len(),
        store_queue: state.store_tx.max_capacity() - state.store_tx.capacity(),
        mem_process_bytes: mem_process,
        mem_sys_used_bytes: mem_used,
        mem_sys_total_bytes: mem_total,
        cpu_percent: crate::sysmon::cpu_percent(),
        cpu_process_percent: crate::sysmon::proc_cpu_percent(),
        cpu_mhz: crate::sysmon::cpu_mhz(),
        cpu_process_percent_norm: crate::sysmon::proc_cpu_percent_norm(),
        cpu_ref_mhz: crate::sysmon::cpu_ref_mhz(),
        disk_total_bytes: disk_total,
        disk_free_bytes: disk_free,
        wave_store_bytes: crate::patch_store::STORE_BYTES.load(Ordering::Relaxed),
        store_patches: crate::patch_store::STORE_PATCHES.load(Ordering::Relaxed),
        gateways: state.gateways.summary(),
        latency: crate::latency::stats(),
        now_ms: crate::protocol::now_ms(),
    })
}

async fn events(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let mut v = serde_json::to_value(state.recent_events(100)).unwrap_or_default();
    if !p.phi() || !p.bio() {
        // 알람 이벤트 문구에 들어 있는 환자 이름(현재 레지스트리 이름)과 수치를 가린다
        if let Some(a) = v.as_array_mut() {
            for e in a {
                let Some(ch) = e.get("channel_id").and_then(|c| c.as_str()).map(String::from) else { continue };
                let Some(msg) = e.get("message").and_then(|m| m.as_str()).map(String::from) else { continue };
                let mut m = msg;
                if !p.phi() {
                    if let Some(name) = state.registry.patient_of(&ch).map(|pt| pt.name.clone()).filter(|n| !n.is_empty()) {
                        m = m.replace(&name, &mask_name(&name));
                    }
                }
                if !p.bio() {
                    m = crate::auth::mask_numbers(&m);
                }
                e["message"] = serde_json::json!(m);
            }
        }
    }
    Json(v)
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
async fn patch_index(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>) -> impl IntoResponse {
    let phi = p.phi();
    let Some(pid) = patch_id_of(&id) else { return (StatusCode::BAD_REQUEST, "bad patch id").into_response() };
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let bk = state.backup.clone();
    let r = tokio::task::spawn_blocking(move || {
        crate::patch_store::read_index(&root, pid).map(|ix| {
            let files = crate::patch_store::list_files(&root, pid);
            // where: local = 로컬 저장소, restored = 백업에서 받아 둔 복원 캐시, backup = 백업에만 있음(열면 받아 온다)
            let mut out: Vec<(String, serde_json::Value)> = files.iter().map(|(k, p, n)| {
                let seal = crate::patch_store::read_seal(p);
                let (a, b) = crate::patch_store::key_range(k).unwrap_or((0, 0));
                let wh = if p.to_string_lossy().contains(crate::patch_store::RESTORE_DIR) { "restored" } else { "local" };
                (k.clone(), serde_json::json!({"hour": k, "path": p, "bytes": n, "start_ms": a, "end_ms": b, "where": wh,
                                   "sealed": seal.is_some(), "sealed_ok": seal.as_ref().map(|s| s.ok), "crc32": seal.as_ref().map(|s| s.crc32.clone())}))
            }).collect();
            for (k, _rel, n) in bk.remote_blocks(pid) {
                if out.iter().any(|x| x.0 == k) {
                    continue;
                }
                let (a, b) = crate::patch_store::key_range(&k).unwrap_or((0, 0));
                out.push((k.clone(), serde_json::json!({"hour": k, "bytes": n, "start_ms": a, "end_ms": b, "where": "backup", "sealed": true})));
            }
            out.sort_by(|x, y| x.0.cmp(&y.0));
            serde_json::json!({ "index": ix, "files": out.into_iter().map(|x| x.1).collect::<Vec<_>>() })
        })
    })
    .await
    .ok()
    .flatten();
    match r {
        Some(mut v) => {
            if !phi {
                mask_json(&mut v, false, true);
            }
            Json(v).into_response()
        }
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
        let bk = state.backup.clone();
        let r = tokio::task::spawn_blocking(move || {
            bk.ensure_local(pid, from, to, 13); // 로컬에서 지운 과거 구간은 백업에서 (하루 = 2시간 파일 12개)
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
    let _permit = hist_sem().acquire().await;
    let sr = state.registry.sample_rate_of(&channel_id).unwrap_or(250);
    let bk = state.backup.clone();
    let r: Vec<(u64, u32, Vec<f32>)> = tokio::task::spawn_blocking(move || {
        bk.ensure_local(pid, from, to, 2);
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

/// 채널 행에 내장 ECG 분석 요약(`ana`: hr·rhythm·q·af·vf·pvc_min·since)을 붙인다 — 목록·지도·뷰어가 WS 없이도 리듬을 본다
fn attach_ana(state: &AppState, mut rows: Vec<crate::registry::ChannelInfo>) -> Vec<crate::registry::ChannelInfo> {
    if !state.analysis.enabled() {
        return rows;
    }
    for r in rows.iter_mut() {
        if let Some(a) = state.analysis.row(&r.channel_id) {
            r.ana = Some(serde_json::json!({ "hr": a.hr, "rhythm": a.rhythm, "since_ms": a.rhythm_since_ms, "q": a.q, "qs": a.qs, "af": a.af, "af_p": a.af_p, "vf": a.vf, "pvc_min": a.pvc_min, "updated_ms": a.updated_ms }));
        }
    }
    rows
}

/// 내장 ECG 분석 엔진 상태 (id·ABI·단계·채널·부하) / 다시 읽기 / 채널 하나의 분석 요약
async fn ecg_engine_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.analysis.status_json())
}
async fn ecg_engine_reload(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let st = state.clone();
    match tokio::task::spawn_blocking(move || st.analysis.reload()).await.unwrap_or(Err("failed".into())) {
        Ok(id) => {
            state.set_analysis_up(true);
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_engine_reload", &id);
            state.push_event("ecg_engine", None, format!("ECG 분석 엔진 다시 읽음: {id}"));
            Json(state.analysis.status_json()).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_config_get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.analysis.config_json())
}
#[derive(serde::Deserialize)]
struct EcgCfgIn {
    #[serde(default)]
    preset: String,
    #[serde(default)]
    stages: String,
}
async fn ecg_config_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<EcgCfgIn>) -> impl IntoResponse {
    match state.analysis.set_config(&b.preset, &b.stages) {
        Ok(v) => {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_config", &format!("preset={} stages={}", b.preset, b.stages));
            state.push_event("ecg_engine", None, format!("ECG 분석 설정 변경: 프리셋 {} · 단계 {}", b.preset, if b.stages.is_empty() { "기본" } else { &b.stages }));
            Json(v).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_versions(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let _ = state.analysis.import_current();
    Json(serde_json::json!({ "versions": state.analysis.versions(), "active": state.analysis.engine().map(|e| crate::ecg_analysis::AnalysisHub::version_key(&e.id)) }))
}
async fn ecg_version_activate(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(key): Path<String>) -> impl IntoResponse {
    let st = state.clone();
    let by = p.username.clone();
    match tokio::task::spawn_blocking(move || st.analysis.activate(&key, &by)).await.unwrap_or(Err("failed".into())) {
        Ok(id) => {
            state.set_analysis_up(true);
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_engine_activate", &id);
            state.push_event("ecg_engine", None, format!("ECG 엔진 활성화: {id}"));
            Json(state.analysis.status_json()).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_version_delete(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(key): Path<String>) -> impl IntoResponse {
    match state.analysis.delete_version(&key) {
        Ok(()) => {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_engine_delete", &key);
            Json(serde_json::json!({ "ok": true })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_version_doc(State(state): State<Arc<AppState>>, Path((key, name)): Path<(String, String)>) -> impl IntoResponse {
    match state.analysis.version_doc(&key, &name) {
        Some(t) => ([(axum::http::header::CONTENT_TYPE, "text/plain; charset=utf-8")], t).into_response(),
        None => (StatusCode::NOT_FOUND, "없음").into_response(),
    }
}
async fn ecg_history(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.analysis.history())
}
async fn ecg_summary(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut v = state.analysis.summary_json();
    // QRS 검출율(대용): 최근 1분 검출 박동 ÷ 패치가 보낸 HR(=1분 기대 박동). 품질 '사용 불가'·전극 탈락·최근 갱신 없는 채널은 제외.
    let now = crate::protocol::now_ms();
    let mut hr_of: std::collections::HashMap<u32, (u8, u64, u8)> = std::collections::HashMap::new();
    state.registry.for_each(|id, ch| {
        if let (Ok(pid), Some(hr)) = (id.parse::<u32>(), ch.vitals.hr) {
            hr_of.insert(pid, (hr, ch.vitals_ts_ms, ch.flags));
        }
    });
    let mut ratios: Vec<f64> = Vec::new();
    let (mut det, mut exp) = (0u64, 0u64);
    for (pid, b1m, _hr, q, upd) in state.analysis.beat_rates() {
        if now.saturating_sub(upd) > 10_000 || q == crate::ecg_engine::QUALITY_UNUSABLE { continue; }
        let Some((hr, vts, flags)) = hr_of.get(&pid) else { continue };
        if *hr < 20 || now.saturating_sub(*vts) > 10_000 || flags & crate::wire::R_LEAD_OFF != 0 { continue; }
        ratios.push(b1m as f64 / *hr as f64);
        det += b1m as u64;
        exp += *hr as u64;
    }
    ratios.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let n = ratios.len();
    let within = |tol: f64| ratios.iter().filter(|r| (**r - 1.0).abs() <= tol).count();
    let hist: Vec<(String, usize)> = [("<80%", 0.0, 0.8), ("80–90%", 0.8, 0.9), ("90–95%", 0.9, 0.95), ("95–105%", 0.95, 1.05), ("105–110%", 1.05, 1.1), (">110%", 1.1, 1e9)].iter().map(|(l, a, b)| (l.to_string(), ratios.iter().filter(|r| **r >= *a && **r < *b).count())).collect();
    if let Some(o) = v.as_object_mut() {
        o.insert("qrs".into(), serde_json::json!({
            "channels": n, "detected_1m": det, "expected_1m": exp,
            "rate": if exp > 0 { Some(det as f64 / exp as f64) } else { None },
            "median_ratio": if n > 0 { Some(ratios[n / 2]) } else { None },
            "within_5pct": within(0.05), "within_10pct": within(0.10), "hist": hist,
            "note": "검출율 = 최근 1분 엔진 검출 박동 ÷ 패치 HR(기대 박동). 박동 단위 정답이 없어 민감도·정밀도 대신 쓰는 대용 지표 — 사용 불가 품질·전극 탈락·10초 이상 갱신 없는 채널 제외"
        }));
    }
    Json(v)
}
#[derive(serde::Deserialize)]
struct BenchIn {
    #[serde(default)]
    seconds: u32,
    #[serde(default)]
    channels: u32,
}
async fn ecg_bench(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<BenchIn>) -> impl IntoResponse {
    let st = state.clone();
    let (sec, ch) = (if b.seconds == 0 { 20 } else { b.seconds }, if b.channels == 0 { 8 } else { b.channels });
    match tokio::task::spawn_blocking(move || st.analysis.bench(sec, ch)).await.unwrap_or(Err("failed".into())) {
        Ok(v) => {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_bench", &format!("{} ns/sample", v["ns_per_sample"]));
            Json(v).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
#[derive(serde::Deserialize)]
struct EvalIn {
    #[serde(default)]
    hours: f64,
}
async fn ecg_eval_get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(crate::ecg_eval::last(&state))
}
async fn ecg_eval_run(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<EvalIn>) -> impl IntoResponse {
    let hours = if b.hours <= 0.0 { 1.0 } else { b.hours };
    match crate::ecg_eval::run(&state, hours).await {
        Ok(v) => {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_eval", &format!("{hours}h labels={}", v["labels"]));
            Json(v).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_criteria_get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(crate::ecg_eval::criteria(&state))
}
async fn ecg_criteria_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(v): Json<serde_json::Value>) -> impl IntoResponse {
    match crate::ecg_eval::set_criteria(&state, v) {
        Ok(r) => { state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_criteria", "참고 기준 변경"); Json(r).into_response() }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_criteria_reset(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    match crate::ecg_eval::set_criteria(&state, serde_json::Value::Null) {
        Ok(r) => { state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "ecg_criteria", "참고 기준 초기화"); Json(r).into_response() }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn ecg_row(State(state): State<Arc<AppState>>, Path(channel_id): Path<String>) -> impl IntoResponse {
    match state.analysis.row(&channel_id) {
        Some(r) => Json(serde_json::to_value(r).unwrap_or_default()).into_response(),
        None => (StatusCode::NOT_FOUND, "분석 결과 없음").into_response(),
    }
}

/// 여러 환자의 "최근 N초 ECG" 미니 파형(환자 목록의 ECG(10초) 열): 저장 파일 꼬리 + 미플러시 버퍼를 읽어 서버에서
/// min/max 버킷(points 쌍)으로 줄여 한 번에 돌려준다 — 브라우저가 10초 동안 스트림을 모으던 것(지연 ≥ 10 s)을 대체.
/// `?ids=a,b,c&secs=10&points=96` (ids ≤ 120). 응답 {"t","secs","points":{id:{"n","pts":[max,min,…]}}}, pts 는 최솟값을 0 으로 옮긴 mV.
async fn wave_recent(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let now = crate::protocol::now_ms();
    let getn = |k: &str, d: u64| q.get(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let secs = getn("secs", 10).clamp(2, 30);
    let points = getn("points", 96).clamp(16, 400) as usize;
    let ids: Vec<String> = q.get("ids").map(|v| v.split(',').filter(|x| !x.is_empty()).take(120).map(String::from).collect()).unwrap_or_default();
    let from = now.saturating_sub(secs * 1000);
    // 미플러시 버퍼는 저장 스레드에 한꺼번에 묻고 한꺼번에 받는다
    let mut waits = Vec::new();
    for id in &ids {
        if let Some(pid) = patch_id_of(id) {
            let (tx, rx) = tokio::sync::oneshot::channel();
            state.send_store(crate::patch_store::StoreOp::Pending { pid, tx });
            waits.push((pid, rx));
        }
    }
    let mut bufs: std::collections::HashMap<u32, Vec<u8>> = std::collections::HashMap::new();
    for (pid, rx) in waits {
        if let Ok(Ok(b)) = tokio::time::timeout(std::time::Duration::from_millis(300), rx).await {
            bufs.insert(pid, b);
        }
    }
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    // 이력 뷰어의 청크 읽기와 다른 게이트(1개): 환자 목록 배치가 이력 뷰어를 0.5 s 씩 기다리게 하지 않는다
    let _permit = recent_sem().acquire().await;
    let out = tokio::task::spawn_blocking(move || {
        let mut m = serde_json::Map::new();
        for id in ids {
            let Some(pid) = patch_id_of(&id) else { continue };
            let mut recs: Vec<(u64, Vec<f32>)> = crate::patch_store::read_ecg_range(&root, pid, from, now).into_iter().map(|(ts, _seq, s)| (ts, s)).collect();
            if let Some(b) = bufs.get(&pid) {
                for r in crate::patch_store::wave_recs_in_buf(b, from, now) {
                    for (ch, _n, data) in r.blocks {
                        if ch == crate::wire::CH_ECG {
                            recs.push((r.ts_ms, data.iter().map(|v| *v as f32 * 0.001).collect()));
                        }
                    }
                }
            }
            recs.sort_by_key(|r| r.0);
            recs.dedup_by_key(|r| r.0);
            let samples: Vec<f32> = recs.into_iter().flat_map(|r| r.1).collect();
            let n = samples.len();
            if n < 2 {
                continue;
            }
            let stride = (n / points).max(1);
            let mut pts: Vec<f32> = Vec::with_capacity(points * 2 + 2);
            let mut lo_all = f32::INFINITY;
            let mut i = 0;
            while i < n {
                let end = (i + stride).min(n);
                let (mut mn, mut mx) = (f32::INFINITY, f32::NEG_INFINITY);
                for v in &samples[i..end] {
                    if *v < mn { mn = *v }
                    if *v > mx { mx = *v }
                }
                pts.push(mx);
                pts.push(mn);
                if mn < lo_all { lo_all = mn }
                i += stride;
            }
            let arr: Vec<serde_json::Value> = pts.iter().map(|v| serde_json::json!(((v - lo_all) * 1000.0).round() / 1000.0)).collect();
            m.insert(id, serde_json::json!({ "n": n, "pts": arr }));
        }
        m
    }).await.unwrap_or_default();
    Json(serde_json::json!({ "t": now, "secs": secs, "points": out })).into_response()
}

/// 저장 파형 전 채널 조회 (이력 뷰어). 범위 최대 10분. 바이너리 응답:
///   [u8 0xB3][u32 header_len][header JSON][i16 blob]
///   header = {"from_ms","to_ms","records","segments":[{key,fs,axes,scale,t0_ms,n,off}],"pace":[[t_ms,mark],…]}
/// 세그먼트 = 연속 레코드 묶음(seq 연속 · 시간 간격 정상); n 은 축당 샘플 수, off 는 블롭의 i16 인덱스, 값 = raw × scale.
/// 레코드의 ts_ms 는 번들 마지막 샘플 시각(스트림/링 버퍼와 같은 규약)이므로 t0_ms = ts − (n−1)/fs, 페이스 t 도 절대 시각.
/// At most this many stored-waveform reads run at once: each loads a whole hour file (a few MB) and a burst of
/// a dozen concurrent requests from a scrolling history list left ~40 MB of allocator-retained memory behind.
static HIST_SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
static RECENT_SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
fn recent_sem() -> &'static tokio::sync::Semaphore {
    RECENT_SEM.get_or_init(|| tokio::sync::Semaphore::new(1))
}
fn hist_sem() -> &'static tokio::sync::Semaphore {
    HIST_SEM.get_or_init(|| tokio::sync::Semaphore::new(2))
}

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
    let _permit = hist_sem().acquire().await;
    let bk = state.backup.clone();
    let mut recs = tokio::task::spawn_blocking(move || {
        bk.ensure_local(pid, from, to, 2); // 로컬에서 지운 구간은 백업에서 받아 온다 (첫 요청만 느림)
        crate::patch_store::read_wave_range(&root, pid, from, to)
    }).await.unwrap_or_default();
    // 아직 플러시되지 않은 버퍼(최대 ~5 s)도 이어 붙인다: 이력 LIVE 구간이 "지금" 직전까지 저장본으로 채워진다.
    // 파일과 겹치는 레코드(플러시 직후의 경합)는 (ts, seq) 로 걸러 낸다.
    if to + 10_000 >= now {
        let (tx, rx) = tokio::sync::oneshot::channel();
        state.send_store(crate::patch_store::StoreOp::Pending { pid, tx });
        if let Ok(Ok(buf)) = tokio::time::timeout(std::time::Duration::from_millis(300), rx).await {
            let seen: std::collections::HashSet<(u64, u32)> = recs.iter().map(|r| (r.ts_ms, r.seq)).collect();
            recs.extend(crate::patch_store::wave_recs_in_buf(&buf, from, to).into_iter().filter(|r| !seen.contains(&(r.ts_ms, r.seq))));
        }
    }
    recs.sort_by_key(|r| (r.ts_ms, r.seq));
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

/// 장기 운영 통계: `?range=hour|day|week|month|quarter|year`.
/// A year range aggregates thousands of rows, so the answer is cached per range for 15 s — several open pages
/// (or tabs) then cost one query, and the query itself runs on a blocking thread, never on the async runtime.
static SERIES_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, axum::body::Bytes)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

async fn metrics_series(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let range = q.get("range").cloned().unwrap_or_else(|| "day".into());
    // 5분 구간은 2 s 샘플이라 캐시도 2 s (여러 탭이 같은 초에 물어도 한 번만 만든다)
    let ttl = std::time::Duration::from_secs(if range == "5min" { 2 } else { 15 });
    if let Some((at, body)) = SERIES_CACHE.lock().unwrap().get(&range).cloned() {
        if at.elapsed() < ttl {
            return body_with_type(body, "application/json; charset=utf-8");
        }
    }
    let s = state.clone();
    let r2 = range.clone();
    let v = tokio::task::spawn_blocking(move || crate::metrics::series(&s.metrics, &r2))
        .await
        .unwrap_or_else(|_| serde_json::json!({ "points": [] }));
    let body = axum::body::Bytes::from(serde_json::to_string(&v).unwrap_or_else(|_| "{}".into()));
    SERIES_CACHE.lock().unwrap().insert(range, (std::time::Instant::now(), body.clone()));
    body_with_type(body, "application/json; charset=utf-8")
}

async fn metrics_info(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let s = state.clone();
    let v = tokio::task::spawn_blocking(move || crate::metrics::info(&s.metrics, &s.cfg.db_path))
        .await
        .unwrap_or_else(|_| serde_json::json!({}));
    Json(v)
}

async fn metrics_reset(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    SERIES_CACHE.lock().unwrap().clear();
    let s = state.clone();
    let ok = tokio::task::spawn_blocking(move || crate::metrics::reset(&s.metrics)).await.unwrap_or(false);
    state.push_event("metrics_reset", None, "운영 통계 초기화".into());
    Json(serde_json::json!({ "ok": ok }))
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
async fn wave_reset(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "wave_reset", "로컬 파형 저장소 전체 삭제");
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

// ---------------------------------------------------------------- 파형 백업 (운영관리 › 데이터 관리)

fn bk_result(r: Result<serde_json::Value, String>) -> axum::response::Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

async fn backup_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let b = state.backup.clone();
    Json(tokio::task::spawn_blocking(move || b.status()).await.unwrap_or_default())
}

async fn backup_policy(State(state): State<Arc<AppState>>, Extension(who): Extension<Principal>, Json(p): Json<crate::backup::Policy>) -> impl IntoResponse {
    let detail = format!(
        "저장 단위 {}시간 · 상한 {} · 봉인 {}/s · 사본 {} · 삭제 {} · 검증 {} · {}",
        p.block_hours,
        if p.store_max_gb > 0 { format!("{} GB", p.store_max_gb) } else { "런처 값".into() },
        if p.seal_per_sec > 0 { p.seal_per_sec.to_string() } else { "무제한".into() },
        p.copies,
        p.delete_mode,
        p.verify,
        if p.paused { "일시 중지" } else { "전송 중" }
    );
    let r = state.backup.set_policy(p).map(|_| serde_json::json!({ "ok": true }));
    if r.is_ok() {
        state.auth.audit(&who.username, who.tenant_id.as_deref().unwrap_or(""), "backup_policy", &detail);
        state.push_event("backup_config", None, "백업 정책 변경".into());
    }
    bk_result(r)
}

async fn backup_create(State(state): State<Arc<AppState>>, Json(t): Json<crate::backup::TargetInput>) -> impl IntoResponse {
    let name = t.t.name.clone();
    let r = state.backup.create_target(t);
    if r.is_ok() {
        state.push_event("backup_config", None, format!("백업 대상 추가: {name}"));
    }
    bk_result(r)
}

async fn backup_update(State(state): State<Arc<AppState>>, Path(id): Path<String>, Json(t): Json<crate::backup::TargetInput>) -> impl IntoResponse {
    bk_result(state.backup.update_target(&id, t).map(|_| serde_json::json!({ "ok": true })))
}

async fn backup_delete(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    let name = state.backup.target(&id).map(|t| t.name).unwrap_or_default();
    let r = state.backup.delete_target(&id).map(|_| serde_json::json!({ "ok": true }));
    if r.is_ok() {
        state.push_event("backup_config", None, format!("백업 대상 삭제: {name}"));
    }
    bk_result(r)
}

#[derive(serde::Deserialize)]
struct OrderBody {
    ids: Vec<String>,
}

async fn backup_order(State(state): State<Arc<AppState>>, Json(b): Json<OrderBody>) -> impl IntoResponse {
    bk_result(state.backup.reorder(&b.ids).map(|_| serde_json::json!({ "ok": true })))
}

/// 연결 시험 — 저장 전 입력값 그대로 (비밀번호가 비어 있으면 같은 id 의 저장된 값)
async fn backup_test(State(state): State<Arc<AppState>>, Json(t): Json<crate::backup::TargetInput>) -> impl IntoResponse {
    let b = state.backup.clone();
    let r = tokio::task::spawn_blocking(move || b.resolve_for_test(t).map(|t| b.test_target(&t))).await.unwrap_or_else(|e| Err(e.to_string()));
    bk_result(r)
}

#[derive(serde::Deserialize)]
struct CatalogQ {
    hour: Option<String>,
    #[serde(default)]
    q: String,
}

/// 대상별 백업 목록: 시간별 요약, `?hour=` 이면 그 시간의 파일
async fn backup_catalog(State(state): State<Arc<AppState>>, Path(id): Path<String>, Query(q): Query<CatalogQ>) -> impl IntoResponse {
    let b = state.backup.clone();
    Json(tokio::task::spawn_blocking(move || b.catalog(&id, q.hour.as_deref(), &q.q)).await.unwrap_or_default())
}

async fn backup_catalog_sync(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> impl IntoResponse {
    bk_result(state.backup.sync_catalog(&id).map(|_| serde_json::json!({ "ok": true })))
}

/// 서비스 제어 상태 (멈춘 서비스·알람 억제)
async fn control_status(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(crate::control::status(&state))
}

async fn control_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(svc): Path<String>, Json(b): Json<crate::control::SetReq>) -> impl IntoResponse {
    bk_result(crate::control::set(&state, &p.username, &svc, &b, false).map(|_| crate::control::status(&state)))
}

async fn control_maintenance(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<crate::control::SetReq>) -> impl IntoResponse {
    bk_result(crate::control::maintenance(&state, &p.username, &b).map(|_| crate::control::status(&state)))
}

/// 가동 초기화: 모든 서비스 멈춤 → 로컬 저장소·원격 백업 파일 삭제 → 카운터·통계·알람·표 비움 → 다시 켬 (백그라운드).
/// 확인 문구(`confirm`)가 "가동 초기화" 와 같아야 하고, 운영 모드에서는 사유가 필요하다. 권한: 백업 파일 전체 삭제.
#[derive(serde::Deserialize)]
struct ResetBody {
    #[serde(default)]
    confirm: String,
    #[serde(default)]
    reason: String,
}
async fn control_reset(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<ResetBody>) -> impl IntoResponse {
    let who = p.username.clone();
    bk_result(crate::reset::start(state.clone(), &who, &b.reason, &b.confirm).map(|_| crate::control::status(&state)))
}

/// 운영 통계 조회 캐시 비우기 (통계 초기화·가동 초기화)
pub fn clear_series_cache() {
    SERIES_CACHE.lock().unwrap().clear();
}

/// 백업 중단: 전송 중인 파일까지 바로 끊고 일시 중지
/// NAS 이관 마법사 상태 (콘솔이 단계·선택을 저장; null 로 지움) / 미러링 즉시 재검사
async fn backup_migration_get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    Json(state.backup.migration())
}
async fn backup_migration_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(v): Json<serde_json::Value>) -> impl IntoResponse {
    match state.backup.set_migration(v.clone()) {
        Ok(()) => {
            let phase = v.get("phase").and_then(|x| x.as_str()).unwrap_or("-").to_string();
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "backup_migration", &phase);
            if !v.is_null() {
                state.push_event("backup_config", None, format!("NAS 이관 단계: {phase}"));
            }
            Json(state.backup.migration()).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}
async fn backup_mirror_kick(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    state.backup.mirror_kick();
    Json(serde_json::json!({ "ok": true, "mirror": state.backup.mirror_states() }))
}

async fn backup_abort(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let r = state.backup.abort().map(|n| serde_json::json!({ "ok": true, "killed": n }));
    if let Ok(v) = &r {
        state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "backup_abort", &format!("전송 중 {}건 종료", v["killed"]));
        state.push_event("backup_config", None, "백업 중단 (사용자)".into());
    }
    bk_result(r)
}

/// 대상의 백업 파일 전체 삭제 (설정된 디렉터리의 patches/ 만). 확인 문구가 대상 이름과 같아야 한다.
#[derive(serde::Deserialize)]
struct PurgeBody {
    confirm: String,
}
async fn backup_catalog_purge(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>, Json(b): Json<PurgeBody>) -> impl IntoResponse {
    let Some(t) = state.backup.target(&id) else { return bk_result(Err("대상 없음".into())) };
    if b.confirm.trim() != t.name.trim() {
        return bk_result(Err("확인 문구가 대상 이름과 다릅니다".into()));
    }
    let r = state.backup.purge_target(&id).map(|_| serde_json::json!({ "ok": true }));
    if r.is_ok() {
        state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "backup_purge", &format!("{} ({})", t.name, t.id));
        state.push_event("backup_config", None, format!("백업 파일 전체 삭제 시작: {}", t.name));
    }
    bk_result(r)
}

async fn backup_scan(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    state.backup.kick();
    Json(serde_json::json!({ "ok": true }))
}

// ---------------------------------------------------------------- 네트워크 설정 (운영관리 › 네트워크 설정)

async fn net_get(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut v = state.net.view();
    if let Some(o) = v.as_object_mut() {
        o.insert("ingest_addr".into(), state.cfg.ingest_addr.clone().into());
        o.insert("http_addr".into(), state.cfg.http_addr.clone().into());
        o.insert("analysis_connected".into(), state.analysis_up.load(Ordering::Relaxed).into());
        o.insert("emulator_connected".into(), (crate::emu_link::LAST_OK_MS.load(Ordering::Relaxed) > 0).into());
        o.insert("emulator_last_ok_ms".into(), crate::emu_link::LAST_OK_MS.load(Ordering::Relaxed).into());
    }
    Json(v)
}

async fn net_put(State(state): State<Arc<AppState>>, Json(inp): Json<crate::netcfg::NetInput>) -> impl IntoResponse {
    match state.net.apply(inp) {
        Ok(changed) => {
            if !changed.is_empty() {
                state.push_event("network_config", None, format!("네트워크 설정 변경: {}", changed.join(", ")));
            }
            Json(serde_json::json!({ "ok": true, "changed": changed })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}

#[derive(serde::Deserialize)]
struct NetTest {
    kind: String,
    addr: String,
}

async fn net_test(Json(t): Json<NetTest>) -> impl IntoResponse {
    Json(crate::netcfg::test(&t.kind, &t.addr).await)
}

// ───────── 패치 재고 ─────────
fn inv_tenants(state: &AppState, p: &Principal) -> Vec<(String, String)> {
    let mut v: Vec<(String, String)> = state.auth.tenants_for(p).iter().filter_map(|t| Some((t.get("id")?.as_str()?.to_string(), t.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string()))).collect();
    let site = state.auth.site_tenant();
    if v.is_empty() && p.can_access(&site) { v.push((site, String::new())); }
    v
}
fn inv_res<T: serde::Serialize>(r: Result<T, String>) -> axum::response::Response {
    match r { Ok(v) => Json(serde_json::json!({ "ok": true, "result": v })).into_response(), Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response() }
}
async fn inv_summary(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> impl IntoResponse {
    let t = inv_tenants(&state, &p);
    let inv = state.inventory.clone();
    let mut v = tokio::task::spawn_blocking(move || inv.summary(&t)).await.unwrap_or_default();
    v["site"] = serde_json::json!(state.auth.site_tenant());
    Json(v)
}
async fn inv_detail(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "이 병원의 재고를 볼 권한이 없습니다").into_response(); }
    let inv = state.inventory.clone();
    Json(tokio::task::spawn_blocking(move || inv.detail(&tenant)).await.unwrap_or_default()).into_response()
}
#[derive(serde::Deserialize)]
struct SkuIn { id: String, #[serde(default)] name: String, #[serde(default)] per_box: i64, #[serde(default)] unit_price: f64, #[serde(default)] wear_days: f64, #[serde(default = "yes_true")] active: bool }
fn yes_true() -> bool { true }
async fn inv_sku(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<SkuIn>) -> impl IntoResponse {
    if !matches!(p.role.as_str(), "super_admin" | "system_admin" | "reseller" | "sales_crm") { return (StatusCode::FORBIDDEN, "품목은 리셀러·영업·관리자만 바꿉니다").into_response(); }
    state.auth.audit(&p.username, "", "inv_sku", &b.id);
    inv_res(state.inventory.upsert_sku(&b.id, &b.name, b.per_box, b.unit_price, if b.wear_days > 0.0 { b.wear_days } else { 14.0 }, b.active))
}
#[derive(serde::Deserialize)]
struct PolicyIn { sku: String, lead_days: f64, review_days: f64, service: f64, #[serde(default)] min_boxes: i64 }
async fn inv_policy(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<PolicyIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "권한 없음").into_response(); }
    state.auth.audit(&p.username, &tenant, "inv_policy", &format!("{} L{} R{} {}", b.sku, b.lead_days, b.review_days, b.service));
    inv_res(state.inventory.set_policy(&tenant, &b.sku, b.lead_days, b.review_days, b.service, b.min_boxes))
}
#[derive(serde::Deserialize)]
struct ReceiveIn { sku: String, lot: String, #[serde(default)] expiry: String, qty: i64, #[serde(default)] po: Option<i64> }
async fn inv_receive(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<ReceiveIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "권한 없음").into_response(); }
    state.auth.audit(&p.username, &tenant, "inv_receive", &format!("{} {} ×{}", b.sku, b.lot, b.qty));
    inv_res(state.inventory.receive(&tenant, &b.sku, &b.lot, &b.expiry, b.qty, b.po, &p.username))
}
#[derive(serde::Deserialize)]
struct AdjustIn { sku: String, kind: String, qty: i64, #[serde(default)] reason: String, #[serde(default)] lot: Option<i64> }
async fn inv_adjust(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<AdjustIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "권한 없음").into_response(); }
    state.auth.audit(&p.username, &tenant, "inv_adjust", &format!("{} {} {} {}", b.sku, b.kind, b.qty, b.reason));
    inv_res(state.inventory.adjust(&tenant, &b.sku, &b.kind, b.qty, &b.reason, b.lot, &p.username))
}
#[derive(serde::Deserialize)]
struct PoIn { sku: String, boxes: i64, #[serde(default)] note: String }
async fn inv_po_create(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<PoIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "권한 없음").into_response(); }
    state.auth.audit(&p.username, &tenant, "inv_po_create", &format!("{} ×{}", b.sku, b.boxes));
    inv_res(state.inventory.po_create(&tenant, &b.sku, b.boxes, &b.note, &p.username))
}
#[derive(serde::Deserialize)]
struct PoUpd { status: String, #[serde(default)] tracking: String, #[serde(default)] eta: String, #[serde(default)] boxes: Option<i64> }
async fn inv_po_update(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path((tenant, id)): Path<(String, i64)>, Json(b): Json<PoUpd>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return (StatusCode::FORBIDDEN, "권한 없음").into_response(); }
    if b.status != "cancelled" { return (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "승인·출고·수령은 각 단계 버튼으로 진행합니다" }))).into_response(); }
    state.auth.audit(&p.username, &tenant, "inv_po_update", &format!("PO-{id} → {}", b.status));
    inv_res(state.inventory.po_update(&tenant, id, &b.status, &b.tracking, &b.eta, b.boxes))
}

// ───────── 일일 ECG 리포트 ─────────
async fn rep_daily(State(state): State<Arc<AppState>>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let Some(patch) = q.get("patch").and_then(|v| v.parse::<u32>().ok()) else { return (StatusCode::BAD_REQUEST, "patch 필요").into_response() };
    let date = q.get("date").cloned().unwrap_or_else(|| (chrono::Local::now() - chrono::Duration::days(1)).format("%Y-%m-%d").to_string());
    static REP_SEM: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let _permit = REP_SEM.get_or_init(|| tokio::sync::Semaphore::new(4)).acquire().await;
    // 판정 출처(관리 › ECG 분석 엔진): 정답지면 에뮬레이터 정답을 먼저 받는다. ?source= 로 한 번만 바꿔 볼 수도 있다.
    let source = q.get("source").cloned().filter(|s| s == "truth" || s == "engine").unwrap_or_else(|| crate::reports::report_source(&state));
    let truth = if source == "truth" {
        match crate::reports::truth_for(&state, patch, &date).await { Ok(t) => Some(t), Err(e) => return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({ "error": format!("{e} — 관리 › ECG 분석 엔진에서 리포트 판정 출처를 '분석 엔진'으로 바꾸면 엔진 결과로 만듭니다") }))).into_response() }
    } else { None };
    let st = state.clone();
    match tokio::task::spawn_blocking(move || crate::reports::daily(&st, patch, &date, truth.as_ref())).await.unwrap_or(Err("failed".into())) {
        Ok(v) => Json(v).into_response(),
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}
async fn rep_days(State(state): State<Arc<AppState>>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let Some(patch) = q.get("patch").and_then(|v| v.parse::<u32>().ok()) else { return (StatusCode::BAD_REQUEST, "patch 필요").into_response() };
    let st = state.clone();
    Json(tokio::task::spawn_blocking(move || crate::reports::days(&st, patch)).await.unwrap_or_default()).into_response()
}

// 역할: 공급사(요청·출고·계약·이동) / 병원(승인·수령). 관리자는 둘 다(시험·대행).
fn is_supplier(p: &Principal) -> bool { matches!(p.role.as_str(), "super_admin" | "system_admin" | "reseller" | "sales_crm") }
fn is_hospital(p: &Principal) -> bool { matches!(p.role.as_str(), "super_admin" | "system_admin" | "hospital_it" | "nurse" | "staff") }
fn inv_forbid(msg: &str) -> axum::response::Response { (StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": msg }))).into_response() }
async fn inv_po_delete(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path((tenant, id)): Path<(String, i64)>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return inv_forbid("권한 없음"); }
    state.auth.audit(&p.username, &tenant, "inv_po_delete", &format!("PO-{id}"));
    inv_res(state.inventory.po_delete(&tenant, id))
}
#[derive(serde::Deserialize)]
struct ApproveIn { #[serde(default)] hospital_po: String }
async fn inv_po_approve(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path((tenant, id)): Path<(String, i64)>, Json(b): Json<ApproveIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) || !is_hospital(&p) { return inv_forbid("발주 승인은 병원 담당자(IT·간호·원무)가 합니다"); }
    state.auth.audit(&p.username, &tenant, "inv_po_approve", &format!("PO-{id} {}", b.hospital_po));
    inv_res(state.inventory.po_approve(&tenant, id, &b.hospital_po, &p.username))
}
#[derive(serde::Deserialize)]
struct ShipIn { lines: Vec<crate::inventory::ShipLine>, #[serde(default)] tracking: String, #[serde(default)] eta: String }
async fn inv_po_ship(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path((tenant, id)): Path<(String, i64)>, Json(b): Json<ShipIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) || !is_supplier(&p) { return inv_forbid("출고는 공급사(리셀러·영업)가 합니다"); }
    state.auth.audit(&p.username, &tenant, "inv_po_ship", &format!("PO-{id} {}줄 {}", b.lines.len(), b.tracking));
    inv_res(state.inventory.po_ship(&tenant, id, &b.lines, &b.tracking, &b.eta, &p.username))
}
#[derive(serde::Deserialize)]
struct RecvIn { #[serde(default)] lines: std::collections::HashMap<String, i64> }
async fn inv_po_receive(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path((tenant, id)): Path<(String, i64)>, Json(b): Json<RecvIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return inv_forbid("권한 없음"); }
    let m: std::collections::HashMap<i64, i64> = b.lines.iter().filter_map(|(k, v)| Some((k.parse().ok()?, *v))).collect();
    state.auth.audit(&p.username, &tenant, "inv_po_receive", &format!("PO-{id}"));
    inv_res(state.inventory.po_receive(&tenant, id, &m, &p.username))
}
#[derive(serde::Deserialize)]
struct ContractIn { sku: String, model: String, #[serde(default)] price: Option<f64>, #[serde(default = "d30")] count_days: f64, #[serde(default)] auto_request: bool, #[serde(default)] contract_end: String, #[serde(default)] committed: i64,
    lead_days: f64, review_days: f64, service: f64, #[serde(default)] min_boxes: i64 }
fn d30() -> f64 { 30.0 }
async fn inv_contract(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<ContractIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) || !is_supplier(&p) { return inv_forbid("계약·보충 설정은 공급사(리셀러·영업)가 합니다"); }
    state.auth.audit(&p.username, &tenant, "inv_contract", &format!("{} {} L{} R{} {} auto={}", b.sku, b.model, b.lead_days, b.review_days, b.service, b.auto_request));
    if let Err(e) = state.inventory.set_policy(&tenant, &b.sku, b.lead_days, b.review_days, b.service, b.min_boxes) { return inv_res::<()>(Err(e)); }
    inv_res(state.inventory.set_contract(&tenant, &b.sku, &b.model, b.price.filter(|v| *v > 0.0), b.count_days, b.auto_request, &b.contract_end, b.committed))
}
#[derive(serde::Deserialize)]
struct CountIn { sku: String, counts: Vec<crate::inventory::LotCount>, #[serde(default)] extra_found: i64, #[serde(default)] note: String }
async fn inv_count(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, Json(b): Json<CountIn>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return inv_forbid("권한 없음"); }
    state.auth.audit(&p.username, &tenant, "inv_visit_count", &format!("{} {}로트", b.sku, b.counts.len()));
    inv_res(state.inventory.visit_count(&tenant, &b.sku, &b.counts, b.extra_found, &b.note, &p.username))
}
async fn inv_statement(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(tenant): Path<String>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    if !p.can_access(&tenant) { return inv_forbid("권한 없음"); }
    let month = q.get("month").cloned().unwrap_or_else(|| chrono::Local::now().format("%Y-%m").to_string());
    let inv = state.inventory.clone();
    match tokio::task::spawn_blocking(move || inv.statement(&tenant, &month)).await.unwrap_or(Err("failed".into())) { Ok(v) => Json(v).into_response(), Err(e) => inv_res::<()>(Err(e)) }
}
#[derive(serde::Deserialize)]
struct TransferIn { from: String, to: String, lot_id: i64, qty: i64 }
async fn inv_transfer(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<TransferIn>) -> impl IntoResponse {
    if !p.can_access(&b.from) || !p.can_access(&b.to) || !is_supplier(&p) { return inv_forbid("병원 간 이동은 두 병원을 모두 맡은 공급사가 합니다"); }
    state.auth.audit(&p.username, &b.from, "inv_transfer", &format!("lot#{} ×{} → {}", b.lot_id, b.qty, b.to));
    inv_res(state.inventory.transfer(&b.from, &b.to, b.lot_id, b.qty, &p.username))
}
async fn inv_trace(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, axum::extract::Query(q): axum::extract::Query<std::collections::HashMap<String, String>>) -> impl IntoResponse {
    let lot = q.get("lot").cloned().unwrap_or_default();
    let t: Vec<String> = inv_tenants(&state, &p).into_iter().map(|x| x.0).collect();
    Json(state.inventory.lot_trace(&lot, &t)).into_response()
}
async fn rep_source_get(State(state): State<Arc<AppState>>) -> impl IntoResponse { Json(crate::reports::report_source_json(&state)) }
#[derive(serde::Deserialize)]
struct RepSrcIn { source: String }
async fn rep_source_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<RepSrcIn>) -> impl IntoResponse {
    state.auth.audit(&p.username, "", "report_source", &b.source);
    match crate::reports::set_report_source(&state, &b.source, &p.username) { Ok(v) => Json(v).into_response(), Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": e }))).into_response() }
}
/// 리포트 화면용 가벼운 환자 목록 (채널 전체 2.6 MB 대신 필요한 칸만)
async fn rep_patients(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let mut out: Vec<serde_json::Value> = Vec::new();
    state.registry.for_each(|id, ch| if let Some(p) = &ch.patient {
        out.push(serde_json::json!({ "channel_id": id, "profile_id": p.profile_no, "patient": { "id": p.id, "name": p.name, "room": p.room, "ward": p.ward, "bed": p.bed, "department": p.department, "diagnosis": p.diagnosis, "mode": p.mode, "home_region": p.home_region, "profile_no": p.profile_no, "emr": p.emr } }));
    });
    Json(out)
}

