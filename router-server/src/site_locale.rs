//! 사이트 국가(신원 세트) — 에뮬레이터의 '송출 국가'(KR/US/JP)를 읽고, 로그인 화면에서 고른 국가로 바꾸도록 요청한다.
//! 콘솔은 `GET /api/site/locale`(로그인 전에도 열림)로 기본 언어를 정한다. 국가·세트 버전이 바뀌면 EMR 캐시를 비워
//! 환자 이름·주소·MRN 이 새 세트로 다시 읽히게 한다(환자 식별은 patch_id 그대로 — 표시만 갱신).
use crate::state::AppState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use tracing::{info, warn};

#[derive(Clone, Default, serde::Serialize)]
pub struct Site {
    pub country: String,
    pub locale: String,
    pub version: u64,
    pub source: String,
    pub updated_ms: u64,
}
pub static SITE: std::sync::LazyLock<RwLock<Site>> = std::sync::LazyLock::new(|| RwLock::new(Site::default()));
/// EMR 동기화 루프가 보고 집주소 캐시를 비우는 신호
pub static RESET_HOME: AtomicBool = AtomicBool::new(false);

pub fn locale_of(c: &str) -> &'static str {
    match c { "US" => "en-US", "JP" => "ja-JP", _ => "ko-KR" }
}
pub fn get() -> Site {
    SITE.read().unwrap().clone()
}

/// 에뮬레이터에서 현재 국가를 읽는다: /identities → /emr/hospital(country) → /config(identity_country·patient_country)
pub async fn refresh(state: &Arc<AppState>) {
    let Some(addr) = state.net.emulator() else { return };
    let mut found: Option<(String, u64, &str)> = None;
    if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/identities", None).await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(c) = v.get("current").and_then(|x| x.as_str().map(String::from).or_else(|| x.get("country").and_then(|y| y.as_str()).map(String::from))) {
                found = Some((c, v.get("version").and_then(|x| x.as_u64()).unwrap_or(0), "identities"));
            }
        }
    }
    if found.is_none() {
        if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/hospital", None).await {
            if let Some(c) = serde_json::from_str::<serde_json::Value>(&body).ok().and_then(|v| v.get("country").and_then(|x| x.as_str()).map(String::from)) {
                found = Some((c, 0, "hospital"));
            }
        }
    }
    if found.is_none() {
        if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/config", None).await {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                let c = v.pointer("/config/transport/identity_country").or_else(|| v.pointer("/config/general/patient_country")).and_then(|x| x.as_str()).map(String::from);
                if let Some(c) = c { found = Some((c, 0, "config")); }
            }
        }
    }
    let Some((c, ver, src)) = found else { return };
    let c = c.to_uppercase();
    let prev = get();
    let changed = !prev.country.is_empty() && (prev.country != c || (ver > 0 && prev.version != ver));
    *SITE.write().unwrap() = Site { locale: locale_of(&c).into(), country: c.clone(), version: ver, source: src.into(), updated_ms: crate::protocol::now_ms() };
    if changed {
        on_changed(state, &prev.country, &c);
    }
}

fn on_changed(state: &Arc<AppState>, from: &str, to: &str) {
    state.emr_cache.lock().unwrap().clear();
    RESET_HOME.store(true, Ordering::Relaxed);
    info!("site country {} → {}: EMR 캐시 비움", from, to);
    state.push_event("site_country", None, format!("송출 국가 변경: {from} → {to} — 환자 이름·주소·MRN 을 새 세트로 다시 읽습니다"));
}

/// 국가 전환 요청 (로그인 화면 선택). 에뮬레이터 POST /api/v1/identities/select, 없으면 PATCH /api/v1/config 로.
pub async fn select(state: &Arc<AppState>, country: &str, by: &str, reason: &str) -> Result<String, String> {
    let c = country.trim().to_uppercase();
    if !matches!(c.as_str(), "KR" | "US" | "JP") {
        return Err(format!("알 수 없는 국가 {c}"));
    }
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다")?;
    if get().country == c {
        return Ok(format!("이미 {c}"));
    }
    let body = serde_json::json!({ "country": c, "by": by, "reason": reason }).to_string();
    let r = crate::emu_link::request(&addr, "POST", "/api/v1/identities/select", Some(&body)).await.map_err(|e| e.to_string())?;
    let how = if r.0 == 200 {
        "identities/select"
    } else {
        let patch = serde_json::json!({ "transport": { "identity_country": c } }).to_string();
        let r2 = crate::emu_link::request(&addr, "PATCH", "/api/v1/config", Some(&patch)).await.map_err(|e| e.to_string())?;
        if r2.0 != 200 {
            return Err(format!("에뮬레이터가 국가 전환을 거부했습니다 (select HTTP {}, config HTTP {}: {})", r.0, r2.0, r2.1.chars().take(160).collect::<String>()));
        }
        "config.transport.identity_country"
    };
    // 채팅에도 한 줄 (에뮬레이터 로그 참고용)
    let msg = serde_json::json!({ "from": "router", "text": format!("[fitlet3 라우터] 송출 국가 전환 요청 {c} ({how}) — {reason}") }).to_string();
    let _ = crate::emu_link::request(&addr, "POST", "/api/v1/chat", Some(&msg)).await;
    state.auth.audit(by, "", "site_country", &format!("{c} via {how}"));
    refresh(state).await;
    Ok(format!("{c} ({how})"))
}

/// 60초마다 국가를 다시 읽는다
pub async fn run(state: Arc<AppState>) {
    loop {
        refresh(&state).await;
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
}
#[allow(dead_code)]
fn _unused() { warn!("") }
