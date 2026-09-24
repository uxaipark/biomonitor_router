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
            }
            if kicks.contains(&"send") || now.saturating_sub(last_send) >= cfg.interval_s.max(15) * 1000 {
                send_all(&state, &cfg).await?;
                last_send = now_ms();
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
            let b = state.emr.state.lock().unwrap().get(&id).map(|s| s.backoff_s).unwrap_or(0);
            state.emr.log(&id, "error", false, "재시도 대기", format!("{e} — {b} s 뒤 다시"));
            last_census = 0;
            last_send = 0;
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
        p => return Err(format!("지원하지 않는 형식: {p}")),
    };
    let n = remotes.len();
    let links = match_patients(state, cfg, remotes);
    let paired = links.len();
    {
        let mut st = state.emr.state.lock().unwrap();
        let s = st.entry(cfg.id.clone()).or_default();
        // 기존 전송 이력은 같은 (패치, 원격 환자) 짝에 이어 붙인다
        let old: HashMap<(String, String), Link> = s.links.drain(..).map(|l| ((l.channel_id.clone(), l.remote.id.clone()), l)).collect();
        s.links = links
            .into_iter()
            .map(|mut l| {
                if let Some(o) = old.get(&(l.channel_id.clone(), l.remote.id.clone())) {
                    l.ok = o.ok;
                    l.fail = o.fail;
                    l.last_sent_ms = o.last_sent_ms;
                    l.last_result = o.last_result.clone();
                    if l.remote.encounter.is_none() {
                        l.remote.encounter = o.remote.encounter.clone();
                    }
                }
                l
            })
            .collect();
        s.census = n;
        s.census_ms = now_ms();
    }
    state.emr.log(&cfg.id, "census", true, "OK", format!("재원 {n}명 · 매칭 {paired}명 ({})", if cfg.match_mode == "mrn" { "MRN 일치" } else { "시험용 짝짓기" }));
    Ok(())
}

async fn fhir_census(state: &AppState, cfg: &ConnCfg) -> Result<Vec<Remote>, String> {
    let mut url = cfg.census_url.clone();
    let mut out: Vec<Remote> = Vec::new();
    let mut pats: HashMap<String, (String, String)> = HashMap::new(); // id → (name, mrn)
    for _page in 0..20 {
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
        let segs: Vec<&str> = er7.split(['\r', '\n']).filter(|s| !s.is_empty()).collect();
        let pid = segs.iter().find(|s| s.starts_with("PID|")).map(|s| s.to_string());
        let pv1 = segs.iter().find(|s| s.starts_with("PV1|")).map(|s| s.to_string());
        let Some(pid_s) = pid.clone() else { continue };
        let f: Vec<&str> = pid_s.split('|').collect();
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
        out.push(Remote { id: first_id.clone(), ident: first_id, name, location: loc, encounter: if visit.is_empty() { None } else { Some(visit) }, pid_seg: pid, pv1_seg: pv1 });
    }
    out.sort_by(|a, b| a.location.cmp(&b.location).then(a.id.cmp(&b.id)));
    Ok(out)
}

// ───────────────────────────── 매칭 ─────────────────────────────

fn match_patients(state: &AppState, cfg: &ConnCfg, remotes: Vec<Remote>) -> Vec<Link> {
    let mut locals: Vec<(String, String, String, String)> = state
        .registry
        .snapshot()
        .into_iter()
        .filter(|c| c.connected)
        .filter_map(|c| {
            let p = c.patient.as_ref()?;
            if !cfg.scope_ward.is_empty() && p.ward != cfg.scope_ward {
                return None;
            }
            Some((c.channel_id.clone(), p.name.clone(), c.mrn.clone(), if p.bed.is_empty() { p.room.clone() } else { p.bed.clone() }))
        })
        .collect();
    locals.sort_by(|a, b| a.3.cmp(&b.3).then(a.0.cmp(&b.0)));
    let mk = |l: &(String, String, String, String), r: Remote| Link {
        channel_id: l.0.clone(),
        local_name: l.1.clone(),
        local_mrn: l.2.clone(),
        local_room: l.3.clone(),
        remote: r,
        last_sent_ms: 0,
        last_result: String::new(),
        ok: 0,
        fail: 0,
    };
    let mut out = Vec::new();
    if cfg.match_mode == "mrn" {
        for l in &locals {
            if let Some(r) = remotes.iter().find(|r| !r.ident.is_empty() && (r.ident == l.2 || r.ident == l.2.trim_start_matches("MRN-"))) {
                out.push(mk(l, r.clone()));
            }
        }
    } else {
        for (l, r) in locals.iter().zip(remotes) {
            out.push(mk(l, r));
        }
    }
    out.truncate(cfg.max_patients.max(1));
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

async fn send_all(state: &AppState, cfg: &ConnCfg) -> Result<(), String> {
    let links: Vec<Link> = state.emr.state.lock().unwrap().get(&cfg.id).map(|s| s.links.clone()).unwrap_or_default();
    if links.is_empty() {
        return Ok(());
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
    state.emr.log(&cfg.id, "send", fail == 0, if fail == 0 { "OK" } else { "일부 실패" }, format!("바이탈 전송 {ok}명 성공 · {fail}명 실패"));
    match hard {
        Some(h) => Err(h),
        None => Ok(()),
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
    s.split("  ").next().unwrap_or(s).trim().to_string()
}

/// 가상 EMR 카탈로그의 기관 한 곳 → 연결 설정. 지원 형식이 아니면 None.
pub fn from_catalog(site: &Value, emu_host: &str) -> Option<ConnCfg> {
    let protocol = site["protocol"].as_str()?.to_string();
    if !matches!(protocol.as_str(), "fhir" | "hl7v2") {
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
        census_url: ep["census"].as_str().map(strip_method).unwrap_or_default(),
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
    fn jp_encoding_roundtrip() {
        let c = ConnCfg { charset: "iso-2022-jp".into(), ..Default::default() };
        let b = encode(&c, "伊藤^一郎");
        assert!(b.contains(&0x1b), "ISO-2022-JP escape sequences");
        assert_eq!(decode(&c, &b), "伊藤^一郎");
    }
}
