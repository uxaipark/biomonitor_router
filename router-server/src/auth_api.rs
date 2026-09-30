//! 로그인·계정·권한·병원(테넌트) REST — `/api/auth/*`, `/api/admin/*`.
//! 권한 검사는 `auth::guard` 가 경로 단위로 먼저 하고, 여기서는 "누구를 대상으로 무엇까지" 를 따진다.

use crate::auth::{self, Matrix, Principal, Tenant, UserInput};
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use serde::Deserialize;
use std::sync::Arc;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/auth/me", get(me))
        .route("/api/auth/password", post(change_password))
        .route("/api/auth/prefs", get(prefs_get).put(prefs_set))
        .route("/api/site/locale", get(site_locale))
        .route("/api/auth/display-token", post(display_token))
        .route("/api/auth/test-accounts", get(test_accounts))
        .route("/api/admin/users", get(users).post(user_create))
        .route("/api/admin/users/test-pins", get(test_pins).put(test_pins_save))
        .route("/api/admin/users/{id}", put(user_update))
        .route("/api/admin/users/{id}/reset_password", post(user_reset))
        .route("/api/admin/tenants", get(tenants).post(tenant_create))
        .route("/api/admin/tenants/{id}", put(tenant_update))
        .route("/api/admin/permissions", get(perms).put(perms_save))
        .route("/api/admin/permissions/versions", get(perm_versions))
        .route("/api/admin/dev_mode", put(dev_mode))
        .route("/api/admin/audit", get(audit))
}

fn err(code: StatusCode, msg: impl Into<String>) -> Response {
    (code, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}
fn result<T: serde::Serialize>(r: Result<T, String>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

#[derive(Deserialize)]
struct LoginIn {
    #[serde(default)]
    tenant: String,
    username: String,
    password: String,
    /// 시험용 계정용 고정 PIN(8자리). 일반 계정은 비워도 된다.
    #[serde(default)]
    pin: String,
    /// 로그인 화면에서 고른 국가(KR/US/JP) — 에뮬레이터 송출 국가를 이것으로 바꾼다(비우면 그대로)
    #[serde(default)]
    country: String,
}

async fn login(State(state): State<Arc<AppState>>, axum::extract::ConnectInfo(addr): axum::extract::ConnectInfo<std::net::SocketAddr>, Json(b): Json<LoginIn>) -> Response {
    // PBKDF2 는 수십 ms 걸리므로 워커 스레드를 막지 않게
    let st = state.clone();
    let (tenant, username) = (b.tenant.trim().to_uppercase(), b.username.trim().to_lowercase());
    let want_country = b.country.trim().to_uppercase();
    let r = tokio::task::spawn_blocking(move || st.auth.login(&b.tenant, &b.username, &b.password, &b.pin)).await;
    let ip = addr.ip();
    match r {
        Ok(Ok((token, p, _must))) => {
            // 성공 한 번이면 이 IP 의 실패 목록은 모두 지운다 (보안 운영)
            crate::security::SEC.login_ok(ip);
            let mut body = state.auth.me(&p);
            // 로그인 화면에서 고른 국가로 에뮬레이터 신원 세트 전환 (응답을 막지 않게 백그라운드로)
            if !want_country.is_empty() && want_country != crate::site_locale::get().country {
                let (st2, who, why) = (state.clone(), p.username.clone(), format!("login {} {}", if tenant.is_empty() { "platform" } else { tenant.as_str() }, p.username));
                let c = want_country.clone();
                tokio::spawn(async move {
                    match crate::site_locale::select(&st2, &c, &who, &why).await {
                        Ok(m) => st2.push_event("site_country", None, format!("로그인 국가 선택으로 전환 요청: {m}")),
                        Err(e) => st2.push_event("site_country", None, format!("국가 전환 실패: {e}")),
                    }
                });
                if let Some(o) = body.as_object_mut() { o.insert("country_switch".into(), serde_json::json!(want_country)); }
            }
            ([(header::SET_COOKIE, auth::session_cookie(&token, false))], Json(body)).into_response()
        }
        Ok(Err(e)) => {
            // PIN·비밀번호·계정 불일치 모두 실패 1건 — 같은 IP 에서 기간 안 한도에 닿으면 차단
            let kind = if e.contains("PIN") { "pin" } else if e.contains("잠겼") { "locked" } else { "credential" };
            let (n, blocked) = crate::security::SEC.login_failed(ip, &tenant, &username, kind);
            if let Some(bl) = blocked {
                state.auth.audit("system", "", "security_block", &format!("{} — {} ({})", bl.ip, bl.reason, bl.detail));
                state.push_event("security", None, format!("IP 차단: {} — {}", bl.ip, bl.reason));
            } else if n >= 3 {
                state.push_event("security", None, format!("로그인 실패 {n}회: {ip} ({tenant}/{username})"));
            }
            err(StatusCode::UNAUTHORIZED, e)
        }
        Err(_) => err(StatusCode::INTERNAL_SERVER_ERROR, "login failed"),
    }
}

async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(t) = auth::cookie_token(&headers) {
        if let Some(p) = state.auth.resolve(&t) {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "logout", "");
        }
        state.auth.logout(&t);
    }
    ([(header::SET_COOKIE, auth::session_cookie("", true))], Json(serde_json::json!({"ok": true}))).into_response()
}

async fn me(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    Json(state.auth.me(&p)).into_response()
}

/// 뷰어 전용 토큰 발급 (로그인 상태에서 뷰어가 한 번 호출) — 이후 뷰어는 쿠키 없이도 이 토큰으로 동작한다
async fn display_token(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    match state.auth.create_display_token(&p) {
        Ok((token, exp)) => {
            state.auth.audit(&p.username, p.tenant_id.as_deref().unwrap_or(""), "display_token", "뷰어 전용 토큰 발급");
            Json(serde_json::json!({ "token": token, "expires_ms": exp })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

/// 사이트 국가·로케일 (로그인 전에도 열림: 로그인 화면의 기본 언어)
async fn site_locale() -> Response {
    Json(serde_json::to_value(crate::site_locale::get()).unwrap_or_default()).into_response()
}

/// 계정별 UI 선호 (GET 전체 / PUT 병합) — 서비스 토큰에는 없다
async fn prefs_get(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    let st = state.clone();
    let m = tokio::task::spawn_blocking(move || st.auth.prefs_get(p.user_id)).await.unwrap_or_default();
    Json(serde_json::Value::Object(m)).into_response()
}

async fn prefs_set(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<serde_json::Value>) -> Response {
    let Some(patch) = b.as_object().cloned() else { return (StatusCode::BAD_REQUEST, "객체를 보내세요").into_response() };
    if p.service {
        return (StatusCode::FORBIDDEN, "서비스 토큰은 선호를 저장할 수 없습니다").into_response();
    }
    let st = state.clone();
    match tokio::task::spawn_blocking(move || st.auth.prefs_set(p.user_id, &patch).map(|_| st.auth.prefs_get(p.user_id))).await.unwrap_or(Err("failed".into())) {
        Ok(m) => Json(serde_json::Value::Object(m)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, e).into_response(),
    }
}

#[derive(Deserialize)]
struct PwIn {
    old: String,
    new: String,
}

async fn change_password(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<PwIn>) -> Response {
    let st = state.clone();
    let r = tokio::task::spawn_blocking(move || st.auth.change_password(&p, &b.old, &b.new)).await.unwrap_or(Err("failed".into()));
    result(r.map(|_| serde_json::json!({"ok": true})))
}

async fn test_accounts(State(state): State<Arc<AppState>>) -> Response {
    Json(serde_json::json!({ "dev_mode": state.auth.dev_mode(), "accounts": state.auth.test_accounts(),
                             "tenants": state.auth.login_tenants(), "site": state.auth.site_tenant(),
                             // 시험용 계정은 PIN(8자리)이 있어야 로그인된다 — 화면이 입력란을 보여 주는 기준
                             "pin_len": auth::TEST_PIN_LEN }))
    .into_response()
}

async fn users(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    Json(serde_json::json!({
        "users": state.auth.users_for(&p),
        "assignable": state.auth.assignable_roles(&p).iter().map(|r| serde_json::json!({"code": r, "label": auth::role_label(r), "platform": auth::is_platform(r)})).collect::<Vec<_>>(),
        "tenants": state.auth.tenants_for(&p),
        "can_edit": p.level("page.admin_users") >= 2,
    }))
    .into_response()
}

async fn user_create(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<UserInput>) -> Response {
    let st = state.clone();
    result(tokio::task::spawn_blocking(move || st.auth.save_user(&p, None, b)).await.unwrap_or(Err("failed".into())))
}

async fn user_update(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<i64>, Json(b): Json<UserInput>) -> Response {
    result(state.auth.save_user(&p, Some(id), b))
}

/// 수퍼 어드민: 시험용 계정 PIN 보기/바꾸기 (기본 PIN + 계정별 PIN, 본인 것 포함)
async fn test_pins(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    result(state.auth.test_pins(&p))
}

#[derive(Deserialize)]
struct PinsIn {
    #[serde(default)]
    default: Option<String>,
    /// 계정 id → PIN 8자리 ("" = 기본 PIN 사용)
    #[serde(default)]
    pins: std::collections::BTreeMap<i64, String>,
}

async fn test_pins_save(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<PinsIn>) -> Response {
    let default = b.default.map(|d| d.trim().to_string()).filter(|d| !d.is_empty());
    let pins: std::collections::BTreeMap<i64, String> = b.pins.into_iter().map(|(k, v)| (k, v.trim().to_string())).collect();
    result(state.auth.set_test_pins(&p, default, &pins).and_then(|_| state.auth.test_pins(&p)))
}

async fn user_reset(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<i64>) -> Response {
    let st = state.clone();
    result(tokio::task::spawn_blocking(move || st.auth.reset_password(&p, id)).await.unwrap_or(Err("failed".into())).map(|pw| serde_json::json!({"temp_password": pw})))
}

async fn tenants(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>) -> Response {
    Json(serde_json::json!({ "tenants": state.auth.tenants_for(&p), "site": state.auth.site_tenant(),
                             "can_edit": p.level("page.admin_tenants") >= 2, "can_create": p.level("page.admin_tenants") >= 2 && matches!(p.role.as_str(), "super_admin" | "system_admin" | "reseller") }))
    .into_response()
}

async fn tenant_create(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(t): Json<Tenant>) -> Response {
    if !matches!(p.role.as_str(), "super_admin" | "system_admin" | "reseller") {
        return err(StatusCode::FORBIDDEN, "병원을 새로 만들 권한이 없습니다");
    }
    result(state.auth.upsert_tenant(&p, t, true).map(|_| serde_json::json!({"ok": true})))
}

async fn tenant_update(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Path(id): Path<String>, Json(mut t): Json<Tenant>) -> Response {
    t.id = id;
    result(state.auth.upsert_tenant(&p, t, false).map(|_| serde_json::json!({"ok": true})))
}

#[derive(Deserialize)]
struct TenantQ {
    tenant: Option<String>,
    scope: Option<String>,
}

fn tenant_param(state: &AppState, p: &Principal, q: &Option<String>) -> String {
    q.clone().filter(|t| !t.is_empty()).or_else(|| p.tenant_id.clone()).or_else(|| p.context.clone()).unwrap_or_else(|| state.auth.site_tenant())
}

async fn perms(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Query(q): Query<TenantQ>) -> Response {
    let t = tenant_param(&state, &p, &q.tenant);
    if !p.can_access(&t) {
        return err(StatusCode::FORBIDDEN, "담당하지 않는 병원입니다");
    }
    let mut v = state.auth.permissions_view(&p, &t);
    v["tenants"] = serde_json::json!(state.auth.tenants_for(&p));
    Json(v).into_response()
}

#[derive(Deserialize)]
struct PermSave {
    scope: String,
    tenant: Option<String>,
    matrix: Matrix,
    #[serde(default)]
    note: String,
}

async fn perms_save(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<PermSave>) -> Response {
    let t = tenant_param(&state, &p, &b.tenant);
    result(state.auth.save_permissions(&p, &b.scope, &t, b.matrix, b.note.trim()).map(|_| serde_json::json!({"ok": true})))
}

async fn perm_versions(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Query(q): Query<TenantQ>) -> Response {
    let t = tenant_param(&state, &p, &q.tenant);
    if !p.can_access(&t) {
        return err(StatusCode::FORBIDDEN, "담당하지 않는 병원입니다");
    }
    Json(state.auth.permission_versions(&p, q.scope.as_deref().unwrap_or("global"), &t)).into_response()
}

#[derive(Deserialize)]
struct DevIn {
    on: bool,
}

async fn dev_mode(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Json(b): Json<DevIn>) -> Response {
    result(state.auth.set_dev_mode(&p, b.on).map(|_| serde_json::json!({"ok": true, "dev_mode": b.on})))
}

#[derive(Deserialize)]
struct AuditQ {
    limit: Option<usize>,
}

async fn audit(State(state): State<Arc<AppState>>, Extension(p): Extension<Principal>, Query(q): Query<AuditQ>) -> Response {
    Json(state.auth.audit_list(&p, q.limit.unwrap_or(200).min(1000))).into_response()
}
