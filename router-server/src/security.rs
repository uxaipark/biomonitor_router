//! 보안 운영 (운영관리 › 보안 운영): 무단 스캐닝 감지·차단, 로그인 실패 IP 차단.
//!
//! * **스캐닝** — HTTP(7300) 로 콘솔(`/`, `/assets/*`)·API·WS 가 아닌 경로를 두드리거나, 공격 서명(경로 조작·인젝션·
//!   웹 취약점 탐색)이 보이거나, 게이트웨이 포트(9100)에 프로토콜이 아닌 바이트를 보내는 IP 를 기록한다. IP 마다
//!   분류(서브그룹)별 횟수·예시 경로를 모으고, 공격·침투 목적 분류는 즉시, 미상 경로는 창 안 횟수가 한도를 넘으면 차단.
//! * **로그인 실패** — 같은 IP 에서 30일(설정) 안에 실패 10번(설정)이면 차단. PIN·비밀번호·계정 불일치 모두 1건.
//!   한 번 성공하면 그 IP 의 실패 목록을 모두 지운다.
//! * **차단** — HTTP 는 미들웨어(`guard`)가 403 으로 막고, 9100 은 accept 직후 끊는다. 루프백과 신뢰 IP(설정)는
//!   차단하지 않는다(콘솔을 서비스 토큰 스크립트로 되살릴 수 있게). 차단 시간은 종류별 설정, 0 = 수동 해제까지.
//!
//! 상태는 `router.db`(`sec_*` 표, `settings.security`)에 남아 재시작 뒤에도 유지된다.

use crate::state::AppState;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, LazyLock, Mutex, RwLock};
use tracing::{info, warn};

// ───────────────────────────── 설정 ─────────────────────────────

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct Settings {
    /// 로그인 실패 한도 (같은 IP, 기간 안)
    #[serde(default = "d_fail_limit")]
    pub login_fail_limit: u32,
    /// 로그인 실패를 세는 기간(일)
    #[serde(default = "d_window_days")]
    pub login_window_days: u32,
    /// 로그인 실패 차단 시간(시간, 0 = 수동 해제까지)
    #[serde(default = "d_login_block_h")]
    pub login_block_hours: u32,
    #[serde(default = "d_true")]
    pub auto_block_login: bool,
    /// 스캐닝 자동 차단 (공격 서명은 즉시, 미상 경로는 한도)
    #[serde(default = "d_true")]
    pub auto_block_scan: bool,
    /// 스캐닝 차단 시간(시간, 0 = 수동 해제까지)
    #[serde(default = "d_scan_block_h")]
    pub scan_block_hours: u32,
    /// 미상 경로·API 탐색·포트 탐색: 이 창(분) 안에 이 횟수면 차단
    #[serde(default = "d_unknown_limit")]
    pub scan_unknown_limit: u32,
    #[serde(default = "d_unknown_window")]
    pub scan_unknown_window_min: u32,
    /// 절대 차단하지 않는 IP (정확한 IP 또는 IPv4 CIDR, 예: 192.168.0.10, 10.0.0.0/8)
    #[serde(default)]
    pub trusted: Vec<String>,
}
fn d_fail_limit() -> u32 {
    10
}
fn d_window_days() -> u32 {
    30
}
fn d_login_block_h() -> u32 {
    24
}
fn d_scan_block_h() -> u32 {
    24 * 30
}
fn d_unknown_limit() -> u32 {
    30
}
fn d_unknown_window() -> u32 {
    10
}
fn d_true() -> bool {
    true
}
impl Default for Settings {
    fn default() -> Self {
        serde_json::from_str("{}").unwrap()
    }
}

// ───────────────────────────── 자료 ─────────────────────────────

#[derive(Clone, Serialize, Debug)]
pub struct Block {
    pub ip: String,
    /// login | scan | manual
    pub kind: String,
    pub reason: String,
    pub detail: String,
    pub created_ms: u64,
    /// 0 = 수동 해제까지
    pub until_ms: u64,
    pub by: String,
}

#[derive(Clone, Debug)]
struct Fail {
    ts_ms: u64,
    tenant: String,
    username: String,
    /// pin | credential | locked
    kind: String,
}

#[derive(Clone, Default, Debug, Serialize)]
struct ScanGroup {
    count: u64,
    last_ms: u64,
    /// 서로 다른 예시 경로 최대 5개
    samples: Vec<String>,
}

#[derive(Clone, Default, Debug)]
struct ScanAgg {
    first_ms: u64,
    last_ms: u64,
    count: u64,
    groups: BTreeMap<String, ScanGroup>,
    /// 한도형 분류(미상 경로·API 탐색·포트 탐색)의 최근 시각 (창 계산용)
    recent: VecDeque<u64>,
}

/// 즉시 차단하는 분류 (공격·침투 목적)
pub const ATTACK: [&str; 3] = ["경로 조작", "인젝션", "웹 취약점 탐색"];
/// 한도형 분류
pub const RATE: [&str; 4] = ["미상 경로", "API 탐색", "게이트웨이 포트 탐색", "프로토콜 이상"];
const SCAN_KEEP_DAYS: u64 = 7;

pub struct Security {
    db: Mutex<Option<Connection>>,
    settings: RwLock<Settings>,
    blocked: RwLock<HashMap<IpAddr, Block>>,
    fails: Mutex<HashMap<IpAddr, Vec<Fail>>>,
    scans: Mutex<HashMap<IpAddr, ScanAgg>>,
}

pub static SEC: LazyLock<Security> = LazyLock::new(|| Security {
    db: Mutex::new(None),
    settings: RwLock::new(Settings::default()),
    blocked: RwLock::new(HashMap::new()),
    fails: Mutex::new(HashMap::new()),
    scans: Mutex::new(HashMap::new()),
});

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS sec_blocks (ip TEXT PRIMARY KEY, kind TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
  created_ms INTEGER NOT NULL, until_ms INTEGER NOT NULL DEFAULT 0, by TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS sec_login_fail (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  tenant TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS sec_login_fail_ip ON sec_login_fail(ip, ts_ms);
CREATE TABLE IF NOT EXISTS sec_scan (id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, ts_ms INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT '', path TEXT NOT NULL DEFAULT '', status INTEGER NOT NULL DEFAULT 0, category TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sec_scan_ip ON sec_scan(ip, ts_ms);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

/// 시작 때: DB 열고 설정·차단·실패·스캔 기록을 불러온다
pub fn init(db_path: &str) {
    let db = match Connection::open(db_path) {
        Ok(d) => d,
        Err(e) => {
            warn!("security: db open failed ({}); running in memory only", e);
            return;
        }
    };
    let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    if let Err(e) = db.execute_batch(SCHEMA) {
        warn!("security schema: {}", e);
    }
    if let Ok(s) = db.query_row("SELECT value FROM settings WHERE key = 'security'", [], |r| r.get::<_, String>(0)) {
        if let Ok(v) = serde_json::from_str::<Settings>(&s) {
            *SEC.settings.write().unwrap() = v;
        }
    }
    let now = now_ms();
    let settings = SEC.settings.read().unwrap().clone();
    // 차단 (만료된 것은 버림)
    {
        let mut m = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT ip, kind, reason, detail, created_ms, until_ms, by FROM sec_blocks") {
            let rows = st.query_map([], |r| {
                Ok(Block { ip: r.get(0)?, kind: r.get(1)?, reason: r.get(2)?, detail: r.get(3)?, created_ms: r.get::<_, i64>(4)? as u64, until_ms: r.get::<_, i64>(5)? as u64, by: r.get(6)? })
            });
            if let Ok(rows) = rows {
                for b in rows.flatten() {
                    if b.until_ms != 0 && b.until_ms <= now {
                        continue;
                    }
                    if let Ok(ip) = b.ip.parse::<IpAddr>() {
                        m.insert(ip, b);
                    }
                }
            }
        }
        let _ = db.execute("DELETE FROM sec_blocks WHERE until_ms != 0 AND until_ms <= ?1", params![now as i64]);
        *SEC.blocked.write().unwrap() = m;
    }
    // 로그인 실패 (기간 안)
    {
        let cut = now.saturating_sub(settings.login_window_days as u64 * 86_400_000);
        let _ = db.execute("DELETE FROM sec_login_fail WHERE ts_ms < ?1", params![cut as i64]);
        let mut m: HashMap<IpAddr, Vec<Fail>> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT ip, ts_ms, tenant, username, kind FROM sec_login_fail ORDER BY ts_ms") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))) {
                for (ip, ts_ms, tenant, username, kind) in rows.flatten() {
                    if let Ok(ip) = ip.parse::<IpAddr>() {
                        m.entry(ip).or_default().push(Fail { ts_ms, tenant, username, kind });
                    }
                }
            }
        }
        *SEC.fails.lock().unwrap() = m;
    }
    // 스캔 (최근 7일) → 집계 재구성
    {
        let cut = now.saturating_sub(SCAN_KEEP_DAYS * 86_400_000);
        let _ = db.execute("DELETE FROM sec_scan WHERE ts_ms < ?1", params![cut as i64]);
        let mut m: HashMap<IpAddr, ScanAgg> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT ip, ts_ms, method, path, category FROM sec_scan ORDER BY ts_ms") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u64, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, String>(4)?))) {
                for (ip, ts_ms, method, path, category) in rows.flatten() {
                    if let Ok(ip) = ip.parse::<IpAddr>() {
                        add_scan(m.entry(ip).or_default(), ts_ms, &method, &path, &category, &settings);
                    }
                }
            }
        }
        *SEC.scans.lock().unwrap() = m;
    }
    let (nb, nf, ns) = (SEC.blocked.read().unwrap().len(), SEC.fails.lock().unwrap().len(), SEC.scans.lock().unwrap().len());
    *SEC.db.lock().unwrap() = Some(db);
    info!("security: {} blocked ip(s), login-fail tracking {} ip(s), scanning {} ip(s)", nb, nf, ns);
}

fn add_scan(a: &mut ScanAgg, ts_ms: u64, method: &str, path: &str, category: &str, s: &Settings) {
    if a.first_ms == 0 {
        a.first_ms = ts_ms;
    }
    a.last_ms = a.last_ms.max(ts_ms);
    a.count += 1;
    let g = a.groups.entry(category.to_string()).or_default();
    g.count += 1;
    g.last_ms = g.last_ms.max(ts_ms);
    let sample = format!("{method} {path}");
    if !g.samples.iter().any(|x| *x == sample) {
        if g.samples.len() >= 5 {
            g.samples.remove(0);
        }
        g.samples.push(sample);
    }
    if RATE.contains(&category) {
        a.recent.push_back(ts_ms);
        let cut = ts_ms.saturating_sub(s.scan_unknown_window_min as u64 * 60_000);
        while a.recent.front().is_some_and(|t| *t < cut) {
            a.recent.pop_front();
        }
    }
}

// ───────────────────────────── 판단 ─────────────────────────────

/// IPv4 CIDR("a.b.c.d/n") 또는 정확한 IP 와 일치하는가
fn ip_matches(rule: &str, ip: IpAddr) -> bool {
    let rule = rule.trim();
    if let Some((net, bits)) = rule.split_once('/') {
        if let (Ok(IpAddr::V4(n)), Ok(bits), IpAddr::V4(a)) = (net.parse::<IpAddr>(), bits.parse::<u32>(), ip) {
            if bits == 0 {
                return true;
            }
            if bits > 32 {
                return false;
            }
            let mask = u32::MAX << (32 - bits);
            return (u32::from(n) & mask) == (u32::from(a) & mask);
        }
        return false;
    }
    rule.parse::<IpAddr>().map(|r| r == ip).unwrap_or(false)
}

pub fn is_trusted(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    SEC.settings.read().unwrap().trusted.iter().any(|r| ip_matches(r, ip))
}

/// 차단 중이면 그 기록 (만료된 것은 여기서 지운다)
pub fn is_blocked(ip: IpAddr) -> Option<Block> {
    let b = SEC.blocked.read().unwrap().get(&ip).cloned()?;
    if b.until_ms != 0 && b.until_ms <= now_ms() {
        SEC.blocked.write().unwrap().remove(&ip);
        if let Some(db) = SEC.db.lock().unwrap().as_ref() {
            let _ = db.execute("DELETE FROM sec_blocks WHERE ip = ?1", params![ip.to_string()]);
        }
        return None;
    }
    Some(b)
}

/// 요청 분류. None = 정상 트래픽. `authed` = 세션 쿠키/토큰이 있는 요청(콘솔 사용자의 API 404 는 세지 않음).
pub fn classify(method: &str, path: &str, query: &str, status: u16, authed: bool) -> Option<&'static str> {
    if !matches!(method, "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS") {
        return Some("프로토콜 이상");
    }
    let p = path.to_ascii_lowercase();
    let all = format!("{p}?{}", query.to_ascii_lowercase());
    // 공격 서명은 경로가 무엇이든 본다 (예: /api/..?id=1' or 1=1)
    if ["../", "..%2f", "..%5c", "%2e%2e", "/etc/passwd", "boot.ini", "win.ini", "/proc/self"].iter().any(|s| all.contains(s)) {
        return Some("경로 조작");
    }
    if (all.contains("union") && all.contains("select"))
        || ["' or ", "%27%20or", "%27or", "<script", "%3cscript", "${", "%24%7b", "{{", "sleep(", "benchmark(", "waitfor delay", "; wget", ";wget", "; curl", "|curl", "$(", "onerror=", "/bin/sh", "cmd.exe", "powershell"]
            .iter()
            .any(|s| all.contains(s))
    {
        return Some("인젝션");
    }
    let legit = p == "/"
        || p == "/index.html"
        || p.starts_with("/assets/")
        || matches!(p.as_str(), "/favicon.ico" | "/favicon.svg" | "/manifest.webmanifest" | "/robots.txt" | "/apple-touch-icon.png" | "/apple-touch-icon-precomposed.png")
        || p == "/ws"
        || p.starts_with("/fhir");
    if legit {
        return None;
    }
    if p.starts_with("/api/") {
        // 있는 API 는 정상. 없는 API(404) 를 로그인 없이 두드리면 탐색
        return if status == 404 && !authed { Some("API 탐색") } else { None };
    }
    const PROBES: [&str; 44] = [
        ".env", ".git", ".svn", ".hg", ".aws", ".ssh", ".htaccess", ".htpasswd", "wp-", "wordpress", "xmlrpc", "phpmyadmin", "pma/", ".php", "cgi-bin", "/admin", "/manager/html",
        "/actuator", "/console", "/jenkins", "/solr", "/struts", "/boaform", "/hnap1", "/shell", "/cmd", "/eval", "/vendor/", "/config", "/backup", ".sql", ".bak", "/owa", "/autodiscover",
        "/telescope", "/_ignition", "/druid", "/geoserver", "/webui", "/login.action", "/v1/pods", "/.well-known/", "/server-status", "/debug",
    ];
    if PROBES.iter().any(|s| p.contains(s)) {
        return Some("웹 취약점 탐색");
    }
    Some("미상 경로")
}

// ───────────────────────────── 기록·차단 ─────────────────────────────

impl Security {
    fn persist_block(&self, b: &Block) {
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute(
                "INSERT INTO sec_blocks (ip, kind, reason, detail, created_ms, until_ms, by) VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(ip) DO UPDATE SET kind=excluded.kind, reason=excluded.reason, detail=excluded.detail, created_ms=excluded.created_ms, until_ms=excluded.until_ms, by=excluded.by",
                params![b.ip, b.kind, b.reason, b.detail, b.created_ms as i64, b.until_ms as i64, b.by],
            );
        }
    }

    /// 차단. 신뢰 IP·루프백은 거부. hours 0 = 수동 해제까지. 이미 차단 중이면 더 긴 쪽으로 갱신.
    pub fn block(&self, ip: IpAddr, kind: &str, reason: &str, detail: &str, hours: u32, by: &str) -> Result<Block, String> {
        if is_trusted(ip) {
            return Err(format!("{ip} 은(는) 신뢰 IP 라 차단하지 않습니다"));
        }
        let now = now_ms();
        let until = if hours == 0 { 0 } else { now + hours as u64 * 3_600_000 };
        let b = Block { ip: ip.to_string(), kind: kind.into(), reason: reason.into(), detail: detail.chars().take(300).collect(), created_ms: now, until_ms: until, by: by.into() };
        {
            let mut m = self.blocked.write().unwrap();
            if let Some(old) = m.get(&ip) {
                // 이미 차단 중: 기간이 더 길어질 때만 덮어쓴다 (영구 > 기한)
                let longer = until == 0 || (old.until_ms != 0 && until > old.until_ms);
                if !longer {
                    return Ok(old.clone());
                }
            }
            m.insert(ip, b.clone());
        }
        self.persist_block(&b);
        warn!("security: blocked {} ({}: {}) until {}", ip, kind, reason, if until == 0 { "manual".into() } else { until.to_string() });
        Ok(b)
    }

    pub fn unblock(&self, ip: IpAddr) -> bool {
        let had = self.blocked.write().unwrap().remove(&ip).is_some();
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute("DELETE FROM sec_blocks WHERE ip = ?1", params![ip.to_string()]);
        }
        had
    }

    /// 로그인 실패 1건 (PIN·비밀번호·계정 모두 같은 1건). (누적 횟수, 이번에 생긴 차단)
    pub fn login_failed(&self, ip: IpAddr, tenant: &str, username: &str, kind: &str) -> (u32, Option<Block>) {
        let s = self.settings.read().unwrap().clone();
        let now = now_ms();
        let cut = now.saturating_sub(s.login_window_days as u64 * 86_400_000);
        let count = {
            let mut m = self.fails.lock().unwrap();
            let v = m.entry(ip).or_default();
            v.retain(|f| f.ts_ms >= cut);
            v.push(Fail { ts_ms: now, tenant: tenant.into(), username: username.chars().take(64).collect(), kind: kind.into() });
            v.len() as u32
        };
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute("INSERT INTO sec_login_fail (ip, ts_ms, tenant, username, kind) VALUES (?1,?2,?3,?4,?5)", params![ip.to_string(), now as i64, tenant, username, kind]);
            let _ = db.execute("DELETE FROM sec_login_fail WHERE ts_ms < ?1", params![cut as i64]);
        }
        let block = if s.auto_block_login && count >= s.login_fail_limit && !is_trusted(ip) && is_blocked(ip).is_none() {
            self.block(ip, "login", &format!("로그인 실패 {}회 / {}일", count, s.login_window_days), &format!("마지막 시도 {tenant}/{username} ({kind})"), s.login_block_hours, "자동")
                .ok()
        } else {
            None
        };
        (count, block)
    }

    /// 로그인 성공: 그 IP 의 실패 목록을 모두 지운다
    pub fn login_ok(&self, ip: IpAddr) {
        self.fails.lock().unwrap().remove(&ip);
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute("DELETE FROM sec_login_fail WHERE ip = ?1", params![ip.to_string()]);
        }
    }

    /// 스캐닝 1건 기록. 공격 분류는 즉시, 한도형은 창 안 횟수가 한도를 넘으면 차단. 돌려주는 값 = 이번에 생긴 차단.
    pub fn scan_event(&self, ip: IpAddr, method: &str, path: &str, status: u16, category: &str) -> Option<Block> {
        if ip.is_loopback() {
            return None; // 라우터 자신의 스크립트
        }
        let s = self.settings.read().unwrap().clone();
        let now = now_ms();
        let (rate_hits, total) = {
            let mut m = self.scans.lock().unwrap();
            let a = m.entry(ip).or_default();
            add_scan(a, now, method, path, category, &s);
            (a.recent.len() as u32, a.count)
        };
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute(
                "INSERT INTO sec_scan (ip, ts_ms, method, path, status, category) VALUES (?1,?2,?3,?4,?5,?6)",
                params![ip.to_string(), now as i64, method, path.chars().take(300).collect::<String>(), status as i64, category],
            );
            if total % 100 == 1 {
                let _ = db.execute("DELETE FROM sec_scan WHERE ts_ms < ?1", params![now.saturating_sub(SCAN_KEEP_DAYS * 86_400_000) as i64]);
            }
        }
        if !s.auto_block_scan || is_trusted(ip) || is_blocked(ip).is_some() {
            return None;
        }
        if ATTACK.contains(&category) {
            return self.block(ip, "scan", &format!("무단 스캐닝 — {category}"), &format!("{method} {path}"), s.scan_block_hours, "자동").ok();
        }
        if RATE.contains(&category) && rate_hits >= s.scan_unknown_limit {
            return self
                .block(ip, "scan", &format!("무단 스캐닝 — {category} {}회 / {}분", rate_hits, s.scan_unknown_window_min), &format!("{method} {path}"), s.scan_block_hours, "자동")
                .ok();
        }
        None
    }

    /// 목록 지우기: what = scan | login | all, ip = None 이면 전부
    pub fn clear(&self, ip: Option<IpAddr>, what: &str) {
        let db = self.db.lock().unwrap();
        if what == "scan" || what == "all" {
            match ip {
                Some(ip) => {
                    self.scans.lock().unwrap().remove(&ip);
                    if let Some(db) = db.as_ref() {
                        let _ = db.execute("DELETE FROM sec_scan WHERE ip = ?1", params![ip.to_string()]);
                    }
                }
                None => {
                    self.scans.lock().unwrap().clear();
                    if let Some(db) = db.as_ref() {
                        let _ = db.execute("DELETE FROM sec_scan", []);
                    }
                }
            }
        }
        if what == "login" || what == "all" {
            match ip {
                Some(ip) => {
                    self.fails.lock().unwrap().remove(&ip);
                    if let Some(db) = db.as_ref() {
                        let _ = db.execute("DELETE FROM sec_login_fail WHERE ip = ?1", params![ip.to_string()]);
                    }
                }
                None => {
                    self.fails.lock().unwrap().clear();
                    if let Some(db) = db.as_ref() {
                        let _ = db.execute("DELETE FROM sec_login_fail", []);
                    }
                }
            }
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    pub fn set_settings(&self, mut s: Settings) -> Result<(), String> {
        s.login_fail_limit = s.login_fail_limit.clamp(3, 1000);
        s.login_window_days = s.login_window_days.clamp(1, 365);
        s.login_block_hours = s.login_block_hours.min(24 * 365);
        s.scan_block_hours = s.scan_block_hours.min(24 * 365);
        s.scan_unknown_limit = s.scan_unknown_limit.clamp(3, 100_000);
        s.scan_unknown_window_min = s.scan_unknown_window_min.clamp(1, 24 * 60);
        let mut trusted = Vec::new();
        for t in &s.trusted {
            let t = t.trim();
            if t.is_empty() {
                continue;
            }
            let ok = match t.split_once('/') {
                Some((n, b)) => n.parse::<std::net::Ipv4Addr>().is_ok() && b.parse::<u32>().map(|b| b <= 32).unwrap_or(false),
                None => t.parse::<IpAddr>().is_ok(),
            };
            if !ok {
                return Err(format!("신뢰 IP 형식이 아닙니다: {t} (예: 192.168.0.10 또는 10.0.0.0/8)"));
            }
            trusted.push(t.to_string());
        }
        s.trusted = trusted;
        // 새로 신뢰한 IP 가 차단 중이면 푼다
        let now_trusted: Vec<IpAddr> = self.blocked.read().unwrap().keys().copied().filter(|ip| s.trusted.iter().any(|r| ip_matches(r, *ip))).collect();
        for ip in now_trusted {
            self.unblock(ip);
        }
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute(
                "INSERT INTO settings (key, value) VALUES ('security', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![serde_json::to_string(&s).unwrap_or_default()],
            );
        }
        *self.settings.write().unwrap() = s;
        Ok(())
    }

    /// 화면용 전체 보기
    pub fn view(&self) -> serde_json::Value {
        let now = now_ms();
        let s = self.settings.read().unwrap().clone();
        let mut blocked: Vec<Block> = self.blocked.read().unwrap().values().filter(|b| b.until_ms == 0 || b.until_ms > now).cloned().collect();
        blocked.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
        let blocked_ips: std::collections::HashSet<String> = blocked.iter().map(|b| b.ip.clone()).collect();
        let cut = now.saturating_sub(s.login_window_days as u64 * 86_400_000);
        let mut fails: Vec<serde_json::Value> = self
            .fails
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(ip, v)| {
                let v: Vec<&Fail> = v.iter().filter(|f| f.ts_ms >= cut).collect();
                if v.is_empty() {
                    return None;
                }
                let mut accounts: BTreeMap<String, u64> = BTreeMap::new();
                let mut kinds: BTreeMap<String, u64> = BTreeMap::new();
                for f in &v {
                    *accounts.entry(if f.tenant.is_empty() { f.username.clone() } else { format!("{}/{}", f.tenant, f.username) }).or_default() += 1;
                    *kinds.entry(f.kind.clone()).or_default() += 1;
                }
                Some(serde_json::json!({
                    "ip": ip.to_string(), "count": v.len(), "limit": s.login_fail_limit,
                    "first_ms": v.first().map(|f| f.ts_ms), "last_ms": v.last().map(|f| f.ts_ms),
                    "accounts": accounts.iter().map(|(k, n)| serde_json::json!({ "account": k, "count": n })).collect::<Vec<_>>(),
                    "kinds": kinds, "blocked": blocked_ips.contains(&ip.to_string()), "trusted": is_trusted(*ip),
                }))
            })
            .collect();
        fails.sort_by(|a, b| b["last_ms"].as_u64().cmp(&a["last_ms"].as_u64()));
        let mut scans: Vec<serde_json::Value> = self
            .scans
            .lock()
            .unwrap()
            .iter()
            .map(|(ip, a)| {
                let mut groups: Vec<serde_json::Value> = a
                    .groups
                    .iter()
                    .map(|(c, g)| serde_json::json!({ "category": c, "attack": ATTACK.contains(&c.as_str()), "count": g.count, "last_ms": g.last_ms, "samples": g.samples }))
                    .collect();
                groups.sort_by(|x, y| y["count"].as_u64().cmp(&x["count"].as_u64()));
                serde_json::json!({
                    "ip": ip.to_string(), "count": a.count, "first_ms": a.first_ms, "last_ms": a.last_ms,
                    "attack": a.groups.keys().any(|c| ATTACK.contains(&c.as_str())),
                    "recent": a.recent.len(), "groups": groups,
                    "blocked": blocked_ips.contains(&ip.to_string()), "trusted": is_trusted(*ip),
                })
            })
            .collect();
        scans.sort_by(|a, b| b["last_ms"].as_u64().cmp(&a["last_ms"].as_u64()));
        serde_json::json!({
            "settings": s, "blocked": blocked, "login_fails": fails, "scans": scans,
            "categories": { "attack": ATTACK, "rate": RATE }, "now_ms": now,
        })
    }
}

/// 미들웨어: 차단 IP 는 403, 그 밖에는 응답 뒤 요청을 분류해 스캐닝으로 기록
pub async fn guard(State(state): State<Arc<AppState>>, ConnectInfo(addr): ConnectInfo<SocketAddr>, req: Request, next: Next) -> Response {
    let ip = addr.ip();
    if is_blocked(ip).is_some() {
        return (StatusCode::FORBIDDEN, "blocked").into_response();
    }
    let method = req.method().as_str().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let authed = req.headers().get(axum::http::header::AUTHORIZATION).is_some()
        || req.headers().get(axum::http::header::COOKIE).and_then(|c| c.to_str().ok()).map(|c| c.contains("bm_session=")).unwrap_or(false);
    let resp = next.run(req).await;
    if let Some(cat) = classify(&method, &path, &query, resp.status().as_u16(), authed) {
        if let Some(b) = SEC.scan_event(ip, &method, &path, resp.status().as_u16(), cat) {
            state.auth.audit("system", "", "security_block", &format!("{} — {} ({})", b.ip, b.reason, b.detail));
            state.push_event("security", None, format!("IP 차단: {} — {}", b.ip, b.reason));
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_paths() {
        assert_eq!(classify("GET", "/", "", 200, false), None);
        assert_eq!(classify("GET", "/assets/index-abc.js", "", 200, false), None);
        assert_eq!(classify("GET", "/api/stats", "", 200, true), None);
        assert_eq!(classify("GET", "/api/nothing", "", 404, true), None, "console user 404 is not scanning");
        assert_eq!(classify("GET", "/api/nothing", "", 404, false), Some("API 탐색"));
        assert_eq!(classify("GET", "/.env", "", 200, false), Some("웹 취약점 탐색"));
        assert_eq!(classify("GET", "/wp-login.php", "", 200, false), Some("웹 취약점 탐색"));
        assert_eq!(classify("GET", "/static/../../etc/passwd", "", 200, false), Some("경로 조작"));
        assert_eq!(classify("GET", "/api/patients", "id=1' or 1=1", 200, true), Some("인젝션"));
        assert_eq!(classify("GET", "/something/else", "", 200, false), Some("미상 경로"));
        assert_eq!(classify("PROPFIND", "/", "", 405, false), Some("프로토콜 이상"));
    }

    #[test]
    fn cidr_and_trust() {
        let ip: IpAddr = "192.168.0.77".parse().unwrap();
        assert!(ip_matches("192.168.0.0/24", ip));
        assert!(!ip_matches("192.168.1.0/24", ip));
        assert!(ip_matches("192.168.0.77", ip));
        assert!(!ip_matches("bogus", ip));
        assert!(is_trusted("127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn login_failures_block_after_limit_and_clear_on_success() {
        let ip: IpAddr = "10.9.8.7".parse().unwrap();
        SEC.clear(Some(ip), "all");
        SEC.unblock(ip);
        let limit = SEC.settings().login_fail_limit;
        let mut blocked = None;
        for i in 0..limit {
            let (n, b) = SEC.login_failed(ip, "H001", "x", if i % 2 == 0 { "pin" } else { "credential" });
            assert_eq!(n, i + 1);
            blocked = b;
        }
        assert!(blocked.is_some(), "blocked at the limit");
        assert!(is_blocked(ip).is_some());
        SEC.unblock(ip);
        SEC.login_ok(ip);
        assert_eq!(SEC.login_failed(ip, "H001", "x", "pin").0, 1, "success cleared the list");
        SEC.clear(Some(ip), "all");
    }

    #[test]
    fn attack_scan_blocks_immediately_unknown_needs_rate() {
        let ip: IpAddr = "10.9.8.8".parse().unwrap();
        SEC.clear(Some(ip), "all");
        SEC.unblock(ip);
        assert!(SEC.scan_event(ip, "GET", "/nope-1", 200, "미상 경로").is_none());
        assert!(SEC.scan_event(ip, "GET", "/.env", 200, "웹 취약점 탐색").is_some());
        assert!(is_blocked(ip).is_some());
        SEC.unblock(ip);
        SEC.clear(Some(ip), "all");
        let limit = SEC.settings().scan_unknown_limit;
        let mut b = None;
        for i in 0..limit {
            b = SEC.scan_event(ip, "GET", &format!("/x{i}"), 200, "미상 경로");
        }
        assert!(b.is_some(), "rate limit reached");
        SEC.unblock(ip);
        SEC.clear(Some(ip), "all");
    }
}
