//! 알고리즘 검증 — 에뮬레이터 정답지(`/api/v1/labels`, 패치별 리듬 에피소드·전극 탈락 구간, ms 단위)와 내장 엔진의 판정 흔적을
//! 대조해 클래스별 민감도·정밀도·검출 지연을 낸다. 결과는 활성 엔진 버전 폴더(`versions/<key>/eval.json`)에 남아 페이지에 보인다.
//!
//! 에피소드 매칭 규칙: 정답 에피소드 [t0, t1] 안(t0 − 2 s ~ t1 + 5 s)에서 엔진이 대응 라벨을 한 번이라도 냈으면 검출(TP), 지연 = 첫 검출 − t0.
//! 엔진 라벨 구간(전환 이력에서 복원)이 어떤 정답 에피소드와도 겹치지 않으면 오검출(FP). 엔진이 검출하지 않는 클래스(방실 차단 등)는
//! "미지원"으로 따로 센다. 박동 단위 정답(R파 시각·N/S/V)은 에뮬레이터가 아직 주지 않아 박동 지표는 비어 있다.
use crate::state::AppState;
use std::collections::HashMap;
use std::sync::Arc;

/// 정답 값 → (엔진 라벨 후보, 표시 이름). None = 엔진 미지원 클래스
pub fn map_truth(v: &str) -> (Vec<&'static str>, &'static str) {
    match v {
        "afib" | "afib_rvr" | "aflutter" => (vec!["afib"], "심방세동"),
        "vfib" => (vec!["vf"], "심실세동"),
        "vt" => (vec!["vtach", "vrun"], "심실빈맥"),
        "nsvt" => (vec!["vrun", "vtach"], "비지속성 심실빈맥"),
        "sinus_pause" => (vec!["pause", "asystole"], "동정지/휴지"),
        "asystole" => (vec!["asystole", "pause"], "심정지"),
        "pvc" => (vec!["pvc", "*V"], "심실조기수축"),
        "pvc_bigeminy" => (vec!["bigeminy", "trigeminy", "pvc", "*V"], "심실 이단맥"),
        "sinus_tachy" => (vec!["tachy"], "동빈맥"),
        "sinus_brady" | "brady" => (vec!["brady"], "동서맥"),
        "pac" => (vec!["*S", "svrun"], "심방조기수축"),
        "svt" => (vec!["svrun", "tachy"], "상심실성 빈맥"),
        "nsr" | "sinus" => (vec!["nsr"], "정상 동율동"),
        "lead_off" => (vec!["leadoff"], "전극 탈락"),
        "avb1" | "avb2_m1" | "avb2_m2" | "avb3" | "block" => (vec![], "방실 차단 (엔진 미지원)"),
        "paced_malfunction" | "paced" | "paced_aai" | "paced_vvi" | "paced_ddd" | "paced_crt" => (vec![], "페이싱 (엔진 미지원)"),
        "lbbb" | "rbbb" | "stemi" | "ischemia" => (vec![], "형태 이상 (엔진 미지원)"),
        _ => (vec![], "기타"),
    }
}

#[derive(Default, Clone, serde::Serialize)]
pub struct ClassStat {
    pub name: String,
    pub engine: Vec<String>,
    pub labels: u64,
    pub tp: u64,
    pub fn_: u64,
    pub fp: u64,
    pub unsupported: bool,
    pub latencies_ms: Vec<u64>,
    pub sensitivity: Option<f64>,
    pub precision: Option<f64>,
    pub latency_median_ms: Option<u64>,
    pub latency_p90_ms: Option<u64>,
}

/// 오검출 억제용 "양립 가능" 매핑: 이 정답 상태에서 엔진이 내도 이상하지 않은 라벨 (검출 점수에는 넣지 않는다)
///   방실 차단·페이싱 오작동 → 탈락 박동으로 휴지/서맥, 페이싱·각차단 → 넓은 QRS 를 V 로, 심방조동 → AF 로
pub fn compatible(v: &str) -> &'static [&'static str] {
    match v {
        "avb2_m1" | "avb2_m2" | "avb3" | "block" => &["pause", "asystole", "brady", "*V", "afib"],
        "paced_malfunction" => &["pause", "asystole", "brady", "*V", "pvc", "bigeminy", "vrun", "afib"],
        "paced" | "paced_aai" | "paced_vvi" | "paced_ddd" | "paced_crt" => &["*V", "pvc", "bigeminy", "vrun", "vtach"],
        "lbbb" | "rbbb" => &["*V", "pvc", "bigeminy", "vrun", "vtach"],
        "aflutter" | "afib_rvr" | "afib" => &["afib", "tachy", "svrun", "*S"],
        "svt" | "pac" => &["svrun", "*S", "tachy", "afib"],
        "vfib" => &["vf", "vtach", "vrun", "*V", "asystole", "pause", "noise"],
        "vt" | "nsvt" => &["vtach", "vrun", "*V", "pvc", "tachy"],
        "sinus_pause" => &["pause", "asystole", "brady"],
        _ => &[],
    }
}

/// 오검출(FP)을 세는 엔진 라벨 — 정답이 명시적으로 표기되는 경보급 판정만. tachy/brady/nsr/noise/unknown 은 심박수 파생·기본 상태라 제외.
const FP_LABELS: &[(&str, &str)] = &[("afib", "afib"), ("vf", "vfib"), ("vtach", "vt"), ("vrun", "nsvt"), ("pause", "sinus_pause"), ("asystole", "sinus_pause"), ("pvc", "pvc"), ("bigeminy", "pvc_bigeminy"), ("svrun", "svt"), ("leadoff", "lead_off")];

/// 라벨 구간과 엔진 흔적으로 지표 계산. `labels`: (patch_id, value, t0, t1(None=진행 중)) — 구간과 겹치는 것만(전부터 이어지던 것 포함).
/// `base`: 패치별 기저 리듬(만성 상태) — 창 전체를 그 클래스의 정답 구간으로 보고 오검출 계산에서 제외한다. `tol_ms`: 시각 허용 오차(분 단위 이력이면 60초).
pub fn evaluate(labels: &[(u32, String, u64, Option<u64>)], base: &HashMap<u32, String>, traces: &[(u32, String, u64, Vec<(u64, String)>, Vec<u64>, Vec<u64>)], from_ms: u64, to_ms: u64, tol_ms: u64) -> serde_json::Value {
    let now = crate::protocol::now_ms();
    let end_of = |t1: &Option<u64>| t1.unwrap_or(to_ms.min(now));
    // 채널별 엔진 라벨 구간 복원
    let mut segs: HashMap<u32, Vec<(u64, u64, String)>> = HashMap::new();
    let mut vb: HashMap<u32, Vec<u64>> = HashMap::new();
    let mut sb: HashMap<u32, Vec<u64>> = HashMap::new();
    for (pid, cur, since, trace, v, s) in traces {
        let mut list: Vec<(u64, String)> = trace.clone();
        if list.last().map(|l| l.1 != *cur).unwrap_or(true) { list.push((*since, cur.clone())); }
        let mut out: Vec<(u64, u64, String)> = Vec::new();
        for (i, (t, l)) in list.iter().enumerate() {
            let end = list.get(i + 1).map(|n| n.0).unwrap_or(now);
            out.push((*t, end, l.clone()));
        }
        // 같은 라벨이 30초 안에 다시 켜지면 한 에피소드로 (켜졌다 꺼지기를 반복하는 판정을 조각마다 세지 않게)
        let mut merged: Vec<(u64, u64, String)> = Vec::new();
        for seg in out {
            let k = merged.iter().rposition(|m| m.2 == seg.2);
            let can = match k {
                Some(k) => seg.0.saturating_sub(merged[k].1) <= 30_000 && merged[k + 1..].iter().all(|m| m.1.saturating_sub(m.0) <= 30_000),
                None => false,
            };
            if let (true, Some(k)) = (can, k) {
                merged[k].1 = merged[k].1.max(seg.1);
            } else {
                merged.push(seg);
            }
        }
        segs.insert(*pid, merged);
        vb.insert(*pid, v.clone());
        sb.insert(*pid, s.clone());
    }
    // 정답 구간 (창과 겹치는 에피소드) + 기저 리듬을 창 전체 구간으로
    let mut truth: Vec<(u32, String, u64, u64, bool)> = labels.iter().filter(|(_, _, t0, t1)| *t0 <= to_ms && end_of(t1) >= from_ms).map(|(p, v, t0, t1)| (*p, v.clone(), *t0, end_of(t1), false)).collect();
    for (p, b) in base {
        if segs.contains_key(p) && !matches!(b.as_str(), "nsr" | "sinus" | "") {
            truth.push((*p, b.clone(), from_ms, to_ms, true));
        }
    }
    let mut stats: HashMap<String, ClassStat> = HashMap::new();
    let mut base_rows: HashMap<String, (u64, u64)> = HashMap::new(); // 기저 리듬: (환자 수, 엔진이 창 안에서 한 번이라도 맞춘 수)
    for (pid, value, t0, t1, is_base) in &truth {
        let (cands, name) = map_truth(value);
        if *is_base {
            let e = base_rows.entry(name.to_string()).or_default();
            e.0 += 1;
            let hit = cands.iter().any(|c| if let Some(kind) = c.strip_prefix('*') { let b = if kind == "V" { vb.get(pid) } else { sb.get(pid) }; b.map(|b| b.iter().any(|t| *t >= from_ms && *t <= to_ms)).unwrap_or(false) } else { segs.get(pid).map(|sg| sg.iter().any(|(a, b, l)| l == c && *a <= to_ms && *b >= from_ms)).unwrap_or(false) });
            if hit { e.1 += 1 }
            continue;
        }
        let st = stats.entry(name.to_string()).or_insert_with(|| ClassStat { name: name.to_string(), engine: cands.iter().map(|s| s.to_string()).collect(), unsupported: cands.is_empty(), ..Default::default() });
        st.labels += 1;
        if cands.is_empty() { continue; }
        let lo = t0.saturating_sub(2000 + tol_ms);
        let hi = t1.saturating_add(5000 + tol_ms);
        let mut first: Option<u64> = None;
        for c in &cands {
            if let Some(kind) = c.strip_prefix('*') {
                let beats = if kind == "V" { vb.get(pid) } else { sb.get(pid) };
                if let Some(t) = beats.and_then(|b| b.iter().find(|t| **t >= lo && **t <= hi)) { first = Some(first.map_or(*t, |f| f.min(*t))); }
            } else if let Some(sg) = segs.get(pid) {
                for (a, b, l) in sg {
                    if l == c && *a <= hi && *b >= lo { let t = (*a).max(*t0); first = Some(first.map_or(t, |f| f.min(t))); }
                }
            }
        }
        match first { Some(t) => { st.tp += 1; st.latencies_ms.push(t.saturating_sub(*t0)); } None => st.fn_ += 1 }
    }
    // 오검출: 경보급 엔진 라벨 구간(창 안) 중 어떤 정답(에피소드·기저 리듬)과도 겹치지 않는 것
    for (pid, sg) in &segs {
        for (a, b, l) in sg {
            if *b < from_ms || *a > to_ms { continue; }
            let Some((_, tv)) = FP_LABELS.iter().find(|(e, _)| e == l) else { continue };
            let ok = truth.iter().any(|(p, v, t0, t1, _)| p == pid && (map_truth(v).0.iter().any(|c| c == l) || compatible(v).iter().any(|c| c == l)) && *t0 <= b.saturating_add(5000 + tol_ms) && t1.saturating_add(5000 + tol_ms) >= *a);
            if !ok {
                let (c0, name0) = map_truth(tv);
                let e = stats.entry(name0.to_string()).or_insert_with(|| ClassStat { name: name0.to_string(), engine: c0.iter().map(|s| s.to_string()).collect(), ..Default::default() });
                e.fp += 1;
            }
        }
    }
    let mut rows: Vec<ClassStat> = stats.into_values().collect();
    for st in rows.iter_mut() {
        if st.tp + st.fn_ > 0 { st.sensitivity = Some(st.tp as f64 / (st.tp + st.fn_) as f64); }
        if st.tp + st.fp > 0 { st.precision = Some(st.tp as f64 / (st.tp + st.fp) as f64); }
        if !st.latencies_ms.is_empty() {
            let mut l = st.latencies_ms.clone(); l.sort_unstable();
            st.latency_median_ms = Some(l[l.len() / 2]);
            st.latency_p90_ms = Some(l[(l.len() * 9 / 10).min(l.len() - 1)]);
        }
        st.latencies_ms.clear();
    }
    rows.sort_by(|a, b| b.labels.cmp(&a.labels));
    let supported: Vec<&ClassStat> = rows.iter().filter(|r| !r.unsupported && r.labels > 0).collect();
    let (tp, fn_, fp) = supported.iter().fold((0u64, 0u64, 0u64), |a, r| (a.0 + r.tp, a.1 + r.fn_, a.2 + r.fp));
    let base_list: Vec<serde_json::Value> = base_rows.into_iter().map(|(k, (n, hit))| serde_json::json!({ "name": k, "patients": n, "matched": hit })).collect();
    serde_json::json!({
        "ms": now, "from_ms": from_ms, "to_ms": to_ms, "labels": truth.iter().filter(|t| !t.4).count(), "channels": traces.len(), "tol_ms": tol_ms,
        "overall": { "tp": tp, "fn": fn_, "fp": fp, "sensitivity": if tp + fn_ > 0 { Some(tp as f64 / (tp + fn_) as f64) } else { None }, "precision": if tp + fp > 0 { Some(tp as f64 / (tp + fp) as f64) } else { None } },
        "classes": rows,
        "base": base_list,
        "beats": serde_json::Value::Null,
        "note": "정답: 에뮬레이터 /api/v1/labels (rhythm_episode · lead_off, 창과 겹치는 에피소드 — 전부터 이어지던 것 포함) + 환자 기저 리듬(창 전체). 검출 = 정답 구간(−2 s ~ +5 s) 안에 엔진이 대응 라벨/박동을 냄. 오검출은 경보급 라벨만 세고, 방실 차단·페이싱·각차단처럼 그 라벨이 생리적으로 예상되는 정답 상태(양립)는 제외한다. 박동 단위 정답은 아직 없음.",
    })
}

/// 에뮬레이터에서 최근 구간의 정답을 받아 평가하고 활성 엔진 폴더에 저장
pub async fn run(state: &Arc<AppState>, hours: f64) -> Result<serde_json::Value, String> {
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다 (네트워크 설정)")?;
    let now = crate::protocol::now_ms();
    let hours = hours.clamp(0.05, 14.0 * 24.0);
    let from = now.saturating_sub((hours * 3_600_000.0) as u64);
    // 전부터 이어지던 에피소드도 잡히게 6시간 앞부터 받는다
    let since = from.saturating_sub(6 * 3_600_000);
    let mut labels: Vec<(u32, String, u64, Option<u64>)> = Vec::new();
    let mut base: HashMap<u32, String> = HashMap::new();
    let mut offset = 0usize;
    loop {
        let path = format!("/api/v1/labels?kind=rhythm_episode,lead_off&since_ms={since}&until_ms={now}&include_open=true&limit=5000&offset={offset}");
        let (code, body) = crate::emu_link::request(&addr, "GET", &path, None).await.map_err(|e| e.to_string())?;
        if code != 200 { return Err(format!("labels HTTP {code}")); }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let arr = v.get("labels").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let got = arr.len();
        for l in arr {
            let pid = l.get("patch_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let t0 = l.get("t_start_ms").and_then(|x| x.as_u64()).unwrap_or(0);
            if pid == 0 || t0 == 0 { continue; }
            let t1 = l.get("t_end_ms").and_then(|x| x.as_u64());
            let kind = l.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            let value = if kind == "lead_off" { "lead_off".to_string() } else { l.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string() };
            if let Some(b) = l.get("meta").and_then(|m| m.get("base")).and_then(|x| x.as_str()) { base.entry(pid).or_insert_with(|| b.to_string()); }
            labels.push((pid, value, t0, t1));
        }
        offset += got;
        if got < 5000 || offset > 300_000 { break; }
    }
    // 기저 리듬: 재원 환자 목록(rhythm + admission.patch_id) — 라벨에 base 가 없는 환자까지
    if let Ok((200, body)) = crate::emu_link::request(&addr, "GET", "/api/v1/emr/patients?status=admitted&limit=10000", None).await {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
            for p in v.get("patients").and_then(|a| a.as_array()).cloned().unwrap_or_default() {
                let pid = p.get("admission").and_then(|a| a.get("patch_id")).and_then(|x| x.as_u64()).or_else(|| p.get("patch_id").and_then(|x| x.as_u64())).unwrap_or(0) as u32;
                if let (true, Some(r)) = (pid > 0, p.get("rhythm").and_then(|x| x.as_str())) { base.entry(pid).or_insert_with(|| r.to_string()); }
            }
        }
    }
    // 판정 이력: 1시간 이하는 메모리 흔적(정밀), 그 이상은 DB (분 단위 박동 → 허용 오차 60 s)
    let (traces, tol) = if hours <= 1.0 { (state.analysis.traces(), 0u64) } else { (state.analysis.traces_db(from, now), 60_000u64) };
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || evaluate(&labels, &base, &traces, from, now, tol)).await.map_err(|e| e.to_string())?;
    if let Some(e) = st.analysis.engine() {
        let dir = st.analysis.versions_dir().join(crate::ecg_analysis::AnalysisHub::version_key(&e.id));
        let _ = std::fs::create_dir_all(&dir);
        let mut all: Vec<serde_json::Value> = std::fs::read_to_string(dir.join("eval.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        all.push(result.clone());
        if all.len() > 30 { let cut = all.len() - 30; all.drain(..cut); }
        let _ = std::fs::write(dir.join("eval.json"), serde_json::to_string(&all).unwrap_or_default());
    }
    Ok(result)
}

pub fn last(state: &AppState) -> serde_json::Value {
    let Some(e) = state.analysis.engine() else { return serde_json::Value::Null };
    let dir = state.analysis.versions_dir().join(crate::ecg_analysis::AnalysisHub::version_key(&e.id));
    let all: Vec<serde_json::Value> = std::fs::read_to_string(dir.join("eval.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    serde_json::json!({ "last": all.last().cloned(), "history": all.iter().map(|r| serde_json::json!({ "ms": r["ms"], "labels": r["labels"], "overall": r["overall"] })).collect::<Vec<_>>() })
}
