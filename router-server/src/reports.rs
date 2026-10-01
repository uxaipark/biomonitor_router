//! 일일 ECG 리포트 — 환자(패치) 하루(병원 현지 자정~자정) 요약: 기록·분석 가능 시간, 심박수 평균·최저·최고(분 평균, 시각),
//! 시간대별 심박수, 리듬 에피소드(내장 엔진 판정 이력)와 부담률(burden), 분당 V/S 박동 합계, 대표 파형(심박 최고·최저·
//! 중요 에피소드 시작점의 ECG 8초). 콘솔이 이 데이터로 리포트·보험 청구서를 그리고 인쇄(PDF)한다.
use crate::state::AppState;
use chrono::{Local, NaiveDate, TimeZone};
use std::collections::HashMap;
use std::sync::Arc;

const STRIP_MS: u64 = 8_000;
// 휴지·무수축은 리포트에 넣지 않는다 — 원인(전극 탈락·접촉 불량·움직임·수신 끊김 포함)을 알 수 없어 실제 휴지인지 판단할 수 없다
const SEVERE: &[&str] = &["vf", "vtach", "vrun", "afib", "ivr", "bigeminy", "trigeminy", "svrun", "brady", "tachy"];
const EXCLUDED: &[&str] = &["pause", "asystole"];
/// 정답지 모드에서 대표 파형을 고르는 순서 (엔진이 못 하는 방실 차단·각차단 등 포함)
const TRUTH_ORDER: &[&str] = &["vf", "vtach", "vrun", "avb3", "avb2_m2", "afib", "aflutter", "svt", "avb2_m1", "bigeminy", "pvc", "pac", "avb1", "avb", "brady", "tachy", "lbbb", "rbbb", "stemi", "ischemia", "paced"];

/// 리포트 판정 출처: "truth"(에뮬레이터 정답지, 데모 기본) | "engine"(내장 분석 엔진). data/engine/report.json
pub fn report_source(state: &AppState) -> String {
    let p = std::path::Path::new(&state.cfg.ecg_lib).parent().unwrap_or(std::path::Path::new(".")).join("report.json");
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).and_then(|v| v["source"].as_str().map(String::from)).filter(|s| s == "truth" || s == "engine").unwrap_or_else(|| "truth".into())
}
pub fn report_source_json(state: &AppState) -> serde_json::Value {
    let p = std::path::Path::new(&state.cfg.ecg_lib).parent().unwrap_or(std::path::Path::new(".")).join("report.json");
    let mut v = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok()).unwrap_or_else(|| serde_json::json!({}));
    v["source"] = serde_json::json!(report_source(state));
    v
}
pub fn set_report_source(state: &AppState, source: &str, by: &str) -> Result<serde_json::Value, String> {
    if source != "truth" && source != "engine" { return Err("출처는 truth 또는 engine".into()); }
    let p = std::path::Path::new(&state.cfg.ecg_lib).parent().unwrap_or(std::path::Path::new(".")).join("report.json");
    let v = serde_json::json!({ "source": source, "updated_ms": crate::protocol::now_ms(), "by": by });
    std::fs::write(p, serde_json::to_string_pretty(&v).unwrap_or_default()).map_err(|e| e.to_string())?;
    state.analysis.history_push("report_source", &state.analysis.engine().map(|e| e.id.clone()).unwrap_or_default(), &format!("리포트 판정 출처 → {}", if source == "truth" { "에뮬레이터 정답지" } else { "분석 엔진" }));
    Ok(v)
}

/// 정답지 값 → 리포트 라벨 (휴지·무수축은 EXCLUDED 로 빠진다)
pub fn truth_key(v: &str) -> &'static str {
    match v {
        "afib" | "afib_rvr" => "afib", "aflutter" => "aflutter", "vfib" => "vf", "vt" => "vtach", "nsvt" => "vrun",
        "sinus_pause" => "pause", "asystole" => "asystole", "pvc" => "pvc", "pvc_bigeminy" => "bigeminy",
        "sinus_tachy" => "tachy", "sinus_brady" | "brady" => "brady", "pac" => "pac", "svt" => "svt", "nsr" | "sinus" => "nsr",
        "avb1" => "avb1", "avb2_m1" => "avb2_m1", "avb2_m2" => "avb2_m2", "avb3" => "avb3", "block" => "avb",
        "lbbb" => "lbbb", "rbbb" => "rbbb", "stemi" => "stemi", "ischemia" => "ischemia",
        x if x.starts_with("paced") => "paced",
        _ => "",
    }
}

/// 한 패치의 정답 에피소드 (값, 시작, 끝 — 열린 것은 창 끝까지) 와 기저 리듬
#[derive(Clone, Default)]
pub struct Truth { pub eps: Vec<(String, u64, u64)>, pub base: Option<String> }

type TruthDay = (std::time::Instant, HashMap<u32, Truth>);
static TRUTH_CACHE: std::sync::LazyLock<tokio::sync::Mutex<HashMap<(u64, u64), TruthDay>>> = std::sync::LazyLock::new(Default::default);

/// 에뮬레이터 /api/v1/labels 에서 그날 정답을 받아 패치별로 나눠 둔다 (지난 날은 30분, 오늘은 2분 캐시). 라벨 API 는 패치 거르기를 지원하지 않아 하루치를 한 번에 받는다.
pub async fn truth_for(state: &Arc<AppState>, patch: u32, date: &str) -> Result<Truth, String> {
    let (from, to) = day_window(date).ok_or("날짜는 YYYY-MM-DD")?;
    let now = crate::protocol::now_ms();
    let mut cache = TRUTH_CACHE.lock().await;
    let ttl = if to > now { 120 } else { 1800 };
    if let Some((at, m)) = cache.get(&(from, to)) { if at.elapsed().as_secs() < ttl { let mut t = m.get(&patch).cloned().unwrap_or_default(); if t.base.is_none() { t.base = state.inventory.base_of(patch); } if t.base.is_some() { return Ok(t); } } }
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다 (네트워크 설정)")?;
    let until = to.min(now);
    let since = from.saturating_sub(6 * 3_600_000);
    let mut m: HashMap<u32, Truth> = HashMap::new();
    let mut offset = 0usize;
    loop {
        let path = format!("/api/v1/labels?kind=rhythm_episode&since_ms={since}&until_ms={until}&include_open=true&limit=5000&offset={offset}");
        let (code, body) = crate::emu_link::request(&addr, "GET", &path, None).await.map_err(|e| format!("정답지를 받지 못했습니다: {e}"))?;
        if code != 200 { return Err(format!("정답지 HTTP {code}")); }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let arr = v.get("labels").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let got = arr.len();
        for l in arr {
            let pid = l.get("patch_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let t0 = l.get("t_start_ms").and_then(|x| x.as_u64()).unwrap_or(0);
            if pid == 0 || t0 == 0 || t0 >= to { continue; }
            let t1 = l.get("t_end_ms").and_then(|x| x.as_u64()).unwrap_or(until);
            if t1 <= from { continue; }
            let e = m.entry(pid).or_default();
            if let Some(b) = l.get("meta").and_then(|x| x.get("base")).and_then(|x| x.as_str()) { e.base.get_or_insert_with(|| b.to_string()); }
            e.eps.push((l.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string(), t0, t1));
        }
        offset += got;
        if got < 5000 || offset > 400_000 { break; }
    }
    // 기저 리듬: 라벨 meta.base → 재원 환자 EMR → 보관값 → (없으면) 퇴원 포함 전체 EMR(1시간에 한 번)
    let mut bases: Vec<(u32, String)> = m.iter().filter_map(|(p, t)| t.base.clone().map(|b| (*p, b))).collect();
    let emr_bases = |body: &str| -> Vec<(u32, String)> {
        serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("patients").and_then(|a| a.as_array()).cloned()).unwrap_or_default().iter()
            .filter_map(|p| Some((p.get("patch_id").and_then(|x| x.as_u64())? as u32, p.get("rhythm").and_then(|x| x.as_str())?.to_string()))).collect()
    };
    if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/patients?status=admitted&limit=10000", None).await { bases.extend(emr_bases(&body)); }
    { let inv = state.inventory.clone(); let b = bases.clone(); let _ = tokio::task::spawn_blocking(move || inv.save_bases(&b)).await; }
    for (p, b) in &bases { let e = m.entry(*p).or_default(); if e.base.is_none() { e.base = Some(b.clone()); } }
    let mut out = m.get(&patch).cloned().unwrap_or_default();
    if out.base.is_none() {
        out.base = state.inventory.base_of(patch);
        static FULL_AT: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);
        let due = FULL_AT.lock().unwrap().map(|t| t.elapsed().as_secs() > 3600).unwrap_or(true);
        if out.base.is_none() && due {
            *FULL_AT.lock().unwrap() = Some(std::time::Instant::now());
            if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/patients?status=all&limit=20000", None).await {
                let all = emr_bases(&body);
                { let inv = state.inventory.clone(); let b = all.clone(); let _ = tokio::task::spawn_blocking(move || inv.save_bases(&b)).await; }
                out.base = all.iter().find(|(p, _)| *p == patch).map(|x| x.1.clone());
                for (p, b) in all { let e = m.entry(p).or_default(); if e.base.is_none() { e.base = Some(b); } }
            }
        }
    }
    cache.retain(|_, (at, _)| at.elapsed().as_secs() < 3600);
    cache.insert((from, to), (std::time::Instant::now(), m));
    Ok(out)
}

pub fn day_window(date: &str) -> Option<(u64, u64)> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let s = Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).earliest()?;
    let e = Local.from_local_datetime(&(d + chrono::Duration::days(1)).and_hms_opt(0, 0, 0)?).earliest()?;
    Some((s.timestamp_millis() as u64, e.timestamp_millis() as u64))
}

/// 한 패치의 하루 리포트 데이터
pub fn daily(state: &Arc<AppState>, patch: u32, date: &str, truth: Option<&Truth>) -> Result<serde_json::Value, String> {
    let (from, to) = day_window(date).ok_or("날짜는 YYYY-MM-DD")?;
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    state.backup.ensure_local(patch, from, to, 13);
    // 1) 저장 레코드 훑기: 초 단위 기록 여부, 분당 HR 평균, 전극 탈락 초
    let mut sec_rec: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut sec_off: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut min_hr: HashMap<u64, (u32, u32)> = HashMap::new(); // minute → (sum, n)
    let (mut first, mut last) = (u64::MAX, 0u64);
    for (key, path, _) in crate::patch_store::list_files(&root, patch) {
        if !crate::patch_store::key_range(&key).map(|(a, b)| a < to && b > from).unwrap_or(false) { continue; }
        let _ = crate::patch_store::stream_entries_in(&path, from, to, |e| {
            let sec = e.ts_ms / 1000;
            sec_rec.insert(sec);
            if e.flags & crate::wire::R_LEAD_OFF != 0 { sec_off.insert(sec); }
            first = first.min(e.ts_ms); last = last.max(e.ts_ms);
            for (ch, dt, _n, data) in &e.channels {
                if *ch == crate::wire::CH_HR && *dt == 2 {
                    if let Some(&hr) = data.first() { if hr > 0 && e.flags & crate::wire::R_LEAD_OFF == 0 { let m = min_hr.entry(e.ts_ms / 60_000 * 60_000).or_insert((0, 0)); m.0 += hr as u32; m.1 += 1; } }
                }
            }
        });
    }
    if sec_rec.is_empty() { return Err("그날 저장된 기록이 없습니다".into()); }
    let mut mins: Vec<(u64, f64)> = min_hr.iter().map(|(m, (s, n))| (*m, *s as f64 / *n as f64)).collect();
    mins.sort_by_key(|x| x.0);
    let hr_avg = if mins.is_empty() { None } else { Some(mins.iter().map(|x| x.1).sum::<f64>() / mins.len() as f64) };
    let hr_min = mins.iter().cloned().fold(None::<(u64, f64)>, |a, x| match a { Some(b) if b.1 <= x.1 => Some(b), _ => Some(x) });
    let hr_max = mins.iter().cloned().fold(None::<(u64, f64)>, |a, x| match a { Some(b) if b.1 >= x.1 => Some(b), _ => Some(x) });
    // 시간대별 (0–23시) 평균·최저·최고
    let mut hourly: Vec<serde_json::Value> = Vec::new();
    for h in 0..24u64 {
        let (a, b) = (from + h * 3_600_000, from + (h + 1) * 3_600_000);
        let v: Vec<f64> = mins.iter().filter(|x| x.0 >= a && x.0 < b).map(|x| x.1).collect();
        hourly.push(if v.is_empty() { serde_json::json!({"h": h, "n": 0}) } else { serde_json::json!({"h": h, "n": v.len(), "avg": v.iter().sum::<f64>() / v.len() as f64, "min": v.iter().cloned().fold(f64::MAX, f64::min), "max": v.iter().cloned().fold(0.0, f64::max)}) });
    }
    let total_beats: f64 = mins.iter().map(|x| x.1).sum(); // 분당 HR 합 ≈ 그 분의 박동 수
    // 2) 판정 → 에피소드 · 부담률 — 출처: 에뮬레이터 정답지(truth) 또는 내장 엔진 판정 이력
    let rec_ms = sec_rec.len() as u64 * 1000;
    let analyzable_ms = rec_ms.saturating_sub(sec_off.len() as u64 * 1000);
    let mut episodes: Vec<serde_json::Value> = Vec::new();
    let mut burden: HashMap<String, u64> = HashMap::new();
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut ectopy = serde_json::Value::Null;
    let mut truth_base: Option<String> = None;
    if let Some(t) = truth {
        // 기록이 있는 구간 안으로 자른 정답 에피소드. 기저 리듬은 나머지 분석 가능 시간을 채운다.
        let (lo, hi) = (from.max(first), to.min(last));
        let base = t.base.as_deref().map(truth_key).unwrap_or("").to_string(); // 모르면 채우지 않는다
        let mut other = 0u64;
        for (v, s0, e0) in &t.eps {
            let k = truth_key(v);
            if k.is_empty() || EXCLUDED.contains(&k) { continue; }
            let (a, b) = ((*s0).max(lo), (*e0).min(hi));
            if b <= a { continue; }
            let dur = b - a;
            *burden.entry(k.to_string()).or_default() += dur;
            if k != base { other += dur; }
            if k != "nsr" {
                *counts.entry(k.to_string()).or_default() += 1;
                episodes.push(serde_json::json!({ "label": k, "start_ms": a, "end_ms": b, "dur_ms": dur }));
            }
        }
        if !base.is_empty() && !EXCLUDED.contains(&base.as_str()) { *burden.entry(base.clone()).or_default() += analyzable_ms.saturating_sub(other); }
        truth_base = Some(base.clone());
        episodes.sort_by_key(|e| std::cmp::Reverse(e["start_ms"].as_u64().unwrap_or(0)));
    } else {
        let (tr, bm) = state.analysis.patch_history(patch, from, to);
        for (i, (t, l)) in tr.iter().enumerate() {
            let end = tr.get(i + 1).map(|n| n.0).unwrap_or(to.min(last.max(*t)));
            let dur = end.saturating_sub(*t);
            if EXCLUDED.contains(&l.as_str()) { continue; }
            *burden.entry(l.clone()).or_default() += dur;
            if SEVERE.contains(&l.as_str()) {
                *counts.entry(l.clone()).or_default() += 1;
                episodes.push(serde_json::json!({ "label": l, "start_ms": t, "end_ms": end, "dur_ms": dur }));
            }
        }
        let (v_beats, s_beats) = bm.iter().fold((0u64, 0u64), |a, x| (a.0 + x.1 as u64, a.1 + x.2 as u64));
        ectopy = serde_json::json!({ "v_beats": v_beats, "s_beats": s_beats, "v_pct": if total_beats > 0.0 { Some((v_beats as f64 / total_beats * 1000.0).round() / 10.0) } else { None }, "s_pct": if total_beats > 0.0 { Some((s_beats as f64 / total_beats * 1000.0).round() / 10.0) } else { None } });
    }
    let burden_pct: HashMap<String, f64> = burden.iter().map(|(k, v)| (k.clone(), if analyzable_ms > 0 { ((*v as f64 / analyzable_ms as f64 * 1000.0).round() / 10.0).min(100.0) } else { 0.0 })).collect();
    // 3) 대표 파형: 최고·최저 심박 분, 중요 에피소드 시작(심각도 순, 라벨당 최대 2개, 총 8개)
    let mut picks: Vec<(String, u64)> = Vec::new();
    if let Some((m, v)) = hr_max { picks.push((format!("max_hr:{:.0}", v), m + 30_000)); }
    if let Some((m, v)) = hr_min { picks.push((format!("min_hr:{:.0}", v), m + 30_000)); }
    let mut per: HashMap<String, usize> = HashMap::new();
    for sev in if truth.is_some() { TRUTH_ORDER } else { SEVERE } {
        for e in episodes.iter().filter(|e| e["label"] == *sev) {
            if picks.len() >= 8 { break; }
            let n = per.entry(sev.to_string()).or_default();
            if *n >= 2 { break; }
            *n += 1;
            picks.push((format!("episode:{sev}"), e["start_ms"].as_u64().unwrap_or(from) + 1500));
        }
    }
    let mut strips = Vec::new();
    for (what, center) in picks {
        let a = center.saturating_sub(STRIP_MS / 2);
        let recs = crate::patch_store::read_ecg_range(&root, patch, a, a + STRIP_MS);
        let mut pts: Vec<f32> = Vec::new();
        let mut t0 = 0u64;
        for (ts, _seq, s) in recs {
            if t0 == 0 { t0 = ts.saturating_sub((s.len() as u64).saturating_sub(1) * 4); }
            pts.extend(s.iter().step_by(2)); // 250 → 125 Hz
        }
        if pts.len() < 200 { continue; }
        pts.truncate(1000);
        strips.push(serde_json::json!({ "what": what, "t0_ms": t0, "fs": 125, "mv": pts.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>() }));
    }
    // 지금 연결된 환자가 없으면(퇴원·패치 교체) 마지막으로 저장한 환자 정보로
    let snap = state.inventory.patient_snapshot(&patch.to_string());
    let patient: Option<serde_json::Value> = state.registry.patient_of(&patch.to_string()).and_then(|p| serde_json::to_value(p).ok()).or_else(|| snap.as_ref().map(|s| s.0.clone()));
    let wear_start = state.registry.wear_start_of(&patch.to_string()).or_else(|| snap.as_ref().map(|s| s.1).filter(|w| *w > 0));
    let site = state.auth.site_tenant();
    let hospital = state.auth.tenants().into_iter().find(|t| t.id == site).map(|t| serde_json::json!({"id": t.id, "name": t.name, "region": t.region, "contact": t.contact}));
    Ok(serde_json::json!({
        "patch": patch, "date": date, "from_ms": from, "to_ms": to, "tz": Local::now().format("%:z").to_string(),
        "first_ms": if first == u64::MAX { None } else { Some(first) }, "last_ms": if last == 0 { None } else { Some(last) },
        "recorded_ms": rec_ms, "analyzable_ms": analyzable_ms, "lead_off_ms": sec_off.len() as u64 * 1000,
        "hr": { "avg": hr_avg.map(|x| (x * 10.0).round() / 10.0), "min": hr_min.map(|(m, v)| serde_json::json!({"bpm": v.round(), "at_ms": m})), "max": hr_max.map(|(m, v)| serde_json::json!({"bpm": v.round(), "at_ms": m})), "total_beats": total_beats.round() },
        "hourly": hourly,
        "burden_pct": burden_pct, "episode_counts": counts, "episodes": episodes.into_iter().rev().take(200).collect::<Vec<_>>(),
        "ectopy": ectopy,
        "source": if truth.is_some() { "truth" } else { "engine" }, "truth_base": truth_base,
        "strips": strips,
        "patient": patient,
        "monitor_start_ms": wear_start, "patient_from_snapshot": state.registry.patient_of(&patch.to_string()).is_none() && snap.is_some(),
        "site": state.auth.site_tenant(),
        "hospital": hospital,
        "site_country": crate::site_locale::SITE.read().map(|s| s.country.clone()).unwrap_or_default(),
        "engine": state.analysis.engine().map(|e| e.id.clone()),
        "generated_ms": crate::protocol::now_ms(),
    }))
}

/// 패치의 기록이 있는 날짜 목록 (최근 30일)
pub fn days(state: &Arc<AppState>, patch: u32) -> Vec<String> {
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let mut set = std::collections::BTreeSet::new();
    for (key, _, _) in crate::patch_store::list_files(&root, patch) {
        if let Some((a, b)) = crate::patch_store::key_range(&key) {
            let mut t = a;
            while t < b { set.insert(Local.timestamp_millis_opt(t as i64).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()); t += 3_600_000; }
        }
    }
    set.into_iter().rev().filter(|s| !s.is_empty()).take(30).collect()
}
