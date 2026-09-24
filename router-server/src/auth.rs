//! 계정·권한·멀티테넌시.
//!
//! - **계정 계층**: 플랫폼 역할(수퍼 어드민·시스템 관리자·리셀러·CRM 영업)은 병원에 속하지 않고, 병원 역할(병원 IT
//!   매니저·의사·간호사·스태프)은 한 병원(테넌트)에 속한다. 리셀러·CRM 영업은 배정된 병원만 본다.
//! - **권한 매트릭스**: 역할 × 자원(메뉴·페이지·동작·데이터) → 0 없음 / 1 보기 / 2 편집. 전역 표(수퍼 어드민이 편집)
//!   위에 병원별 덮어쓰기(의사가 간호사·스태프 칸만, 자기 권한 이하로)가 얹힌다. 저장할 때마다 판(version)을 남겨
//!   "이전 설정 불러오기"가 되고, "초기값"은 코드의 기본 표다.
//! - **개인정보·생체신호**: `data.phi`·`data.biosignal` 이 0 이면 서버가 이름·MRN 등을 가리고(마스킹) 파형·수치는
//!   내보내지 않는다. 화면이 아니라 API 응답에서 가리므로 브라우저 개발자 도구로도 원문을 볼 수 없다.
//! - **수퍼 어드민**: 개발 모드(`auth.dev_mode`, 기본 켜짐) 동안만 모든 권한. 끄면 관리 메뉴만 남고 개인정보·생체신호는
//!   가려진다.
//! - **테넌트 격리**: 이 라우터가 받는 데이터는 한 병원(`site.tenant_id`) 소유다. 모든 데이터 API 는 요청자가 그 병원에
//!   접근할 수 있는지 먼저 확인하고, 아니면 403 — 다른 병원 계정은 이 병원 환자를 한 건도 볼 수 없다.

use axum::extract::{Request, State};
use axum::http::{header, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use tracing::{info, warn};

use crate::protocol::now_ms;
use crate::state::AppState;

// ───────────────────────────── 역할 · 자원 ─────────────────────────────

/// (코드, 이름, 플랫폼 역할 여부)
pub const ROLES: [(&str, &str, bool); 8] = [
    ("super_admin", "수퍼 어드민", true),
    ("system_admin", "시스템 관리자", true),
    ("reseller", "리셀러", true),
    ("sales_crm", "CRM 영업", true),
    ("hospital_it", "병원 IT 매니저", false),
    ("doctor", "의사", false),
    ("nurse", "간호사", false),
    ("staff", "스태프", false),
];

/// 의사가 권한을 정하는 역할
pub const CLINICAL_DELEGATED: [&str; 2] = ["nurse", "staff"];

pub fn role_label(code: &str) -> &'static str {
    ROLES.iter().find(|r| r.0 == code).map(|r| r.1).unwrap_or("알 수 없음")
}
pub fn is_platform(code: &str) -> bool {
    ROLES.iter().find(|r| r.0 == code).map(|r| r.2).unwrap_or(false)
}

/// (코드, 이름, 묶음, 기본값 [SA, SYS, RES, CRM, IT, DOC, NUR, STF])
pub const RESOURCES: [(&str, &str, &str, [u8; 8]); 24] = [
    ("page.dashboard", "대시보드", "메뉴", [2, 1, 1, 0, 1, 1, 1, 1]),
    ("page.alarms", "알람", "메뉴", [2, 1, 0, 0, 1, 2, 2, 1]),
    ("page.events", "이벤트", "메뉴", [2, 1, 0, 0, 1, 1, 1, 0]),
    ("page.patients", "환자", "메뉴", [2, 1, 0, 0, 1, 2, 2, 1]),
    ("page.gateways", "게이트웨이", "메뉴", [2, 2, 1, 0, 2, 1, 1, 0]),
    ("page.map", "병원 지도", "메뉴", [2, 1, 0, 0, 1, 1, 1, 1]),
    ("page.viewers", "뷰어", "메뉴", [2, 1, 0, 0, 1, 2, 2, 1]),
    ("page.test", "테스트 › 실시간·멀티 뷰어", "메뉴", [2, 2, 0, 0, 1, 0, 0, 0]),
    ("page.ops", "테스트 › 운영 통계", "메뉴", [2, 2, 1, 0, 1, 0, 0, 0]),
    ("page.data_admin", "테스트 › 데이터 관리", "메뉴", [2, 1, 0, 0, 0, 0, 0, 0]),
    ("page.settings_viewer", "설정 › 뷰어 설정", "메뉴", [2, 2, 0, 0, 2, 1, 1, 1]),
    ("page.settings_biosignal", "설정 › 생체신호 관리(백업)", "메뉴", [2, 2, 0, 0, 2, 0, 0, 0]),
    ("page.settings_network", "설정 › 네트워크 설정", "메뉴", [2, 2, 0, 0, 2, 0, 0, 0]),
    ("page.integration", "설정 › EMR 연동", "메뉴", [2, 2, 0, 0, 2, 1, 0, 0]),
    ("page.admin_users", "관리 › 계정", "메뉴", [2, 1, 1, 0, 2, 1, 0, 0]),
    ("page.admin_permissions", "관리 › 권한 설정", "메뉴", [2, 1, 0, 0, 1, 2, 0, 0]),
    ("page.admin_tenants", "관리 › 병원(테넌트)", "메뉴", [2, 1, 2, 1, 1, 0, 0, 0]),
    ("page.admin_audit", "관리 › 감사 기록", "메뉴", [2, 2, 0, 0, 1, 1, 0, 0]),
    ("action.alarm_ack", "알람 확인", "동작", [2, 0, 0, 0, 0, 2, 2, 0]),
    ("action.alarm_rules", "알람 규칙 변경", "동작", [2, 0, 0, 0, 0, 2, 1, 0]),
    ("action.groups_edit", "그룹 편집", "동작", [2, 1, 0, 0, 1, 2, 2, 0]),
    ("action.wave_reset", "저장 파형 전체 삭제", "동작", [2, 0, 0, 0, 0, 0, 0, 0]),
    ("data.phi", "개인정보 원문 (없으면 마스킹)", "데이터", [2, 0, 0, 0, 0, 2, 2, 1]),
    ("data.biosignal", "생체신호 (파형·수치)", "데이터", [2, 0, 0, 0, 0, 2, 2, 1]),
];

fn role_idx(role: &str) -> Option<usize> {
    ROLES.iter().position(|r| r.0 == role)
}
fn res_known(res: &str) -> bool {
    RESOURCES.iter().any(|r| r.0 == res)
}
pub fn builtin(role: &str, res: &str) -> u8 {
    match (role_idx(role), RESOURCES.iter().find(|r| r.0 == res)) {
        (Some(i), Some(r)) => r.3[i],
        _ => 0,
    }
}
/// role → resource → level
pub type Matrix = BTreeMap<String, BTreeMap<String, u8>>;

pub fn builtin_matrix() -> Matrix {
    let mut m = Matrix::new();
    for (i, (role, ..)) in ROLES.iter().enumerate() {
        let row = m.entry(role.to_string()).or_default();
        for r in RESOURCES.iter() {
            row.insert(r.0.to_string(), r.3[i]);
        }
    }
    m
}

// ───────────────────────────── 요청 주체 ─────────────────────────────

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", content = "tenants")]
pub enum Scope {
    All,
    Some(HashSet<String>),
}

#[derive(Clone, Debug, Serialize)]
pub struct Principal {
    pub user_id: i64,
    pub username: String,
    pub name: String,
    pub role: String,
    pub tenant_id: Option<String>,
    pub scope: Scope,
    pub perms: HashMap<String, u8>,
    /// 서비스 토큰(스크립트·연동)으로 들어온 요청
    pub service: bool,
    /// 로그인 때 고른 병원 (없음 = 플랫폼으로 로그인)
    pub context: Option<String>,
}

impl Principal {
    pub fn level(&self, res: &str) -> u8 {
        *self.perms.get(res).unwrap_or(&0)
    }
    pub fn can_access(&self, tenant: &str) -> bool {
        match &self.scope {
            Scope::All => true,
            Scope::Some(s) => s.contains(tenant),
        }
    }
    pub fn phi(&self) -> bool {
        self.level("data.phi") > 0
    }
    pub fn bio(&self) -> bool {
        self.level("data.biosignal") > 0
    }
}

// ───────────────────────────── 저장 ─────────────────────────────

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'hospital', region TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '', reseller TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants(id), tenant_key TEXT NOT NULL DEFAULT '', pw TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  must_change INTEGER NOT NULL DEFAULT 1, test_pw TEXT, created_ms INTEGER NOT NULL, last_login_ms INTEGER,
  UNIQUE (tenant_key, username));
CREATE TABLE IF NOT EXISTS user_tenants (user_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, PRIMARY KEY (user_id, tenant_id));
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL, tenant TEXT);
CREATE TABLE IF NOT EXISTS perm_matrix (tenant TEXT NOT NULL, role TEXT NOT NULL, resource TEXT NOT NULL, level INTEGER NOT NULL,
  PRIMARY KEY (tenant, role, resource));
CREATE TABLE IF NOT EXISTS perm_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, saved_ms INTEGER NOT NULL,
  saved_by TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', matrix TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts_ms INTEGER NOT NULL, username TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts_ms);
";

const K_DEV: &str = "auth.dev_mode";
const K_SITE: &str = "site.tenant_id";
const GLOBAL: &str = "*";
const SESSION_MS: u64 = 12 * 3600 * 1000;
pub const COOKIE: &str = "bm_session";

#[derive(Clone, Debug, Serialize)]
pub struct User {
    pub id: i64,
    pub username: String,
    pub name: String,
    pub role: String,
    pub tenant_id: Option<String>,
    pub tenants: Vec<String>,
    pub active: bool,
    pub must_change: bool,
    pub created_ms: u64,
    pub last_login_ms: Option<u64>,
    #[serde(skip)]
    pw: String,
    #[serde(skip)]
    test_pw: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tenant {
    pub id: String,
    pub name: String,
    #[serde(default = "hospital")]
    pub kind: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub contact: String,
    /// 담당 리셀러 계정 이름 (선택)
    #[serde(default)]
    pub reseller: String,
    #[serde(default = "yes")]
    pub active: bool,
    #[serde(default)]
    pub created_ms: u64,
}
fn hospital() -> String {
    "hospital".into()
}
fn yes() -> bool {
    true
}

pub struct Auth {
    db: Mutex<Connection>,
    users: RwLock<HashMap<i64, User>>,
    /// sha256(token) → (user_id, expires_ms, 로그인 때 고른 병원 — 플랫폼 계정이 한 병원으로 들어온 경우)
    sessions: Mutex<HashMap<String, (i64, u64, Option<String>)>>,
    /// tenant("*" = 전역) → matrix
    matrix: RwLock<HashMap<String, Matrix>>,
    dev_mode: AtomicBool,
    site: RwLock<String>,
    service_token: Option<String>,
    fails: Mutex<HashMap<String, (u32, u64)>>,
}

/// 플랫폼 시험용 계정: (아이디, 이름, 역할, 임시 비밀번호, 담당 병원)
const PLATFORM_SEED: [(&str, &str, &str, &str, &[&str]); 4] = [
    ("superadmin", "수퍼 어드민", "super_admin", "Super!2026", &[]),
    ("sysadmin", "시스템 관리자", "system_admin", "Sys!2026", &[]),
    ("reseller1", "메디링크 리셀러", "reseller", "Resell!2026", &["H001", "H002", "H003"]),
    ("sales1", "CRM 영업 김영업", "sales_crm", "Sales!2026", &["H001", "H003"]),
];
/// 병원마다 만드는 시험용 계정: (아이디, 이름, 역할, 임시 비밀번호). 아이디는 병원 안에서만 유일하다 —
/// 같은 `dr.kim` 이 병원마다 따로 있고, 로그인할 때 고른 병원 ID 로 구분한다.
const TENANT_SEED: [(&str, &str, &str, &str); 6] = [
    ("it.admin", "IT 매니저", "hospital_it", "It!2026"),
    ("dr.kim", "김의사 (심장내과)", "doctor", "Doctor!2026"),
    ("dr.lee", "이의사 (호흡기내과)", "doctor", "Doctor!2026"),
    ("nurse.lee", "이간호 (병동)", "nurse", "Nurse!2026"),
    ("nurse.choi", "최간호 (중환자실)", "nurse", "Nurse!2026"),
    ("staff.park", "박스태프 (원무)", "staff", "Staff!2026"),
];
/// 시험용 병원: (ID, 이름, 지역). 첫 줄은 이 라우터의 병원(site)으로 바뀐다.
const TENANT_DEMO: [(&str, &str, &str); 3] = [
    ("H001", "바이오모니터 병원 (본관·별관·신관)", "경기"),
    ("H002", "데모 병원 (격리 시험용)", "서울"),
    ("H003", "서울 중앙병원 (데모)", "서울"),
];

fn seed_tenant_accounts(db: &Connection, tenant: &str) -> usize {
    let now = now_ms() as i64;
    let mut n = 0;
    for (u, name, role, pw) in TENANT_SEED.iter() {
        if let Ok(k) = db.execute(
            "INSERT OR IGNORE INTO users (username, name, role, tenant_id, tenant_key, pw, must_change, test_pw, created_ms) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 1, ?6, ?7)",
            params![u, name, role, tenant, hash_pw(pw), pw, now],
        ) {
            n += k;
        }
    }
    n
}

impl Auth {
    pub fn open(db_path: &str) -> Self {
        let db = Connection::open(db_path).unwrap_or_else(|e| {
            warn!("auth db open {} failed ({}): in-memory", db_path, e);
            Connection::open_in_memory().expect("in-memory sqlite")
        });
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
        migrate(&db);
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("auth schema: {}", e);
        }
        let get = |k: &str| -> Option<String> {
            db.query_row("SELECT value FROM settings WHERE key = ?1", params![k], |r| r.get::<_, String>(0)).ok()
        };
        let dev = match get(K_DEV) {
            Some(v) => v == "1",
            None => std::env::var("ROUTER_DEV_MODE").map(|v| v != "0").unwrap_or(true),
        };
        let site = get(K_SITE)
            .or_else(|| std::env::var("ROUTER_TENANT_ID").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "H001".into());
        let now = now_ms() as i64;
        // 병원(테넌트): 이 라우터의 병원 + 격리 시험용 병원들 (없는 것만)
        let n: i64 = db.query_row("SELECT COUNT(*) FROM tenants", [], |r| r.get(0)).unwrap_or(0);
        if n == 0 || dev {
            for (i, (id, name, region)) in TENANT_DEMO.iter().enumerate() {
                let id = if i == 0 { site.as_str() } else { id };
                let _ = db.execute(
                    "INSERT OR IGNORE INTO tenants (id, name, region, contact, reseller, created_ms) VALUES (?1, ?2, ?3, '', 'reseller1', ?4)",
                    params![id, name, region, now],
                );
            }
        }
        if dev {
            let mut made = 0;
            for (u, name, role, pw, extra) in PLATFORM_SEED.iter() {
                let k = db
                    .execute(
                        "INSERT OR IGNORE INTO users (username, name, role, tenant_id, tenant_key, pw, must_change, test_pw, created_ms) VALUES (?1, ?2, ?3, NULL, '', ?4, 1, ?5, ?6)",
                        params![u, name, role, hash_pw(pw), pw, now],
                    )
                    .unwrap_or(0);
                made += k;
                // 담당 병원은 이미 있던 시험용 계정에도 채운다 (시험용 병원이 늘어난 경우)
                if let Ok(id) = db.query_row("SELECT id FROM users WHERE tenant_key = '' AND username = ?1 AND test_pw IS NOT NULL", params![u], |r| r.get::<_, i64>(0)) {
                    for t in extra.iter() {
                        let t = if *t == "H001" { site.clone() } else { t.to_string() };
                        let _ = db.execute("INSERT OR IGNORE INTO user_tenants (user_id, tenant_id) VALUES (?1, ?2)", params![id, t]);
                    }
                }
            }
            let tenants: Vec<String> = db
                .prepare("SELECT id FROM tenants WHERE active = 1")
                .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().collect()))
                .unwrap_or_default();
            for t in &tenants {
                made += seed_tenant_accounts(&db, t);
            }
            if made > 0 {
                info!("auth: seeded {} test accounts (dev mode, temporary passwords)", made);
            }
        }
        let _ = db.execute("DELETE FROM sessions WHERE expires_ms < ?1", params![now]);
        // 스크립트·감시 도구용 서비스 토큰: 환경변수, 없으면 DB 옆 `service_token` 파일(처음 실행 때 만들고 0600)
        let service_token = std::env::var("ROUTER_SERVICE_TOKEN").ok().filter(|s| s.len() >= 16).or_else(|| {
            if db_path == ":memory:" {
                return None;
            }
            let f = std::path::Path::new(db_path).parent().map(|d| d.join("service_token")).unwrap_or_else(|| "service_token".into());
            if let Ok(t) = std::fs::read_to_string(&f) {
                let t = t.trim().to_string();
                if t.len() >= 16 {
                    return Some(t);
                }
            }
            let t = random_hex(32);
            if std::fs::write(&f, &t).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o600));
                }
                info!("auth: service token written to {}", f.display());
                Some(t)
            } else {
                None
            }
        });
        let me = Self {
            db: Mutex::new(db),
            users: RwLock::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
            matrix: RwLock::new(HashMap::new()),
            dev_mode: AtomicBool::new(dev),
            site: RwLock::new(site.clone()),
            service_token,
            fails: Mutex::new(HashMap::new()),
        };
        me.reload_users();
        me.reload_matrix();
        me.reload_sessions();
        info!("auth: site tenant {}, dev mode {}, {} users", site, dev, me.users.read().unwrap().len());
        me
    }

    fn reload_users(&self) {
        let db = self.db.lock().unwrap();
        let mut extra: HashMap<i64, Vec<String>> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT user_id, tenant_id FROM user_tenants") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))) {
                for (u, t) in rows.flatten() {
                    extra.entry(u).or_default().push(t);
                }
            }
        }
        let mut m = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT id, username, name, role, tenant_id, pw, active, must_change, test_pw, created_ms, last_login_ms FROM users") {
            if let Ok(rows) = st.query_map([], |r| {
                Ok(User {
                    id: r.get(0)?,
                    username: r.get(1)?,
                    name: r.get(2)?,
                    role: r.get(3)?,
                    tenant_id: r.get(4)?,
                    pw: r.get(5)?,
                    active: r.get::<_, i64>(6)? != 0,
                    must_change: r.get::<_, i64>(7)? != 0,
                    test_pw: r.get(8)?,
                    created_ms: r.get::<_, i64>(9)? as u64,
                    last_login_ms: r.get::<_, Option<i64>>(10)?.map(|v| v as u64),
                    tenants: Vec::new(),
                })
            }) {
                for mut u in rows.flatten() {
                    u.tenants = extra.remove(&u.id).unwrap_or_default();
                    m.insert(u.id, u);
                }
            }
        }
        *self.users.write().unwrap() = m;
    }

    fn reload_matrix(&self) {
        let db = self.db.lock().unwrap();
        let mut all: HashMap<String, Matrix> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT tenant, role, resource, level FROM perm_matrix") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))) {
                for (t, role, res, lv) in rows.flatten() {
                    all.entry(t).or_default().entry(role).or_default().insert(res, lv.clamp(0, 2) as u8);
                }
            }
        }
        *self.matrix.write().unwrap() = all;
    }

    fn reload_sessions(&self) {
        let db = self.db.lock().unwrap();
        let mut m = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT token_hash, user_id, expires_ms, tenant FROM sessions") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, Option<String>>(3)?))) {
                for (h, u, e, t) in rows.flatten() {
                    m.insert(h, (u, e as u64, t));
                }
            }
        }
        *self.sessions.lock().unwrap() = m;
    }

    pub fn site_tenant(&self) -> String {
        self.site.read().unwrap().clone()
    }
    pub fn dev_mode(&self) -> bool {
        self.dev_mode.load(Ordering::Relaxed)
    }

    pub fn audit(&self, who: &str, tenant: &str, action: &str, detail: &str) {
        if let Ok(db) = self.db.lock() {
            let _ = db.execute(
                "INSERT INTO audit (ts_ms, username, tenant, action, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![now_ms() as i64, who, tenant, action, detail],
            );
            // 1년 넘은 기록은 정리
            let _ = db.execute("DELETE FROM audit WHERE ts_ms < ?1", params![(now_ms() - 366 * 86_400_000) as i64]);
        }
    }

    /// 역할의 실제 권한: 병원 덮어쓰기(간호사·스태프) → 전역 표 → 기본값. 수퍼 어드민은 개발 모드 동안 전부 2.
    pub fn effective(&self, role: &str, tenant: Option<&str>) -> HashMap<String, u8> {
        let m = self.matrix.read().unwrap();
        let dev = self.dev_mode();
        let mut out = HashMap::new();
        for r in RESOURCES.iter() {
            let res = r.0;
            let mut lv = builtin(role, res);
            if let Some(g) = m.get(GLOBAL).and_then(|g| g.get(role)).and_then(|row| row.get(res)) {
                lv = *g;
            }
            if let Some(t) = tenant {
                if CLINICAL_DELEGATED.contains(&role) {
                    if let Some(o) = m.get(t).and_then(|g| g.get(role)).and_then(|row| row.get(res)) {
                        lv = *o;
                    }
                }
            }
            if role == "super_admin" {
                lv = if dev { 2 } else if res.starts_with("data.") { 0 } else { lv };
            }
            out.insert(res.to_string(), lv);
        }
        out
    }

    /// `ctx` = 로그인 때 고른 병원. 플랫폼 계정이 병원을 골라 들어오면 그 세션은 그 병원 하나로 좁혀진다.
    fn principal_of(&self, u: &User, ctx: Option<&str>) -> Principal {
        let mut scope = match u.role.as_str() {
            "super_admin" | "system_admin" => Scope::All,
            "reseller" | "sales_crm" => Scope::Some(u.tenants.iter().cloned().collect()),
            _ => Scope::Some(u.tenant_id.iter().cloned().collect()),
        };
        if is_platform(&u.role) {
            if let Some(t) = ctx {
                scope = Scope::Some([t.to_string()].into_iter().collect());
            }
        }
        let ptenant = if is_platform(&u.role) { ctx.map(String::from) } else { u.tenant_id.clone() };
        Principal {
            user_id: u.id,
            username: u.username.clone(),
            name: u.name.clone(),
            role: u.role.clone(),
            tenant_id: u.tenant_id.clone(),
            scope,
            perms: self.effective(&u.role, ptenant.as_deref().or(Some(&self.site_tenant()))),
            service: false,
            context: ctx.map(String::from),
        }
    }

    fn service_principal(&self) -> Principal {
        Principal {
            user_id: 0,
            username: "service".into(),
            name: "서비스 토큰".into(),
            role: "super_admin".into(),
            tenant_id: None,
            scope: Scope::All,
            perms: RESOURCES.iter().map(|r| (r.0.to_string(), 2u8)).collect(),
            service: true,
            context: None,
        }
    }

    /// 쿠키 또는 Bearer 토큰 → 요청 주체
    pub fn resolve(&self, token: &str) -> Option<Principal> {
        if let Some(st) = &self.service_token {
            if constant_eq(token.as_bytes(), st.as_bytes()) {
                return Some(self.service_principal());
            }
        }
        let h = sha_hex(token.as_bytes());
        let (uid, exp, ctx) = self.sessions.lock().unwrap().get(&h).cloned()?;
        let now = now_ms();
        if exp < now {
            self.sessions.lock().unwrap().remove(&h);
            return None;
        }
        let users = self.users.read().unwrap();
        let u = users.get(&uid)?;
        if !u.active {
            return None;
        }
        // 사용 중이면 만료를 늘린다 (1분에 한 번만 DB 기록)
        if exp - now < SESSION_MS - 60_000 {
            let ne = now + SESSION_MS;
            self.sessions.lock().unwrap().insert(h.clone(), (uid, ne, ctx.clone()));
            if let Ok(db) = self.db.lock() {
                let _ = db.execute("UPDATE sessions SET expires_ms = ?1 WHERE token_hash = ?2", params![ne as i64, h]);
            }
        }
        Some(self.principal_of(u, ctx.as_deref()))
    }

    /// 병원 ID + 아이디 + 비밀번호. 병원 계정은 자기 병원 ID 로만, 플랫폼 계정은 병원 ID 를 비우거나(플랫폼)
    /// 담당 병원 ID 로 들어온다(그 세션은 그 병원만). 어느 쪽이 틀렸는지는 알려 주지 않는다(계정 탐색 방지).
    pub fn login(&self, tenant: &str, username: &str, password: &str) -> Result<(String, Principal, bool), String> {
        let tenant = tenant.trim().to_uppercase();
        let uname = username.trim().to_lowercase();
        let key = format!("{tenant}/{uname}");
        let now = now_ms();
        {
            let f = self.fails.lock().unwrap();
            if let Some((n, since)) = f.get(&key) {
                if *n >= 5 && now - since < 5 * 60_000 {
                    return Err("로그인 실패가 5회를 넘어 5분 동안 잠겼습니다".into());
                }
            }
        }
        let user = {
            let users = self.users.read().unwrap();
            let hosp = users.values().find(|u| u.username.to_lowercase() == uname && u.tenant_id.as_deref().unwrap_or("") == tenant && !tenant.is_empty());
            let plat = users.values().find(|u| {
                u.username.to_lowercase() == uname
                    && u.tenant_id.is_none()
                    && (tenant.is_empty() || matches!(u.role.as_str(), "super_admin" | "system_admin") || u.tenants.iter().any(|t| *t == tenant))
            });
            hosp.or(plat).cloned()
        };
        let tenant_ok = tenant.is_empty() || self.tenants().iter().any(|t| t.id == tenant && t.active);
        let ok = tenant_ok && user.as_ref().map(|u| verify_pw(password, &u.pw)).unwrap_or_else(|| {
            let _ = verify_pw(password, &hash_pw("x")); // 계정 유무가 응답 시간으로 드러나지 않게
            false
        });
        let Some(u) = user.filter(|u| ok && u.active) else {
            let mut f = self.fails.lock().unwrap();
            let e = f.entry(key.clone()).or_insert((0, now));
            if now - e.1 > 5 * 60_000 {
                *e = (0, now);
            }
            e.0 += 1;
            drop(f);
            self.audit(&uname, &tenant, "login_fail", "");
            return Err("병원 ID·아이디·비밀번호를 확인하세요".into());
        };
        self.fails.lock().unwrap().remove(&key);
        let ctx = if tenant.is_empty() { None } else { Some(tenant.clone()) };
        let token = random_hex(32);
        let h = sha_hex(token.as_bytes());
        let exp = now + SESSION_MS;
        {
            let db = self.db.lock().unwrap();
            let _ = db.execute(
                "INSERT INTO sessions (token_hash, user_id, created_ms, expires_ms, tenant) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![h, u.id, now as i64, exp as i64, ctx],
            );
            let _ = db.execute("UPDATE users SET last_login_ms = ?1 WHERE id = ?2", params![now as i64, u.id]);
            let _ = db.execute("DELETE FROM sessions WHERE expires_ms < ?1", params![now as i64]);
        }
        self.sessions.lock().unwrap().insert(h, (u.id, exp, ctx.clone()));
        if let Some(x) = self.users.write().unwrap().get_mut(&u.id) {
            x.last_login_ms = Some(now);
        }
        self.audit(&u.username, ctx.as_deref().or(u.tenant_id.as_deref()).unwrap_or(""), "login", role_label(&u.role));
        Ok((token, self.principal_of(&u, ctx.as_deref()), u.must_change))
    }

    pub fn logout(&self, token: &str) {
        let h = sha_hex(token.as_bytes());
        self.sessions.lock().unwrap().remove(&h);
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("DELETE FROM sessions WHERE token_hash = ?1", params![h]);
        }
    }

    fn drop_sessions_of(&self, uid: i64) {
        self.sessions.lock().unwrap().retain(|_, (u, _, _)| *u != uid);
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("DELETE FROM sessions WHERE user_id = ?1", params![uid]);
        }
    }

    pub fn change_password(&self, p: &Principal, old: &str, new: &str) -> Result<(), String> {
        let u = self.users.read().unwrap().get(&p.user_id).cloned().ok_or("계정을 찾을 수 없습니다")?;
        if !verify_pw(old, &u.pw) {
            return Err("현재 비밀번호가 올바르지 않습니다".into());
        }
        check_pw_policy(new)?;
        if new == old {
            return Err("새 비밀번호가 현재 비밀번호와 같습니다".into());
        }
        {
            let db = self.db.lock().unwrap();
            db.execute("UPDATE users SET pw = ?1, must_change = 0, test_pw = NULL WHERE id = ?2", params![hash_pw(new), u.id]).map_err(|e| e.to_string())?;
        }
        self.reload_users();
        self.audit(&u.username, u.tenant_id.as_deref().unwrap_or(""), "password_change", "");
        Ok(())
    }

    pub fn me(&self, p: &Principal) -> serde_json::Value {
        let users = self.users.read().unwrap();
        let u = users.get(&p.user_id);
        let site = self.site_tenant();
        let tenants = self.tenants();
        let tname = |id: &str| tenants.iter().find(|t| t.id == id).map(|t| t.name.clone()).unwrap_or_default();
        serde_json::json!({
            "user": { "id": p.user_id, "username": p.username, "name": p.name, "role": p.role, "role_label": role_label(&p.role),
                      "tenant_id": p.tenant_id, "tenant_name": p.tenant_id.as_deref().map(tname), "must_change": u.map(|u| u.must_change).unwrap_or(false),
                      "service": p.service },
            "scope": p.scope,
            "context": { "tenant_id": p.context, "name": p.context.as_deref().map(tname) },
            "site": { "tenant_id": site, "name": tname(&site), "accessible": p.can_access(&site) },
            "dev_mode": self.dev_mode(),
            "perms": p.perms,
        })
    }

    /// 로그인 화면의 시험용 계정 (개발 모드에서만, 아직 임시 비밀번호인 계정만)
    /// 로그인 화면의 병원 목록 (개발 모드에서만 — 운영에서는 병원 ID 를 직접 입력)
    pub fn login_tenants(&self) -> Vec<serde_json::Value> {
        if !self.dev_mode() {
            return Vec::new();
        }
        let site = self.site_tenant();
        self.tenants().into_iter().filter(|t| t.active).map(|t| serde_json::json!({"id": t.id, "name": t.name, "is_site": t.id == site})).collect()
    }

    pub fn test_accounts(&self) -> Vec<serde_json::Value> {
        if !self.dev_mode() {
            return Vec::new();
        }
        let tenants = self.tenants();
        let mut v: Vec<&User> = Vec::new();
        let users = self.users.read().unwrap();
        for u in users.values() {
            if u.active && u.test_pw.is_some() {
                v.push(u);
            }
        }
        v.sort_by_key(|u| (role_idx(&u.role).unwrap_or(99), u.tenant_id.clone(), u.username.clone()));
        v.into_iter()
            .map(|u| {
                let tn = u.tenant_id.as_deref().and_then(|t| tenants.iter().find(|x| x.id == t)).map(|t| t.name.clone());
                serde_json::json!({ "username": u.username, "name": u.name, "role": u.role, "role_label": role_label(&u.role),
                                    "tenant_id": u.tenant_id, "tenant_name": tn, "tenants": u.tenants, "password": u.test_pw })
            })
            .collect()
    }

    // ── 병원(테넌트) ──

    pub fn tenants(&self) -> Vec<Tenant> {
        let db = self.db.lock().unwrap();
        let mut v = Vec::new();
        if let Ok(mut st) = db.prepare("SELECT id, name, kind, region, contact, reseller, active, created_ms FROM tenants ORDER BY id") {
            if let Ok(rows) = st.query_map([], |r| {
                Ok(Tenant {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    kind: r.get(2)?,
                    region: r.get(3)?,
                    contact: r.get(4)?,
                    reseller: r.get(5)?,
                    active: r.get::<_, i64>(6)? != 0,
                    created_ms: r.get::<_, i64>(7)? as u64,
                })
            }) {
                v.extend(rows.flatten());
            }
        }
        v
    }

    pub fn tenants_for(&self, p: &Principal) -> Vec<serde_json::Value> {
        let site = self.site_tenant();
        let users = self.users.read().unwrap();
        self.tenants()
            .into_iter()
            .filter(|t| p.can_access(&t.id))
            .map(|t| {
                let n = users.values().filter(|u| u.tenant_id.as_deref() == Some(&t.id)).count();
                let mut v = serde_json::to_value(&t).unwrap_or_default();
                v["is_site"] = serde_json::json!(t.id == site);
                v["users"] = serde_json::json!(n);
                v
            })
            .collect()
    }

    pub fn upsert_tenant(&self, p: &Principal, t: Tenant, create: bool) -> Result<(), String> {
        let id = t.id.trim().to_uppercase();
        if id.is_empty() || id.len() > 16 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            return Err("병원 ID 는 영문·숫자·-·_ 16자 이내입니다".into());
        }
        if t.name.trim().is_empty() {
            return Err("병원 이름이 비어 있습니다".into());
        }
        // 리셀러는 자기 담당 병원만 고치고, 새로 만든 병원은 자기 담당이 된다
        if !create && !p.can_access(&id) {
            return Err("담당하지 않는 병원입니다".into());
        }
        let db = self.db.lock().unwrap();
        if create {
            db.execute(
                "INSERT INTO tenants (id, name, kind, region, contact, reseller, active, created_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![id, t.name.trim(), t.kind, t.region, t.contact, if p.role == "reseller" { p.username.clone() } else { t.reseller.clone() }, t.active as i64, now_ms() as i64],
            )
            .map_err(|e| if e.to_string().contains("UNIQUE") { "이미 있는 병원 ID 입니다".to_string() } else { e.to_string() })?;
            if p.role == "reseller" || p.role == "sales_crm" {
                let _ = db.execute("INSERT OR IGNORE INTO user_tenants (user_id, tenant_id) VALUES (?1, ?2)", params![p.user_id, id]);
            }
        } else {
            db.execute(
                "UPDATE tenants SET name = ?2, kind = ?3, region = ?4, contact = ?5, reseller = ?6, active = ?7 WHERE id = ?1",
                params![id, t.name.trim(), t.kind, t.region, t.contact, t.reseller, t.active as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if create && self.dev_mode() {
            let n = seed_tenant_accounts(&db, &id);
            info!("auth: tenant {} created — {} test accounts (dev mode)", id, n);
        }
        drop(db);
        self.reload_users();
        self.audit(&p.username, &id, if create { "tenant_create" } else { "tenant_update" }, &t.name);
        Ok(())
    }

    // ── 계정 ──

    /// 이 요청자가 볼 수 있는 계정: 수퍼·시스템 = 전부, 리셀러 = 담당 병원 계정, 병원 역할 = 자기 병원 계정
    pub fn users_for(&self, p: &Principal) -> Vec<User> {
        let mut v: Vec<User> = self
            .users
            .read()
            .unwrap()
            .values()
            .filter(|u| match &p.scope {
                Scope::All => true,
                Scope::Some(s) => u.tenant_id.as_ref().map(|t| s.contains(t)).unwrap_or(false),
            })
            .cloned()
            .collect();
        v.sort_by_key(|u| (u.tenant_id.clone(), role_idx(&u.role).unwrap_or(99), u.username.clone()));
        v
    }

    /// 이 요청자가 만들 수·줄 수 있는 역할
    pub fn assignable_roles(&self, p: &Principal) -> Vec<&'static str> {
        match p.role.as_str() {
            "super_admin" => ROLES.iter().map(|r| r.0).collect(),
            "system_admin" => ROLES.iter().map(|r| r.0).filter(|r| *r != "super_admin").collect(),
            "reseller" => vec!["hospital_it", "doctor", "nurse", "staff"],
            "hospital_it" => vec!["hospital_it", "doctor", "nurse", "staff"],
            "doctor" => vec!["nurse", "staff"],
            _ => vec![],
        }
    }

    pub fn save_user(&self, p: &Principal, id: Option<i64>, inp: UserInput) -> Result<serde_json::Value, String> {
        let roles = self.assignable_roles(p);
        let role = inp.role.trim().to_string();
        if !roles.contains(&role.as_str()) {
            return Err(format!("{} 역할을 줄 권한이 없습니다", role_label(&role)));
        }
        let platform = is_platform(&role);
        let tenant = if platform { None } else { inp.tenant_id.clone().filter(|t| !t.is_empty()) };
        if !platform {
            let Some(t) = &tenant else { return Err("병원 역할은 소속 병원이 필요합니다".into()) };
            if !p.can_access(t) {
                return Err("담당하지 않는 병원에는 계정을 만들 수 없습니다".into());
            }
            if !self.tenants().iter().any(|x| &x.id == t) {
                return Err("없는 병원입니다".into());
            }
        }
        let extra: Vec<String> = if role == "reseller" || role == "sales_crm" { inp.tenants.clone().unwrap_or_default() } else { vec![] };
        for t in &extra {
            if !p.can_access(t) {
                return Err(format!("{t}: 담당하지 않는 병원입니다"));
            }
        }
        if let Some(uid) = id {
            let cur = self.users.read().unwrap().get(&uid).cloned().ok_or("계정을 찾을 수 없습니다")?;
            if !roles.contains(&cur.role.as_str()) {
                return Err("이 계정을 고칠 권한이 없습니다".into());
            }
            if let Some(t) = &cur.tenant_id {
                if !p.can_access(t) {
                    return Err("담당하지 않는 병원의 계정입니다".into());
                }
            }
            if uid == p.user_id && role != cur.role {
                return Err("자기 역할은 바꿀 수 없습니다".into());
            }
        }
        let username = inp.username.trim().to_lowercase();
        if id.is_none() && (username.len() < 3 || !username.chars().all(|c| c.is_ascii_alphanumeric() || ".-_".contains(c))) {
            return Err("아이디는 영문·숫자·.-_ 3자 이상입니다".into());
        }
        let name = inp.name.trim().to_string();
        if name.is_empty() {
            return Err("이름이 비어 있습니다".into());
        }
        let active = inp.active.unwrap_or(true);
        let mut temp = None;
        let db = self.db.lock().unwrap();
        let uid = match id {
            Some(uid) => {
                db.execute("UPDATE users SET name = ?2, role = ?3, tenant_id = ?4, tenant_key = COALESCE(?4, ''), active = ?5 WHERE id = ?1", params![uid, name, role, tenant, active as i64])
                    .map_err(|e| e.to_string())?;
                uid
            }
            None => {
                let pw = temp_password();
                db.execute(
                    "INSERT INTO users (username, name, role, tenant_id, tenant_key, pw, must_change, test_pw, active, created_ms) VALUES (?1, ?2, ?3, ?4, COALESCE(?4, ''), ?5, 1, ?6, ?7, ?8)",
                    params![username, name, role, tenant, hash_pw(&pw), if self.dev_mode() { Some(pw.clone()) } else { None }, active as i64, now_ms() as i64],
                )
                .map_err(|e| if e.to_string().contains("UNIQUE") { "이 병원에 이미 있는 아이디입니다".to_string() } else { e.to_string() })?;
                temp = Some(pw);
                db.last_insert_rowid()
            }
        };
        let _ = db.execute("DELETE FROM user_tenants WHERE user_id = ?1", params![uid]);
        for t in &extra {
            let _ = db.execute("INSERT OR IGNORE INTO user_tenants (user_id, tenant_id) VALUES (?1, ?2)", params![uid, t]);
        }
        drop(db);
        if !active {
            self.drop_sessions_of(uid);
        }
        self.reload_users();
        self.audit(&p.username, tenant.as_deref().unwrap_or(""), if id.is_some() { "user_update" } else { "user_create" }, &format!("{} ({})", username_of(&self.users.read().unwrap(), uid), role_label(&role)));
        Ok(serde_json::json!({ "id": uid, "temp_password": temp }))
    }

    pub fn reset_password(&self, p: &Principal, uid: i64) -> Result<String, String> {
        let u = self.users.read().unwrap().get(&uid).cloned().ok_or("계정을 찾을 수 없습니다")?;
        if !self.assignable_roles(p).contains(&u.role.as_str()) || u.tenant_id.as_ref().map(|t| !p.can_access(t)).unwrap_or(false) {
            return Err("이 계정의 비밀번호를 바꿀 권한이 없습니다".into());
        }
        let pw = temp_password();
        {
            let db = self.db.lock().unwrap();
            db.execute("UPDATE users SET pw = ?1, must_change = 1, test_pw = ?2 WHERE id = ?3", params![hash_pw(&pw), if self.dev_mode() { Some(pw.clone()) } else { None }, uid])
                .map_err(|e| e.to_string())?;
        }
        self.drop_sessions_of(uid);
        self.reload_users();
        self.audit(&p.username, u.tenant_id.as_deref().unwrap_or(""), "password_reset", &u.username);
        Ok(pw)
    }

    // ── 권한 매트릭스 ──

    /// 편집 화면 자료: 역할·자원 목록, 기본값, 전역 표, 병원 덮어쓰기, 요청자가 고칠 수 있는 칸
    pub fn permissions_view(&self, p: &Principal, tenant: &str) -> serde_json::Value {
        let m = self.matrix.read().unwrap();
        let global = merged(&builtin_matrix(), m.get(GLOBAL));
        let overrides = m.get(tenant).cloned().unwrap_or_default();
        drop(m);
        let effective: BTreeMap<String, HashMap<String, u8>> = ROLES.iter().map(|r| (r.0.to_string(), self.effective(r.0, Some(tenant)))).collect();
        serde_json::json!({
            "roles": ROLES.iter().map(|r| serde_json::json!({"code": r.0, "label": r.1, "platform": r.2})).collect::<Vec<_>>(),
            "resources": RESOURCES.iter().map(|r| serde_json::json!({"code": r.0, "label": r.1, "group": r.2})).collect::<Vec<_>>(),
            "defaults": builtin_matrix(),
            "global": global,
            "tenant": tenant,
            "tenant_overrides": overrides,
            "effective": effective,
            "editable": self.editable(p),
            "dev_mode": self.dev_mode(),
        })
    }

    /// {"global": [roles…], "tenant": [roles…]} — 요청자가 고칠 수 있는 열
    pub fn editable(&self, p: &Principal) -> serde_json::Value {
        let edit = p.level("page.admin_permissions") >= 2;
        let g: Vec<&str> = if edit && p.role == "super_admin" { ROLES.iter().map(|r| r.0).filter(|r| *r != "super_admin").collect() } else { vec![] };
        let t: Vec<&str> = if edit && (p.role == "doctor" || p.role == "super_admin") { CLINICAL_DELEGATED.to_vec() } else { vec![] };
        serde_json::json!({ "global": g, "tenant": t })
    }

    pub fn save_permissions(&self, p: &Principal, scope: &str, tenant: &str, inp: Matrix, note: &str) -> Result<(), String> {
        let ed = self.editable(p);
        let allowed: Vec<String> = ed[if scope == "tenant" { "tenant" } else { "global" }]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        if allowed.is_empty() {
            return Err("권한 표를 고칠 권한이 없습니다".into());
        }
        let key = if scope == "tenant" {
            if !p.can_access(tenant) || tenant.is_empty() {
                return Err("담당하지 않는 병원입니다".into());
            }
            tenant.to_string()
        } else {
            GLOBAL.to_string()
        };
        // 의사는 자기 권한보다 높게 줄 수 없다
        let cap = |res: &str| if p.role == "super_admin" { 2 } else { p.level(res) };
        let mut rows = Vec::new();
        for (role, row) in inp.iter() {
            if !allowed.contains(role) {
                continue;
            }
            for (res, lv) in row.iter() {
                if !res_known(res) {
                    continue;
                }
                let lv = (*lv).min(2);
                if lv > cap(res) {
                    return Err(format!("{} · {}: 자기 권한({})보다 높게 줄 수 없습니다", role_label(role), res, cap(res)));
                }
                rows.push((role.clone(), res.clone(), lv));
            }
        }
        {
            let mut db = self.db.lock().unwrap();
            let tx = db.transaction().map_err(|e| e.to_string())?;
            for role in &allowed {
                tx.execute("DELETE FROM perm_matrix WHERE tenant = ?1 AND role = ?2", params![key, role]).map_err(|e| e.to_string())?;
            }
            for (role, res, lv) in &rows {
                tx.execute("INSERT INTO perm_matrix (tenant, role, resource, level) VALUES (?1, ?2, ?3, ?4)", params![key, role, res, *lv as i64])
                    .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        self.reload_matrix();
        // 판 기록: 저장 직후의 이 범위 전체 표
        let snapshot = self.matrix.read().unwrap().get(&key).cloned().unwrap_or_default();
        if let Ok(db) = self.db.lock() {
            let _ = db.execute(
                "INSERT INTO perm_versions (tenant, saved_ms, saved_by, note, matrix) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![key, now_ms() as i64, p.username, note, serde_json::to_string(&snapshot).unwrap_or_default()],
            );
        }
        self.audit(&p.username, if key == GLOBAL { "" } else { &key }, "permissions_save", &format!("{} 칸, {}", rows.len(), note));
        Ok(())
    }

    pub fn permission_versions(&self, scope: &str, tenant: &str) -> Vec<serde_json::Value> {
        let key = if scope == "tenant" { tenant } else { GLOBAL };
        let db = self.db.lock().unwrap();
        let mut v = Vec::new();
        if let Ok(mut st) = db.prepare("SELECT id, saved_ms, saved_by, note, matrix FROM perm_versions WHERE tenant = ?1 ORDER BY id DESC LIMIT 50") {
            if let Ok(rows) = st.query_map(params![key], |r| {
                Ok(serde_json::json!({ "id": r.get::<_, i64>(0)?, "saved_ms": r.get::<_, i64>(1)?, "saved_by": r.get::<_, String>(2)?,
                                       "note": r.get::<_, String>(3)?, "matrix": serde_json::from_str::<serde_json::Value>(&r.get::<_, String>(4)?).unwrap_or_default() }))
            }) {
                v.extend(rows.flatten());
            }
        }
        v
    }

    pub fn set_dev_mode(&self, p: &Principal, on: bool) -> Result<(), String> {
        if p.role != "super_admin" {
            return Err("수퍼 어드민만 바꿀 수 있습니다".into());
        }
        self.dev_mode.store(on, Ordering::Relaxed);
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![K_DEV, if on { "1" } else { "0" }]);
            if !on {
                // 개발이 끝나면 화면에 남아 있던 임시 비밀번호 원문을 지운다
                let _ = db.execute("UPDATE users SET test_pw = NULL", []);
            }
        }
        self.reload_users();
        self.audit(&p.username, "", "dev_mode", if on { "켜짐" } else { "꺼짐" });
        Ok(())
    }

    pub fn audit_list(&self, p: &Principal, limit: usize) -> Vec<serde_json::Value> {
        let db = self.db.lock().unwrap();
        let mut v = Vec::new();
        if let Ok(mut st) = db.prepare("SELECT ts_ms, username, tenant, action, detail FROM audit ORDER BY id DESC LIMIT ?1") {
            if let Ok(rows) = st.query_map(params![(limit * 4) as i64], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))
            }) {
                for (ts, u, t, a, d) in rows.flatten() {
                    // 병원 역할은 자기 병원 기록만 (병원 없는 기록 = 플랫폼 기록은 플랫폼 역할만)
                    let ok = match &p.scope {
                        Scope::All => true,
                        Scope::Some(s) => !t.is_empty() && s.contains(&t),
                    };
                    if ok {
                        v.push(serde_json::json!({"ts_ms": ts, "username": u, "tenant": t, "action": a, "detail": d}));
                    }
                    if v.len() >= limit {
                        break;
                    }
                }
            }
        }
        v
    }
}

/// 2026-09-24 첫 판: 아이디가 전체에서 유일(UNIQUE username), 세션에 병원 문맥 없음 → 병원 안에서 유일 + 세션 병원
fn migrate(db: &Connection) {
    let sql: Option<String> = db.query_row("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'", [], |r| r.get(0)).ok();
    if sql.map(|s| s.contains("username TEXT NOT NULL UNIQUE")).unwrap_or(false) {
        let r = db.execute_batch(
            "BEGIN;
             ALTER TABLE users RENAME TO users_v1;
             CREATE TABLE users (
               id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
               tenant_id TEXT REFERENCES tenants(id), tenant_key TEXT NOT NULL DEFAULT '', pw TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
               must_change INTEGER NOT NULL DEFAULT 1, test_pw TEXT, created_ms INTEGER NOT NULL, last_login_ms INTEGER,
               UNIQUE (tenant_key, username));
             INSERT INTO users (id, username, name, role, tenant_id, tenant_key, pw, active, must_change, test_pw, created_ms, last_login_ms)
               SELECT id, username, name, role, tenant_id, COALESCE(tenant_id, ''), pw, active, must_change, test_pw, created_ms, last_login_ms FROM users_v1;
             DROP TABLE users_v1;
             DELETE FROM users WHERE username IN ('it.h001', 'dr.h002') AND test_pw IS NOT NULL;
             DELETE FROM sessions;
             COMMIT;",
        );
        match r {
            Ok(_) => info!("auth: users table migrated (username unique per hospital)"),
            Err(e) => {
                let _ = db.execute_batch("ROLLBACK;");
                warn!("auth: users migration failed: {}", e);
            }
        }
    }
    let has_tenant: bool = db.prepare("SELECT tenant FROM sessions LIMIT 0").is_ok();
    if !has_tenant {
        let _ = db.execute_batch("ALTER TABLE sessions ADD COLUMN tenant TEXT;");
    }
}

fn username_of(users: &HashMap<i64, User>, id: i64) -> String {
    users.get(&id).map(|u| u.username.clone()).unwrap_or_default()
}

fn merged(base: &Matrix, over: Option<&Matrix>) -> Matrix {
    let mut m = base.clone();
    if let Some(o) = over {
        for (role, row) in o {
            let r = m.entry(role.clone()).or_default();
            for (res, lv) in row {
                r.insert(res.clone(), *lv);
            }
        }
    }
    m
}

#[derive(Deserialize)]
pub struct UserInput {
    #[serde(default)]
    pub username: String,
    pub name: String,
    pub role: String,
    pub tenant_id: Option<String>,
    pub tenants: Option<Vec<String>>,
    pub active: Option<bool>,
}

// ───────────────────────────── 비밀번호 · 토큰 ─────────────────────────────

const PBKDF2_ITER: u32 = 60_000;

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    Sha256::new().chain_update(opad).chain_update(inner).finalize().into()
}

/// PBKDF2-HMAC-SHA256, 32바이트 한 블록
fn pbkdf2(pw: &[u8], salt: &[u8], iter: u32) -> [u8; 32] {
    let mut s = salt.to_vec();
    s.extend_from_slice(&1u32.to_be_bytes());
    let mut u = hmac_sha256(pw, &s);
    let mut out = u;
    for _ in 1..iter {
        u = hmac_sha256(pw, &u);
        for i in 0..32 {
            out[i] ^= u[i];
        }
    }
    out
}

pub fn hash_pw(pw: &str) -> String {
    let salt = random_hex(16);
    let h = pbkdf2(pw.as_bytes(), salt.as_bytes(), PBKDF2_ITER);
    format!("pbkdf2_sha256${}${}${}", PBKDF2_ITER, salt, hex(&h))
}

pub fn verify_pw(pw: &str, stored: &str) -> bool {
    let parts: Vec<&str> = stored.split('$').collect();
    if parts.len() != 4 || parts[0] != "pbkdf2_sha256" {
        return false;
    }
    let Ok(iter) = parts[1].parse::<u32>() else { return false };
    let h = pbkdf2(pw.as_bytes(), parts[2].as_bytes(), iter);
    constant_eq(hex(&h).as_bytes(), parts[3].as_bytes())
}

fn check_pw_policy(pw: &str) -> Result<(), String> {
    let classes = [pw.chars().any(|c| c.is_ascii_lowercase()), pw.chars().any(|c| c.is_ascii_uppercase()), pw.chars().any(|c| c.is_ascii_digit()), pw.chars().any(|c| !c.is_ascii_alphanumeric())];
    if pw.chars().count() < 8 || classes.iter().filter(|x| **x).count() < 3 {
        return Err("비밀번호는 8자 이상, 대문자·소문자·숫자·기호 중 3가지 이상이어야 합니다".into());
    }
    Ok(())
}

fn temp_password() -> String {
    let r = random_hex(4);
    format!("Tmp!{}{}", &r[..4].to_uppercase(), &r[4..])
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

pub fn sha_hex(b: &[u8]) -> String {
    hex(&Sha256::digest(b))
}

/// OS 난수(/dev/urandom). 읽을 수 없는 환경이면 시각·주소·카운터를 섞은 해시로 대신한다.
pub fn random_hex(n: usize) -> String {
    use std::io::Read;
    let mut buf = vec![0u8; n];
    if std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut buf)).is_ok() {
        return hex(&buf);
    }
    static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let mut out = Vec::new();
    while out.len() < n {
        let seed = format!("{:?}{}{:p}", std::time::SystemTime::now(), CTR.fetch_add(1, Ordering::Relaxed), &out);
        out.extend_from_slice(&Sha256::digest(seed.as_bytes()));
    }
    hex(&out[..n])
}

// ───────────────────────────── 마스킹 ─────────────────────────────

/// "김철수" → "김*수", "Dilnoza Rakhimov" → "D****** R*******"
pub fn mask_name(s: &str) -> String {
    let words: Vec<&str> = s.split_whitespace().collect();
    if words.len() > 1 {
        return words.iter().map(|w| mask_word(w, true)).collect::<Vec<_>>().join(" ");
    }
    mask_word(s, false)
}
fn mask_word(w: &str, keep_first_only: bool) -> String {
    let c: Vec<char> = w.chars().collect();
    match c.len() {
        0 => String::new(),
        1 => "*".into(),
        2 => format!("{}*", c[0]),
        n if keep_first_only => format!("{}{}", c[0], "*".repeat(n - 1)),
        n => format!("{}{}{}", c[0], "*".repeat(n - 2), c[n - 1]),
    }
}
/// 문구 속 수치만 가린다 ("SpO2 위험 71%" → "SpO2 위험 ●●%"): 단어에 붙은 숫자(SpO2)는 둔다
pub fn mask_numbers(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_word = false;
    for c in s.chars() {
        if c.is_ascii_digit() || (c == '.' && out.ends_with('●')) {
            if prev_word {
                out.push(c);
            } else {
                out.push('●');
            }
            continue;
        }
        prev_word = c.is_alphanumeric();
        out.push(c);
    }
    out
}

/// 끝 5자리를 가린다: "MRN-11200834" → "MRN-112*****"
pub fn mask_tail(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let k = c.len().saturating_sub(5);
    c[..k].iter().collect::<String>() + &"*".repeat(c.len() - k)
}

/// 개인정보 키 (값 전체를 가리거나 이름 규칙으로 가린다)
const PHI_NAME_KEYS: [&str; 3] = ["name", "patient_name", "emergency_contact"];
const PHI_TAIL_KEYS: [&str; 2] = ["mrn", "patient_id"];
const PHI_DROP_KEYS: [&str; 7] = ["phone", "address", "birth_date", "birth", "home_address", "rrn", "email"];

/// JSON 안의 개인정보 필드를 가린다(재귀). `vital_keys` 가 있으면 생체 수치도 지운다.
pub fn mask_json(v: &mut serde_json::Value, phi: bool, bio: bool) {
    match v {
        serde_json::Value::Object(m) => {
            for (k, x) in m.iter_mut() {
                let k = k.as_str();
                if !phi {
                    if PHI_NAME_KEYS.contains(&k) {
                        if let Some(s) = x.as_str() {
                            *x = serde_json::Value::String(mask_name(s));
                            continue;
                        }
                    }
                    if PHI_TAIL_KEYS.contains(&k) {
                        match x {
                            serde_json::Value::String(s) => {
                                *x = serde_json::Value::String(mask_tail(s));
                                continue;
                            }
                            serde_json::Value::Number(n) => {
                                *x = serde_json::Value::String(mask_tail(&n.to_string()));
                                continue;
                            }
                            _ => {}
                        }
                    }
                    if PHI_DROP_KEYS.contains(&k) && !x.is_object() {
                        *x = serde_json::Value::String("●●●".into());
                        continue;
                    }
                    if k == "address" || k == "home_address" {
                        *x = serde_json::Value::String("●●●".into());
                        continue;
                    }
                }
                // 환자 객체의 id(= 환자번호)
                if !phi && k == "patient" {
                    if let Some(id) = x.get("id").and_then(|i| i.as_str().map(String::from).or_else(|| i.as_i64().map(|n| n.to_string()))) {
                        x["id"] = serde_json::Value::String(mask_tail(&id));
                    }
                }
                if !bio && (k == "vitals" || k == "vitals_ts_ms") {
                    *x = serde_json::Value::Null;
                    continue;
                }
                mask_json(x, phi, bio);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a.iter_mut() {
                mask_json(x, phi, bio);
            }
        }
        _ => {}
    }
}

// ───────────────────────────── 요청 가드 ─────────────────────────────

/// 요청마다 필요한 권한: 목록 중 하나라도 그 수준 이상이면 통과. `None` = 로그인만 필요.
fn requirement(path: &str, method: &axum::http::Method) -> Option<(Vec<&'static str>, u8)> {
    let write = !matches!(*method, axum::http::Method::GET | axum::http::Method::HEAD);
    let lv = if write { 2 } else { 1 };
    let p = path;
    let r = |v: &[&'static str], l: u8| Some((v.to_vec(), l));
    if p == "/ws" {
        return r(&["data.biosignal"], 1);
    }
    if p.starts_with("/api/auth/") || p.starts_with("/api/emu/") {
        return None;
    }
    if p.starts_with("/api/admin/users") {
        return r(&["page.admin_users"], lv);
    }
    if p.starts_with("/api/admin/permissions") || p.starts_with("/api/admin/dev_mode") {
        return r(&["page.admin_permissions"], lv);
    }
    if p.starts_with("/api/admin/tenants") {
        return r(&["page.admin_tenants"], lv);
    }
    if p.starts_with("/api/admin/audit") {
        return r(&["page.admin_audit", "page.admin_users"], 1);
    }
    if p.starts_with("/api/integration") {
        return r(&["page.integration"], lv);
    }
    if p == "/api/stats" || p == "/api/gateways/summary" {
        return r(&["page.dashboard", "page.gateways", "page.ops", "page.data_admin", "page.test"], 1);
    }
    if p.starts_with("/api/stats/") || p == "/api/channels/prune" || p.starts_with("/api/metrics/reset") {
        return r(&["page.ops"], 2);
    }
    if p == "/api/wave/reset" {
        return r(&["action.wave_reset"], 2);
    }
    if p.starts_with("/api/wave/") || p.starts_with("/api/patches/") {
        return r(&["data.biosignal"], 1);
    }
    if p == "/api/events" {
        return r(&["page.events", "page.dashboard"], 1);
    }
    if p.starts_with("/api/displays") {
        return r(&["page.viewers"], lv);
    }
    if p == "/api/gateways" {
        return r(&["page.gateways", "page.map", "page.dashboard", "page.test"], 1);
    }
    if p == "/api/channels" {
        return r(&["page.patients", "page.map", "page.viewers", "page.test", "page.dashboard", "page.alarms"], 1);
    }
    if p.starts_with("/api/groups") {
        return if write { r(&["action.groups_edit"], 2) } else { r(&["page.viewers", "page.test", "page.map"], 1) };
    }
    if p.starts_with("/api/ingest/") {
        return r(&["page.settings_network"], lv);
    }
    if p.starts_with("/api/debug/") || p.starts_with("/api/metrics") {
        return r(&["page.ops"], 1);
    }
    if p.starts_with("/api/alarms/rules") {
        return if write { r(&["action.alarm_rules"], 2) } else { r(&["page.alarms"], 1) };
    }
    if p.starts_with("/api/alarms/") && p.ends_with("/ack") {
        return r(&["action.alarm_ack"], 2);
    }
    if p.starts_with("/api/alarms") {
        return r(&["page.alarms", "page.dashboard", "page.map", "page.patients", "page.viewers", "page.test"], 1);
    }
    if p.starts_with("/api/emr/") {
        return r(&["page.map", "page.patients", "page.viewers", "page.dashboard", "page.test"], 1);
    }
    if p.starts_with("/api/backup") {
        return r(&["page.settings_biosignal"], lv);
    }
    if p.starts_with("/api/settings/network") {
        return r(&["page.settings_network"], lv);
    }
    // 알 수 없는 API: 수퍼 어드민 수준만 (새 경로를 넣고 여기 규칙을 빼먹어도 열리지 않게)
    r(&["page.admin_permissions"], 2)
}

/// 병원 데이터가 아닌 경로 (계정·병원 관리, 에뮬레이터 상태)
fn tenant_free(path: &str) -> bool {
    path.starts_with("/api/auth/") || path.starts_with("/api/admin/") || path.starts_with("/api/emu/")
}

fn token_of(req: &Request) -> Option<String> {
    if let Some(h) = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(t) = h.strip_prefix("Bearer ") {
            return Some(t.trim().to_string());
        }
    }
    let cookies = req.headers().get_all(header::COOKIE);
    for c in cookies.iter().filter_map(|v| v.to_str().ok()) {
        for part in c.split(';') {
            if let Some(v) = part.trim().strip_prefix(&format!("{COOKIE}=")) {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn deny(code: StatusCode, msg: &str) -> Response {
    (code, [(header::CONTENT_TYPE, "application/json; charset=utf-8")], serde_json::json!({ "error": msg }).to_string()).into_response()
}

/// 모든 `/api/*`·`/ws` 요청의 문지기: 로그인 확인 → 병원(테넌트) 접근 확인 → 경로별 권한 확인.
/// 통과하면 요청 주체(`Principal`)를 요청에 붙여 처리기가 마스킹에 쓴다.
pub async fn guard(State(state): State<Arc<AppState>>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let api = path.starts_with("/api/") || path == "/ws" || path.starts_with("/fhir");
    if !api || path == "/api/health" || path == "/api/auth/login" || path == "/api/auth/test-accounts" || path == "/api/auth/logout" {
        return next.run(req).await;
    }
    if path.starts_with("/fhir") {
        // FHIR 는 연동 모듈이 자체 토큰으로 검사한다
        return next.run(req).await;
    }
    let Some(tok) = token_of(&req) else { return deny(StatusCode::UNAUTHORIZED, "로그인이 필요합니다") };
    let Some(p) = state.auth.resolve(&tok) else { return deny(StatusCode::UNAUTHORIZED, "세션이 만료되었습니다. 다시 로그인하세요") };
    if !tenant_free(&path) {
        let site = state.auth.site_tenant();
        if !p.can_access(&site) {
            return deny(StatusCode::FORBIDDEN, "이 병원의 데이터에 접근할 권한이 없습니다");
        }
    }
    if let Some((any, lv)) = requirement(&path, req.method()) {
        if !any.iter().any(|r| p.level(r) >= lv) {
            return deny(StatusCode::FORBIDDEN, &format!("권한이 없습니다 ({})", any.join(" | ")));
        }
    }
    if path == "/ws" && !p.phi() {
        return deny(StatusCode::FORBIDDEN, "실시간 스트림은 개인정보 권한도 필요합니다");
    }
    req.extensions_mut().insert(p);
    next.run(req).await
}

pub fn session_cookie(token: &str, clear: bool) -> String {
    if clear {
        format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
    } else {
        format!("{COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}", SESSION_MS / 1000)
    }
}

pub fn cookie_token(headers: &axum::http::HeaderMap) -> Option<String> {
    for c in headers.get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()) {
        for part in c.split(';') {
            if let Some(v) = part.trim().strip_prefix(&format!("{COOKIE}=")) {
                return Some(v.to_string());
            }
        }
    }
    headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|h| h.strip_prefix("Bearer ")).map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pbkdf2_known_vector() {
        // RFC 7914 §11 PBKDF2-HMAC-SHA256 ("passwd", "salt", 1) 첫 32바이트
        let h = pbkdf2(b"passwd", b"salt", 1);
        assert_eq!(hex(&h), "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc");
    }

    #[test]
    fn password_roundtrip() {
        let h = hash_pw("Doctor!2026");
        assert!(verify_pw("Doctor!2026", &h));
        assert!(!verify_pw("doctor!2026", &h));
    }

    #[test]
    fn masking() {
        assert_eq!(mask_name("김철수"), "김*수");
        assert_eq!(mask_name("이혜"), "이*");
        assert_eq!(mask_name("Vu Duc"), "V* D**");
        assert_eq!(mask_tail("MRN-11200834"), "MRN-112*****");
        assert_eq!(mask_numbers("SpO2 위험 71%"), "SpO2 위험 ●●%");
        assert_eq!(mask_numbers("고열 39.4°C"), "고열 ●●●●°C");
        let mut v = serde_json::json!({"patient": {"name": "김철수", "room": "103A01"}, "mrn": "MRN-11200834", "patient_id": 106744, "vitals": {"hr": 80}});
        mask_json(&mut v, false, false);
        assert_eq!(v["patient"]["name"], "김*수");
        assert_eq!(v["patient"]["room"], "103A01");
        assert_eq!(v["mrn"], "MRN-112*****");
        assert_eq!(v["patient_id"], "1*****");
        assert!(v["vitals"].is_null());
    }

    #[test]
    fn tenant_isolation_and_defaults() {
        let a = Auth::open(":memory:");
        let (_, doc, _) = a.login("H002", "dr.kim", "Doctor!2026").unwrap();
        assert!(!doc.can_access("H001"), "H002 doctor must not reach H001 data");
        let (_, sys, _) = a.login("", "sysadmin", "Sys!2026").unwrap();
        assert!(sys.can_access("H001") && !sys.phi() && !sys.bio(), "system admin: all hospitals, masked");
        let (_, nurse, _) = a.login("H001", "nurse.lee", "Nurse!2026").unwrap();
        assert!(nurse.phi() && nurse.bio() && nurse.can_access("H001") && !nurse.can_access("H002"));
        assert!(a.login("H001", "dr.kim", "wrong").is_err());
        assert!(a.login("", "dr.kim", "Doctor!2026").is_err(), "hospital account needs its hospital ID");
        assert!(a.login("H009", "dr.kim", "Doctor!2026").is_err());
        // 플랫폼 계정이 병원을 골라 들어오면 그 병원 하나로 좁혀진다
        let (_, r, _) = a.login("H002", "reseller1", "Resell!2026").unwrap();
        assert!(r.can_access("H002") && !r.can_access("H001"));
        let (_, s2, _) = a.login("H003", "sales1", "Sales!2026").unwrap();
        assert!(s2.can_access("H003"));
        assert!(a.login("H002", "sales1", "Sales!2026").is_err(), "sales1 is not assigned to H002");
        // 같은 아이디가 병원마다 따로 — H001 의사와 H002 의사는 다른 계정
        let (_, d1, _) = a.login("H001", "dr.kim", "Doctor!2026").unwrap();
        assert_ne!(d1.user_id, doc.user_id);
    }

    #[test]
    fn doctor_edits_only_nurse_staff_within_own_level() {
        let a = Auth::open(":memory:");
        let (_, doc, _) = a.login("H001", "dr.kim", "Doctor!2026").unwrap();
        let mut m = Matrix::new();
        m.entry("nurse".into()).or_default().insert("page.alarms".into(), 1);
        m.entry("hospital_it".into()).or_default().insert("data.phi".into(), 2); // 무시되어야 함
        a.save_permissions(&doc, "tenant", "H001", m, "t").unwrap();
        assert_eq!(a.effective("nurse", Some("H001"))["page.alarms"], 1);
        assert_eq!(a.effective("nurse", Some("H002"))["page.alarms"], 2, "override is per hospital");
        assert_eq!(a.effective("hospital_it", Some("H001"))["data.phi"], 0);
        let mut m = Matrix::new();
        m.entry("staff".into()).or_default().insert("action.wave_reset".into(), 2);
        assert!(a.save_permissions(&doc, "tenant", "H001", m, "t").is_err(), "cannot grant above own level");
    }
}
