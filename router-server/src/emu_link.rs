//! Emulator link: a tiny HTTP/1.1 client (the emulator speaks plain HTTP on the LAN) used to
//!  * report router status to `POST /api/v1/router/status` every few seconds, and
//!  * pull `GET /api/v1/emr/admissions` so registry rows carry patient names / wards / staff.

use crate::state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::{debug, info, warn};

/// 에뮬레이터가 마지막으로 정상 응답한 시각(ms). 0 = 아직 한 번도 붙지 못함 (콘솔 네트워크 설정 표시용).
pub static LAST_OK_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Minimal request: returns (status, body). `Connection: close`, so the body is everything after the header.
pub async fn request(addr: &str, method: &str, path: &str, body: Option<&str>) -> anyhow::Result<(u16, String)> {
    let mut s = tokio::time::timeout(Duration::from_secs(5), TcpStream::connect(addr)).await??;
    let host = addr.split(':').next().unwrap_or(addr);
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nAccept: application/json\r\n");
    if let Some(b) = body {
        req.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    if let Some(b) = body {
        req.push_str(b);
    }
    s.write_all(req.as_bytes()).await?;
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(60), s.read_to_end(&mut raw)).await??;
    let text = String::from_utf8_lossy(&raw);
    let (head, rest) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status: u16 = head.split_whitespace().nth(1).and_then(|c| c.parse().ok()).unwrap_or(0);
    let chunked = head.to_ascii_lowercase().contains("transfer-encoding: chunked");
    let body = if chunked { dechunk(rest) } else { rest.to_string() };
    if status == 200 {
        LAST_OK_MS.store(crate::protocol::now_ms(), std::sync::atomic::Ordering::Relaxed);
    }
    Ok((status, body))
}

fn dechunk(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    loop {
        let Some((size, after)) = rest.split_once("\r\n") else { break };
        let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
        if n == 0 || after.len() < n {
            break;
        }
        out.push_str(&after[..n]);
        rest = after[n..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

/// Status report loop (every `every` seconds).
pub async fn run_reporter(state: Arc<AppState>, every: u64) {
    let mut tick = tokio::time::interval(Duration::from_secs(every.max(1)));
    loop {
        tick.tick().await;
        // 주소는 매 주기 다시 읽는다 — 콘솔(설정 › 네트워크 설정)에서 바꾸면 재시작 없이 붙는다
        let Some(addr) = state.net.emulator() else { continue };
        let body = state.status_report().to_string();
        match request(&addr, "POST", "/api/v1/router/status", Some(&body)).await {
            Ok((200, _)) => {}
            Ok((code, _)) => debug!("status report: HTTP {}", code),
            Err(e) => debug!("status report failed: {}", e),
        }
    }
}

/// EMR sync loop: admissions → patient names/wards/staff on the registry rows keyed by patch id.
pub async fn run_emr_sync(state: Arc<AppState>, every: u64) {
    let mut tick = tokio::time::interval(Duration::from_secs(every.max(5)));
    // home address lives only in the per-patient detail (`/emr/patients/{profile}` → address{sido,sigungu,dong,label});
    // fetched for outside (MCOT) patients only and remembered per profile id, refreshed hourly
    let mut home_cache: std::collections::HashMap<u64, (std::time::Instant, String, String)> = std::collections::HashMap::new();
    loop {
        tick.tick().await;
        let Some(addr) = state.net.emulator() else { continue };
        match request(&addr, "GET", "/api/v1/emr/admissions", None).await {
            Ok((200, body)) => match serde_json::from_str::<serde_json::Value>(&body) {
                Ok(v) => {
                    let n = apply_admissions(&state, &v);
                    debug!("emr sync: {} admissions applied", n);
                    // Patches the EMR no longer lists (discharged, replaced, or a rebuilt patient set) whose records
                    // stopped ≥ 60 s ago: drop the row now instead of waiting for the 15-min prune, otherwise they
                    // linger as connected-but-silent cards in the viewers.
                    let listed: std::collections::HashSet<String> = v
                        .get("admissions")
                        .and_then(|a| a.as_array())
                        .map(|a| a.iter().filter_map(|x| x.get("patch_id").and_then(|p| p.as_u64())).map(|p| p.to_string()).collect())
                        .unwrap_or_default();
                    if listed.len() >= 10 {
                        let now = crate::protocol::now_ms();
                        let mut gone = Vec::new();
                        state.registry.for_each(|ch, st| {
                            if !listed.contains(ch) && st.last_ts_ms > 0 && now.saturating_sub(st.last_ts_ms) > 60_000 {
                                gone.push(ch.to_string());
                            }
                        });
                        for ch in &gone {
                            state.remove_channel(ch);
                        }
                        if !gone.is_empty() {
                            info!("emr sync: removed {} silent patches no longer in admissions", gone.len());
                        }
                    }
                }
                Err(e) => warn!("emr sync: bad JSON: {}", e),
            },
            Ok((code, _)) => warn!("emr sync: HTTP {}", code),
            Err(e) => {
                info!("emr sync: emulator {} unreachable ({})", addr, e);
                continue;
            }
        }
        // patients feed: specialty (진료과목) and disease (주진단) per patch — the admissions feed lacks both.
        // The emulator caps limit at 10,000; page by offset until `total` is covered.
        let mut offset = 0usize;
        let mut applied = 0usize;
        loop {
            let path = format!("/api/v1/emr/patients?status=admitted&limit=10000&offset={offset}");
            match request(&addr, "GET", &path, None).await {
                Ok((200, body)) => match serde_json::from_str::<serde_json::Value>(&body) {
                    Ok(v) => {
                        let got = v.get("patients").and_then(|a| a.as_array()).map(|a| a.len()).unwrap_or(0);
                        let total = v.get("total").and_then(|t| t.as_u64()).unwrap_or(0) as usize;
                        applied += apply_patients(&state, &v);
                        offset += got;
                        if got == 0 || offset >= total {
                            break;
                        }
                    }
                    Err(e) => {
                        warn!("emr sync (patients): bad JSON: {}", e);
                        break;
                    }
                },
                Ok((code, _)) => {
                    debug!("emr sync (patients): HTTP {}", code);
                    break;
                }
                Err(e) => {
                    debug!("emr sync (patients): {}", e);
                    break;
                }
            }
        }
        if applied > 0 {
            info!("emr sync: {} patient records updated (specialty/diagnosis)", applied);
        }
        sync_home_addresses(&state, &addr, &mut home_cache).await;
    }
}

/// `/api/v1/emr/patients` → department (specialty) / diagnosis (disease) on the registry rows.
pub fn apply_patients(state: &Arc<AppState>, v: &serde_json::Value) -> usize {
    let list = match v {
        serde_json::Value::Array(a) => a,
        other => match other.get("patients").and_then(|a| a.as_array()) {
            Some(a) => a,
            None => return 0,
        },
    };
    let mut n = 0;
    for a in list {
        let Some(patch_id) = a.get("patch_id").and_then(|x| x.as_u64()) else { continue };
        let channel_id = patch_id.to_string();
        let Some(prev) = state.registry.patient_of(&channel_id) else { continue };
        let mut p = prev.clone();
        let spec = s(a, "specialty");
        if !spec.is_empty() {
            p.department = spec;
        }
        let dis = s(a, "disease");
        if !dis.is_empty() {
            p.diagnosis = dis;
        }
        apply_home(&mut p, a);
        if prev != p {
            state.registry.upsert_meta(&channel_id, p);
            state.recompute_channel_groups(&channel_id);
            n += 1;
        }
    }
    n
}

/// Home address from an EMR record, tolerant of the field shapes the emulator may use:
/// `home_region` / `region` (short area name), `home_address` / `address` (string, or an object with
/// `region`/`city`/`district`/`full`). Only overwrites when a value is present.
fn apply_home(p: &mut crate::protocol::Patient, a: &serde_json::Value) {
    let region = ["home_region", "region", "area"].iter().map(|k| s(a, k)).find(|v| !v.is_empty());
    let addr = a.get("home_address").or_else(|| a.get("address"));
    let (obj_region, full) = match addr {
        Some(serde_json::Value::String(x)) => (None, x.clone()),
        Some(o @ serde_json::Value::Object(_)) => {
            // emulator shape: {sido, sigungu, dong, label} → region "인천 부평구", full = label; generic keys as fallback
            let mut r = ["sido", "sigungu"].iter().map(|k| s(o, k)).filter(|v| !v.is_empty()).collect::<Vec<_>>();
            if r.is_empty() {
                r = ["region", "city", "district"].iter().map(|k| s(o, k)).filter(|v| !v.is_empty()).collect();
            }
            let region = if r.is_empty() { None } else { Some(r.join(" ")) };
            let full = ["label", "full", "text", "line"].iter().map(|k| s(o, k)).find(|v| !v.is_empty()).unwrap_or_default();
            (region, full)
        }
        _ => (None, String::new()),
    };
    if let Some(r) = region.or(obj_region) {
        p.home_region = r;
    }
    if !full.is_empty() {
        p.home_address = full;
    }
    if p.home_region.is_empty() && !p.home_address.is_empty() {
        // "서울특별시 강남구 역삼동 …" → "서울특별시 강남구"
        p.home_region = p.home_address.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
    }
}

/// Outside (MCOT) patients: rows on a mobile gateway or with mode != inpatient. Fetch each one's EMR detail once
/// (per profile id, hourly refresh) and apply the home address; the list/admissions feeds do not carry it.
async fn sync_home_addresses(state: &Arc<AppState>, addr: &str, cache: &mut std::collections::HashMap<u64, (std::time::Instant, String, String)>) {
    let mobile: std::collections::HashSet<String> = {
        let mut set = std::collections::HashSet::new();
        state.gateways.for_each(|g| {
            if g.gw_type == "mobile" || g.location.building.contains("원외") || g.location.building.to_uppercase().contains("MCOT") {
                set.insert(g.gw_id.to_string());
            }
        });
        set
    };
    let mut targets: Vec<(String, u64)> = Vec::new(); // (channel, profile id)
    state.registry.for_each(|ch, st| {
        let outside = mobile.contains(&st.gateway_id) || st.patient.as_ref().map(|p| !p.mode.is_empty() && p.mode != "inpatient").unwrap_or(false);
        if outside && st.profile_id > 0 {
            targets.push((ch.to_string(), st.profile_id));
        }
    });
    let mut fetched = 0usize;
    for (channel, profile) in targets {
        let fresh = cache.get(&profile).map(|(t, _, _)| t.elapsed() < Duration::from_secs(3600)).unwrap_or(false);
        if !fresh {
            if fetched >= 60 {
                break; // spread a large first batch over several sync rounds
            }
            let path = format!("/api/v1/emr/patients/{profile}");
            match request(addr, "GET", &path, None).await {
                Ok((200, body)) => {
                    let v: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
                    let mut tmp = crate::protocol::Patient::default();
                    apply_home(&mut tmp, &v);
                    cache.insert(profile, (std::time::Instant::now(), tmp.home_region, tmp.home_address));
                    fetched += 1;
                }
                Ok((code, _)) => debug!("emr home {}: HTTP {}", profile, code),
                Err(e) => {
                    debug!("emr home {}: {}", profile, e);
                    break;
                }
            }
        }
        if let Some((_, region, full)) = cache.get(&profile) {
            if let Some(prev) = state.registry.patient_of(&channel) {
                if (!region.is_empty() && prev.home_region != *region) || (!full.is_empty() && prev.home_address != *full) {
                    let mut p = prev.clone();
                    if !region.is_empty() {
                        p.home_region = region.clone();
                    }
                    if !full.is_empty() {
                        p.home_address = full.clone();
                    }
                    state.registry.upsert_meta(&channel, p);
                    state.recompute_channel_groups(&channel);
                }
            }
        }
    }
    if fetched > 0 {
        info!("emr sync: home address fetched for {} outside patients", fetched);
    }
}

fn s(v: &serde_json::Value, k: &str) -> String {
    match v.get(k) {
        Some(serde_json::Value::String(x)) => x.clone(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn apply_admissions(state: &Arc<AppState>, v: &serde_json::Value) -> usize {
    let Some(list) = v.get("admissions").and_then(|a| a.as_array()) else { return 0 };
    let mut n = 0;
    for a in list {
        let Some(patch_id) = a.get("patch_id").and_then(|x| x.as_u64()) else { continue };
        let channel_id = patch_id.to_string();
        let prev = state.registry.patient_of(&channel_id);
        let mut p = prev.clone().unwrap_or_default();
        p.id = s(a, "patient_id");
        p.name = s(a, "name");
        p.ward = s(a, "ward");
        p.doctor = s(a, "doctor");
        p.nurse = s(a, "nurse");
        p.mode = s(a, "mode");
        apply_home(&mut p, a);
        // admissions rarely carry a department; the patients feed fills specialty — do not wipe it here
        if !s(a, "department").is_empty() {
            p.department = s(a, "department");
        }
        p.profile_no = a.get("profile_id").and_then(|x| x.as_u64()).unwrap_or(p.profile_no);
        if !s(a, "room").is_empty() {
            p.room = s(a, "room");
        }
        // 방을 옮기면 침대도 바뀐다 — 빈 값이면 지운다(침대 없는 검사실 이동 등)
        p.bed = s(a, "bed");
        if !s(a, "sex").is_empty() {
            p.sex = s(a, "sex");
        }
        if !s(a, "birth").is_empty() {
            p.birth = s(a, "birth");
        }
        if prev.as_ref() != Some(&p) {
            state.registry.upsert_meta(&channel_id, p);
            state.recompute_channel_groups(&channel_id);
            n += 1;
        }
    }
    n
}
