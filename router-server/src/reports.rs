//! 일일 ECG 리포트 — 환자(패치) 하루(병원 현지 자정~자정) 요약: 기록·분석 가능 시간, 심박수 평균·최저·최고(분 평균, 시각),
//! 시간대별 심박수, 리듬 에피소드(내장 엔진 판정 이력)와 부담률(burden), 분당 V/S 박동 합계, 가장 긴 휴지, 대표 파형(심박 최고·최저·
//! 중요 에피소드 시작점의 ECG 8초). 콘솔이 이 데이터로 리포트·보험 청구서를 그리고 인쇄(PDF)한다.
use crate::state::AppState;
use chrono::{Local, NaiveDate, TimeZone};
use std::collections::HashMap;
use std::sync::Arc;

const STRIP_MS: u64 = 8_000;
const SEVERE: &[&str] = &["vf", "asystole", "vtach", "pause", "vrun", "afib", "ivr", "bigeminy", "trigeminy", "svrun", "brady", "tachy"];

pub fn day_window(date: &str) -> Option<(u64, u64)> {
    let d = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let s = Local.from_local_datetime(&d.and_hms_opt(0, 0, 0)?).earliest()?;
    let e = Local.from_local_datetime(&(d + chrono::Duration::days(1)).and_hms_opt(0, 0, 0)?).earliest()?;
    Some((s.timestamp_millis() as u64, e.timestamp_millis() as u64))
}

/// 한 패치의 하루 리포트 데이터
pub fn daily(state: &Arc<AppState>, patch: u32, date: &str) -> Result<serde_json::Value, String> {
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
    // 2) 판정 이력 → 에피소드 · 부담률
    let (tr, bm) = state.analysis.patch_history(patch, from, to);
    let mut episodes: Vec<serde_json::Value> = Vec::new();
    let mut burden: HashMap<String, u64> = HashMap::new();
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut longest_pause: Option<(u64, u64)> = None;
    for (i, (t, l)) in tr.iter().enumerate() {
        let end = tr.get(i + 1).map(|n| n.0).unwrap_or(to.min(last.max(*t)));
        let dur = end.saturating_sub(*t);
        *burden.entry(l.clone()).or_default() += dur;
        if SEVERE.contains(&l.as_str()) {
            *counts.entry(l.clone()).or_default() += 1;
            if l == "pause" || l == "asystole" { if longest_pause.map(|p| dur > p.1).unwrap_or(true) { longest_pause = Some((*t, dur)); } }
            episodes.push(serde_json::json!({ "label": l, "start_ms": t, "end_ms": end, "dur_ms": dur }));
        }
    }
    let rec_ms = sec_rec.len() as u64 * 1000;
    let analyzable_ms = rec_ms.saturating_sub(sec_off.len() as u64 * 1000);
    let burden_pct: HashMap<String, f64> = burden.iter().map(|(k, v)| (k.clone(), if analyzable_ms > 0 { (*v as f64 / analyzable_ms as f64 * 1000.0).round() / 10.0 } else { 0.0 })).collect();
    let (v_beats, s_beats) = bm.iter().fold((0u64, 0u64), |a, x| (a.0 + x.1 as u64, a.1 + x.2 as u64));
    // 3) 대표 파형: 최고·최저 심박 분, 중요 에피소드 시작(심각도 순, 라벨당 최대 2개, 총 8개)
    let mut picks: Vec<(String, u64)> = Vec::new();
    if let Some((m, v)) = hr_max { picks.push((format!("max_hr:{:.0}", v), m + 30_000)); }
    if let Some((m, v)) = hr_min { picks.push((format!("min_hr:{:.0}", v), m + 30_000)); }
    let mut per: HashMap<String, usize> = HashMap::new();
    for sev in SEVERE {
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
    let patient = state.registry.patient_of(&patch.to_string());
    let site = state.auth.site_tenant();
    let hospital = state.auth.tenants().into_iter().find(|t| t.id == site).map(|t| serde_json::json!({"id": t.id, "name": t.name, "region": t.region, "contact": t.contact}));
    Ok(serde_json::json!({
        "patch": patch, "date": date, "from_ms": from, "to_ms": to, "tz": Local::now().format("%:z").to_string(),
        "first_ms": if first == u64::MAX { None } else { Some(first) }, "last_ms": if last == 0 { None } else { Some(last) },
        "recorded_ms": rec_ms, "analyzable_ms": analyzable_ms, "lead_off_ms": sec_off.len() as u64 * 1000,
        "hr": { "avg": hr_avg.map(|x| (x * 10.0).round() / 10.0), "min": hr_min.map(|(m, v)| serde_json::json!({"bpm": v.round(), "at_ms": m})), "max": hr_max.map(|(m, v)| serde_json::json!({"bpm": v.round(), "at_ms": m})), "total_beats": total_beats.round() },
        "hourly": hourly,
        "burden_pct": burden_pct, "episode_counts": counts, "episodes": episodes.into_iter().rev().take(200).collect::<Vec<_>>(),
        "ectopy": { "v_beats": v_beats, "s_beats": s_beats, "v_pct": if total_beats > 0.0 { Some((v_beats as f64 / total_beats * 1000.0).round() / 10.0) } else { None }, "s_pct": if total_beats > 0.0 { Some((s_beats as f64 / total_beats * 1000.0).round() / 10.0) } else { None } },
        "longest_pause": longest_pause.map(|(t, d)| serde_json::json!({"at_ms": t, "dur_ms": d})),
        "strips": strips,
        "patient": patient,
        "monitor_start_ms": state.registry.wear_start_of(&patch.to_string()),
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
