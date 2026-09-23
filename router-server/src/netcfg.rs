//! 네트워크 설정(에뮬레이터·분석 서버·DB API 주소)을 실행 중에 바꿀 수 있게 하는 저장소.
//!
//! 우선순위는 **DB 값 > 환경변수**다. 콘솔(설정 › 네트워크 설정)에서 저장하면 `router.db` 의 `settings` 표에 남고,
//! 비우면 다시 환경변수 값으로 돌아간다. 재연결 루프(emu_link·analysis_link·db_link)와 EMR 프록시가 매번 여기서
//! 주소를 읽으므로 **라우터를 재시작하지 않아도** 즉시 반영된다.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, RwLock};
use tracing::{info, warn};

const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);";
const K_EMU: &str = "net.emulator_addr";
const K_ANALYSIS: &str = "net.analysis_addr";
const K_DB: &str = "net.db_addr";

/// 주소 한 칸의 현재 값과 출처
#[derive(Clone, Serialize)]
pub struct Field {
    /// 실제 사용 중인 값 (없으면 기능 꺼짐)
    pub value: String,
    /// "db" = 콘솔에서 저장한 값, "env" = 환경변수/기본값, "unset" = 없음
    pub source: &'static str,
    /// 환경변수(또는 기본값) — 콘솔 값을 비웠을 때 돌아갈 주소
    pub env: String,
}

#[derive(Deserialize, Default)]
pub struct NetInput {
    /// 각 항목: 값이 있으면 저장, 빈 문자열이면 DB 값 삭제(환경변수로 복귀), 없으면(`null`) 그대로 둠
    pub emulator_addr: Option<String>,
    pub analysis_addr: Option<String>,
    pub db_addr: Option<String>,
}

pub struct NetCfg {
    db: Mutex<Connection>,
    env_emu: Option<String>,
    env_analysis: String,
    env_db: String,
    cur: RwLock<(Option<String>, String, String)>, // (emulator, analysis, db)
}

/// 대상별 기본 포트 — 포트를 생략하면 이 값을 붙인다.
pub const PORT_EMULATOR: u16 = 5445;
pub const PORT_ANALYSIS: u16 = 7100;
pub const PORT_DB: u16 = 7601;

/// `host:port` 로 정리한다. 포트를 안 쓰면 `default_port` 를 붙이고, IPv6 는 `[::1]:5445` 형태를 요구한다.
fn check(addr: &str, what: &str, default_port: u16) -> Result<String, String> {
    let a = addr.trim();
    if a.is_empty() {
        return Err(format!("{what} 주소가 비어 있습니다"));
    }
    // IPv6: 대괄호가 있으면 그 뒤에서만 포트를 찾는다
    let (host, port) = if let Some(rest) = a.strip_prefix('[') {
        let Some((h, after)) = rest.split_once(']') else {
            return Err(format!("{what} IPv6 주소는 [::1]:{default_port} 형식이어야 합니다"));
        };
        (h.to_string(), after.strip_prefix(':').map(|p| p.to_string()))
    } else if a.matches(':').count() > 1 {
        return Err(format!("{what} IPv6 주소는 대괄호가 필요합니다 (예: [::1]:{default_port})"));
    } else if let Some((h, p)) = a.split_once(':') {
        (h.to_string(), Some(p.to_string()))
    } else {
        (a.to_string(), None) // 포트 생략 → 기본 포트
    };
    if host.trim().is_empty() {
        return Err(format!("{what} 호스트가 비어 있습니다"));
    }
    let host = if a.starts_with('[') { format!("[{host}]") } else { host };
    match port {
        None => Ok(format!("{host}:{default_port}")),
        Some(p) => match p.parse::<u16>() {
            Ok(n) if n > 0 => Ok(format!("{host}:{n}")),
            _ => Err(format!("{what} 포트가 올바르지 않습니다: {p} (비워 두면 {default_port} 을 씁니다)")),
        },
    }
}

impl NetCfg {
    pub fn open(db_path: &str, cfg: &crate::config::Config) -> Self {
        let db = Connection::open(db_path).unwrap_or_else(|e| {
            warn!("netcfg db open {} failed ({}): in-memory", db_path, e);
            Connection::open_in_memory().expect("in-memory sqlite")
        });
        let _ = db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
        if let Err(e) = db.execute_batch(SCHEMA) {
            warn!("netcfg schema: {}", e);
        }
        let get = |k: &str| -> Option<String> {
            db.query_row("SELECT value FROM settings WHERE key = ?1", params![k], |r| r.get::<_, String>(0))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let (emu, analysis, dbaddr) = (get(K_EMU), get(K_ANALYSIS), get(K_DB));
        let me = Self {
            env_emu: cfg.emulator_addr.clone(),
            env_analysis: cfg.analysis_addr.clone(),
            env_db: cfg.db_addr.clone(),
            cur: RwLock::new((
                emu.clone().or_else(|| cfg.emulator_addr.clone()),
                analysis.clone().unwrap_or_else(|| cfg.analysis_addr.clone()),
                dbaddr.clone().unwrap_or_else(|| cfg.db_addr.clone()),
            )),
            db: Mutex::new(db),
        };
        let c = me.cur.read().unwrap();
        info!(
            "network: emulator {} ({}), analysis {} ({}), db {} ({})",
            c.0.clone().unwrap_or_else(|| "미설정".into()),
            if emu.is_some() { "db" } else if me.env_emu.is_some() { "env" } else { "unset" },
            c.1,
            if analysis.is_some() { "db" } else { "env" },
            c.2,
            if dbaddr.is_some() { "db" } else { "env" },
        );
        if c.0.is_none() {
            warn!("network: 에뮬레이터 주소 미설정 — 도면·환자 명단(/api/emr/*)·상태 보고가 꺼집니다. 설정 › 네트워크 설정에서 지정하세요.");
        }
        drop(c);
        me
    }

    pub fn emulator(&self) -> Option<String> {
        self.cur.read().unwrap().0.clone()
    }
    pub fn analysis(&self) -> String {
        self.cur.read().unwrap().1.clone()
    }
    pub fn db_api(&self) -> String {
        self.cur.read().unwrap().2.clone()
    }

    fn stored(&self, key: &str) -> Option<String> {
        self.db
            .lock()
            .ok()?
            .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| r.get::<_, String>(0))
            .ok()
    }

    pub fn view(&self) -> serde_json::Value {
        let c = self.cur.read().unwrap();
        let f = |val: Option<String>, stored: Option<String>, env: Option<String>| Field {
            value: val.unwrap_or_default(),
            source: if stored.is_some() { "db" } else if env.is_some() { "env" } else { "unset" },
            env: env.unwrap_or_default(),
        };
        serde_json::json!({
            "emulator_addr": f(c.0.clone(), self.stored(K_EMU), self.env_emu.clone()),
            "analysis_addr": f(Some(c.1.clone()), self.stored(K_ANALYSIS), Some(self.env_analysis.clone())),
            "db_addr": f(Some(c.2.clone()), self.stored(K_DB), Some(self.env_db.clone())),
        })
    }

    /// 저장: 값이 있으면 검사 후 DB 에 쓰고, 빈 문자열이면 DB 값을 지워 환경변수로 되돌린다.
    pub fn apply(&self, inp: NetInput) -> Result<Vec<String>, String> {
        let mut changed = Vec::new();
        let mut set = |key: &str, what: &str, v: &Option<String>, default_port: u16| -> Result<Option<Option<String>>, String> {
            let Some(raw) = v else { return Ok(None) };
            if raw.trim().is_empty() {
                if let Ok(db) = self.db.lock() {
                    let _ = db.execute("DELETE FROM settings WHERE key = ?1", params![key]);
                }
                changed.push(format!("{what} 초기화(환경변수 값 사용)"));
                return Ok(Some(None));
            }
            let ok = check(raw, what, default_port)?;
            if let Ok(db) = self.db.lock() {
                let _ = db.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)", params![key, ok]);
            }
            changed.push(format!("{what} → {ok}"));
            Ok(Some(Some(ok)))
        };
        let emu = set(K_EMU, "에뮬레이터", &inp.emulator_addr, PORT_EMULATOR)?;
        let ana = set(K_ANALYSIS, "분석 서버", &inp.analysis_addr, PORT_ANALYSIS)?;
        let dba = set(K_DB, "DB API", &inp.db_addr, PORT_DB)?;
        {
            let mut c = self.cur.write().unwrap();
            if let Some(v) = emu {
                c.0 = v.or_else(|| self.env_emu.clone());
            }
            if let Some(v) = ana {
                c.1 = v.unwrap_or_else(|| self.env_analysis.clone());
            }
            if let Some(v) = dba {
                c.2 = v.unwrap_or_else(|| self.env_db.clone());
            }
        }
        if !changed.is_empty() {
            info!("network: {}", changed.join(", "));
        }
        Ok(changed)
    }
}

/// 연결 시험 — 저장 전에 주소가 살아 있는지 본다. 에뮬레이터는 `/api/v1/status`(HTTP), 나머지는 TCP 접속만.
pub async fn test(kind: &str, addr: &str) -> serde_json::Value {
    let (what, port) = match kind {
        "emulator" => ("에뮬레이터", PORT_EMULATOR),
        "analysis" => ("분석 서버", PORT_ANALYSIS),
        "db" => ("DB API", PORT_DB),
        _ => return serde_json::json!({"ok": false, "msg": "알 수 없는 대상"}),
    };
    let addr = match check(addr, what, port) {
        Ok(a) => a,
        Err(e) => return serde_json::json!({"ok": false, "msg": e}),
    };
    let t0 = std::time::Instant::now();
    if kind == "emulator" {
        return match crate::emu_link::request(&addr, "GET", "/api/v1/status", None).await {
            Ok((200, body)) => {
                let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
                let running = v.get("running").and_then(|x| x.as_bool()).unwrap_or(false);
                let pkts = v.get("last").and_then(|l| l.get("pkts_ps")).and_then(|x| x.as_f64()).unwrap_or(0.0);
                let target = v.get("target").map(|t| format!("{}:{}", t.get("ip").and_then(|x| x.as_str()).unwrap_or("?"), t.get("port").and_then(|x| x.as_u64()).unwrap_or(0)));
                serde_json::json!({
                    "ok": true,
                    "ms": t0.elapsed().as_millis() as u64,
                    "addr": addr,
                    "msg": format!("{addr} 응답 — 전송 {}, {:.0} pkt/s{}", if running { "중" } else { "정지" }, pkts,
                        target.map(|t| format!(", 대상 {t}")).unwrap_or_default()),
                })
            }
            Ok((code, _)) => serde_json::json!({"ok": false, "ms": t0.elapsed().as_millis() as u64, "msg": format!("HTTP {code} — 에뮬레이터 API 가 아닌 것 같습니다")}),
            Err(e) => serde_json::json!({"ok": false, "ms": t0.elapsed().as_millis() as u64, "msg": format!("연결 실패: {e}")}),
        };
    }
    match tokio::time::timeout(std::time::Duration::from_secs(5), tokio::net::TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => serde_json::json!({"ok": true, "ms": t0.elapsed().as_millis() as u64, "addr": addr, "msg": format!("{addr} 포트 열림")}),
        Ok(Err(e)) => serde_json::json!({"ok": false, "ms": t0.elapsed().as_millis() as u64, "msg": format!("연결 실패: {e}")}),
        Err(_) => serde_json::json!({"ok": false, "ms": 5000, "msg": "시간 초과(5초)"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addr_check() {
        assert_eq!(check("192.168.0.125:5445", "x", PORT_EMULATOR).unwrap(), "192.168.0.125:5445");
        assert_eq!(check("  host.local:80  ", "x", PORT_EMULATOR).unwrap(), "host.local:80");
        // 포트 생략 → 대상별 기본 포트
        assert_eq!(check("192.168.0.125", "x", PORT_EMULATOR).unwrap(), "192.168.0.125:5445");
        assert_eq!(check("127.0.0.1", "x", PORT_ANALYSIS).unwrap(), "127.0.0.1:7100");
        assert_eq!(check("db.local", "x", PORT_DB).unwrap(), "db.local:7601");
        // IPv6 는 대괄호 필요
        assert_eq!(check("[::1]:5445", "x", PORT_EMULATOR).unwrap(), "[::1]:5445");
        assert_eq!(check("[::1]", "x", PORT_EMULATOR).unwrap(), "[::1]:5445");
        assert!(check("::1", "x", PORT_EMULATOR).is_err());
        assert!(check(":5445", "x", PORT_EMULATOR).is_err()); // 호스트 없음
        assert!(check("host:0", "x", PORT_EMULATOR).is_err());
        assert!(check("host:abc", "x", PORT_EMULATOR).is_err());
        assert!(check("", "x", PORT_EMULATOR).is_err());
    }

    #[test]
    fn db_value_wins_and_clears_back_to_env() {
        let dir = std::env::temp_dir().join(format!("netcfg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.db");
        let mut cfg = crate::config::Config::from_env();
        cfg.emulator_addr = Some("10.0.0.1:5445".into());
        cfg.analysis_addr = "127.0.0.1:7100".into();
        cfg.db_addr = "127.0.0.1:7601".into();

        let n = NetCfg::open(path.to_str().unwrap(), &cfg);
        assert_eq!(n.emulator().unwrap(), "10.0.0.1:5445"); // 환경변수

        // 포트 없이 저장해도 기본 포트가 붙는다
        n.apply(NetInput { emulator_addr: Some("192.168.0.9".into()), ..Default::default() }).unwrap();
        assert_eq!(n.emulator().unwrap(), "192.168.0.9:5445"); // DB 값이 이김
        assert_eq!(n.view()["emulator_addr"]["source"], "db");

        // 재시작해도 유지
        let n2 = NetCfg::open(path.to_str().unwrap(), &cfg);
        assert_eq!(n2.emulator().unwrap(), "192.168.0.9:5445");

        // 빈 문자열 → 환경변수로 복귀
        n2.apply(NetInput { emulator_addr: Some("".into()), ..Default::default() }).unwrap();
        assert_eq!(n2.emulator().unwrap(), "10.0.0.1:5445");
        assert_eq!(n2.view()["emulator_addr"]["source"], "env");

        // 포트 없는 한 단어는 호스트 이름으로 보고 기본 포트를 붙인다
        n2.apply(NetInput { analysis_addr: Some("analysis.local".into()), ..Default::default() }).unwrap();
        assert_eq!(n2.analysis(), "analysis.local:7100");
        // 포트가 숫자가 아니면 거절
        assert!(n2.apply(NetInput { analysis_addr: Some("host:port".into()), ..Default::default() }).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
