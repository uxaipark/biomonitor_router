//! 설정 › EMR 연동 REST — `/api/integration/*` (권한 `page.integration`, 이 라우터 병원만)

use crate::auth::{mask_json, Principal};
use crate::emr_link::{from_catalog, ConnCfg};
use crate::state::AppState;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/integration", get(list).post(create))
        .route("/api/integration/catalog", get(catalog))
        .route("/api/integration/{id}", get(detail).put(update).delete(remove))
        .route("/api/integration/{id}/run", post(run))
        .route("/api/integration/{id}/received", get(received))
}

fn err(code: StatusCode, m: impl Into<String>) -> Response {
    (code, Json(json!({"error": m.into()}))).into_response()
}

/// 자격 증명은 화면에 내보내지 않는다
fn public_cfg(c: &ConnCfg) -> Value {
    let mut v = serde_json::to_value(c).unwrap_or_default();
    if let Some(a) = v["auth"].as_object_mut() {
        for (k, x) in a.iter_mut() {
            if ["secret", "password", "token", "key", "client_secret"].iter().any(|s| k.contains(s)) && x.is_string() {
                *x = json!("••••••");
            }
        }
    }
    v
}

fn summary(state: &AppState, c: &ConnCfg) -> Value {
    let st = state.emr.state.lock().unwrap();
    let s = st.get(&c.id);
    json!({
        "running": s.map(|s| s.running).unwrap_or(false),
        "census": s.map(|s| s.census).unwrap_or(0),
        "census_ms": s.map(|s| s.census_ms).unwrap_or(0),
        "linked": s.map(|s| s.links.len()).unwrap_or(0),
        "sent_ok": s.map(|s| s.sent_ok).unwrap_or(0),
        "sent_fail": s.map(|s| s.sent_fail).unwrap_or(0),
        "last_send_ms": s.map(|s| s.last_send_ms).unwrap_or(0),
        "last_error": s.map(|s| s.last_error.clone()).unwrap_or_default(),
        "backoff_until_ms": s.map(|s| s.backoff_until_ms).unwrap_or(0),
        "token_exp_ms": s.map(|s| s.token_exp_ms).unwrap_or(0),
        "adt_ms": s.map(|s| s.adt_ms).unwrap_or(0),
        "adt_count": s.map(|s| s.adt_count).unwrap_or(0),
    })
}

fn mine(state: &AppState, p: &Principal, id: &str) -> Result<ConnCfg, Response> {
    let c = state.emr.get(id).ok_or_else(|| err(StatusCode::NOT_FOUND, "연결이 없습니다"))?;
    if !p.can_access(&c.tenant_id) {
        return Err(err(StatusCode::FORBIDDEN, "담당하지 않는 병원의 연결입니다"));
    }
    Ok(c)
}

async fn list(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    let v: Vec<Value> = state
        .emr
        .list()
        .iter()
        .filter(|c| p.can_access(&c.tenant_id))
        .map(|c| json!({"config": public_cfg(c), "state": summary(&state, c)}))
        .collect();
    Json(json!({"site": state.auth.site_tenant(), "connections": v, "can_edit": p.level("page.integration") >= 2})).into_response()
}

async fn emrsim_catalog(state: &AppState) -> Result<Value, String> {
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다 (설정 › 네트워크 설정)")?;
    let (code, body) = crate::emu_link::request(&addr, "GET", "/api/v1/emrsim", None).await.map_err(|e| e.to_string())?;
    if code != 200 {
        return Err(format!("가상 EMR 카탈로그 HTTP {code}"));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

async fn catalog(State(state): State<Arc<AppState>>) -> Response {
    match emrsim_catalog(&state).await {
        Ok(c) => {
            let have: Vec<String> = state.emr.list().into_iter().map(|x| x.site_id).collect();
            let sites: Vec<Value> = c["sites"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|s| {
                    let proto = s["protocol"].as_str().unwrap_or("");
                    json!({ "id": s["id"], "name": s["name"], "name_local": s["name_local"], "country_ko": s["country_ko"], "city": s["city"],
                            "protocol": proto, "protocol_ko": s["protocol_ko"], "flavor": s["flavor"], "version": s["version"], "style": s["style"],
                            "supported": matches!(proto, "fhir" | "hl7v2" | "kr-json" | "kr-xml" | "cda" | "athena"), "added": have.iter().any(|h| s["id"].as_str() == Some(h)) })
                })
                .collect();
            Json(json!({"sites": sites, "mllp_port": c["mllp_port"]})).into_response()
        }
        Err(e) => err(StatusCode::BAD_GATEWAY, e),
    }
}

#[derive(Deserialize)]
struct CreateIn {
    site_id: String,
    #[serde(default)]
    scope_ward: String,
    #[serde(default)]
    match_mode: Option<String>,
    #[serde(default)]
    interval_s: Option<u64>,
}

async fn create(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<CreateIn>) -> Response {
    let site = state.auth.site_tenant();
    if !p.can_access(&site) {
        return err(StatusCode::FORBIDDEN, "이 병원의 연결을 만들 권한이 없습니다");
    }
    let cat = match emrsim_catalog(&state).await {
        Ok(c) => c,
        Err(e) => return err(StatusCode::BAD_GATEWAY, e),
    };
    let Some(s) = cat["sites"].as_array().and_then(|a| a.iter().find(|x| x["id"].as_str() == Some(&b.site_id))) else {
        return err(StatusCode::NOT_FOUND, "카탈로그에 없는 기관입니다");
    };
    let emu_host = state.net.emulator().unwrap_or_default().split(':').next().unwrap_or("").to_string();
    let Some(mut c) = from_catalog(s, &emu_host) else {
        return err(StatusCode::BAD_REQUEST, "아직 지원하지 않는 형식입니다");
    };
    c.id = format!("{}-{}", b.site_id, &crate::auth::random_hex(2));
    c.tenant_id = site.clone();
    c.scope_ward = b.scope_ward;
    if let Some(m) = b.match_mode {
        c.match_mode = m;
    }
    if let Some(i) = b.interval_s {
        c.interval_s = i.clamp(15, 3600);
    }
    c.enabled = false;
    c.created_ms = crate::protocol::now_ms();
    if let Err(e) = state.emr.save(&c) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    state.auth.audit(&p.username, &site, "emr_connection_create", &format!("{} ({})", c.name, c.protocol));
    Json(json!({"config": public_cfg(&c)})).into_response()
}

async fn detail(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>) -> Response {
    let c = match mine(&state, &p, &id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let mut st = {
        let s = state.emr.state.lock().unwrap();
        s.get(&id).map(|x| json!({"links": x.links, "log": x.log, "adt": x.adt})).unwrap_or(json!({"links": [], "log": [], "adt": []}))
    };
    if !p.phi() {
        // 매칭 표의 환자 이름·등록번호 (우리 쪽·기관 쪽 모두 개인정보)
        if let Some(a) = st["links"].as_array_mut() {
            for l in a {
                l["local_name"] = json!(crate::auth::mask_name(l["local_name"].as_str().unwrap_or("")));
                l["local_mrn"] = json!(crate::auth::mask_tail(l["local_mrn"].as_str().unwrap_or("")));
                l["remote"]["name"] = json!(crate::auth::mask_name(l["remote"]["name"].as_str().unwrap_or("")));
                l["remote"]["ident"] = json!(crate::auth::mask_tail(l["remote"]["ident"].as_str().unwrap_or("")));
            }
        }
        if let Some(a) = st["adt"].as_array_mut() {
            for e in a {
                e["name"] = json!(crate::auth::mask_name(e["name"].as_str().unwrap_or("")));
            }
        }
    }
    Json(json!({"config": public_cfg(&c), "state": summary(&state, &c), "links": st["links"], "log": st["log"], "adt": st["adt"]})).into_response()
}

#[derive(Deserialize)]
struct UpdateIn {
    name: Option<String>,
    enabled: Option<bool>,
    interval_s: Option<u64>,
    scope_ward: Option<String>,
    match_mode: Option<String>,
    max_patients: Option<usize>,
}

async fn update(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>, Json(b): Json<UpdateIn>) -> Response {
    let mut c = match mine(&state, &p, &id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if let Some(v) = b.name {
        c.name = v;
    }
    if let Some(v) = b.enabled {
        c.enabled = v;
    }
    if let Some(v) = b.interval_s {
        c.interval_s = v.clamp(15, 3600);
    }
    let rematch = b.scope_ward.is_some() || b.match_mode.is_some() || b.max_patients.is_some();
    if let Some(v) = b.scope_ward {
        c.scope_ward = v;
    }
    if let Some(v) = b.match_mode.filter(|m| m == "pair" || m == "mrn") {
        c.match_mode = v;
    }
    if let Some(v) = b.max_patients {
        c.max_patients = v.clamp(1, 500);
    }
    if let Err(e) = state.emr.save(&c) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, e);
    }
    if rematch {
        state.emr.kick(&id, "census");
    }
    state.auth.audit(&p.username, &c.tenant_id, "emr_connection_update", &format!("{} · {}", c.name, if c.enabled { "켜짐" } else { "꺼짐" }));
    Json(json!({"config": public_cfg(&c)})).into_response()
}

async fn remove(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>) -> Response {
    let c = match mine(&state, &p, &id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    state.emr.delete(&id);
    state.auth.audit(&p.username, &c.tenant_id, "emr_connection_delete", &c.name);
    Json(json!({"ok": true})).into_response()
}

#[derive(Deserialize)]
struct RunIn {
    what: String,
}

async fn run(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>, Json(b): Json<RunIn>) -> Response {
    let c = match mine(&state, &p, &id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    if !c.enabled {
        return err(StatusCode::BAD_REQUEST, "연결을 먼저 켜세요");
    }
    match b.what.as_str() {
        "census" => state.emr.kick(&id, "census"),
        "send" => {
            state.emr.kick(&id, "census");
            state.emr.kick(&id, "send")
        }
        "adt_rewind" => state.emr.kick(&id, "adt_rewind"),
        _ => return err(StatusCode::BAD_REQUEST, "what = census | send | adt_rewind"),
    }
    Json(json!({"ok": true})).into_response()
}

/// 가상 EMR 이 실제로 받아 저장한 바이탈 (검증용 — 에뮬레이터 `/received` 프록시)
async fn received(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>) -> Response {
    let c = match mine(&state, &p, &id) {
        Ok(c) => c,
        Err(r) => return r,
    };
    let Some(addr) = state.net.emulator() else { return err(StatusCode::SERVICE_UNAVAILABLE, "에뮬레이터 주소 없음") };
    match crate::emu_link::request(&addr, "GET", &format!("/api/v1/emrsim/{}/received", c.site_id), None).await {
        Ok((200, body)) => {
            let mut v: Value = serde_json::from_str(&body).unwrap_or_default();
            if !p.phi() {
                mask_json(&mut v, false, true);
            }
            Json(v).into_response()
        }
        Ok((code, body)) => err(StatusCode::BAD_GATEWAY, format!("HTTP {code}: {}", body.chars().take(200).collect::<String>())),
        Err(e) => err(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}
