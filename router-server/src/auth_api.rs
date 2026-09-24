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
        .route("/api/auth/test-accounts", get(test_accounts))
        .route("/api/admin/users", get(users).post(user_create))
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
}

async fn login(State(state): State<Arc<AppState>>, Json(b): Json<LoginIn>) -> Response {
    // PBKDF2 는 수십 ms 걸리므로 워커 스레드를 막지 않게
    let st = state.clone();
    let r = tokio::task::spawn_blocking(move || st.auth.login(&b.tenant, &b.username, &b.password)).await;
    match r {
        Ok(Ok((token, p, _must))) => {
            let body = state.auth.me(&p);
            ([(header::SET_COOKIE, auth::session_cookie(&token, false))], Json(body)).into_response()
        }
        Ok(Err(e)) => err(StatusCode::UNAUTHORIZED, e),
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
                             "tenants": state.auth.login_tenants(), "site": state.auth.site_tenant() }))
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
    Json(state.auth.permission_versions(q.scope.as_deref().unwrap_or("global"), &t)).into_response()
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
