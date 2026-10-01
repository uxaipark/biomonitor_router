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

/// 정답 라벨 저장소 — 에뮬레이터 /api/v1/labels 를 한 번 받아 두고 이후엔 바뀐 부분만 받는다(라벨 API 는 패치 거르기가 없어 전체를 받음).
/// 키 (패치, 시작, 값) → 끝(열린 것은 None). 8일보다 오래된 것은 버린다.
#[derive(Default)]
struct LabelStore { lo: u64, hi: u64, at: Option<std::time::Instant>, labels: HashMap<(u32, u64, String, String), Option<u64>>, base: HashMap<u32, String>, emr_at: Option<std::time::Instant> }
static STORE: std::sync::LazyLock<tokio::sync::Mutex<LabelStore>> = std::sync::LazyLock::new(Default::default);

async fn fetch_labels(addr: &str, since: u64, until: u64, st: &mut LabelStore) -> Result<(), String> {
    let mut offset = 0usize;
    loop {
        let path = format!("/api/v1/labels?kind=rhythm_episode,lead_off&since_ms={since}&until_ms={until}&include_open=true&limit=5000&offset={offset}");
        let (code, body) = crate::emu_link::request(addr, "GET", &path, None).await.map_err(|e| format!("정답지를 받지 못했습니다: {e}"))?;
        if code != 200 { return Err(format!("정답지 HTTP {code}")); }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let arr = v.get("labels").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let got = arr.len();
        for l in arr {
            let pid = l.get("patch_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let t0 = l.get("t_start_ms").and_then(|x| x.as_u64()).unwrap_or(0);
            if pid == 0 || t0 == 0 { continue; }
            if let Some(b) = l.get("meta").and_then(|x| x.get("base")).and_then(|x| x.as_str()) { st.base.insert(pid, b.to_string()); }
            let kind = l.get("kind").and_then(|x| x.as_str()).unwrap_or("rhythm_episode").to_string();
            let value = if kind == "lead_off" { "lead_off".to_string() } else { l.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string() };
            st.labels.insert((pid, t0, kind, value), l.get("t_end_ms").and_then(|x| x.as_u64()));
        }
        offset += got;
        if got < 5000 || offset > 400_000 { break; }
    }
    Ok(())
}
fn emr_bases(body: &str) -> Vec<(u32, String)> {
    serde_json::from_str::<serde_json::Value>(body).ok().and_then(|v| v.get("patients").and_then(|a| a.as_array()).cloned()).unwrap_or_default().iter()
        .filter_map(|p| Some((p.get("patch_id").and_then(|x| x.as_u64())? as u32, p.get("rhythm").and_then(|x| x.as_str())?.to_string()))).collect()
}

/// [need_lo, need_hi] 구간 라벨을 저장소에 확보한다. 오늘 쪽 끝은 60초가 지났으면 마지막 30분부터 다시 받아 열린 에피소드의 끝을 갱신.
async fn ensure(state: &Arc<AppState>, need_lo: u64, need_hi: u64) -> Result<(), String> {
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다 (네트워크 설정)")?;
    let now = crate::protocol::now_ms();
    let need_hi = need_hi.min(now);
    let mut st = STORE.lock().await;
    if st.at.is_none() || need_hi + 3_600_000 < st.lo || need_lo > st.hi + 3_600_000 {
        // 처음이거나 멀리 떨어진 구간: 그 구간만 새로
        let mut fresh = LabelStore { base: std::mem::take(&mut st.base), emr_at: st.emr_at, ..Default::default() };
        fetch_labels(&addr, need_lo, need_hi, &mut fresh).await?;
        fresh.lo = need_lo; fresh.hi = need_hi; fresh.at = Some(std::time::Instant::now());
        *st = fresh;
    } else {
        if need_lo < st.lo { let (a, b) = (need_lo, st.lo); fetch_labels(&addr, a, b, &mut st).await?; st.lo = need_lo; }
        let stale = st.at.map(|t| t.elapsed().as_secs() >= 60).unwrap_or(true);
        if need_hi > st.hi || (stale && need_hi + 120_000 >= now) {
            let from = st.hi.saturating_sub(30 * 60_000);
            fetch_labels(&addr, from, now, &mut st).await?;
            st.hi = now; st.at = Some(std::time::Instant::now());
        }
    }
    // 오래된 라벨 정리 (8일)
    let cut = now.saturating_sub(8 * 86_400_000);
    if st.lo < cut { st.labels.retain(|k, e| e.unwrap_or(u64::MAX) >= cut || k.1 >= cut); st.lo = cut; }
    // 재원 환자 기저 리듬: 5분에 한 번
    if st.emr_at.map(|t| t.elapsed().as_secs() >= 300).unwrap_or(true) {
        st.emr_at = Some(std::time::Instant::now());
        if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/patients?status=admitted&limit=10000", None).await {
            let b = emr_bases(&body);
            for (p, r) in &b { st.base.insert(*p, r.clone()); }
            let inv = state.inventory.clone(); let _ = tokio::task::spawn_blocking(move || inv.save_bases(&b)).await;
        }
    }
    Ok(())
}

/// 한 패치·하루의 정답: ① 로컬 정답 파일(truth/) ② 백업에서 복원 ③ 에뮬레이터 순서. 시간 파일이 하나라도 없으면 에뮬레이터로.
pub async fn truth_for(state: &Arc<AppState>, patch: u32, date: &str) -> Result<Truth, String> {
    let (from, to) = day_window(date).ok_or("날짜는 YYYY-MM-DD")?;
    let now = crate::protocol::now_ms();
    let (lo, hi) = (from.saturating_sub(6 * 3_600_000), to.min(now));
    // 끝난 시간들이 모두 정답 파일로 있으면 그것만으로 (재현 가능, 에뮬레이터 없이도)
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let st2 = state.clone();
    let local = tokio::task::spawn_blocking(move || -> Option<Truth> {
        let mut eps: HashMap<(u64, String), Option<u64>> = HashMap::new();
        let mut base: Option<String> = None;
        let mut h = lo / 3_600_000 * 3_600_000;
        while h < hi {
            let key = crate::patch_store::hour_key(h);
            let mut f = crate::truth_store::file_of(&root, &key);
            if !f.exists() { f = st2.backup.restore_truth(&crate::truth_store::rel_of(&key)).ok()?; }
            let (e, b) = crate::truth_store::read_file(&f, patch)?;
            for (_, k, v, s0, e0) in e { if k == "rhythm_episode" { let slot = eps.entry((s0, v)).or_insert(e0); if e0.is_some() { *slot = e0; } } }
            if b.is_some() { base = b; }
            h += 3_600_000;
        }
        Some(Truth { eps: eps.into_iter().filter(|((s0, _), _)| *s0 < to).map(|((s0, v), e0)| (v, s0, e0.unwrap_or(to.min(crate::protocol::now_ms())))).filter(|(_, _, e)| *e > from).collect(), base })
    }).await.ok().flatten();
    if let Some(mut t) = local {
        if t.base.is_none() { t.base = state.inventory.base_of(patch); }
        return Ok(t);
    }
    ensure(state, lo, to).await?;
    let st = STORE.lock().await;
    let eps: Vec<(String, u64, u64)> = st.labels.iter()
        .filter(|((p, t0, k, _), _)| *p == patch && *t0 < to && k == "rhythm_episode")
        .map(|((_, t0, _, v), e)| (v.clone(), *t0, e.unwrap_or(to.min(now))))
        .filter(|(_, _, e)| *e > from).collect();
    let base = st.base.get(&patch).cloned();
    drop(st);
    let base = base.or_else(|| state.inventory.base_of(patch));
    Ok(Truth { eps, base })
}

/// 정답 파일 쓰기: [h_lo, h_hi) 시간들 — 봉인 안 된 것만 다시 쓰고, 끝난 지 30분 지난 것은 봉인
async fn persist_hours(state: &Arc<AppState>, h_lo: u64, h_hi: u64) {
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let now = crate::protocol::now_ms();
    let emu = state.net.emulator().unwrap_or_default();
    let mut jobs: Vec<(String, Vec<crate::truth_store::Ep>, HashMap<u32, String>)> = Vec::new();
    // 기저 리듬은 그 시간에 에피소드가 있는 환자 + 지금 연결된 환자만 (퇴원한 수만 명까지 매시간 쓰지 않게)
    let mut live: std::collections::HashSet<u32> = std::collections::HashSet::new();
    state.registry.for_each(|id, ch| if ch.patient.is_some() { if let Ok(p) = id.parse::<u32>() { live.insert(p); } });
    {
        let st = STORE.lock().await;
        let mut h = h_lo / 3_600_000 * 3_600_000;
        while h < h_hi.min(now) {
            let key = crate::patch_store::hour_key(h);
            if crate::patch_store::read_seal(&crate::truth_store::file_of(&root, &key)).is_none() {
                let (a, b) = (h, h + 3_600_000);
                let eps: Vec<crate::truth_store::Ep> = st.labels.iter().filter(|((_, s0, _, _), e)| *s0 < b && e.unwrap_or(now) > a).map(|((p, s0, k, v), e)| (*p, k.clone(), v.clone(), *s0, *e)).collect();
                let pats: std::collections::HashSet<u32> = eps.iter().map(|e| e.0).collect();
                let bases: HashMap<u32, String> = st.base.iter().filter(|(p, _)| pats.contains(p) || (b + 3_600_000 > now && live.contains(p))).map(|(p, v)| (*p, v.clone())).collect();
                jobs.push((key, eps, bases));
            }
            h += 3_600_000;
        }
    }
    let _ = tokio::task::spawn_blocking(move || {
        for (key, eps, bases) in jobs {
            if let Err(e) = crate::truth_store::write_hour(&root, &key, &eps, &bases, &emu) { tracing::warn!("truth: write {key} failed: {e}"); continue; }
            crate::truth_store::seal_if_due(&root, &key, now);
        }
    }).await;
}

/// 백그라운드: 정답을 1분마다 받아(바뀐 부분만) 시간별 정답 파일(truth/)로 저장·봉인하고, 리포트가 기다리지 않게 메모리에도 둔다. 퇴원 환자 기저 리듬(전체 EMR, 19 MB)·오래된 정답 파일 정리는 1시간에 한 번.
pub async fn run_truth_warm(state: Arc<AppState>) {
    tokio::time::sleep(std::time::Duration::from_secs(15)).await;
    let mut tick: u64 = 0;
    loop {
        if state.net.emulator().is_some() {
            let now = crate::protocol::now_ms();
            // 처음엔 30시간 앞부터(재시작 동안 빠진 시간도 채움), 이후엔 봉인 전인 최근 2시간만
            let lo = if tick == 0 { now.saturating_sub(30 * 3_600_000) } else { now.saturating_sub(2 * 3_600_000 + crate::truth_store::SEAL_GRACE_MS) };
            if ensure(&state, lo.saturating_sub(6 * 3_600_000), now).await.is_ok() {
                persist_hours(&state, lo, now).await;
            }
            if tick % 60 == 0 {
                if let Some(addr) = state.net.emulator() {
                    if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/patients?status=all&limit=20000", None).await {
                        let b = emr_bases(&body);
                        let inv = state.inventory.clone(); let _ = tokio::task::spawn_blocking(move || inv.save_bases(&b)).await;
                    }
                }
                let root = std::path::PathBuf::from(&state.cfg.store_dir);
                let n = tokio::task::spawn_blocking(move || crate::truth_store::prune(&root, crate::protocol::now_ms())).await.unwrap_or(0);
                if n > 0 { tracing::info!("truth: pruned {n} local hour files (backed up, > {} days)", crate::truth_store::KEEP_DAYS); }
            }
            tick += 1;
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
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
    // 3) 대표 파형: 최고·최저 심박 분, 기저 리듬(비정상이면), 중요 에피소드(심각도 순, 라벨당 최대 2개), 총 8개.
    //    각 후보 구간 안에서 '전극 탈락 없고 표본이 거의 다 있는 8초'를 찾아 쓴다 — 못 찾으면 그 파형은 뺀다(빈 칸을 만들지 않음).
    let mut picks: Vec<(String, u64, u64)> = Vec::new(); // (무엇, 찾을 구간 시작, 끝)
    if let Some((m, v)) = hr_max { picks.push((format!("max_hr:{:.0}", v), m.saturating_sub(60_000), m + 120_000)); }
    if let Some((m, v)) = hr_min { picks.push((format!("min_hr:{:.0}", v), m.saturating_sub(60_000), m + 120_000)); }
    // 기저 리듬 / 가장 많은 비정상 리듬 — 에피소드가 없는 환자도 주된 리듬 파형을 보이게
    let dominant: Option<String> = if let Some(b) = truth_base.as_deref().filter(|b| !b.is_empty() && *b != "nsr") { Some(b.to_string()) } else if truth.is_none() {
        burden.iter().filter(|(k, _)| !matches!(k.as_str(), "nsr" | "noise" | "unknown" | "leadoff") && !EXCLUDED.contains(&k.as_str())).max_by_key(|(_, v)| **v).filter(|(_, v)| **v * 10 >= analyzable_ms).map(|(k, _)| k.clone())
    } else { None };
    if let Some(dl) = &dominant {
        if !episodes.iter().any(|e| e["label"] == dl.as_str()) && first < last {
            let span = last - first;
            for q in [1u64, 2] { let c = first + span * q / 3; picks.push((format!("base:{dl}"), c.saturating_sub(120_000), c + 120_000)); }
        }
    }
    let mut per: HashMap<String, usize> = HashMap::new();
    for sev in if truth.is_some() { TRUTH_ORDER } else { SEVERE } {
        for e in episodes.iter().filter(|e| e["label"] == *sev) {
            if picks.len() >= 8 { break; }
            let n = per.entry(sev.to_string()).or_default();
            if *n >= 2 { break; }
            *n += 1;
            let s0 = e["start_ms"].as_u64().unwrap_or(from);
            let e0 = e["end_ms"].as_u64().unwrap_or(s0 + 60_000).min(s0 + 180_000).max(s0 + STRIP_MS);
            picks.push((format!("episode:{sev}"), s0, e0));
        }
    }
    let mut strips = Vec::new();
    for (what, a, b) in picks {
        if let Some((t0, pts)) = best_window(&root, patch, a.max(from), b.min(to), &sec_off) {
            strips.push(serde_json::json!({ "what": what, "t0_ms": t0, "fs": 125, "mv": pts.iter().map(|v| (v * 1000.0).round() / 1000.0).collect::<Vec<_>>() }));
        }
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

/// 패치의 기록이 있는 날짜 목록 (최근 30일). 파일 이름의 시간 범위는 넓게 잡혀 있어서 그날 실제 레코드가 있는지 확인한다.
pub fn days(state: &Arc<AppState>, patch: u32) -> Vec<String> {
    let root = std::path::PathBuf::from(&state.cfg.store_dir);
    let mut set = std::collections::BTreeSet::new();
    let files = crate::patch_store::list_files(&root, patch);
    for (key, _, _) in &files {
        if let Some((a, b)) = crate::patch_store::key_range(key) {
            let mut t = a;
            while t < b { set.insert(Local.timestamp_millis_opt(t as i64).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()); t += 3_600_000; }
            set.insert(Local.timestamp_millis_opt(b.saturating_sub(1) as i64).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default());
        }
    }
    let mut out = Vec::new();
    for d in set.into_iter().rev().filter(|s| !s.is_empty()).take(31) {
        let Some((from, to)) = day_window(&d) else { continue };
        let mut any = false;
        for (key, path, _) in &files {
            if any { break; }
            if !crate::patch_store::key_range(key).map(|(a, b)| a < to && b > from).unwrap_or(false) { continue; }
            // 한 시간씩 보다가 레코드가 나오면 멈춘다 (하루 전체를 읽지 않게)
            let mut h = from;
            while h < to && !any { let _ = crate::patch_store::stream_entries_in(path, h, (h + 3_600_000).min(to), |_| { any = true; }); h += 3_600_000; }
        }
        if any { out.push(d); }
        if out.len() >= 30 { break; }
    }
    out
}

/// [a, b] 안에서 전극 탈락이 없고 표본이 거의 다 있는(≥95%) 8초를 찾는다. 2초 간격으로 밀며 첫 번째 좋은 구간, 없으면 가장 많이 찬 구간(≥60%).
fn best_window(root: &std::path::Path, patch: u32, a: u64, b: u64, sec_off: &std::collections::HashSet<u64>) -> Option<(u64, Vec<f32>)> {
    if b <= a { return None; }
    let recs = crate::patch_store::read_ecg_range(root, patch, a, b.max(a + STRIP_MS));
    // 표본별 시각 (레코드 ts = 마지막 표본, 250 Hz → 125 Hz)
    let mut ts: Vec<u64> = Vec::new();
    let mut vs: Vec<f32> = Vec::new();
    for (t, _seq, s) in recs {
        let n = s.len() as u64;
        for (i, v) in s.iter().enumerate().step_by(2) {
            if !v.is_finite() { continue; }
            ts.push(t.saturating_sub((n - 1 - i as u64) * 4)); vs.push(*v);
        }
    }
    if ts.len() < 200 { return None; }
    let need = (STRIP_MS / 8) as usize; // 125 Hz × 8 s = 1000
    let mut best: Option<(usize, u64)> = None;
    let mut w0 = a;
    while w0 + STRIP_MS <= b.max(a + STRIP_MS) {
        let off = (w0 / 1000..=(w0 + STRIP_MS) / 1000).any(|sec| sec_off.contains(&sec));
        if !off {
            let i0 = ts.partition_point(|t| *t < w0);
            let i1 = ts.partition_point(|t| *t < w0 + STRIP_MS);
            let n = i1 - i0;
            if n * 100 >= need * 95 { best = Some((i0, w0)); break; }
            if best.map(|(bi, bw)| { let bn = ts.partition_point(|t| *t < bw + STRIP_MS) - bi; n > bn }).unwrap_or(true) && n * 100 >= need * 60 { best = Some((i0, w0)); }
        }
        w0 += 2000;
    }
    let (i0, w) = best?;
    let i1 = ts.partition_point(|t| *t < w + STRIP_MS);
    Some((ts[i0], vs[i0..i1].iter().take(need).cloned().collect()))
}

