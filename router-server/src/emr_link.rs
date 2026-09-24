//! 상용 EMR 연동 — 라우터가 받은 생체 수치(HR·RR·SpO₂·체온)를 병원 EMR 에 간호 바이탈로 써 넣는다.
//!
//! 연결 하나 = (이 라우터의 병원, 외부 EMR 한 곳). 연결마다 작업 하나가 돈다:
//!   1. 인증 — 기관 방식대로 토큰 발급·갱신 (SMART JWT, client_credentials, Basic, API 키, 고정 토큰 …)
//!   2. 재원 명단 — FHIR `Group/inpatient-census` 또는 `Encounter?status=in-progress&_include=Encounter:patient`,
//!      HL7 v2 는 `hl7/census`(ADT^A01 묶음)
//!   3. 환자 매칭 — `mrn`: 우리 MRN = 그 기관 등록번호, `pair`: 시험용(병동 순서대로 짝지음 — 가상 EMR 의 환자는
//!      우리 환자와 다른 사람들이라 번호가 맞을 수 없다)
//!   4. 전송 — FHIR transaction Bundle(Observation × 항목), HL7 v2 ORU^R01 over MLLP(기관 문자셋·버전·시간대)
//!   5. 응답 해석 — 201/200 · ACK AA 성공, 401 은 토큰 재발급 후 한 번 더, 5xx·시간 초과·503 은 지수 백오프
//! 병원(테넌트) 경계: 연결은 이 라우터의 병원 소속으로만 만들 수 있고, 그 병원 환자만 보낸다.

use crate::http_client::{self as hc, Resp};
use crate::protocol::now_ms;
use crate::state::AppState;
use chrono::TimeZone;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tracing::{info, warn};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS emr_connections (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, created_ms INTEGER NOT NULL);";

/// 연결 설정 (가상 EMR 카탈로그에서 가져오거나 직접 입력)
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ConnCfg {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub tenant_id: String,
    #[serde(default)]
    pub name: String,
    /// 가상 EMR site_id (예: kr-hanbit)
    #[serde(default)]
    pub site_id: String,
    /// "fhir" | "hl7v2"
    pub protocol: String,
    /// epic, oracle, uk-core, kr-core, nl-zib(STU3) … / meditech, ss-mix2, pam-fr …
    #[serde(default)]
    pub flavor: String,
    /// FHIR 4.0.1 / 3.0.2, HL7 2.3 … 2.5.1
    #[serde(default)]
    pub version: String,
    /// IANA 시간대 (기관 현지 시각으로 보낸다)
    #[serde(default)]
    pub tz: String,
    #[serde(default)]
    pub fhir_base: String,
    /// 기관 루트 URL (FHIR 외 형식의 경로 기준)
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub token_url: String,
    #[serde(default)]
    pub census_url: String,
    /// 인증 방식·자격 증명 (카탈로그 `auth` 그대로)
    #[serde(default)]
    pub auth: Value,
    #[serde(default)]
    pub mllp_host: String,
    #[serde(default)]
    pub mllp_port: u16,
    #[serde(default)]
    pub facility: String,
    #[serde(default)]
    pub receiving_app: String,
    #[serde(default)]
    pub charset: String,
    /// "pair" | "mrn"
    #[serde(default = "pair")]
    pub match_mode: String,
    /// 보낼 우리 환자 범위: 병동 id (예 W103A) — 비우면 전체
    #[serde(default)]
    pub scope_ward: String,
    /// 전송 주기(초) — 간호 기록 간격에 맞춰 기본 300
    #[serde(default = "five_min")]
    pub interval_s: u64,
    /// 한 번에 보낼 최대 환자 수 (시험 기관 병상이 24~60)
    #[serde(default = "max_pat")]
    pub max_patients: usize,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_ms: u64,
}
fn pair() -> String {
    "pair".into()
}
fn five_min() -> u64 {
    300
}
fn max_pat() -> usize {
    60
}

/// 외부 EMR 의 재원 환자 한 명
#[derive(Clone, Debug, Serialize)]
pub struct Remote {
    pub id: String,
    pub ident: String,
    pub name: String,
    pub location: String,
    pub encounter: Option<String>,
    #[serde(skip)]
    pub pid_seg: Option<String>,
    #[serde(skip)]
    pub pv1_seg: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Link {
    pub channel_id: String,
    pub local_name: String,
    pub local_mrn: String,
    pub local_room: String,
    pub remote: Remote,
    /// 어떻게 짝지었는지: "pair"(시험용 순서) · "emr"(에뮬레이터 연동 조인 키) · "mrn"(MRN 값 일치)
    #[serde(default)]
    pub matched_by: String,
    pub last_sent_ms: u64,
    pub last_result: String,
    pub ok: u64,
    pub fail: u64,
}

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    pub ts_ms: u64,
    pub kind: String,
    pub ok: bool,
    pub status: String,
    pub summary: String,
}

#[derive(Default, Serialize)]
pub struct ConnState {
    #[serde(skip)]
    pub token: Option<(String, u64)>,
    pub token_exp_ms: u64,
    pub census: usize,
    pub census_ms: u64,
    pub links: Vec<Link>,
    pub sent_ok: u64,
    pub sent_fail: u64,
    pub last_send_ms: u64,
    pub last_error: String,
    pub backoff_until_ms: u64,
    pub backoff_s: u64,
    pub running: bool,
    pub log: VecDeque<LogEntry>,
    /// 현재 재원 명단 (전체 명단 + 입퇴원 변경분으로 갱신)
    #[serde(skip)]
    pub remotes: Vec<Remote>,
    /// 입퇴원 피드 위치 (HL7 seq · 국내 EVT_SEQ · FHIR _lastUpdated 시각 …); None = 아직 맞추지 않음
    #[serde(skip)]
    pub adt_cursor: Option<String>,
    pub adt_ms: u64,
    pub adt_count: u64,
    pub adt: VecDeque<AdtEvent>,
}

/// 입퇴원 변경 한 건 (화면 표시용)
#[derive(Clone, Debug, Serialize)]
pub struct AdtEvent {
    pub ts_ms: u64,
    /// A01 입원 · A02 전동 · A03 퇴원 · A08 정보 변경 · A11 입원 취소
    pub code: String,
    pub remote_id: String,
    pub name: String,
    pub location: String,
    /// 이 변경이 짝에 준 영향 (예: "짝 해제 · 97382", "새 짝 · 97400")
    pub effect: String,
}

/// 입퇴원 피드에서 읽은 변경
enum Change {
    /// 입원·정보 변경·전동 — 명단에 넣거나 고친다
    Upsert(String, Remote),
    /// 퇴원·입원 취소 — 명단에서 뺀다
    Remove(String, String, String),
}

pub struct EmrLink {
    db: Mutex<Connection>,
    pub state: Mutex<HashMap<String, ConnState>>,
    stops: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// 즉시 실행 요청 (연결 id → "census" | "send")
    kicks: Mutex<HashMap<String, Vec<&'static str>>>,
}

impl EmrLink {
    pub fn open(db_path: &str) -> Self {
        let db = Connection::open(db_path).unwrap_or_else(|_| Connection::open_in_memory().expect("sqlite"));
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("emr schema: {}", e);
        }
        Self { db: Mutex::new(db), state: Mutex::new(HashMap::new()), stops: Mutex::new(HashMap::new()), kicks: Mutex::new(HashMap::new()) }
    }

    pub fn list(&self) -> Vec<ConnCfg> {
        let db = self.db.lock().unwrap();
        let mut v = Vec::new();
        if let Ok(mut st) = db.prepare("SELECT config, enabled, created_ms FROM emr_connections ORDER BY created_ms") {
            if let Ok(rows) = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))) {
                for (c, en, cr) in rows.flatten() {
                    if let Ok(mut cfg) = serde_json::from_str::<ConnCfg>(&c) {
                        cfg.enabled = en != 0;
                        cfg.created_ms = cr as u64;
                        v.push(cfg);
                    }
                }
            }
        }
        v
    }

    pub fn get(&self, id: &str) -> Option<ConnCfg> {
        self.list().into_iter().find(|c| c.id == id)
    }

    pub fn save(&self, cfg: &ConnCfg) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute(
            "INSERT INTO emr_connections (id, tenant_id, config, enabled, created_ms) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET config = excluded.config, enabled = excluded.enabled",
            params![cfg.id, cfg.tenant_id, serde_json::to_string(cfg).unwrap_or_default(), cfg.enabled as i64, cfg.created_ms as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete(&self, id: &str) {
        if let Ok(db) = self.db.lock() {
            let _ = db.execute("DELETE FROM emr_connections WHERE id = ?1", params![id]);
        }
        if let Some(s) = self.stops.lock().unwrap().remove(id) {
            s.store(true, Ordering::Relaxed);
        }
        self.state.lock().unwrap().remove(id);
    }

    pub fn kick(&self, id: &str, what: &'static str) {
        self.kicks.lock().unwrap().entry(id.to_string()).or_default().push(what);
    }

    fn log(&self, id: &str, kind: &str, ok: bool, status: impl Into<String>, summary: impl Into<String>) {
        let mut st = self.state.lock().unwrap();
        let s = st.entry(id.to_string()).or_default();
        let e = LogEntry { ts_ms: now_ms(), kind: kind.into(), ok, status: status.into(), summary: summary.into() };
        if !ok {
            s.last_error = format!("{} · {}", e.status, e.summary);
        }
        s.log.push_front(e);
        s.log.truncate(80);
    }
}

// ───────────────────────────── 감독 ─────────────────────────────

/// 5초마다 설정을 읽어 켜진 연결의 작업을 띄우고, 꺼지거나 지워진 연결의 작업을 멈춘다.
pub async fn supervise(state: Arc<AppState>) {
    let mut t = tokio::time::interval(Duration::from_secs(5));
    loop {
        t.tick().await;
        let site = state.auth.site_tenant();
        let cfgs = state.emr.list();
        let mut stops = state.emr.stops.lock().unwrap();
        for c in &cfgs {
            // 병원 경계: 이 라우터의 병원 연결만 돈다
            let want = c.enabled && c.tenant_id == site;
            match (want, stops.contains_key(&c.id)) {
                (true, false) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    stops.insert(c.id.clone(), stop.clone());
                    let st = state.clone();
                    let id = c.id.clone();
                    tokio::spawn(async move { run_conn(st, id, stop).await });
                }
                (false, true) => {
                    if let Some(s) = stops.remove(&c.id) {
                        s.store(true, Ordering::Relaxed);
                    }
                }
                _ => {}
            }
        }
        let ids: Vec<String> = stops.keys().cloned().collect();
        for id in ids {
            if !cfgs.iter().any(|c| c.id == id) {
                if let Some(s) = stops.remove(&id) {
                    s.store(true, Ordering::Relaxed);
                }
            }
        }
    }
}

async fn run_conn(state: Arc<AppState>, id: String, stop: Arc<AtomicBool>) {
    info!("emr: connection {} started", id);
    state.emr.state.lock().unwrap().entry(id.clone()).or_default().running = true;
    let mut last_census = 0u64;
    let mut last_send = 0u64;
    let mut last_adt = 0u64;
    while !stop.load(Ordering::Relaxed) {
        let Some(cfg) = state.emr.get(&id) else { break };
        let now = now_ms();
        let kicks = state.emr.kicks.lock().unwrap().remove(&id).unwrap_or_default();
        let backoff = state.emr.state.lock().unwrap().get(&id).map(|s| s.backoff_until_ms).unwrap_or(0);
        if backoff > now && kicks.is_empty() {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        let res: Result<(), String> = async {
            if kicks.contains(&"census") || now.saturating_sub(last_census) > 300_000 {
                census(&state, &cfg).await?;
                last_census = now_ms();
                // 매칭 0명(라우터 막 시작해 환자 명단이 아직 비었을 때 등)이면 5분이 아니라 30초 뒤 다시
                if state.emr.state.lock().unwrap().get(&id).map(|s| s.links.is_empty()).unwrap_or(true) {
                    last_census = last_census.saturating_sub(270_000);
                    last_send = 0;
                }
            }
            // 운영: 입퇴원 피드를 조금 되감아 최근 변경을 다시 적용 (장애 뒤 재동기화·시험) — 같은 변경을 다시 적용해도 결과는 같다
            if kicks.contains(&"adt_rewind") {
                let mut st = state.emr.state.lock().unwrap();
                if let Some(s) = st.get_mut(&id) {
                    s.adt_cursor = match s.adt_cursor.as_deref().map(|c| c.parse::<u64>()) {
                        Some(Ok(n)) => Some(n.saturating_sub(10).to_string()),
                        _ if cfg.protocol == "fhir" => Some((chrono::Utc::now() - chrono::Duration::hours(6)).format("%Y-%m-%dT%H:%M:%SZ").to_string()),
                        _ => s.adt_cursor.clone(),
                    };
                }
                drop(st);
                last_adt = 0;
            }
            // 입퇴원 변경분: 15초마다 (피드가 없는 Epic·Oracle·CDA 는 명단 다시 받기라 60초)
            let slow = matches!(cfg.protocol.as_str(), "cda") || (cfg.protocol == "fhir" && matches!(cfg.flavor.as_str(), "epic" | "oracle"));
            let census_done = state.emr.state.lock().unwrap().get(&id).map(|s| s.census_ms > 0).unwrap_or(false);
            if census_done && (last_adt == 0 || now.saturating_sub(last_adt) >= if slow { 60_000 } else { 15_000 }) {
                last_adt = now_ms();
                adt_poll(&state, &cfg).await?;
            }
            // 매칭된 환자가 생길 때까지는 '보냈음'으로 치지 않는다 — 명단이 차면 바로 첫 전송
            let has_links = state.emr.state.lock().unwrap().get(&id).map(|s| !s.links.is_empty()).unwrap_or(false);
            if has_links && (kicks.contains(&"send") || now.saturating_sub(last_send) >= cfg.interval_s.max(15) * 1000) {
                let (ok0, fail0) = state.emr.state.lock().unwrap().get(&id).map(|s| (s.sent_ok, s.sent_fail)).unwrap_or((0, 0));
                let tried = send_all(&state, &cfg).await?;
                last_send = now_ms();
                // 한 회차가 전부 실패(예: 기관의 환자 명단이 통째로 바뀜 → 모르는 환자 422)면 명단부터 다시
                let (ok1, fail1) = state.emr.state.lock().unwrap().get(&id).map(|s| (s.sent_ok, s.sent_fail)).unwrap_or((0, 0));
                if tried > 0 && ok1 == ok0 && fail1 > fail0 {
                    last_census = 0;
                }
                // 새 수치가 있는 환자가 없었으면(라우터 막 시작 등) 주기를 기다리지 않고 15초 뒤 다시
                if tried == 0 {
                    last_send = last_send.saturating_sub(cfg.interval_s.max(15) * 1000 - 15_000);
                }
            }
            Ok(())
        }
        .await;
        {
            let mut st = state.emr.state.lock().unwrap();
            let s = st.entry(id.clone()).or_default();
            match &res {
                Ok(_) => {
                    s.backoff_s = 0;
                    s.backoff_until_ms = 0;
                    s.last_error.clear(); // 복구됐으면 지난 오류는 기록 탭에만
                }
                Err(e) => {
                    // 지수 백오프 4 s → 5 분, 풀리면 재원 명단·전송을 바로 다시 시도
                    s.backoff_s = (s.backoff_s.max(2) * 2).min(300);
                    s.backoff_until_ms = now_ms() + s.backoff_s * 1000;
                    s.last_error = e.clone();
                }
            }
        }
        if let Err(e) = &res {
            // 실패한 단계는 시각이 갱신되지 않았으므로 백오프가 풀리면 그 단계만 다시 한다
            // (전송 시각까지 되돌리면 입퇴원 조회 오류 때마다 바이탈이 다시 나갔다)
            let b = state.emr.state.lock().unwrap().get(&id).map(|s| s.backoff_s).unwrap_or(0);
            state.emr.log(&id, "error", false, "재시도 대기", format!("{e} — {b} s 뒤 다시"));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    state.emr.state.lock().unwrap().entry(id.clone()).or_default().running = false;
    info!("emr: connection {} stopped", id);
}

// ───────────────────────────── 인증 ─────────────────────────────

fn auth_s<'a>(cfg: &'a ConnCfg, k: &str) -> &'a str {
    cfg.auth.get(k).and_then(|v| v.as_str()).unwrap_or("")
}

fn jwt(cfg: &ConnCfg, alg: &str) -> String {
    let cid = auth_s(cfg, "client_id");
    let mut h = json!({"alg": alg, "typ": "JWT"});
    if !auth_s(cfg, "kid").is_empty() {
        h["kid"] = json!(auth_s(cfg, "kid"));
    }
    let now = now_ms() / 1000;
    let p = json!({"iss": cid, "sub": cid, "aud": cfg.token_url, "jti": crate::auth::random_hex(16), "exp": now + 240, "iat": now});
    // 시험 기관은 서명을 검증하지 않는다 — 실제 기관은 등록한 개인키로 서명해야 한다(후속: 키 관리)
    format!("{}.{}.{}", hc::b64(h.to_string().as_bytes(), true), hc::b64(p.to_string().as_bytes(), true), hc::b64(&[0u8; 64], true))
}

async fn token(state: &AppState, cfg: &ConnCfg, force: bool) -> Result<Option<String>, String> {
    let kind = auth_s(cfg, "type").to_string();
    if !matches!(kind.as_str(), "smart-backend-jwt" | "signed-jwt" | "client-credentials-basic" | "client-credentials-post" | "rnds-token") {
        return Ok(None);
    }
    if !force {
        if let Some((t, exp)) = state.emr.state.lock().unwrap().get(&cfg.id).and_then(|s| s.token.clone()) {
            if exp > now_ms() + 60_000 {
                return Ok(Some(t));
            }
        }
    }
    let url = cfg.token_url.clone();
    let scope = auth_s(cfg, "scope").to_string();
    let form_ct = ("Content-Type", "application/x-www-form-urlencoded".to_string());
    let r: Resp = match kind.as_str() {
        "smart-backend-jwt" | "signed-jwt" => {
            let a = jwt(cfg, if kind == "signed-jwt" { "RS512" } else { "RS384" });
            let mut f = vec![("grant_type", "client_credentials"), ("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"), ("client_assertion", a.as_str())];
            if !scope.is_empty() {
                f.push(("scope", scope.as_str()));
            }
            hc::request("POST", &url, &[form_ct], Some(hc::form(&f).as_bytes()), Duration::from_secs(15)).await
        }
        "client-credentials-basic" => {
            let mut f = vec![("grant_type", "client_credentials")];
            if !scope.is_empty() {
                f.push(("scope", scope.as_str()));
            }
            hc::request("POST", &url, &[form_ct, ("Authorization", hc::basic(auth_s(cfg, "client_id"), auth_s(cfg, "client_secret")))], Some(hc::form(&f).as_bytes()), Duration::from_secs(15)).await
        }
        "client-credentials-post" => {
            let f = vec![("grant_type", "client_credentials"), ("client_id", auth_s(cfg, "client_id")), ("client_secret", auth_s(cfg, "client_secret"))];
            hc::request("POST", &url, &[form_ct], Some(hc::form(&f).as_bytes()), Duration::from_secs(15)).await
        }
        _ => hc::request("GET", &url, &[("X-Client-Cert-CN", auth_s(cfg, "cert_cn").to_string())], None, Duration::from_secs(15)).await,
    }
    .map_err(|e| format!("토큰: {e}"))?;
    let j = r.json().unwrap_or_default();
    let Some(t) = j.get("access_token").and_then(|v| v.as_str()).map(String::from) else {
        let msg = format!("토큰 HTTP {}: {}", r.status, r.text().chars().take(160).collect::<String>());
        state.emr.log(&cfg.id, "token", false, r.status.to_string(), msg.clone());
        return Err(msg);
    };
    let mut ttl = j.get("expires_in").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(3600);
    if ttl > 1_000_000 {
        ttl /= 1000; // 브라질 RNDS 는 ms
    }
    let exp = now_ms() + ttl * 1000;
    {
        let mut st = state.emr.state.lock().unwrap();
        let s = st.entry(cfg.id.clone()).or_default();
        s.token = Some((t.clone(), exp));
        s.token_exp_ms = exp;
    }
    state.emr.log(&cfg.id, "token", true, r.status.to_string(), format!("토큰 발급 ({ttl} s)"));
    Ok(Some(t))
}

/// FHIR 요청 헤더 (기관별 인증·필수 헤더)
fn fhir_headers(cfg: &ConnCfg, tok: &Option<String>) -> Vec<(String, String)> {
    let mut h: Vec<(String, String)> = vec![("Accept".into(), "application/fhir+json".to_string())];
    match auth_s(cfg, "type") {
        "bearer-static" => h.push(("Authorization".into(), format!("Bearer {}", auth_s(cfg, "token")))),
        "basic" => h.push(("Authorization".into(), hc::basic(auth_s(cfg, "username"), auth_s(cfg, "password")))),
        "api-key" => {
            h.push((auth_s(cfg, "header").to_string(), auth_s(cfg, "key").to_string()));
            if !auth_s(cfg, "extra_header").is_empty() {
                h.push((auth_s(cfg, "extra_header").to_string(), auth_s(cfg, "extra_value").to_string()));
            }
        }
        "rnds-token" => {
            if let Some(t) = tok {
                h.push(("X-Authorization-Server".into(), format!("Bearer {t}")));
            }
            let cpf: String = auth_s(cfg, "requester_cpf").chars().filter(|c| c.is_ascii_digit()).collect();
            h.push(("Authorization".into(), cpf));
        }
        _ => {
            if let Some(t) = tok {
                h.push(("Authorization".into(), format!("Bearer {t}")));
            }
        }
    }
    if cfg.flavor == "uk-core" {
        h.push(("X-Request-ID".into(), uuid()));
    }
    h
}

fn uuid() -> String {
    let r = crate::auth::random_hex(16);
    format!("{}-{}-4{}-a{}-{}", &r[0..8], &r[8..12], &r[13..16], &r[17..20], &r[20..32])
}

/// 인증이 붙은 FHIR 요청 — 401 이면 토큰을 다시 받아 한 번 더
async fn fhir_req(state: &AppState, cfg: &ConnCfg, method: &str, url: &str, body: Option<&[u8]>) -> Result<Resp, String> {
    for attempt in 0..2 {
        let tok = token(state, cfg, attempt > 0).await?;
        let mut h = fhir_headers(cfg, &tok);
        if body.is_some() {
            h.push(("Content-Type".into(), "application/fhir+json".to_string()));
        }
        let hs: Vec<(&str, String)> = h.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        let r = hc::request(method, url, &hs, body, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
        if r.status == 401 && attempt == 0 && tok.is_some() {
            if let Some(s) = state.emr.state.lock().unwrap().get_mut(&cfg.id) {
                s.token = None;
            }
            continue;
        }
        if r.status == 503 || r.status >= 500 {
            return Err(format!("HTTP {} {}", r.status, r.text().chars().take(120).collect::<String>()));
        }
        return Ok(r);
    }
    Err("인증 실패".into())
}

// ───────────────────────────── 재원 명단 ─────────────────────────────

async fn census(state: &AppState, cfg: &ConnCfg) -> Result<(), String> {
    let remotes = match cfg.protocol.as_str() {
        "fhir" => fhir_census(state, cfg).await?,
        "hl7v2" => hl7_census(state, cfg).await?,
        "kr-json" => krjson_census(state, cfg).await?,
        "kr-xml" => krxml_census(state, cfg).await?,
        "cda" => cda_census(state, cfg).await?,
        "athena" => athena_census(state, cfg).await?,
        p => return Err(format!("지원하지 않는 형식: {p}")),
    };
    let n = remotes.len();
    let paired = apply_remotes(state, cfg, remotes);
    {
        let mut st = state.emr.state.lock().unwrap();
        let s = st.entry(cfg.id.clone()).or_default();
        s.census = n;
        s.census_ms = now_ms();
    }
    state.emr.log(&cfg.id, "census", true, "OK", format!("재원 {n}명 · 매칭 {paired}명 ({})", if cfg.match_mode == "mrn" { "식별자 일치" } else { "시험용 짝짓기" }));
    Ok(())
}

/// 새 재원 명단을 받아 짝을 다시 맞춘다 — 이미 있던 짝은 그대로 두고(전송 이력 유지), 빠진 환자의 짝만 풀고,
/// 남는 우리 환자와 새 환자를 짝짓는다. 반환: 짝 수
fn apply_remotes(state: &AppState, cfg: &ConnCfg, remotes: Vec<Remote>) -> usize {
    let prev: Vec<Link> = state.emr.state.lock().unwrap().get(&cfg.id).map(|s| s.links.clone()).unwrap_or_default();
    let links = match_patients(state, cfg, &remotes, &prev);
    let n = links.len();
    let mut st = state.emr.state.lock().unwrap();
    let s = st.entry(cfg.id.clone()).or_default();
    s.links = links;
    s.census = remotes.len();
    s.remotes = remotes;
    n
}

async fn fhir_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let mut url = cfg.census_url.clone();
    let mut out: Vec<Remote> = Vec::new();
    let mut pats: HashMap<String, (String, String)> = HashMap::new(); // id → (name, mrn)
    for _page in 0..100 {
        let r = fhir_req(state, cfg, "GET", &url, None).await?;
        if r.status != 200 {
            let m = format!("재원 명단 HTTP {}: {}", r.status, r.text().chars().take(200).collect::<String>());
            state.emr.log(&cfg.id, "census", false, r.status.to_string(), m.clone());
            return Err(m);
        }
        let j = r.json().ok_or("재원 명단: JSON 아님")?;
        if j["resourceType"] == "Group" {
            for m in j["member"].as_array().cloned().unwrap_or_default() {
                let id = m["entity"]["reference"].as_str().unwrap_or("").trim_start_matches("Patient/").to_string();
                if id.is_empty() {
                    continue;
                }
                out.push(Remote { id, ident: String::new(), name: m["entity"]["display"].as_str().unwrap_or("").into(), location: String::new(), encounter: None, pid_seg: None, pv1_seg: None });
            }
            break;
        }
        for e in j["entry"].as_array().cloned().unwrap_or_default() {
            let res = &e["resource"];
            match res["resourceType"].as_str() {
                Some("Patient") => {
                    let id = res["id"].as_str().unwrap_or("").to_string();
                    let name = res["name"][0]["text"].as_str().map(String::from).unwrap_or_else(|| {
                        let g = res["name"][0]["given"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(" ")).unwrap_or_default();
                        format!("{} {}", g, res["name"][0]["family"].as_str().unwrap_or("")).trim().to_string()
                    });
                    let mrn = res["identifier"]
                        .as_array()
                        .and_then(|a| a.iter().find(|i| i["type"]["coding"][0]["code"] == "MR").or(a.first()))
                        .and_then(|i| i["value"].as_str())
                        .unwrap_or("")
                        .to_string();
                    pats.insert(id, (name, mrn));
                }
                Some("Encounter") => {
                    let pid = res["subject"]["reference"].as_str().or(res["patient"]["reference"].as_str()).unwrap_or("").trim_start_matches("Patient/").to_string();
                    let loc = res["location"]
                        .as_array()
                        .map(|a| a.iter().filter_map(|l| l["location"]["display"].as_str()).collect::<Vec<_>>().join(" · "))
                        .unwrap_or_default();
                    out.push(Remote {
                        id: pid,
                        ident: String::new(),
                        name: res["subject"]["display"].as_str().unwrap_or("").into(),
                        location: loc,
                        encounter: res["id"].as_str().map(String::from),
                        pid_seg: None,
                        pv1_seg: None,
                    });
                }
                _ => {}
            }
        }
        let next = j["link"].as_array().and_then(|a| a.iter().find(|l| l["relation"] == "next")).and_then(|l| l["url"].as_str()).map(String::from);
        match next {
            Some(n) => url = n,
            None => break,
        }
    }
    for r in out.iter_mut() {
        if let Some((n, m)) = pats.get(&r.id) {
            if r.name.is_empty() {
                r.name = n.clone();
            }
            r.ident = m.clone();
        }
    }
    out.sort_by(|a, b| a.location.cmp(&b.location).then(a.id.cmp(&b.id)));
    Ok(out)
}

/// ADT 메시지 한 건 → 환자 (PID·PV1 세그먼트는 그대로 보관해 ORU 에 쓴다)
fn hl7_remote(er7: &str) -> Option<Remote> {
    let segs: Vec<&str> = er7.split(['\r', '\n']).filter(|s| !s.is_empty()).collect();
    let pid = segs.iter().find(|s| s.starts_with("PID|")).map(|s| s.to_string())?;
    let pv1 = segs.iter().find(|s| s.starts_with("PV1|")).map(|s| s.to_string());
    let f: Vec<&str> = pid.split('|').collect();
    let id3 = f.get(3).copied().unwrap_or("");
    let first_id = id3.split('~').next().unwrap_or("").split('^').next().unwrap_or("").to_string();
    let name = f.get(5).copied().unwrap_or("").split('~').next().unwrap_or("").split('^').take(2).collect::<Vec<_>>().join(" ");
    let (loc, visit) = pv1
        .as_ref()
        .map(|p| {
            let g: Vec<&str> = p.split('|').collect();
            (g.get(3).copied().unwrap_or("").split('^').take(3).collect::<Vec<_>>().join("-"), g.get(19).copied().unwrap_or("").split('^').next().unwrap_or("").to_string())
        })
        .unwrap_or_default();
    Some(Remote { id: first_id.clone(), ident: first_id, name, location: loc, encounter: if visit.is_empty() { None } else { Some(visit) }, pid_seg: Some(pid), pv1_seg: pv1 })
}

async fn hl7_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let auth = hc::basic(auth_s(cfg, "username"), auth_s(cfg, "password"));
    let r = hc::request("GET", &cfg.census_url, &[("Authorization", auth)], None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    if r.status != 200 {
        let m = format!("재원 명단 HTTP {}: {}", r.status, r.text().chars().take(200).collect::<String>());
        state.emr.log(&cfg.id, "census", false, r.status.to_string(), m.clone());
        return Err(m);
    }
    let j = r.json().ok_or("재원 명단: JSON 아님")?;
    let mut out = Vec::new();
    for m in j["messages"].as_array().cloned().unwrap_or_default() {
        let er7 = m.as_str().map(String::from).or_else(|| m["er7"].as_str().map(String::from)).unwrap_or_default();
        if let Some(r) = hl7_remote(&er7) {
            out.push(r);
        }
    }
    out.sort_by(|a, b| a.location.cmp(&b.location).then(a.id.cmp(&b.id)));
    Ok(out)
}


// ───────────────────────────── 입퇴원 (ADT) ─────────────────────────────

const ADT_LABEL: [(&str, &str); 5] = [("A01", "입원"), ("A02", "전동"), ("A03", "퇴원"), ("A08", "정보 변경"), ("A11", "입원 취소")];

pub fn adt_label(code: &str) -> &'static str {
    ADT_LABEL.iter().find(|x| x.0 == code).map(|x| x.1).unwrap_or("변경")
}

fn hl7_basic(cfg: &ConnCfg) -> (&'static str, String) {
    ("Authorization", hc::basic(auth_s(cfg, "username"), auth_s(cfg, "password")))
}

/// 입퇴원 변경분을 읽는다. 반환: (변경들, 새 커서, 전체 명단을 다시 받아야 하는지)
/// 커서가 없으면(처음) 지금 위치로 맞추기만 한다 — 그 이전 이벤트는 방금 받은 전체 명단에 이미 들어 있다.
async fn adt_fetch(state: &AppState, cfg: &ConnCfg, cursor: Option<String>) -> Result<(Vec<Change>, Option<String>, bool), String> {
    let first = cursor.is_none();
    match cfg.protocol.as_str() {
        "hl7v2" => {
            let since: u64 = cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
            let url = format!("{}/hl7/adt?since={}&limit={}", site_base(cfg), since, if first { 100_000 } else { 500 });
            let r = hc::request("GET", &url, &[hl7_basic(cfg)], None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
            let j = r.json().ok_or_else(|| format!("ADT HTTP {}", r.status))?;
            let next = j["next_since"].as_u64().map(|n| n.to_string()).or(cursor.clone());
            if first {
                return Ok((vec![], next, false));
            }
            let mut ch = Vec::new();
            for m in j["messages"].as_array().cloned().unwrap_or_default() {
                let code = m["event"].as_str().unwrap_or("").to_string();
                let Some(rm) = hl7_remote(m["er7"].as_str().unwrap_or("")) else { continue };
                match code.as_str() {
                    "A03" | "A11" => ch.push(Change::Remove(code, rm.id.clone(), rm.name.clone())),
                    _ => ch.push(Change::Upsert(code, rm)),
                }
            }
            Ok((ch, next, false))
        }
        "kr-json" => {
            let since: u64 = cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
            let url = format!("{}/api/v1/adm/events?FROM_SEQ={}", site_base(cfg), since);
            let r = hc::request("GET", &url, &krjson_headers(cfg), None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
            let j = r.json().unwrap_or_default();
            if j["RESULT_CD"] != "0000" {
                return Err(format!("ADT {} {}", j["RESULT_CD"].as_str().unwrap_or("?"), j["RESULT_MSG"].as_str().unwrap_or("")));
            }
            let rows = j["DATA"].as_array().cloned().unwrap_or_default();
            let max = rows.iter().filter_map(|d| d["EVT_SEQ"].as_u64()).max().unwrap_or(since).max(since);
            if first {
                return Ok((vec![], Some(max.to_string()), false));
            }
            let mut ch = Vec::new();
            for d in rows.iter().filter(|d| d["EVT_SEQ"].as_u64().unwrap_or(0) > since) {
                let code = match d["EVT_TP_CD"].as_str().unwrap_or("") {
                    "ADM" => "A01",
                    "TRF" => "A02",
                    "DSC" => "A03",
                    "CNL" => "A11",
                    _ => "A08",
                };
                let rm = Remote {
                    id: d["PT_NO"].as_str().unwrap_or("").into(),
                    ident: d["PT_NO"].as_str().unwrap_or("").into(),
                    name: d["PT_NM"].as_str().unwrap_or("").into(),
                    location: format!("{} {}-{}", d["WARD_CD"].as_str().unwrap_or(""), d["ROOM_NO"].as_str().unwrap_or(""), d["BED_NO"].as_str().unwrap_or("")),
                    encounter: d["ADM_NO"].as_str().map(String::from),
                    pid_seg: None,
                    pv1_seg: None,
                };
                ch.push(if code == "A03" || code == "A11" { Change::Remove(code.into(), rm.id, rm.name) } else { Change::Upsert(code.into(), rm) });
            }
            Ok((ch, Some(max.to_string()), false))
        }
        "kr-xml" => {
            let since: u64 = cursor.as_deref().and_then(|c| c.parse().ok()).unwrap_or(0);
            let ts = local_time(cfg, now_ms()).format("%Y%m%d%H%M%S").to_string();
            let text = krxml_post(cfg, &krxml_msg("EMR_ADT_0002", &format!("<REQ><FROM_SEQ>{since}</FROM_SEQ></REQ>"), &ts)).await?;
            if tag(&text, "RSLT_CD") != "S" {
                return Err(format!("ADT {} {}", tag(&text, "RSLT_CD"), tag(&text, "RSLT_MSG")));
            }
            let rows = blocks(&text, "DATA");
            let seq = |d: &str| tag(d, "SEQ").parse::<u64>().unwrap_or(0);
            let max = rows.iter().map(|d| seq(d)).max().unwrap_or(since).max(since);
            if first {
                return Ok((vec![], Some(max.to_string()), false));
            }
            let mut ch = Vec::new();
            for d in rows.iter().filter(|d| seq(d) > since) {
                let code = match tag(d, "EVT_GB").as_str() {
                    "I" => "A01",
                    "T" => "A02",
                    "O" => "A03",
                    "C" => "A11",
                    _ => "A08",
                };
                let rm = Remote {
                    id: tag(d, "PTNT_NO"),
                    ident: tag(d, "PTNT_NO"),
                    name: tag(d, "PTNT_NM"),
                    location: format!("{} {}-{}", tag(d, "WD_CD"), tag(d, "RM_NO"), tag(d, "BD_NO")),
                    encounter: Some(tag(d, "INPT_NO")).filter(|x| !x.is_empty()),
                    pid_seg: None,
                    pv1_seg: None,
                };
                ch.push(if code == "A03" || code == "A11" { Change::Remove(code.into(), rm.id, rm.name) } else { Change::Upsert(code.into(), rm) });
            }
            Ok((ch, Some(max.to_string()), false))
        }
        "athena" => {
            let tok = token(state, cfg, false).await?.unwrap_or_default();
            let auth = ("Authorization", format!("Bearer {tok}"));
            if first {
                let url = format!("{}/patients/changed/subscription", athena_prefix(cfg));
                let r = hc::request("POST", &url, std::slice::from_ref(&auth), None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
                if r.status != 200 {
                    return Err(format!("변경 구독 HTTP {}", r.status));
                }
                return Ok((vec![], Some("subscribed".into()), false));
            }
            let url = format!("{}/patients/changed", athena_prefix(cfg));
            let r = hc::request("GET", &url, &[auth], None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
            let j = r.json().unwrap_or_default();
            if r.status == 400 {
                return Ok((vec![], None, false)); // 구독이 풀렸다(에뮬레이터 재시작) — 다시 구독
            }
            // 바뀐 환자가 있으면 모니터링 명단을 다시 받는다(퇴원도 UPDATE 로만 온다)
            let n = j["patients"].as_array().map(|a| a.len()).unwrap_or(0);
            Ok((vec![], cursor, n > 0))
        }
        "fhir" if !matches!(cfg.flavor.as_str(), "epic" | "oracle") => {
            let now_iso = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
            if first {
                return Ok((vec![], Some(now_iso), false));
            }
            // 5초 겹쳐 읽는다 (시계 차이) — 같은 변경을 두 번 적용해도 결과가 같다
            let from = cursor
                .as_deref()
                .and_then(|c| chrono::DateTime::parse_from_rfc3339(c).ok())
                .map(|t| (t - chrono::Duration::seconds(5)).with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%SZ").to_string())
                .unwrap_or(now_iso.clone());
            let url = format!("{}/Encounter?_lastUpdated=gt{}&_include=Encounter:patient&_count=100", cfg.fhir_base, hc::enc(&from));
            let r = fhir_req(state, cfg, "GET", &url, None).await?;
            if r.status != 200 {
                return Err(format!("ADT HTTP {}: {}", r.status, r.text().chars().take(120).collect::<String>()));
            }
            let j = r.json().unwrap_or_default();
            let mut names: HashMap<String, String> = HashMap::new();
            for e in j["entry"].as_array().cloned().unwrap_or_default() {
                let res = &e["resource"];
                if res["resourceType"] == "Patient" {
                    let n = res["name"][0]["text"].as_str().map(String::from).unwrap_or_default();
                    names.insert(res["id"].as_str().unwrap_or("").into(), n);
                }
            }
            let mut ch = Vec::new();
            for e in j["entry"].as_array().cloned().unwrap_or_default() {
                let res = &e["resource"];
                if res["resourceType"] != "Encounter" {
                    continue;
                }
                let pid = res["subject"]["reference"].as_str().or(res["patient"]["reference"].as_str()).unwrap_or("").trim_start_matches("Patient/").to_string();
                let name = res["subject"]["display"].as_str().map(String::from).or_else(|| names.get(&pid).cloned()).unwrap_or_default();
                match res["status"].as_str().unwrap_or("") {
                    "in-progress" | "arrived" => {
                        let loc = res["location"].as_array().map(|a| a.iter().filter_map(|l| l["location"]["display"].as_str()).collect::<Vec<_>>().join(" · ")).unwrap_or_default();
                        ch.push(Change::Upsert("A08".into(), Remote { id: pid, ident: String::new(), name, location: loc, encounter: res["id"].as_str().map(String::from), pid_seg: None, pv1_seg: None }));
                    }
                    "finished" | "cancelled" | "entered-in-error" => ch.push(Change::Remove(if res["status"] == "finished" { "A03".into() } else { "A11".into() }, pid, name)),
                    _ => {}
                }
            }
            Ok((ch, Some(now_iso), false))
        }
        // Epic·Oracle(Group 명단)·CDA: 변경분 피드가 없어 명단을 1분마다 다시 받는다
        _ => Ok((vec![], Some(cursor.unwrap_or_default()), true)),
    }
}

/// 변경분을 명단에 적용하고 짝을 다시 맞춘다. 입원·퇴원은 기록에 남긴다.
async fn adt_poll(state: &AppState, cfg: &ConnCfg) -> Result<(), String> {
    let cursor = state.emr.state.lock().unwrap().get(&cfg.id).and_then(|s| s.adt_cursor.clone());
    let (changes, next, resync) = adt_fetch(state, cfg, cursor).await?;
    if resync {
        census(state, cfg).await?;
    }
    let (mut remotes, before): (Vec<Remote>, Vec<Link>) = {
        let st = state.emr.state.lock().unwrap();
        st.get(&cfg.id).map(|s| (s.remotes.clone(), s.links.clone())).unwrap_or_default()
    };
    let mut events: Vec<AdtEvent> = Vec::new();
    let mut real = 0;
    for c in changes {
        match c {
            Change::Upsert(code, r) => {
                let known = remotes.iter().position(|x| x.id == r.id);
                // FHIR 에서 이미 명단에 있는 in-progress 내원은 변경 없음으로 본다 (겹쳐 읽기)
                // 바뀐 것이 없는 변경(되감기·겹쳐 읽기로 다시 온 이벤트)은 건너뛴다
                let unchanged = known
                    .map(|i| remotes[i].location == r.location && remotes[i].encounter == r.encounter && (r.name.is_empty() || remotes[i].name == r.name))
                    .unwrap_or(false);
                if unchanged {
                    continue;
                }
                let code = if known.is_none() && code == "A08" && cfg.protocol == "fhir" { "A01".to_string() } else { code };
                events.push(AdtEvent { ts_ms: now_ms(), code: code.clone(), remote_id: r.id.clone(), name: r.name.clone(), location: r.location.clone(), effect: String::new() });
                match known {
                    Some(i) => {
                        let mut r = r;
                        if r.name.is_empty() {
                            r.name = remotes[i].name.clone();
                        }
                        if r.ident.is_empty() {
                            r.ident = remotes[i].ident.clone();
                        }
                        remotes[i] = r;
                    }
                    None => remotes.push(r),
                }
                real += 1;
            }
            Change::Remove(code, id, name) => {
                let loc = remotes.iter().find(|x| x.id == id).map(|x| x.location.clone()).unwrap_or_default();
                let had = remotes.len();
                remotes.retain(|x| x.id != id);
                if remotes.len() == had {
                    continue; // 명단에 없던 환자의 퇴원(이미 반영됨) — 무시
                }
                events.push(AdtEvent { ts_ms: now_ms(), code, remote_id: id, name, location: loc, effect: String::new() });
                real += 1;
            }
        }
    }
    if real > 0 {
        remotes.sort_by(|a, b| a.location.cmp(&b.location).then(a.id.cmp(&b.id)));
        apply_remotes(state, cfg, remotes);
    }
    let after: Vec<Link> = state.emr.state.lock().unwrap().get(&cfg.id).map(|s| s.links.clone()).unwrap_or_default();
    // 짝에 준 영향: 이 환자와 짝이던 우리 환자, 새로 짝지어진 우리 환자
    for e in events.iter_mut() {
        let was = before.iter().find(|l| l.remote.id == e.remote_id).map(|l| l.channel_id.clone());
        let now = after.iter().find(|l| l.remote.id == e.remote_id).map(|l| l.channel_id.clone());
        e.effect = match (was, now) {
            (Some(a), None) => format!("짝 해제 · 패치 {a}"),
            (None, Some(b)) => format!("새 짝 · 패치 {b}"),
            (Some(a), Some(b)) if a != b => format!("짝 변경 · 패치 {a} → {b}"),
            (Some(_), Some(_)) => "짝 유지".into(),
            _ => String::new(),
        };
    }
    let n = events.len();
    {
        let mut st = state.emr.state.lock().unwrap();
        let s = st.entry(cfg.id.clone()).or_default();
        s.adt_cursor = next;
        s.adt_ms = now_ms();
        s.adt_count += n as u64;
        for e in events.iter() {
            s.adt.push_front(e.clone());
        }
        s.adt.truncate(200);
    }
    if n > 0 {
        let summary = events.iter().take(6).map(|e| format!("{} {}", adt_label(&e.code), e.remote_id)).collect::<Vec<_>>().join(", ");
        state.emr.log(&cfg.id, "adt", true, format!("{n}건"), format!("입퇴원 반영: {summary}{}", if n > 6 { " …" } else { "" }));
    }
    Ok(())
}

// ───────────────────────────── 매칭 ─────────────────────────────

fn match_patients(state: &AppState, cfg: &ConnCfg, remotes: &[Remote], prev: &[Link]) -> Vec<Link> {
    struct Local {
        ch: String,
        name: String,
        mrn: String,
        room: String,
        emr: Option<crate::protocol::EmrKey>,
    }
    let mut locals: Vec<Local> = state
        .registry
        .snapshot()
        .into_iter()
        .filter(|c| c.connected)
        .filter_map(|c| {
            let p = c.patient.as_ref()?;
            if !cfg.scope_ward.is_empty() && p.ward != cfg.scope_ward {
                return None;
            }
            Some(Local {
                ch: c.channel_id.clone(),
                name: p.name.clone(),
                mrn: c.mrn.clone(),
                room: if p.bed.is_empty() { p.room.clone() } else { p.bed.clone() },
                emr: p.emr.clone().filter(|k| k.site == cfg.site_id),
            })
        })
        .collect();
    locals.sort_by(|a, b| a.room.cmp(&b.room).then(a.ch.cmp(&b.ch)));
    let mk = |l: &Local, r: &Remote, by: &str| {
        // 같은 (패치, 기관 환자) 짝이면 전송 이력을 이어 붙인다
        let old = prev.iter().find(|o| o.channel_id == l.ch && o.remote.id == r.id);
        let mut remote = r.clone();
        if remote.encounter.is_none() {
            remote.encounter = old.and_then(|o| o.remote.encounter.clone());
        }
        Link {
            channel_id: l.ch.clone(),
            local_name: l.name.clone(),
            local_mrn: l.mrn.clone(),
            local_room: l.room.clone(),
            remote,
            matched_by: by.to_string(),
            last_sent_ms: old.map(|o| o.last_sent_ms).unwrap_or(0),
            last_result: old.map(|o| o.last_result.clone()).unwrap_or_default(),
            ok: old.map(|o| o.ok).unwrap_or(0),
            fail: old.map(|o| o.fail).unwrap_or(0),
        }
    };
    let cap = cfg.max_patients.max(1);
    let mut out = Vec::new();
    if cfg.match_mode == "mrn" {
        // 실제 병원 방식: 같은 사람을 식별자로 찾는다.
        //  1) 에뮬레이터 연동 병원 조인 키(emr.mrn / fhir_patient_id / 내원번호)  2) 우리 MRN = 기관 등록번호
        for l in &locals {
            if out.len() >= cap {
                break;
            }
            let by_emr = l.emr.as_ref().and_then(|k| {
                remotes.iter().find(|r| {
                    (!k.fhir_patient_id.is_empty() && r.id == k.fhir_patient_id)
                        || (!k.mrn.is_empty() && (r.ident == k.mrn || r.id == k.mrn))
                        || (!k.visit.is_empty() && r.encounter.as_deref() == Some(k.visit.as_str()))
                })
            });
            if let Some(r) = by_emr {
                out.push(mk(l, r, "emr"));
                continue;
            }
            if let Some(r) = remotes.iter().find(|r| !r.ident.is_empty() && (r.ident == l.mrn || r.ident == l.mrn.trim_start_matches("MRN-"))) {
                out.push(mk(l, r, "mrn"));
            }
        }
    } else {
        // 시험용 짝짓기도 '끈끈하게': 두 쪽 다 남아 있는 짝은 유지, 빈자리만 순서대로 채운다
        let mut used_l = std::collections::HashSet::new();
        let mut used_r = std::collections::HashSet::new();
        for o in prev {
            if out.len() >= cap {
                break;
            }
            let (Some(l), Some(r)) = (locals.iter().find(|l| l.ch == o.channel_id), remotes.iter().find(|r| r.id == o.remote.id)) else { continue };
            used_l.insert(l.ch.clone());
            used_r.insert(r.id.clone());
            out.push(mk(l, r, "pair"));
        }
        let free_r: Vec<&Remote> = remotes.iter().filter(|r| !used_r.contains(&r.id)).collect();
        for (l, r) in locals.iter().filter(|l| !used_l.contains(&l.ch)).zip(free_r) {
            if out.len() >= cap {
                break;
            }
            out.push(mk(l, r, "pair"));
        }
    }
    out.truncate(cap);
    out
}

// ───────────────────────────── 전송 ─────────────────────────────

struct Vit {
    hr: Option<f64>,
    rr: Option<f64>,
    spo2: Option<f64>,
    temp_c: Option<f64>,
    ts_ms: u64,
    device: String,
}

fn vitals_of(state: &AppState, channel_id: &str) -> Option<Vit> {
    let (v, ts, _, _) = state.registry.vitals_of(channel_id)?;
    // 1분 넘게 새 수치가 없으면 보내지 않는다(패치 떨어짐·수신 끊김)
    if ts == 0 || now_ms().saturating_sub(ts) > 60_000 {
        return None;
    }
    let x = Vit { hr: v.hr.map(|x| x as f64), rr: v.resp.map(|x| x as f64), spo2: v.spo2.map(|x| x as f64), temp_c: v.temp.map(|x| (x as f64 * 10.0).round() / 10.0), ts_ms: ts, device: format!("BIOMON-PATCH {channel_id}") };
    if x.hr.is_none() && x.rr.is_none() && x.spo2.is_none() && x.temp_c.is_none() {
        return None;
    }
    Some(x)
}

fn local_time(cfg: &ConnCfg, ms: u64) -> chrono::DateTime<chrono_tz::Tz> {
    let tz: chrono_tz::Tz = cfg.tz.parse().unwrap_or(chrono_tz::UTC);
    tz.timestamp_millis_opt(ms as i64).single().unwrap_or_else(|| tz.timestamp_millis_opt(0).unwrap())
}

fn fahrenheit(cfg: &ConnCfg) -> bool {
    matches!(cfg.flavor.as_str(), "epic" | "oracle" | "meditech" | "athena")
}

async fn send_all(state: &AppState, cfg: &ConnCfg) -> Result<u64, String> {
    let links: Vec<Link> = state.emr.state.lock().unwrap().get(&cfg.id).map(|s| s.links.clone()).unwrap_or_default();
    if links.is_empty() {
        return Ok(0);
    }
    let mut ok = 0u64;
    let mut fail = 0u64;
    let mut hard: Option<String> = None;
    let mut streak = 0; // 연속 연결 오류 — 3번이면 이번 회차를 멈추고 백오프(한두 건의 5xx 는 건너뛴다)
    let mut mllp: Option<tokio::net::TcpStream> = None;
    for l in links.iter() {
        let Some(v) = vitals_of(state, &l.channel_id) else { continue };
        let r = match cfg.protocol.as_str() {
            "fhir" => send_fhir(state, cfg, l, &v).await,
            "hl7v2" => send_hl7(cfg, l, &v, &mut mllp).await,
            "kr-json" => send_krjson(cfg, l, &v).await,
            "kr-xml" => send_krxml(cfg, l, &v).await,
            "cda" => send_cda(cfg, l, &v).await,
            "athena" => send_athena(state, cfg, l, &v).await,
            _ => Err("형식".into()),
        };
        let (good, msg) = match r {
            Ok(m) => (true, m),
            Err(e) => (false, e),
        };
        if good {
            ok += 1
        } else {
            fail += 1;
            if msg.contains("시간 초과") || msg.contains("HTTP 5") || msg.contains("connect") || msg.contains("Connection") || msg.contains("연결") {
                streak += 1;
                if streak >= 3 {
                    hard = Some(msg.clone());
                }
            } else {
                streak = 0;
            }
        }
        if good {
            streak = 0;
        }
        {
            let mut st = state.emr.state.lock().unwrap();
            if let Some(s) = st.get_mut(&cfg.id) {
                if let Some(x) = s.links.iter_mut().find(|x| x.channel_id == l.channel_id) {
                    x.last_sent_ms = now_ms();
                    x.last_result = msg.clone();
                    if good { x.ok += 1 } else { x.fail += 1 }
                }
                if good { s.sent_ok += 1 } else { s.sent_fail += 1 }
                s.last_send_ms = now_ms();
            }
        }
        if !good {
            state.emr.log(&cfg.id, "send", false, "실패", format!("{} → {}: {}", l.channel_id, l.remote.id, msg));
        }
        if hard.is_some() {
            break;
        }
    }
    if ok + fail == 0 {
        state.emr.log(&cfg.id, "send", true, "대기", "새 수치가 있는 매칭 환자 없음 — 15초 뒤 다시");
        return Ok(0);
    }
    state.emr.log(&cfg.id, "send", fail == 0, if fail == 0 { "OK" } else { "일부 실패" }, format!("바이탈 전송 {ok}명 성공 · {fail}명 실패"));
    match hard {
        Some(h) => Err(h),
        None => Ok(ok + fail),
    }
}

fn obs(cfg: &ConnCfg, l: &Link, loinc: &str, display: &str, value: f64, unit: &str, code: &str, when: &str, stu3: bool) -> Value {
    let mut o = json!({
        "resourceType": "Observation",
        "status": "final",
        "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/observation-category", "code": "vital-signs", "display": "Vital Signs"}]}],
        "code": {"coding": [{"system": "http://loinc.org", "code": loinc, "display": display}], "text": display},
        "subject": {"reference": format!("Patient/{}", l.remote.id)},
        "effectiveDateTime": when,
        "valueQuantity": {"value": value, "unit": unit, "system": "http://unitsofmeasure.org", "code": code},
        "device": {"display": format!("BIOMON-PATCH {}", l.channel_id)},
    });
    if stu3 {
        o["category"][0]["coding"][0]["system"] = json!("http://hl7.org/fhir/observation-category");
    }
    if let Some(e) = &l.remote.encounter {
        o[if stu3 { "context" } else { "encounter" }] = json!({"reference": format!("Encounter/{e}")});
    }
    let _ = cfg;
    o
}

async fn encounter_for(state: &AppState, cfg: &ConnCfg, pid: &str) -> Option<String> {
    let url = format!("{}/Encounter?patient={}&status=in-progress", cfg.fhir_base, hc::enc(pid));
    let r = fhir_req(state, cfg, "GET", &url, None).await.ok()?;
    let j = r.json()?;
    j["entry"].as_array()?.iter().find(|e| e["resource"]["resourceType"] == "Encounter").and_then(|e| e["resource"]["id"].as_str()).map(String::from)
}

async fn send_fhir(state: &AppState, cfg: &ConnCfg, l: &Link, v: &Vit) -> Result<String, String> {
    let mut l = l.clone();
    // Group 명단(Epic·Oracle)에는 내원 id 가 없다 — 한 번 찾아 기억
    if l.remote.encounter.is_none() && matches!(cfg.flavor.as_str(), "epic" | "oracle") {
        if let Some(e) = encounter_for(state, cfg, &l.remote.id).await {
            l.remote.encounter = Some(e.clone());
            if let Some(s) = state.emr.state.lock().unwrap().get_mut(&cfg.id) {
                if let Some(x) = s.links.iter_mut().find(|x| x.channel_id == l.channel_id) {
                    x.remote.encounter = Some(e);
                }
            }
        }
    }
    let stu3 = cfg.version.starts_with('3');
    let when = local_time(cfg, v.ts_ms).format("%Y-%m-%dT%H:%M:%S%:z").to_string();
    let mut entries = Vec::new();
    let mut push = |o: Value| entries.push(json!({"fullUrl": format!("urn:uuid:{}", uuid()), "resource": o, "request": {"method": "POST", "url": "Observation"}}));
    if let Some(x) = v.hr {
        push(obs(cfg, &l, "8867-4", "Heart rate", x, "beats/minute", "/min", &when, stu3));
    }
    if let Some(x) = v.rr {
        push(obs(cfg, &l, "9279-1", "Respiratory rate", x, "breaths/minute", "/min", &when, stu3));
    }
    if let Some(x) = v.spo2 {
        push(obs(cfg, &l, "59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", x, "%", "%", &when, stu3));
    }
    if let Some(c) = v.temp_c {
        if fahrenheit(cfg) {
            push(obs(cfg, &l, "8310-5", "Body temperature", ((c * 9.0 / 5.0 + 32.0) * 10.0).round() / 10.0, "degF", "[degF]", &when, stu3));
        } else {
            push(obs(cfg, &l, "8310-5", "Body temperature", c, "Cel", "Cel", &when, stu3));
        }
    }
    let n = entries.len();
    let bundle = json!({"resourceType": "Bundle", "type": "transaction", "entry": entries});
    let r = fhir_req(state, cfg, "POST", &cfg.fhir_base, Some(bundle.to_string().as_bytes())).await?;
    if r.status == 200 || r.status == 201 {
        return Ok(format!("{n}항목 저장 ({})", r.status));
    }
    let oo = r.json().and_then(|j| j["issue"][0]["diagnostics"].as_str().or(j["issue"][0]["details"]["text"].as_str()).map(String::from));
    Err(format!("HTTP {}: {}", r.status, oo.unwrap_or_else(|| r.text().chars().take(160).collect())))
}

fn hl7_ts(cfg: &ConnCfg, ms: u64) -> String {
    let t = local_time(cfg, ms);
    // 일본 SS-MIX2·캐나다 2.3 은 오프셋 없는 현지 시각
    if matches!(cfg.flavor.as_str(), "ss-mix2" | "ca-v23") {
        t.format("%Y%m%d%H%M%S").to_string()
    } else {
        t.format("%Y%m%d%H%M%S%z").to_string()
    }
}

/// ORU^R01 — PID·PV1 은 그 기관이 준 재원 명단의 세그먼트를 그대로 쓴다(식별자 규칙·이름 표기를 그 기관 것으로)
fn build_oru(cfg: &ConnCfg, l: &Link, v: &Vit, ctrl: &str) -> String {
    let ts = hl7_ts(cfg, v.ts_ms);
    let two_part = cfg.version.starts_with("2.3");
    let msh9 = if two_part { "ORU^R01" } else { "ORU^R01^ORU_R01" };
    let mut msh: Vec<String> = vec!["MSH".into(), "^~\\&".into(), "BIOMON".into(), "BIOMON".into(), cfg.receiving_app.clone(), cfg.facility.clone(), ts.clone(), String::new(), msh9.into(), ctrl.into(), "P".into(), cfg.version.clone()];
    // msh[i] = MSH-(i+1): msh[0] 은 세그먼트 이름, msh[1] 이 MSH-2(인코딩 문자)
    let set = |m: &mut Vec<String>, field: usize, v: &str| {
        let i = field - 1;
        while m.len() <= i {
            m.push(String::new());
        }
        m[i] = v.to_string();
    };
    match cfg.charset.as_str() {
        "iso-2022-jp" => {
            set(&mut msh, 18, "~ISO IR87");
            set(&mut msh, 20, "ISO 2022-1994");
        }
        "iso-8859-1" => {
            set(&mut msh, 17, "FRA");
            set(&mut msh, 18, "8859/1");
        }
        _ if !two_part && cfg.version != "2.5.1" || cfg.flavor == "ae-malaffi" => set(&mut msh, 18, "UNICODE UTF-8"),
        _ => {}
    }
    // MSH 는 필드 구분자 자체가 MSH-1 이므로 join 할 때 두 번째 요소부터
    let msh_line = format!("MSH|{}", msh[1..].join("|"));
    let pid = l.remote.pid_seg.clone().unwrap_or_else(|| format!("PID|1||{}", l.remote.id));
    let mut segs = vec![msh_line, pid];
    if let Some(pv1) = &l.remote.pv1_seg {
        segs.push(pv1.clone());
    }
    segs.push(format!("OBR|1||BM{}^BIOMON|85353-1^Vital signs panel^LN|||{}", v.ts_ms, ts));
    let jp = cfg.flavor == "ss-mix2";
    let code = |loinc: &str, name: &str, jp_code: &str, jp_name: &str| if jp { format!("{jp_code}^{jp_name}^99L01^{loinc}^{name}^LN") } else { format!("{loinc}^{name}^LN") };
    let mut n = 0;
    let mut obx = |c: String, val: String, unit: &str| {
        n += 1;
        segs.push(format!("OBX|{n}|NM|{c}||{val}|{unit}|||||F|||{ts}|||"));
    };
    if let Some(x) = v.hr {
        obx(code("8867-4", "Heart rate", "VS002", "脈拍"), format!("{x}"), "/min^/min^UCUM");
    }
    if let Some(x) = v.rr {
        obx(code("9279-1", "Respiratory rate", "VS003", "呼吸数"), format!("{x}"), "/min^/min^UCUM");
    }
    if let Some(x) = v.spo2 {
        obx(code("59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", "VS006", "SpO2"), format!("{x}"), "%^%^UCUM");
    }
    if let Some(c) = v.temp_c {
        if fahrenheit(cfg) {
            obx(code("8310-5", "Body temperature", "VS001", "体温"), format!("{:.1}", c * 9.0 / 5.0 + 32.0), "[degF]^degF^UCUM");
        } else {
            obx(code("8310-5", "Body temperature", "VS001", "体温"), format!("{c:.1}"), "Cel^Cel^UCUM");
        }
    }
    let _ = &v.device;
    segs.join("\r") + "\r"
}

fn encode(cfg: &ConnCfg, s: &str) -> Vec<u8> {
    let enc = match cfg.charset.as_str() {
        "iso-2022-jp" => encoding_rs::ISO_2022_JP,
        "iso-8859-1" => encoding_rs::WINDOWS_1252,
        "euc-kr" => encoding_rs::EUC_KR,
        _ => return s.as_bytes().to_vec(),
    };
    enc.encode(s).0.into_owned()
}

fn decode(cfg: &ConnCfg, b: &[u8]) -> String {
    let enc = match cfg.charset.as_str() {
        "iso-2022-jp" => encoding_rs::ISO_2022_JP,
        "iso-8859-1" => encoding_rs::WINDOWS_1252,
        "euc-kr" => encoding_rs::EUC_KR,
        _ => encoding_rs::UTF_8,
    };
    enc.decode(b).0.into_owned()
}

async fn send_hl7(cfg: &ConnCfg, l: &Link, v: &Vit, conn: &mut Option<tokio::net::TcpStream>) -> Result<String, String> {
    let ctrl = format!("BM{}{}", now_ms() % 1_000_000_000, &crate::auth::random_hex(2));
    let msg = build_oru(cfg, l, v, &ctrl);
    let mut frame = vec![0x0b];
    frame.extend(encode(cfg, &msg));
    frame.extend([0x1c, 0x0d]);
    for attempt in 0..2 {
        if conn.is_none() {
            let addr = format!("{}:{}", cfg.mllp_host, cfg.mllp_port);
            let s = tokio::time::timeout(Duration::from_secs(10), tokio::net::TcpStream::connect(&addr))
                .await
                .map_err(|_| "MLLP 연결 시간 초과".to_string())?
                .map_err(|e| format!("MLLP 연결 실패 {addr}: {e}"))?;
            *conn = Some(s);
        }
        let s = conn.as_mut().unwrap();
        let r = async {
            s.write_all(&frame).await?;
            let mut buf = Vec::new();
            let mut tmp = [0u8; 4096];
            loop {
                let n = s.read(&mut tmp).await?;
                if n == 0 {
                    return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "closed"));
                }
                buf.extend_from_slice(&tmp[..n]);
                if buf.windows(2).any(|w| w == [0x1c, 0x0d]) {
                    return Ok(buf);
                }
            }
        };
        match tokio::time::timeout(Duration::from_secs(20), r).await {
            Ok(Ok(buf)) => {
                let text = decode(cfg, &buf).trim_matches(|c| c == '\x0b' || c == '\x1c' || c == '\r').to_string();
                let msa = text.split('\r').find(|s| s.starts_with("MSA|")).unwrap_or("");
                let code = msa.split('|').nth(1).unwrap_or("");
                let err = text.split('\r').find(|s| s.starts_with("ERR|")).unwrap_or("");
                return match code {
                    "AA" | "CA" => Ok(format!("ACK {code}{}", if err.is_empty() { String::new() } else { format!(" (경고 {err})") })),
                    _ => Err(format!("ACK {code} {} {err}", msa.split('|').nth(3).unwrap_or(""))),
                };
            }
            _ if attempt == 0 => {
                *conn = None; // 끊긴 연결 — 한 번 다시 접속
                continue;
            }
            Ok(Err(e)) => return Err(format!("MLLP 연결 끊김: {e}")),
            Err(_) => return Err("MLLP 응답 시간 초과".into()),
        }
    }
    Err("MLLP 전송 실패".into())
}

// ───────────────────────────── 카탈로그 → 연결 ─────────────────────────────

fn strip_method(s: &str) -> String {
    let s = s.trim();
    let s = s.strip_prefix("GET ").or_else(|| s.strip_prefix("POST ")).unwrap_or(s);
    // 뒤에 붙은 설명 "(Basic …)" · "  (Content-Type …)" 은 떼어 낸다
    s.split("  ").next().unwrap_or(s).split(" (").next().unwrap_or(s).trim().to_string()
}

/// 가상 EMR 카탈로그의 기관 한 곳 → 연결 설정. 지원 형식이 아니면 None.
pub fn from_catalog(site: &Value, emu_host: &str) -> Option<ConnCfg> {
    let protocol = site["protocol"].as_str()?.to_string();
    if !matches!(protocol.as_str(), "fhir" | "hl7v2" | "kr-json" | "kr-xml" | "cda" | "athena") {
        return None;
    }
    let ep = &site["endpoints"];
    let mut c = ConnCfg {
        name: format!("{} ({})", site["name_local"].as_str().or(site["name"].as_str()).unwrap_or(""), site["id"].as_str().unwrap_or("")),
        site_id: site["id"].as_str()?.to_string(),
        protocol: protocol.clone(),
        flavor: site["flavor"].as_str().unwrap_or("").into(),
        version: site["version"].as_str().unwrap_or("").into(),
        tz: site["tz"].as_str().unwrap_or("UTC").into(),
        fhir_base: site["fhir_base"].as_str().unwrap_or("").into(),
        token_url: ep["token"].as_str().map(strip_method).unwrap_or_default(),
        census_url: ["census", "inpatients", "list", "patients", "endpoint"].iter().find_map(|k| ep[*k].as_str()).map(strip_method).unwrap_or_default(),
        base_url: site["base_url"].as_str().unwrap_or("").into(),
        auth: site["auth"].clone(),
        match_mode: "pair".into(),
        interval_s: 300,
        max_patients: 40,
        ..Default::default()
    };
    if protocol == "hl7v2" {
        let m = &site["mllp"];
        c.mllp_host = emu_host.to_string();
        c.mllp_port = m["port"].as_u64().unwrap_or(2575) as u16;
        c.facility = m["receiving_facility"].as_str().unwrap_or("").into();
        c.receiving_app = m["receiving_app"].as_str().unwrap_or("").into();
        c.charset = m["charset"].as_str().unwrap_or("utf-8").into();
    }
    Some(c)
}


/// 기관 루트 URL — 예전에 만든 연결(base_url 없음)은 재원 명단 주소에서 `/emrsim/{site}` 까지 잘라 쓴다
fn site_base(cfg: &ConnCfg) -> String {
    if !cfg.base_url.is_empty() {
        return cfg.base_url.trim_end_matches('/').to_string();
    }
    let u = &cfg.census_url;
    if let Some(i) = u.find("/emrsim/") {
        let rest = &u[i + 8..];
        let end = rest.find('/').map(|j| i + 8 + j).unwrap_or(u.len());
        return u[..end].to_string();
    }
    u.split("/hl7/").next().unwrap_or(u).to_string()
}

// ───────────────────────────── 국내·벤더 형식 ─────────────────────────────

fn xml_esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// `<name>값</name>` 의 값 (간단한 전문용 — 속성·중첩 없는 태그)
fn tag(xml: &str, name: &str) -> String {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    xml.find(&open).and_then(|i| xml[i + open.len()..].find(&close).map(|j| xml[i + open.len()..i + open.len() + j].to_string())).unwrap_or_default()
}

/// `<name>…</name>` 블록들
fn blocks<'a>(xml: &'a str, name: &str) -> Vec<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i + open.len()..];
        let Some(j) = after.find(&close) else { break };
        out.push(&after[..j]);
        rest = &after[j + close.len()..];
    }
    out
}

fn krjson_headers(cfg: &ConnCfg) -> Vec<(&'static str, String)> {
    vec![("X-API-KEY", auth_s(cfg, "key").to_string()), ("X-HOSP-CD", auth_s(cfg, "hosp_cd").to_string()), ("Accept", "application/json".into())]
}

/// 국내 대학병원 REST JSON (새솔): 업무 오류도 HTTP 200 — RESULT_CD 가 0000 이어야 성공
async fn krjson_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let r = hc::request("GET", &cfg.census_url, &krjson_headers(cfg), None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    let j = r.json().ok_or_else(|| format!("재원 명단 HTTP {}", r.status))?;
    if j["RESULT_CD"] != "0000" {
        let m = format!("재원 명단 {} {}", j["RESULT_CD"].as_str().unwrap_or("?"), j["RESULT_MSG"].as_str().unwrap_or(""));
        state.emr.log(&cfg.id, "census", false, r.status.to_string(), m.clone());
        return Err(m);
    }
    let mut out: Vec<Remote> = j["DATA"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|d| Remote {
            id: d["PT_NO"].as_str().unwrap_or("").into(),
            ident: d["PT_NO"].as_str().unwrap_or("").into(),
            name: d["PT_NM"].as_str().unwrap_or("").into(),
            location: format!("{} {}-{}", d["WARD_NM"].as_str().unwrap_or(""), d["ROOM_NO"].as_str().unwrap_or(""), d["BED_NO"].as_str().unwrap_or("")),
            encounter: d["ADM_NO"].as_str().map(String::from),
            pid_seg: None,
            pv1_seg: None,
        })
        .collect();
    out.sort_by(|a, b| a.location.cmp(&b.location));
    Ok(out)
}

async fn send_krjson(cfg: &ConnCfg, l: &Link, v: &Vit) -> Result<String, String> {
    let mut list = Vec::new();
    let mut add = |cd: &str, x: Option<f64>| {
        if let Some(x) = x {
            list.push(json!({"VS_CD": cd, "VS_VAL": if cd == "BT" { format!("{x:.1}") } else { format!("{}", x.round()) }}));
        }
    };
    add("PR", v.hr);
    add("RR", v.rr);
    add("SPO2", v.spo2);
    add("BT", v.temp_c);
    let body = json!({
        "HOSP_CD": auth_s(cfg, "hosp_cd"), "PT_NO": l.remote.id, "ADM_NO": l.remote.encounter.clone().unwrap_or_default(),
        "MSR_DTM": local_time(cfg, v.ts_ms).format("%Y%m%d%H%M%S").to_string(), "DEVICE_ID": format!("BIOMON-{}", l.channel_id), "VS_LIST": list,
    });
    let url = format!("{}/api/v1/vs", site_base(cfg));
    let mut h = krjson_headers(cfg);
    h.push(("Content-Type", "application/json; charset=UTF-8".into()));
    let r = hc::request("POST", &url, &h, Some(body.to_string().as_bytes()), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    if r.status >= 500 {
        return Err(format!("HTTP {}", r.status));
    }
    let j = r.json().unwrap_or_default();
    match j["RESULT_CD"].as_str() {
        Some("0000") => Ok(format!("{}항목 저장 (0000)", list_len(&body))),
        Some(c) => Err(format!("{c} {}", j["RESULT_MSG"].as_str().unwrap_or(""))),
        None => Err(format!("HTTP {}: {}", r.status, r.text().chars().take(120).collect::<String>())),
    }
}

fn list_len(b: &Value) -> usize {
    b["VS_LIST"].as_array().map(|a| a.len()).unwrap_or(0)
}

fn krxml_msg(if_id: &str, body: &str, ts: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"EUC-KR\"?>\n<IF_MSG><HEADER><IF_ID>{if_id}</IF_ID><SND_SYS_CD>BIOMON</SND_SYS_CD><RCV_SYS_CD>OCS</RCV_SYS_CD><TRX_ID>BM{}</TRX_ID><TRX_DTM>{ts}</TRX_DTM></HEADER><BODY>{body}</BODY></IF_MSG>",
        crate::auth::random_hex(5)
    )
}

async fn krxml_post(cfg: &ConnCfg, xml: &str) -> Result<String, String> {
    let bytes = encoding_rs::EUC_KR.encode(xml).0.into_owned();
    let r = hc::request("POST", &cfg.census_url, &[("Content-Type", "text/xml; charset=EUC-KR".into())], Some(&bytes), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    if r.status >= 500 {
        return Err(format!("HTTP {}", r.status));
    }
    Ok(encoding_rs::EUC_KR.decode(&r.body).0.into_owned())
}

/// EUC-KR XML 전문 (동해): IF_ID 로 업무를 고르고, 전문 오류도 HTTP 200 — RSLT_CD S 가 성공
async fn krxml_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let ts = local_time(cfg, now_ms()).format("%Y%m%d%H%M%S").to_string();
    let text = krxml_post(cfg, &krxml_msg("EMR_ADT_0001", "<REQ><WD_CD></WD_CD></REQ>", &ts)).await?;
    if tag(&text, "RSLT_CD") != "S" {
        let m = format!("재원 명단 {} {}", tag(&text, "RSLT_CD"), tag(&text, "RSLT_MSG"));
        state.emr.log(&cfg.id, "census", false, "E", m.clone());
        return Err(m);
    }
    let mut out: Vec<Remote> = blocks(&text, "DATA")
        .iter()
        .map(|d| Remote {
            id: tag(d, "PTNT_NO"),
            ident: tag(d, "PTNT_NO"),
            name: tag(d, "PTNT_NM"),
            location: format!("{} {}-{}", tag(d, "WD_CD"), tag(d, "RM_NO"), tag(d, "BD_NO")),
            encounter: Some(tag(d, "INPT_NO")).filter(|x| !x.is_empty()),
            pid_seg: None,
            pv1_seg: None,
        })
        .collect();
    out.sort_by(|a, b| a.location.cmp(&b.location));
    Ok(out)
}

async fn send_krxml(cfg: &ConnCfg, l: &Link, v: &Vit) -> Result<String, String> {
    let t = local_time(cfg, v.ts_ms);
    let f = |x: Option<f64>, dec: bool| x.map(|x| if dec { format!("{x:.1}") } else { format!("{}", x.round()) }).unwrap_or_default();
    let data = format!(
        "<DATA_LIST><DATA><PTNT_NO>{}</PTNT_NO><VS_DT>{}</VS_DT><VS_TM>{}</VS_TM><BT>{}</BT><PR>{}</PR><RR>{}</RR><BP_H></BP_H><BP_L></BP_L><SPO2>{}</SPO2><EQUIP_ID>BIOMON-{}</EQUIP_ID></DATA></DATA_LIST>",
        xml_esc(&l.remote.id), t.format("%Y%m%d"), t.format("%H%M"), f(v.temp_c, true), f(v.hr, false), f(v.rr, false), f(v.spo2, false), xml_esc(&l.channel_id)
    );
    let text = krxml_post(cfg, &krxml_msg("EMR_VS_0002", &data, &t.format("%Y%m%d%H%M%S").to_string())).await?;
    match tag(&text, "RSLT_CD").as_str() {
        "S" => Ok("전문 저장 (S)".into()),
        c => {
            let row = blocks(&text, "DATA").first().map(|d| format!("{} {}", tag(d, "PROC_CD"), tag(d, "PROC_MSG"))).unwrap_or_default();
            Err(format!("RSLT_CD {c} {} {row}", tag(&text, "RSLT_MSG")))
        }
    }
}

/// 진료정보교류 CDA R2 (청람): 재원 환자 = 입원 중(ADMITTED=Y) 문서의 환자, 바이탈은 활력징후 CDA 문서로 등록
async fn cda_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let h = [("Authorization", format!("Bearer {}", auth_s(cfg, "token")))];
    let r = hc::request("GET", &cfg.census_url, &h, None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    if r.status != 200 {
        let m = format!("문서 목록 HTTP {}: {}", r.status, r.text().chars().take(160).collect::<String>());
        state.emr.log(&cfg.id, "census", false, r.status.to_string(), m.clone());
        return Err(m);
    }
    let text = r.text();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for d in blocks(&text, "Document") {
        let id = tag(d, "PtNo");
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(Remote { id: id.clone(), ident: id, name: tag(d, "PtNm"), location: tag(d, "DocTitle"), encounter: None, pid_seg: None, pv1_seg: None });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

async fn send_cda(cfg: &ConnCfg, l: &Link, v: &Vit) -> Result<String, String> {
    let ts = local_time(cfg, v.ts_ms).format("%Y%m%d%H%M%S%z").to_string();
    let mut obs = String::new();
    let mut add = |code: &str, val: Option<f64>, unit: &str, dec: bool| {
        if let Some(x) = val {
            let s = if dec { format!("{x:.1}") } else { format!("{}", x.round()) };
            obs.push_str(&format!("<component><observation classCode=\"OBS\" moodCode=\"EVN\"><code code=\"{code}\" codeSystem=\"2.16.840.1.113883.6.1\" codeSystemName=\"LOINC\"/><effectiveTime value=\"{ts}\"/><value xsi:type=\"PQ\" value=\"{s}\" unit=\"{unit}\"/></observation></component>"));
        }
    };
    add("8867-4", v.hr, "/min", false);
    add("9279-1", v.rr, "/min", false);
    add("59408-5", v.spo2, "%", false);
    add("8310-5", v.temp_c, "Cel", true);
    let doc = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <realmCode code="KR"/>
  <typeId root="2.16.840.1.113883.1.3" extension="POCD_HD000040"/>
  <templateId root="1.2.410.100110.40.2.1.9"/>
  <id root="1.2.410.999999.1" extension="BM{}{}"/>
  <code code="8716-3" codeSystem="2.16.840.1.113883.6.1" displayName="Vital signs"/>
  <title>활력징후 기록 (생체신호 모니터링)</title>
  <effectiveTime value="{ts}"/>
  <confidentialityCode code="N" codeSystem="2.16.840.1.113883.5.25"/>
  <recordTarget><patientRole><id root="1.2.410.100110.10.34100089.100" extension="{}"/><patient><name>{}</name></patient></patientRole></recordTarget>
  <author><time value="{ts}"/><assignedAuthor><id root="1.2.410.999999.2" extension="BIOMON-{}"/></assignedAuthor></author>
  <custodian><assignedCustodian><representedCustodianOrganization><id root="1.2.410.100110.10" extension="34100089"/></representedCustodianOrganization></assignedCustodian></custodian>
  <component><structuredBody><component><section><code code="8716-3" codeSystem="2.16.840.1.113883.6.1"/><title>활력징후</title><text>장비 측정값</text>
    <entry><organizer classCode="CLUSTER" moodCode="EVN"><statusCode code="completed"/>{obs}</organizer></entry>
  </section></component></structuredBody></component>
</ClinicalDocument>
"#,
        v.ts_ms,
        crate::auth::random_hex(2),
        xml_esc(&l.remote.id),
        xml_esc(&l.remote.name),
        xml_esc(&l.channel_id)
    );
    let url = format!("{}/cda/documents", site_base(cfg));
    let h = [("Authorization", format!("Bearer {}", auth_s(cfg, "token"))), ("Content-Type", "application/xml; charset=utf-8".into())];
    let r = hc::request("POST", &url, &h, Some(doc.as_bytes()), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    match r.status {
        200 | 201 => Ok(format!("문서 등록 ({})", r.status)),
        s if s >= 500 => Err(format!("HTTP {s}")),
        s => Err(format!("HTTP {s}: {}", r.text().chars().take(160).collect::<String>())),
    }
}

/// athenaOne 계열 (Bayside): 토큰(Basic) → 모니터링 환자 목록(페이지) → 열린 encounter 에 form-encoded vitals, 체온 °F
async fn athena_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let mut url = cfg.census_url.clone();
    let mut out = Vec::new();
    for _ in 0..30 {
        let tok = token(state, cfg, false).await?.unwrap_or_default();
        let r = hc::request("GET", &url, &[("Authorization", format!("Bearer {tok}"))], None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
        if r.status == 401 {
            if let Some(s) = state.emr.state.lock().unwrap().get_mut(&cfg.id) {
                s.token = None;
            }
            continue;
        }
        if r.status != 200 {
            let m = format!("환자 목록 HTTP {}: {}", r.status, r.text().chars().take(160).collect::<String>());
            state.emr.log(&cfg.id, "census", false, r.status.to_string(), m.clone());
            return Err(m);
        }
        let j = r.json().unwrap_or_default();
        for p in j["patients"].as_array().cloned().unwrap_or_default() {
            let id = p["patientid"].as_str().unwrap_or("").to_string();
            out.push(Remote {
                id: id.clone(),
                ident: id,
                name: format!("{} {}", p["firstname"].as_str().unwrap_or(""), p["lastname"].as_str().unwrap_or("")),
                location: format!("department {}", p["departmentid"].as_str().unwrap_or("")),
                encounter: None,
                pid_seg: None,
                pv1_seg: None,
            });
        }
        match j["next"].as_str().filter(|n| !n.is_empty()) {
            Some(n) if n.starts_with("http") => url = n.to_string(),
            Some(n) => {
                // athena 의 next 는 API 루트(= 기관 base_url) 기준 경로 — departmentid 가 빠져 있으면 붙인다
                url = format!("{}/{}", site_base(cfg), n.trim_start_matches('/'));
                if !url.contains("departmentid=") {
                    url.push_str(if url.contains('?') { "&departmentid=1" } else { "?departmentid=1" });
                }
            }
            None => break,
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

fn athena_prefix(cfg: &ConnCfg) -> String {
    // .../v1/{practiceid}/patients?departmentid=1 → .../v1/{practiceid}
    cfg.census_url.split("/patients").next().unwrap_or(&cfg.census_url).to_string()
}

async fn send_athena(state: &AppState, cfg: &ConnCfg, l: &Link, v: &Vit) -> Result<String, String> {
    let tok = token(state, cfg, false).await?.unwrap_or_default();
    let auth = ("Authorization", format!("Bearer {tok}"));
    let enc = match &l.remote.encounter {
        Some(e) => e.clone(),
        None => {
            let url = format!("{}/chart/{}/encounters?departmentid=1", athena_prefix(cfg), l.remote.id);
            let r = hc::request("GET", &url, std::slice::from_ref(&auth), None, Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
            let j = r.json().unwrap_or_default();
            let e = j["encounters"]
                .as_array()
                .and_then(|a| a.iter().find(|e| e["status"] == "OPEN"))
                .and_then(|e| e["encounterid"].as_str())
                .map(String::from)
                .ok_or("열린 encounter 가 없습니다")?;
            if let Some(s) = state.emr.state.lock().unwrap().get_mut(&cfg.id) {
                if let Some(x) = s.links.iter_mut().find(|x| x.channel_id == l.channel_id) {
                    x.remote.encounter = Some(e.clone());
                }
            }
            e
        }
    };
    let mut groups: Vec<Value> = Vec::new();
    let mut add = |id: &str, x: Option<f64>, dec: bool| {
        if let Some(x) = x {
            groups.push(json!([{"clinicalelementid": id, "value": if dec { format!("{x:.1}") } else { format!("{}", x.round()) }}]));
        }
    };
    add("VITALS.HEARTRATE", v.hr, false);
    add("VITALS.RESPIRATIONRATE", v.rr, false);
    add("VITALS.O2SATURATION", v.spo2, false);
    add("VITALS.TEMPERATURE", v.temp_c.map(|c| c * 9.0 / 5.0 + 32.0), true);
    let n = groups.len();
    let body = hc::form(&[("departmentid", "1"), ("source", "DEVICE"), ("vitals", &Value::Array(groups).to_string())]);
    let url = format!("{}/chart/encounter/{}/vitals", athena_prefix(cfg), enc);
    let r = hc::request("POST", &url, &[auth, ("Content-Type", "application/x-www-form-urlencoded".into())], Some(body.as_bytes()), Duration::from_secs(30)).await.map_err(|e| e.to_string())?;
    match r.status {
        200 | 201 => Ok(format!("{n}항목 저장 ({})", r.status)),
        s if s >= 500 => Err(format!("HTTP {s}")),
        401 => {
            if let Some(s) = state.emr.state.lock().unwrap().get_mut(&cfg.id) {
                s.token = None;
            }
            Err("HTTP 401 (토큰 재발급 예정)".into())
        }
        s => Err(format!("HTTP {s}: {}", r.text().chars().take(160).collect::<String>())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link() -> Link {
        Link {
            channel_id: "95134".into(),
            local_name: "x".into(),
            local_mrn: "MRN-1".into(),
            local_room: "103A01-A".into(),
            remote: Remote { id: "M1".into(), ident: "M1".into(), name: "A".into(), location: "".into(), encounter: Some("V1".into()), pid_seg: Some("PID|1||M1^^^PRCH^MR||DOE^JOHN".into()), pv1_seg: Some("PV1|1|I|2MS^201^A^PRCH".into()) },
            matched_by: "pair".into(),
            last_sent_ms: 0,
            last_result: String::new(),
            ok: 0,
            fail: 0,
        }
    }

    #[test]
    fn oru_per_site_headers() {
        let v = Vit { hr: Some(80.0), rr: Some(16.0), spo2: Some(97.0), temp_c: Some(36.8), ts_ms: 1_790_000_000_000, device: String::new() };
        let mut c = ConnCfg { protocol: "hl7v2".into(), flavor: "ca-v23".into(), version: "2.3".into(), tz: "America/Toronto".into(), facility: "SLGH".into(), receiving_app: "HIS".into(), charset: "utf-8".into(), ..Default::default() };
        let m = build_oru(&c, &link(), &v, "C1");
        assert!(m.starts_with("MSH|^~\\&|BIOMON|BIOMON|HIS|SLGH|"), "{m}");
        assert!(m.contains("||ORU^R01|C1|P|2.3\r"), "{m}");
        assert!(!m.split('\r').next().unwrap().split('|').nth(6).unwrap().contains('-'), "no offset for 2.3");
        c.flavor = "pam-fr".into();
        c.version = "2.5".into();
        c.charset = "iso-8859-1".into();
        let m = build_oru(&c, &link(), &v, "C2");
        assert!(m.split('\r').next().unwrap().ends_with("|2.5|||||FRA|8859/1"), "{m}");
        c.flavor = "meditech".into();
        c.version = "2.5.1".into();
        c.charset = "utf-8".into();
        let m = build_oru(&c, &link(), &v, "C3");
        assert!(m.contains("[degF]"), "US sends °F");
        assert!(m.split('\r').next().unwrap().ends_with("|2.5.1"), "{m}");
    }

    #[test]
    fn hl7_adt_parse() {
        let er7 = "MSH|^~\\&|MEDITECH|PRCH|BIOMON|BIOMON|20260920210938-0400||ADT^A02^ADT_A02|1|P|2.5.1\rPID|1||M000400755^^^PRCH^MR||BROWN^RICHARD^W\rPV1|1|I|2MS^209^A^PRCH||||||||||||||||V0012000026^^^PRCH^VN";
        let r = hl7_remote(er7).unwrap();
        assert_eq!(r.id, "M000400755");
        assert_eq!(r.name, "BROWN RICHARD");
        assert_eq!(r.location, "2MS-209-A");
        assert_eq!(r.encounter.as_deref(), Some("V0012000026"));
        assert_eq!(adt_label("A03"), "퇴원");
        let c = ConnCfg { census_url: "http://h:5445/emrsim/us-pineridge/hl7/census".into(), ..Default::default() };
        assert_eq!(site_base(&c), "http://h:5445/emrsim/us-pineridge");
    }

    #[test]
    fn xml_helpers() {
        let x = "<R><RSLT_CD>S</RSLT_CD><DATA><A>1</A></DATA><DATA><A>2</A></DATA></R>";
        assert_eq!(tag(x, "RSLT_CD"), "S");
        assert_eq!(blocks(x, "DATA").iter().map(|d| tag(d, "A")).collect::<Vec<_>>(), vec!["1", "2"]);
        assert_eq!(strip_method("POST http://h/t (Basic client_id:secret, x)"), "http://h/t");
        assert_eq!(strip_method("POST http://h/if  (Content-Type: text/xml)"), "http://h/if");
    }

    #[test]
    fn jp_encoding_roundtrip() {
        let c = ConnCfg { charset: "iso-2022-jp".into(), ..Default::default() };
        let b = encode(&c, "伊藤^一郎");
        assert!(b.contains(&0x1b), "ISO-2022-JP escape sequences");
        assert_eq!(decode(&c, &b), "伊藤^一郎");
    }
}
