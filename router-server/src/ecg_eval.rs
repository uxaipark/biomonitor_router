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

/// 라벨 구간과 엔진 흔적으로 지표 계산. `labels`: (patch_id, value, t0, t1(None=진행 중))
pub fn evaluate(labels: &[(u32, String, u64, Option<u64>)], traces: &[(u32, String, u64, Vec<(u64, String)>, Vec<u64>, Vec<u64>)], from_ms: u64, to_ms: u64) -> serde_json::Value {
    let now = crate::protocol::now_ms();
    // 채널별 엔진 라벨 구간 복원: 전환 이력 + 현재 라벨
    let mut segs: HashMap<u32, Vec<(u64, u64, String)>> = HashMap::new();
    let mut vb: HashMap<u32, Vec<u64>> = HashMap::new();
    let mut sb: HashMap<u32, Vec<u64>> = HashMap::new();
    for (pid, cur, since, trace, v, s) in traces {
        let mut list: Vec<(u64, String)> = trace.clone();
        if list.last().map(|l| l.1 != *cur).unwrap_or(true) {
            list.push((*since, cur.clone()));
        }
        let mut out = Vec::new();
        for (i, (t, l)) in list.iter().enumerate() {
            let end = list.get(i + 1).map(|n| n.0).unwrap_or(now);
            out.push((*t, end, l.clone()));
        }
        segs.insert(*pid, out);
        vb.insert(*pid, v.clone());
        sb.insert(*pid, s.clone());
    }
    let mut stats: HashMap<String, ClassStat> = HashMap::new();
    let mut used: HashMap<u32, Vec<(u64, u64)>> = HashMap::new(); // 엔진 구간이 정답에 쓰였는지 (FP 계산)
    for (pid, value, t0, t1) in labels {
        let (cands, name) = map_truth(value);
        let st = stats.entry(value.clone()).or_insert_with(|| ClassStat { name: name.to_string(), engine: cands.iter().map(|s| s.to_string()).collect(), unsupported: cands.is_empty(), ..Default::default() });
        st.labels += 1;
        if cands.is_empty() {
            continue;
        }
        let lo = t0.saturating_sub(2000);
        let hi = t1.unwrap_or(now).saturating_add(5000);
        let mut first: Option<u64> = None;
        for c in &cands {
            if let Some(kind) = c.strip_prefix('*') {
                let beats = if kind == "V" { vb.get(pid) } else { sb.get(pid) };
                if let Some(t) = beats.and_then(|b| b.iter().find(|t| **t >= lo && **t <= hi)) {
                    first = Some(first.map_or(*t, |f| f.min(*t)));
                }
            } else if let Some(sg) = segs.get(pid) {
                for (a, b, l) in sg {
                    if l == c && *a <= hi && *b >= lo {
                        let t = (*a).max(lo);
                        first = Some(first.map_or(t, |f| f.min(t)));
                        used.entry(*pid).or_default().push((*a, *b));
                    }
                }
            }
        }
        match first {
            Some(t) => {
                st.tp += 1;
                st.latencies_ms.push(t.saturating_sub(*t0));
            }
            None => st.fn_ += 1,
        }
    }
    // FP: 엔진 라벨 구간(비정상 클래스만) 중 어떤 정답과도 겹치지 않은 것 — 라벨→정답 클래스 역매핑으로 센다
    let rev: Vec<(&str, &str)> = vec![("afib", "afib"), ("vf", "vfib"), ("vtach", "vt"), ("vrun", "nsvt"), ("pause", "sinus_pause"), ("asystole", "sinus_pause"), ("pvc", "pvc"), ("bigeminy", "pvc_bigeminy"), ("tachy", "sinus_tachy"), ("brady", "sinus_brady"), ("svrun", "svt"), ("leadoff", "lead_off")];
    let mut truth_by_pid: HashMap<u32, Vec<(u64, u64, &str)>> = HashMap::new();
    for (pid, value, t0, t1) in labels {
        truth_by_pid.entry(*pid).or_default().push((*t0, t1.unwrap_or(now), value.as_str()));
    }
    for (pid, sg) in &segs {
        for (a, b, l) in sg {
            if *b < from_ms || *a > to_ms {
                continue;
            }
            let Some((_, tv)) = rev.iter().find(|(e, _)| e == l) else { continue };
            let (cands, _) = map_truth(tv);
            // 이 엔진 라벨을 검출로 인정하는 정답 값들과 겹치는지
            let overlaps = truth_by_pid.get(pid).map(|ts| ts.iter().any(|(t0, t1, v)| { let (c2, _) = map_truth(v); c2.iter().any(|c| c == l) && *t0 <= b.saturating_add(5000) && *t1 + 5000 >= *a })).unwrap_or(false);
            let _ = cands;
            if !overlaps {
                if let Some(st) = stats.get_mut(*tv) {
                    st.fp += 1;
                } else {
                    let (c, name) = map_truth(tv);
                    stats.insert(tv.to_string(), ClassStat { name: name.to_string(), engine: c.iter().map(|s| s.to_string()).collect(), fp: 1, ..Default::default() });
                }
            }
        }
    }
    let mut rows: Vec<ClassStat> = stats.into_values().collect();
    for st in rows.iter_mut() {
        if st.tp + st.fn_ > 0 {
            st.sensitivity = Some(st.tp as f64 / (st.tp + st.fn_) as f64);
        }
        if st.tp + st.fp > 0 {
            st.precision = Some(st.tp as f64 / (st.tp + st.fp) as f64);
        }
        if !st.latencies_ms.is_empty() {
            let mut l = st.latencies_ms.clone();
            l.sort_unstable();
            st.latency_median_ms = Some(l[l.len() / 2]);
            st.latency_p90_ms = Some(l[(l.len() * 9 / 10).min(l.len() - 1)]);
        }
        st.latencies_ms.clear();
    }
    rows.sort_by(|a, b| b.labels.cmp(&a.labels));
    let supported: Vec<&ClassStat> = rows.iter().filter(|r| !r.unsupported && r.labels > 0).collect();
    let (tp, fn_, fp) = supported.iter().fold((0u64, 0u64, 0u64), |a, r| (a.0 + r.tp, a.1 + r.fn_, a.2 + r.fp));
    serde_json::json!({
        "ms": now, "from_ms": from_ms, "to_ms": to_ms, "labels": labels.len(), "channels": traces.len(),
        "overall": { "tp": tp, "fn": fn_, "fp": fp, "sensitivity": if tp + fn_ > 0 { Some(tp as f64 / (tp + fn_) as f64) } else { None }, "precision": if tp + fp > 0 { Some(tp as f64 / (tp + fp) as f64) } else { None } },
        "classes": rows,
        "beats": serde_json::Value::Null,
        "note": "정답: 에뮬레이터 /api/v1/labels (rhythm_episode · lead_off). 검출 = 정답 구간(−2 s ~ +5 s) 안에 엔진이 대응 라벨/박동을 한 번이라도 냄. 박동 단위 정답은 아직 없음.",
    })
}

/// 에뮬레이터에서 최근 구간의 정답을 받아 평가하고 활성 엔진 폴더에 저장
pub async fn run(state: &Arc<AppState>, hours: f64) -> Result<serde_json::Value, String> {
    let addr = state.net.emulator().ok_or("에뮬레이터 주소가 없습니다 (네트워크 설정)")?;
    let now = crate::protocol::now_ms();
    let from = now.saturating_sub((hours.clamp(0.1, 24.0) * 3_600_000.0) as u64);
    let mut labels: Vec<(u32, String, u64, Option<u64>)> = Vec::new();
    let mut offset = 0usize;
    loop {
        let path = format!("/api/v1/labels?kind=rhythm_episode,lead_off&since_ms={from}&until_ms={now}&include_open=true&limit=5000&offset={offset}");
        let (code, body) = crate::emu_link::request(&addr, "GET", &path, None).await.map_err(|e| e.to_string())?;
        if code != 200 {
            return Err(format!("labels HTTP {code}"));
        }
        let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let arr = v.get("labels").and_then(|a| a.as_array()).cloned().unwrap_or_default();
        let got = arr.len();
        for l in arr {
            let pid = l.get("patch_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let t0 = l.get("t_start_ms").and_then(|x| x.as_u64()).unwrap_or(0);
            if pid == 0 || t0 == 0 {
                continue;
            }
            let t1 = l.get("t_end_ms").and_then(|x| x.as_u64());
            let kind = l.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            let value = if kind == "lead_off" { "lead_off".to_string() } else { l.get("value").and_then(|x| x.as_str()).unwrap_or("").to_string() };
            labels.push((pid, value, t0, t1));
        }
        offset += got;
        if got < 5000 || offset > 200_000 {
            break;
        }
    }
    let traces = state.analysis.traces();
    let st = state.clone();
    let result = tokio::task::spawn_blocking(move || evaluate(&labels, &traces, from, now)).await.map_err(|e| e.to_string())?;
    // 저장: 활성 엔진 버전 폴더 + 최근 결과
    if let Some(e) = st.analysis.engine() {
        let dir = st.analysis.versions_dir().join(crate::ecg_analysis::AnalysisHub::version_key(&e.id));
        let _ = std::fs::create_dir_all(&dir);
        let mut all: Vec<serde_json::Value> = std::fs::read_to_string(dir.join("eval.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        all.push(result.clone());
        if all.len() > 30 {
            let cut = all.len() - 30;
            all.drain(..cut);
        }
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
