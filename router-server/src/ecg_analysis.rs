//! 실시간 ECG 분석 허브 — live-ecg 엔진(`ecg_engine.rs` 로 읽은 libecg.so)을 라우터 안에서 돌린다.
//!
//! 흐름: ingest → [샤드 스레드 N개: 채널별 엔진 채널에 mV 샘플 push, 유실은 gap 으로 선언] → 이벤트(박동·리듬 에피소드·AF 창·VF·
//! 전극·상심실 런) → 채널별 요약(`AnaRow`, DashMap) → ① 스트림 헤더 `ana`(뷰어 표시·박동 마크) ② `/api/channels` 행 ③ 알람 평가.
//! 엔진 파일이 바뀌면(mtime/size) 감시 스레드가 새 엔진을 읽고 세대(gen)를 올린다; 샤드는 다음 패킷에서 채널을 새 엔진으로
//! 다시 만든다(옛 라이브러리는 옛 채널이 모두 사라진 뒤 닫힘). 라우터 재빌드·재시작 없음.
use crate::ecg_engine::{self as eng, Channel, EcgEvent, Engine};
use dashmap::DashMap;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, RwLock};
use std::time::{Duration, Instant};
use tracing::{info, warn};

/// 뷰어·목록·알람이 보는 채널별 분석 요약
#[derive(Debug, Clone, Serialize, Default)]
pub struct AnaRow {
    /// 분석 심박수 (최근 8개 RR 평균) — 패치가 보내는 HR 이 아니라 직접 검출한 박동에서
    pub hr: Option<f32>,
    /// 표시용 리듬 라벨: nsr afib vf vtach vrun bigeminy trigeminy ivr svrun brady tachy pause asystole pvc leadoff noise unknown
    pub rhythm: String,
    pub rhythm_since_ms: u64,
    /// 신호 품질 0 good · 1 acceptable · 2 unusable · 3 unknown, 점수 0..1
    pub q: u32,
    pub qs: f32,
    pub af: bool,
    pub af_p: f32,
    pub vf: bool,
    pub lead_off: bool,
    /// 최근 1분 심실 조기 박동 수
    pub pvc_min: u32,
    pub beats_total: u64,
    pub last_beat_ms: u64,
    /// 마지막으로 분석한 샘플의 시각(패킷 시간대) 과 검출 지연 추정(ms): 휴지·심정지는 (pkt_ms − last_beat_ms − lag) 로 잰다
    pub pkt_ms: u64,
    pub lag_ms: u32,
    /// 최근 에피소드 (kind, start_ms, end_ms) — kind 는 rhythm_name / "vf" / "svrun" / "leadoff"
    pub episodes: Vec<(String, u64, u64)>,
    pub stages: String,
    pub engine: String,
    pub updated_ms: u64,
    /// 아직 스트림에 실어 보내지 않은 박동 마크 (t_ms, code) — 스트림 방출 때 비운다
    #[serde(skip)]
    pub marks: Vec<(u64, u32)>,
    /// 검증용 흔적: 리듬 라벨 전환 (t_ms, label) 최근 160개, 심실(V)·상심실(S) 박동 시각 최근 300개
    #[serde(skip)]
    pub trace: VecDeque<(u64, String)>,
    #[serde(skip)]
    pub vbeats: VecDeque<u64>,
    #[serde(skip)]
    pub sbeats: VecDeque<u64>,
}

/// 스트림 헤더에 싣는 축약본
#[derive(Debug, Clone, Serialize)]
pub struct AnaBrief {
    pub hr: Option<f32>,
    pub rhythm: String,
    pub q: u32,
    pub af: bool,
    pub vf: bool,
    pub pvc: u32,
    /// [[t_ms, code], …] code 0 N · 1 S · 2 V · 3 F · 4 ?
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub beats: Vec<(u64, u32)>,
}

pub struct Pkt {
    /// 패치 번호 (채널 id 는 숫자 문자열) — 패킷마다 문자열을 만들지 않는다
    pub channel_id: u32,
    pub seq: u64,
    pub ts_ms: u64,
    pub fs: u32,
    pub samples: Vec<f32>,
}
enum Job {
    /// 게이트웨이 프레임 하나에 든 패킷들을 샤드별로 묶어 보낸다 — 패킷마다 스레드를 깨우지 않는다
    Batch(Vec<Pkt>),
    Remove(u32),
}

struct Slot {
    chan: Channel,
    gen: u64,
    fs: u32,
    last_seq: u64,
    /// 다음 샘플이 와야 할 시각 (ms, 마지막 샘플 + 1 step); 0 = 처음
    last_end_ms: f64,
    /// 엔진 인덱스(0 = 첫 push 샘플) 와 시각의 대응: t = anchor + idx*step, 패킷마다 다시 맞춘다
    idx: u64,
    anchor_ms: f64,
    beats: VecDeque<(f64, u32)>,
    pvc: VecDeque<f64>,
    episodes: VecDeque<(String, u64, u64)>,
    af_p: f32,
    in_af: bool,
    status: eng::EcgStatus,
    last_pkt_ms: u64,
    rhythm: String,
    rhythm_since: u64,
    beats_total: u64,
    last_beat_ms: f64,
    stages: String,
    marks: Vec<(u64, u32)>,
    last_touch: Instant,
    /// 박동 검출 지연(패킷 시각 − 보고된 R 시각) 의 지수 이동 평균
    lag_ms: f64,
    /// 요약 행을 마지막으로 쓴 패킷 번호 (이벤트 없으면 5패킷=1초마다만 쓴다)
    row_seq: u64,
    dirty: bool,
    /// 행에 아직 옮기지 않은 검증 흔적
    pend_trace: Vec<(u64, String)>,
    pend_v: Vec<u64>,
    pend_s: Vec<u64>,
}

pub struct AnalysisHub {
    pub lib_path: String,
    /// 프리셋(0 clinical · 1 patch)과 단계 선택 "kind=name;…" — 실행 중 바꿀 수 있고(`set_config`) data/engine/config.json 에 남는다
    preset: std::sync::atomic::AtomicU32,
    stages_cfg: RwLock<String>,
    engine: RwLock<Option<Arc<Engine>>>,
    gen: AtomicU64,
    shards: Vec<mpsc::SyncSender<Job>>,
    rows: DashMap<u32, AnaRow>,
    pub packets: AtomicU64,
    pub dropped: AtomicU64,
    pub stale: AtomicU64,
    pub gaps: AtomicU64,
    pub events: AtomicU64,
    pub beats: AtomicU64,
    pub channels_live: AtomicU64,
    pub busy_ns: AtomicU64,
    last_error: Mutex<String>,
    loaded_ms: AtomicU64,
    bench_last: Mutex<serde_json::Value>,
    /// 벤치 이력(최근 10회)·판정 이력(ecg_trace: 라벨 전환, ecg_beatmin: 분당 V/S 박동 수, 14일 보관)을 남기는 라우터 DB 연결
    db: Mutex<Option<rusqlite::Connection>>,
    /// DB 에 아직 안 쓴 이력 (10초마다 감시 스레드가 쓴다)
    pend_db: Mutex<(Vec<(u32, u64, String)>, HashMap<(u32, u64), (u32, u32)>)>,
    last_prune_ms: AtomicU64,
}

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

impl AnalysisHub {
    /// 엔진을 읽고(없으면 꺼진 채로) 샤드 스레드와 감시 스레드를 띄운다.
    pub fn start(lib_path: &str, preset: u32, stages: &str, threads: usize, db_path: &str) -> Arc<AnalysisHub> {
        let n = threads.clamp(1, 8);
        let mut shards = Vec::with_capacity(n);
        let mut rxs = Vec::with_capacity(n);
        for _ in 0..n {
            let (tx, rx) = mpsc::sync_channel::<Job>(8192);
            shards.push(tx);
            rxs.push(rx);
        }
        // 저장된 실행 설정(config.json)이 있으면 환경변수보다 우선
        let (mut preset, mut stages) = (preset, stages.to_string());
        if let Ok(txt) = std::fs::read_to_string(Self::cfg_path_of(lib_path)) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(p) = v.get("preset").and_then(|x| x.as_str()) {
                    preset = if p == "clinical" { eng::ECG_PRESET_CLINICAL } else { eng::ECG_PRESET_PATCH };
                }
                if let Some(st) = v.get("stages").and_then(|x| x.as_str()) {
                    stages = st.to_string();
                }
            }
        }
        let hub = Arc::new(AnalysisHub {
            lib_path: lib_path.to_string(),
            preset: std::sync::atomic::AtomicU32::new(preset),
            stages_cfg: RwLock::new(stages),
            engine: RwLock::new(None),
            gen: AtomicU64::new(0),
            shards,
            rows: DashMap::new(),
            packets: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            stale: AtomicU64::new(0),
            gaps: AtomicU64::new(0),
            events: AtomicU64::new(0),
            beats: AtomicU64::new(0),
            channels_live: AtomicU64::new(0),
            busy_ns: AtomicU64::new(0),
            last_error: Mutex::new(String::new()),
            loaded_ms: AtomicU64::new(0),
            bench_last: Mutex::new(serde_json::Value::Null),
            db: Mutex::new(rusqlite::Connection::open(db_path).ok().and_then(|c| {
                let _ = c.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS ecg_bench (ms INTEGER PRIMARY KEY, engine TEXT NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ecg_trace (patch INTEGER NOT NULL, ms INTEGER NOT NULL, label TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ecg_trace_pm ON ecg_trace(patch, ms); CREATE INDEX IF NOT EXISTS ecg_trace_ms ON ecg_trace(ms); CREATE TABLE IF NOT EXISTS ecg_beatmin (patch INTEGER NOT NULL, minute_ms INTEGER NOT NULL, v INTEGER NOT NULL, s INTEGER NOT NULL, PRIMARY KEY (patch, minute_ms)); CREATE INDEX IF NOT EXISTS ecg_beatmin_ms ON ecg_beatmin(minute_ms);");
                Some(c)
            })),
            pend_db: Mutex::new((Vec::new(), HashMap::new())),
            last_prune_ms: AtomicU64::new(0),
        });
        match hub.reload() {
            Ok(id) => info!("ecg engine: {} ({})", id, lib_path),
            Err(e) => warn!("ecg engine: 없음/실패 — 분석 꺼짐 ({}); scripts/update-ecg-engine.sh 로 설치하면 10초 안에 켜집니다", e),
        }
        for (i, rx) in rxs.into_iter().enumerate() {
            let h = hub.clone();
            std::thread::Builder::new().name(format!("ecg-shard-{i}")).spawn(move || h.shard_loop(rx)).expect("ecg shard thread");
        }
        {
            let h = hub.clone();
            std::thread::Builder::new()
                .name("ecg-watch".into())
                .spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(10));
                    h.check_file();
                    h.flush_db();
                })
                .expect("ecg watch thread");
        }
        hub
    }

    pub fn engine(&self) -> Option<Arc<Engine>> {
        self.engine.read().unwrap().clone()
    }
    pub fn enabled(&self) -> bool {
        self.engine.read().unwrap().is_some()
    }
    pub fn last_error(&self) -> String {
        self.last_error.lock().unwrap().clone()
    }

    /// 파일에서 엔진을 (다시) 읽는다. 성공하면 세대가 올라가 채널이 새 엔진으로 옮겨 간다.
    pub fn reload(&self) -> Result<String, String> {
        match Engine::load(&self.lib_path) {
            Ok(e) => {
                let id = e.id.clone();
                let prev = self.engine.read().unwrap().as_ref().map(|x| x.id.clone());
                *self.engine.write().unwrap() = Some(e);
                self.gen.fetch_add(1, Ordering::Relaxed);
                self.loaded_ms.store(now_ms(), Ordering::Relaxed);
                self.last_error.lock().unwrap().clear();
                if prev.as_deref() != Some(id.as_str()) {
                    self.history_push("load", &id, "");
                    let _ = self.import_current();
                }
                Ok(id)
            }
            Err(e) => {
                *self.last_error.lock().unwrap() = e.clone();
                Err(e)
            }
        }
    }

    /// 파일이 바뀌었으면(mtime·size) 다시 읽는다 — 감시 스레드가 10초마다
    fn check_file(&self) {
        let cur = self.engine();
        let Ok(meta) = std::fs::metadata(&self.lib_path) else { return };
        let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0);
        let changed = match &cur {
            Some(e) => e.mtime_ms != mtime || e.size != meta.len(),
            None => true,
        };
        if !changed {
            return;
        }
        // 쓰는 중인 파일을 읽지 않게: 마지막 수정이 2초는 지나야
        if now_ms().saturating_sub(mtime) < 2000 {
            return;
        }
        match self.reload() {
            Ok(id) => info!("ecg engine reloaded: {} — 채널을 새 엔진으로 옮깁니다", id),
            Err(e) => warn!("ecg engine reload failed: {}", e),
        }
    }

    // ── 실행 설정: 프리셋·단계 (새 채널부터 적용, 세대를 올려 모든 채널이 다시 만들어진다) ──
    fn cfg_path_of(lib_path: &str) -> std::path::PathBuf {
        std::path::Path::new(lib_path).parent().unwrap_or(std::path::Path::new(".")).join("config.json")
    }
    pub fn config_json(&self) -> serde_json::Value {
        serde_json::json!({ "preset": if self.preset.load(Ordering::Relaxed) == eng::ECG_PRESET_PATCH { "patch" } else { "clinical" }, "stages": self.stages_cfg.read().unwrap().clone(), "threads": self.shards.len() })
    }
    /// 프리셋(patch|clinical)·단계("kind=name;…", 빈 문자열 = 프리셋 기본) 를 바꾼다. 엔진이 거부하는 단계 이름이면 오류(ECG_ERR_CONFIG).
    pub fn set_config(&self, preset: &str, stages: &str) -> Result<serde_json::Value, String> {
        let pv = match preset { "clinical" => eng::ECG_PRESET_CLINICAL, "patch" | "" => eng::ECG_PRESET_PATCH, other => return Err(format!("알 수 없는 프리셋 {other}")) };
        let stages = stages.trim().trim_matches(';').to_string();
        if let Some(e) = self.engine() {
            e.channel(250.0, pv, &stages).map_err(|code| if code == -2 { format!("엔진이 단계 선택을 거부했습니다 (ECG_ERR_CONFIG): {stages}") } else { format!("채널 생성 실패 ({code})") })?;
        }
        self.preset.store(pv, Ordering::Relaxed);
        *self.stages_cfg.write().unwrap() = stages.clone();
        let cfg = serde_json::json!({ "preset": if pv == eng::ECG_PRESET_PATCH { "patch" } else { "clinical" }, "stages": stages, "updated_ms": now_ms() });
        let _ = std::fs::write(Self::cfg_path_of(&self.lib_path), serde_json::to_string_pretty(&cfg).unwrap_or_default());
        self.gen.fetch_add(1, Ordering::Relaxed); // 채널을 새 설정으로 다시 만든다
        self.history_push("config", &self.engine().map(|e| e.id.clone()).unwrap_or_default(), &format!("preset={} stages={}", cfg["preset"].as_str().unwrap_or(""), if stages.is_empty() { "(preset)" } else { &stages }));
        Ok(self.config_json())
    }

    // ── 엔진 보관함(버전): data/engine/versions/<hash>/{libecg.so, meta.json, perf.md} ──
    pub fn versions_dir(&self) -> std::path::PathBuf {
        std::path::Path::new(&self.lib_path).parent().unwrap_or(std::path::Path::new(".")).join("versions")
    }
    fn history_path(&self) -> std::path::PathBuf {
        std::path::Path::new(&self.lib_path).parent().unwrap_or(std::path::Path::new(".")).join("history.json")
    }
    /// 엔진 id "live-ecg 0.1.0 src 10ef7af134c3a5cb" → 버전 키 (src 해시, 없으면 id 를 파일명으로 안전하게)
    pub fn version_key(id: &str) -> String {
        let mut it = id.split_whitespace();
        while let Some(w) = it.next() {
            if w == "src" {
                if let Some(h) = it.next() {
                    return h.trim_matches(|c: char| !c.is_ascii_hexdigit()).to_string();
                }
            }
        }
        id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect()
    }
    pub fn history_push(&self, action: &str, id: &str, detail: &str) {
        let path = self.history_path();
        let mut v: Vec<serde_json::Value> = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        v.push(serde_json::json!({ "ms": now_ms(), "action": action, "engine": id, "key": Self::version_key(id), "detail": detail }));
        if v.len() > 500 {
            let cut = v.len() - 500;
            v.drain(..cut);
        }
        if let Some(d) = path.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&path, serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    pub fn history(&self) -> Vec<serde_json::Value> {
        std::fs::read_to_string(self.history_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    /// 지금 활성 파일이 보관함에 없으면 복사해 둔다 (스크립트가 아닌 경로로 들어온 엔진도 버전으로 남게)
    pub fn import_current(&self) -> Result<String, String> {
        let e = self.engine().ok_or("엔진 없음")?;
        let key = Self::version_key(&e.id);
        let dir = self.versions_dir().join(&key);
        if dir.join("libecg.so").exists() {
            return Ok(key);
        }
        std::fs::create_dir_all(&dir).map_err(|x| x.to_string())?;
        std::fs::copy(&self.lib_path, dir.join("libecg.so")).map_err(|x| x.to_string())?;
        let meta = serde_json::json!({ "id": e.id, "key": key, "size": e.size, "imported_ms": now_ms(), "built_ms": e.mtime_ms, "abi": format!("{}.{}", e.abi.0, e.abi.1), "stages": e.stages.iter().map(|(n, _)| n).collect::<Vec<_>>(), "source": "import" });
        let _ = std::fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&meta).unwrap_or_default());
        Ok(key)
    }
    pub fn versions(&self) -> Vec<serde_json::Value> {
        let active_key = self.engine().map(|e| Self::version_key(&e.id)).unwrap_or_default();
        let mut out = Vec::new();
        if let Ok(rd) = std::fs::read_dir(self.versions_dir()) {
            for d in rd.flatten() {
                let dir = d.path();
                if !dir.join("libecg.so").exists() {
                    continue;
                }
                let key = d.file_name().to_string_lossy().to_string();
                let mut meta: serde_json::Value = std::fs::read_to_string(dir.join("meta.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(serde_json::json!({}));
                let m = std::fs::metadata(dir.join("libecg.so")).ok();
                if let Some(o) = meta.as_object_mut() {
                    o.insert("key".into(), key.clone().into());
                    o.insert("active".into(), (key == active_key).into());
                    o.insert("size".into(), m.as_ref().map(|m| m.len()).unwrap_or(0).into());
                    o.insert("file_ms".into(), m.and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0).into());
                    o.insert("has_perf".into(), dir.join("perf.md").exists().into());
                    o.insert("has_notes".into(), dir.join("notes.md").exists().into());
                }
                out.push(meta);
            }
        }
        out.sort_by(|a, b| b.get("built_ms").and_then(|x| x.as_u64()).unwrap_or(0).cmp(&a.get("built_ms").and_then(|x| x.as_u64()).unwrap_or(0)));
        out
    }
    /// 보관함의 버전을 활성 파일로 복사(원자적 교체) → 곧바로 다시 읽는다
    pub fn activate(&self, key: &str, by: &str) -> Result<String, String> {
        if key.is_empty() || key.contains('/') || key.contains("..") {
            return Err("잘못된 버전 키".into());
        }
        let src = self.versions_dir().join(key).join("libecg.so");
        if !src.exists() {
            return Err("보관함에 그 버전이 없습니다".into());
        }
        let tmp = format!("{}.activate.{}", self.lib_path, now_ms());
        std::fs::copy(&src, &tmp).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.lib_path).map_err(|e| e.to_string())?;
        let id = self.reload()?;
        self.history_push("activate", &id, by);
        Ok(id)
    }
    pub fn delete_version(&self, key: &str) -> Result<(), String> {
        if key.is_empty() || key.contains('/') || key.contains("..") {
            return Err("잘못된 버전 키".into());
        }
        if self.engine().map(|e| Self::version_key(&e.id) == key).unwrap_or(false) {
            return Err("활성 엔진은 지울 수 없습니다 (다른 버전을 먼저 활성화)".into());
        }
        std::fs::remove_dir_all(self.versions_dir().join(key)).map_err(|e| e.to_string())
    }
    pub fn version_doc(&self, key: &str, name: &str) -> Option<String> {
        if key.contains('/') || key.contains("..") || !matches!(name, "perf.md" | "notes.md" | "meta.json") {
            return None;
        }
        std::fs::read_to_string(self.versions_dir().join(key).join(name)).ok()
    }
    /// 지금 채널들의 리듬 분포·품질 요약 (관리 페이지)
    pub fn summary_json(&self) -> serde_json::Value {
        let mut rhythm: HashMap<String, u64> = HashMap::new();
        let mut q = [0u64; 4];
        let (mut n, mut hr_sum, mut hr_n, mut pvc) = (0u64, 0f64, 0u64, 0u64);
        let now = now_ms();
        for r in self.rows.iter() {
            if now.saturating_sub(r.updated_ms) > 10_000 {
                continue;
            }
            n += 1;
            *rhythm.entry(r.rhythm.clone()).or_default() += 1;
            if (r.q as usize) < 4 { q[r.q as usize] += 1 }
            if let Some(h) = r.hr { hr_sum += h as f64; hr_n += 1 }
            pvc += r.pvc_min as u64;
        }
        serde_json::json!({ "channels": n, "rhythm": rhythm, "quality": { "good": q[0], "acceptable": q[1], "unusable": q[2], "unknown": q[3] }, "hr_mean": if hr_n > 0 { hr_sum / hr_n as f64 } else { 0.0 }, "pvc_min_total": pvc })
    }

    /// 이 기기 실측 벤치: 합성 ECG(60 bpm + 잡음, 250 Hz)를 채널 N개에 `seconds` 초 분량씩 밀어 넣고 처리 시간을 잰다.
    /// 결과: 샘플당 ns, 코어당 처리 가능 채널 수(@250 Hz), 검출 박동 수, 스레드 수. 실제 운영 부하와 별도의 스레드에서 돌며 수 초 걸린다.
    pub fn bench(&self, seconds: u32, channels: u32) -> Result<serde_json::Value, String> {
        let e = self.engine().ok_or("엔진 없음")?;
        let seconds = seconds.clamp(5, 120);
        let channels = channels.clamp(1, 64);
        let fs = 250usize;
        let preset = self.preset.load(Ordering::Relaxed);
        let stages = self.stages_cfg.read().unwrap().clone();
        let mut chans: Vec<Channel> = (0..channels).map(|_| e.channel(fs as f64, preset, &stages)).collect::<Result<_, _>>().map_err(|c| format!("채널 생성 실패 ({c})"))?;
        let total = seconds as usize * fs;
        let mut buf = vec![0f32; 50];
        let mut ev = Vec::new();
        let (mut beats, mut events) = (0u64, 0u64);
        let t0 = Instant::now();
        let mut t = 0usize;
        while t < total {
            for (i, v) in buf.iter_mut().enumerate() {
                let k = (t + i) % fs;
                let phase = ((t + i) as f32) * 0.013;
                *v = if k < 10 { 1.2 * (1.0 - ((k as f32 - 5.0).abs() / 5.0)) } else { 0.05 * (phase * 2.0).sin() } + 0.02 * (phase * 37.0).sin();
            }
            for c in chans.iter_mut() {
                c.push(&buf);
                ev.clear();
                c.poll(&mut ev);
                for x in ev.iter() {
                    if x.kind == eng::EV_BEAT { beats += 1 }
                    events += 1;
                }
            }
            t += 50;
        }
        let el = t0.elapsed();
        let samples = total as u64 * channels as u64;
        let ns = el.as_nanos() as f64 / samples as f64;
        let per_core = if ns > 0.0 { (1e9 / (ns * fs as f64)) as u64 } else { 0 };
        let r = serde_json::json!({
            "ms": now_ms(), "engine": e.id, "seconds": seconds, "channels": channels, "fs": fs, "samples": samples,
            "elapsed_ms": el.as_millis() as u64, "ns_per_sample": (ns * 10.0).round() / 10.0, "channels_per_core": per_core,
            "beats": beats, "events": events, "beats_expected": seconds as u64 * channels as u64,
            "host": std::env::var("HOSTNAME").ok().or_else(|| std::fs::read_to_string("/etc/hostname").ok().map(|s| s.trim().to_string())).unwrap_or_default(),
            "threads_live": self.shards.len(), "channels_live": self.channels_live.load(Ordering::Relaxed),
        });
        *self.bench_last.lock().unwrap() = r.clone();
        if let Some(db) = self.db.lock().unwrap().as_ref() {
            let _ = db.execute("INSERT OR REPLACE INTO ecg_bench (ms, engine, json) VALUES (?1, ?2, ?3)", rusqlite::params![now_ms() as i64, e.id, r.to_string()]);
            let _ = db.execute("DELETE FROM ecg_bench WHERE ms NOT IN (SELECT ms FROM ecg_bench ORDER BY ms DESC LIMIT 10)", []);
        }
        Ok(r)
    }
    pub fn bench_last(&self) -> serde_json::Value {
        self.bench_last.lock().unwrap().clone()
    }
    /// 벤치 이력 최근 10회 (최신 먼저)
    pub fn bench_history(&self) -> Vec<serde_json::Value> {
        let g = self.db.lock().unwrap();
        let Some(db) = g.as_ref() else { return Vec::new() };
        let Ok(mut st) = db.prepare("SELECT json FROM ecg_bench ORDER BY ms DESC LIMIT 10") else { return Vec::new() };
        st.query_map([], |r| r.get::<_, String>(0)).map(|rows| rows.flatten().filter_map(|t| serde_json::from_str(&t).ok()).collect()).unwrap_or_default()
    }

    /// 판정 이력을 DB 에 쓴다 (10초마다). 하루에 한 번 14일 지난 행 정리.
    pub fn flush_db(&self) {
        let (tr, bm) = { let mut q = self.pend_db.lock().unwrap(); (std::mem::take(&mut q.0), std::mem::take(&mut q.1)) };
        if tr.is_empty() && bm.is_empty() && now_ms().saturating_sub(self.last_prune_ms.load(Ordering::Relaxed)) < 86_400_000 {
            return;
        }
        let mut g = self.db.lock().unwrap();
        let Some(db) = g.as_mut() else { return };
        if let Ok(tx) = db.transaction() {
            for (p, ms, l) in &tr {
                let _ = tx.execute("INSERT INTO ecg_trace (patch, ms, label) VALUES (?1, ?2, ?3)", rusqlite::params![*p as i64, *ms as i64, l]);
            }
            for ((p, m), (v, s)) in &bm {
                let _ = tx.execute("INSERT INTO ecg_beatmin (patch, minute_ms, v, s) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(patch, minute_ms) DO UPDATE SET v = v + excluded.v, s = s + excluded.s", rusqlite::params![*p as i64, *m as i64, *v as i64, *s as i64]);
            }
            let _ = tx.commit();
        }
        let now = now_ms();
        if now.saturating_sub(self.last_prune_ms.load(Ordering::Relaxed)) >= 86_400_000 {
            self.last_prune_ms.store(now, Ordering::Relaxed);
            let cut = (now - 14 * 86_400_000) as i64;
            let _ = db.execute("DELETE FROM ecg_trace WHERE ms < ?1", rusqlite::params![cut]);
            let _ = db.execute("DELETE FROM ecg_beatmin WHERE minute_ms < ?1", rusqlite::params![cut]);
        }
    }
    /// DB 에서 구간 [from, to] 의 판정 이력 (검증용, 긴 구간): 패치별 (전환 목록, V 박동 분 시각, S 박동 분 시각). 구간 시작 시점의 상태는
    /// 그 전 마지막 전환으로 채운다.
    pub fn traces_db(&self, from_ms: u64, to_ms: u64) -> Vec<(u32, String, u64, Vec<(u64, String)>, Vec<u64>, Vec<u64>)> {
        self.flush_db();
        let g = self.db.lock().unwrap();
        let Some(db) = g.as_ref() else { return Vec::new() };
        let mut per: HashMap<u32, (Vec<(u64, String)>, Vec<u64>, Vec<u64>)> = HashMap::new();
        if let Ok(mut st) = db.prepare("SELECT patch, ms, label FROM ecg_trace WHERE ms >= ?1 AND ms <= ?2 ORDER BY patch, ms") {
            if let Ok(rows) = st.query_map(rusqlite::params![from_ms as i64, to_ms as i64], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u64, r.get::<_, String>(2)?))) {
                for (p, ms, l) in rows.flatten() { per.entry(p).or_default().0.push((ms, l)); }
            }
        }
        // 구간 시작 시점 상태: 그 전 마지막 전환 (패치별)
        if let Ok(mut st) = db.prepare("SELECT patch, label, MAX(ms) FROM ecg_trace WHERE ms < ?1 AND ms >= ?1 - 86400000 GROUP BY patch") {
            if let Ok(rows) = st.query_map(rusqlite::params![from_ms as i64], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, String>(1)?))) {
                for (p, l) in rows.flatten() { per.entry(p).or_default().0.insert(0, (from_ms, l)); }
            }
        }
        if let Ok(mut st) = db.prepare("SELECT patch, minute_ms, v, s FROM ecg_beatmin WHERE minute_ms >= ?1 - 60000 AND minute_ms <= ?2") {
            if let Ok(rows) = st.query_map(rusqlite::params![from_ms as i64, to_ms as i64], |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))) {
                for (p, m, v, s) in rows.flatten() {
                    let e = per.entry(p).or_default();
                    if v > 0 { e.1.push(m + 30_000) }
                    if s > 0 { e.2.push(m + 30_000) }
                }
            }
        }
        per.into_iter().map(|(p, (tr, v, s))| { let (cur, since) = tr.last().cloned().map(|(t, l)| (l, t)).unwrap_or(("unknown".into(), from_ms)); (p, cur, since, tr, v, s) }).collect()
    }

    fn shard_of(&self, channel_id: u32) -> usize {
        (channel_id as usize).wrapping_mul(2654435761) % self.shards.len()
    }
    fn key(channel_id: &str) -> Option<u32> {
        channel_id.trim().parse::<u32>().ok()
    }

    /// ingest 에서: 프레임 하나의 패킷들을 샤드별로 묶어 큐에 넣는다 (꽉 차면 묶음 단위로 드롭·계수)
    pub fn feed_batch(&self, pkts: Vec<Pkt>) {
        if pkts.is_empty() || !self.enabled() {
            return;
        }
        let n = self.shards.len();
        let mut per: Vec<Vec<Pkt>> = (0..n).map(|_| Vec::new()).collect();
        for p in pkts {
            if p.samples.is_empty() || p.fs == 0 {
                continue;
            }
            let i = self.shard_of(p.channel_id);
            per[i].push(p);
        }
        for (i, v) in per.into_iter().enumerate() {
            if v.is_empty() {
                continue;
            }
            let k = v.len() as u64;
            if self.shards[i].try_send(Job::Batch(v)).is_err() {
                self.dropped.fetch_add(k, Ordering::Relaxed);
            }
        }
    }
    pub fn remove(&self, channel_id: &str) {
        let Some(k) = Self::key(channel_id) else { return };
        let i = self.shard_of(k);
        let _ = self.shards[i].try_send(Job::Remove(k));
        self.rows.remove(&k);
    }

    pub fn row(&self, channel_id: &str) -> Option<AnaRow> {
        self.rows.get(&Self::key(channel_id)?).map(|r| r.clone())
    }
    /// 스트림 헤더용 축약본 — 미전송 박동 마크를 비우며 가져간다
    pub fn brief(&self, channel_id: &str) -> Option<AnaBrief> {
        let mut r = self.rows.get_mut(&Self::key(channel_id)?)?;
        let beats = std::mem::take(&mut r.marks);
        Some(AnaBrief { hr: r.hr, rhythm: r.rhythm.clone(), q: r.q, af: r.af, vf: r.vf, pvc: r.pvc_min, beats })
    }
    /// 검증용: 모든 채널의 흔적 스냅샷 (patch_id, 현재 라벨, since, 전환 목록, V/S 박동 시각)
    pub fn traces(&self) -> Vec<(u32, String, u64, Vec<(u64, String)>, Vec<u64>, Vec<u64>)> {
        self.rows.iter().map(|r| (*r.key(), r.rhythm.clone(), r.rhythm_since_ms, r.trace.iter().cloned().collect(), r.vbeats.iter().copied().collect(), r.sbeats.iter().copied().collect())).collect()
    }
    pub fn rows_len(&self) -> usize {
        self.rows.len()
    }

    pub fn status_json(&self) -> serde_json::Value {
        let e = self.engine();
        serde_json::json!({
            "enabled": e.is_some(),
            "path": self.lib_path,
            "engine": e.as_ref().map(|e| e.id.clone()),
            "abi": e.as_ref().map(|e| format!("{}.{}", e.abi.0, e.abi.1)),
            "file_mtime_ms": e.as_ref().map(|e| e.mtime_ms),
            "file_size": e.as_ref().map(|e| e.size),
            "loaded_ms": self.loaded_ms.load(Ordering::Relaxed),
            "gen": self.gen.load(Ordering::Relaxed),
            "preset": if self.preset.load(Ordering::Relaxed) == eng::ECG_PRESET_PATCH { "patch" } else { "clinical" },
            "stages_cfg": self.stages_cfg.read().unwrap().clone(),
            "versions_dir": self.versions_dir().display().to_string(),
            "stages": e.as_ref().map(|e| e.stages.iter().map(|(n, d)| serde_json::json!({"name": n, "desc": d})).collect::<Vec<_>>()).unwrap_or_default(),
            "threads": self.shards.len(),
            "channels": self.channels_live.load(Ordering::Relaxed),
            "rows": self.rows.len(),
            "packets": self.packets.load(Ordering::Relaxed),
            "dropped": self.dropped.load(Ordering::Relaxed),
            "stale": self.stale.load(Ordering::Relaxed),
            "gaps": self.gaps.load(Ordering::Relaxed),
            "events": self.events.load(Ordering::Relaxed),
            "beats": self.beats.load(Ordering::Relaxed),
            "busy_ms": self.busy_ns.load(Ordering::Relaxed) / 1_000_000,
            "last_error": self.last_error(),
            "bench": self.bench_last(),
            "bench_history": self.bench_history(),
        })
    }

    fn shard_loop(self: Arc<Self>, rx: mpsc::Receiver<Job>) {
        let mut slots: HashMap<u32, Slot> = HashMap::new();
        let mut ev: Vec<EcgEvent> = Vec::with_capacity(128);
        let mut last_prune = Instant::now();
        loop {
            let job = match rx.recv() {
                Ok(j) => j,
                Err(_) => return,
            };
            match job {
                Job::Remove(id) => {
                    slots.remove(&id);
                }
                Job::Batch(pkts) => {
                    let t_start = Instant::now();
                    self.packets.fetch_add(pkts.len() as u64, Ordering::Relaxed);
                    for p in pkts {
                        self.packet(&mut slots, &mut ev, p.channel_id, p.seq, p.ts_ms, p.fs, p.samples);
                    }
                    self.busy_ns.fetch_add(t_start.elapsed().as_nanos() as u64, Ordering::Relaxed);
                }
            }
            if last_prune.elapsed() > Duration::from_secs(60) {
                last_prune = Instant::now();
                let before = slots.len();
                slots.retain(|id, s| {
                    let keep = s.last_touch.elapsed() < Duration::from_secs(600);
                    if !keep {
                        self.rows.remove(id);
                    }
                    keep
                });
                if before != slots.len() {
                    self.channels_live.fetch_sub((before - slots.len()) as u64, Ordering::Relaxed);
                }
            }
        }
    }

    fn packet(&self, slots: &mut HashMap<u32, Slot>, ev: &mut Vec<EcgEvent>, id: u32, seq: u64, ts_ms: u64, fs: u32, samples: Vec<f32>) {
        let gen = self.gen.load(Ordering::Relaxed);
        let step = 1000.0 / fs as f64;
        let n = samples.len() as u64;
        let need_new = match slots.get(&id) {
            Some(s) => s.gen != gen || s.fs != fs || s.chan.poisoned(),
            None => true,
        };
        if need_new {
            let Some(engine) = self.engine() else { return };
            let stages_cfg = self.stages_cfg.read().unwrap().clone();
            match engine.channel(fs as f64, self.preset.load(Ordering::Relaxed), &stages_cfg) {
                Ok(chan) => {
                    let stages = chan.stages();
                    if !slots.contains_key(&id) {
                        self.channels_live.fetch_add(1, Ordering::Relaxed);
                    }
                    slots.insert(
                        id,
                        Slot {
                            chan,
                            gen,
                            fs,
                            last_seq: 0,
                            last_end_ms: 0.0,
                            idx: 0,
                            anchor_ms: 0.0,
                            beats: VecDeque::new(),
                            pvc: VecDeque::new(),
                            episodes: VecDeque::new(),
                            af_p: 0.0,
                            in_af: false,
                            status: Default::default(),
                            last_pkt_ms: 0,
                            rhythm: "unknown".into(),
                            rhythm_since: ts_ms,
                            beats_total: 0,
                            last_beat_ms: 0.0,
                            stages,
                            marks: Vec::new(),
                            last_touch: Instant::now(),
                            lag_ms: 600.0,
                            row_seq: 0,
                            dirty: true,
                            pend_trace: Vec::new(),
                            pend_v: Vec::new(),
                            pend_s: Vec::new(),
                        },
                    );
                }
                Err(code) => {
                    *self.last_error.lock().unwrap() = format!("channel create failed ({code})");
                    return;
                }
            }
        }
        let s = slots.get_mut(&id).unwrap();
        s.last_touch = Instant::now();
        if s.last_seq != 0 && seq <= s.last_seq {
            self.stale.fetch_add(1, Ordering::Relaxed);
            return;
        }
        s.last_seq = seq;
        // 유실 구간은 gap 으로 선언 (이어 붙이면 가짜 휴지·심정지, 0 을 넣으면 가짜 평탄선)
        let t0 = ts_ms as f64 - (n.saturating_sub(1)) as f64 * step;
        if s.last_end_ms > 0.0 && t0 - s.last_end_ms > 1.5 * step {
            let g = ((t0 - s.last_end_ms) / step).round().max(1.0) as u64;
            s.chan.gap(g);
            s.idx += g;
            self.gaps.fetch_add(1, Ordering::Relaxed);
        }
        s.chan.push(&samples);
        s.idx += n;
        s.last_end_ms = ts_ms as f64 + step;
        s.anchor_ms = ts_ms as f64 - (s.idx.saturating_sub(1)) as f64 * step;
        s.last_pkt_ms = ts_ms;
        ev.clear();
        s.chan.poll(ev);
        if !ev.is_empty() {
            self.events.fetch_add(ev.len() as u64, Ordering::Relaxed);
            s.dirty = true;
        }
        let t_of = |idx: u64| s.anchor_ms + idx as f64 * step;
        for e in ev.iter() {
            match e.kind {
                eng::EV_BEAT => {
                    let t = t_of(e.start);
                    s.beats.push_back((t, e.code));
                    while s.beats.len() > 64 {
                        s.beats.pop_front();
                    }
                    if e.code == eng::BEAT_V {
                        s.pvc.push_back(t);
                        s.pend_v.push(t as u64);
                    } else if e.code == eng::BEAT_S {
                        s.pend_s.push(t as u64);
                    }
                    // 검출 지연: 이 패킷의 마지막 샘플 시각 − R 시각 (음수면 0)
                    let lag = (ts_ms as f64 - t).max(0.0).min(5000.0);
                    s.lag_ms = s.lag_ms * 0.9 + lag * 0.1;
                    s.last_beat_ms = t;
                    s.beats_total += 1;
                    s.marks.push((t as u64, e.code));
                    if s.marks.len() > 200 {
                        s.marks.drain(..100);
                    }
                    self.beats.fetch_add(1, Ordering::Relaxed);
                }
                eng::EV_RHYTHM => s.episodes.push_back((eng::rhythm_name(e.code).to_string(), t_of(e.start) as u64, t_of(e.end) as u64)),
                eng::EV_AF_WINDOW => {
                    s.af_p = e.score[0];
                    s.in_af = e.flags & eng::AF_FLAG_IN_AF != 0;
                }
                eng::EV_VF => s.episodes.push_back(("vf".into(), t_of(e.start) as u64, t_of(e.end) as u64)),
                eng::EV_LEAD_OFF => s.episodes.push_back(("leadoff".into(), t_of(e.start) as u64, t_of(e.end) as u64)),
                eng::EV_SV_RUN => s.episodes.push_back(("svrun".into(), t_of(e.start) as u64, t_of(e.end) as u64)),
                _ => {}
            }
        }
        while s.episodes.len() > 20 {
            s.episodes.pop_front();
        }
        let horizon = ts_ms as f64 - 60_000.0;
        while s.pvc.front().map(|t| *t < horizon).unwrap_or(false) {
            s.pvc.pop_front();
        }
        // 상태(FFI)는 이벤트가 있었거나 1초(5패킷)마다만 읽는다 — 패킷마다 읽을 필요가 없다
        if !ev.is_empty() || seq % 5 == 0 || s.status.samples == 0 {
            s.status = s.chan.status();
        }
        // HR: 최근 10초 안 박동의 RR (최대 8개 간격) 평균 — 할당 없이
        let hr = {
            let lo = ts_ms as f64 - 10_000.0;
            let (mut n, mut first, mut last) = (0usize, 0.0f64, 0.0f64);
            for (t, _) in s.beats.iter().rev().take(9) {
                if *t < lo { break; }
                if n == 0 { last = *t; }
                first = *t;
                n += 1;
            }
            if n >= 3 {
                let mean = (last - first) / (n - 1) as f64;
                if mean > 200.0 { Some((60_000.0 / mean) as f32) } else { None }
            } else { None }
        };
        let st = s.status.state;
        let lead_off = st & eng::STATE_LEAD_OFF != 0;
        let in_vf = st & eng::STATE_IN_VF != 0;
        let in_af = s.in_af || st & eng::STATE_IN_AF != 0;
        // 박동 없음 시간: 검출 지연만큼 빼서 잰다 (지연을 빼지 않으면 정상 리듬도 2초를 넘겨 '휴지'로 보인다)
        let since_beat = if s.last_beat_ms > 0.0 { (ts_ms as f64 - s.last_beat_ms - s.lag_ms).max(0.0) } else { 0.0 };
        let recent_ep = |kind: &str, hold_ms: u64| s.episodes.iter().rev().any(|(k, _, end)| k == kind && ts_ms.saturating_sub(*end) < hold_ms);
        let unusable = s.status.quality == eng::QUALITY_UNUSABLE;
        let label = if lead_off {
            "leadoff"
        } else if in_vf {
            "vf"
        } else if !unusable && s.last_beat_ms > 0.0 && since_beat >= 4000.0 {
            "asystole"
        } else if !unusable && s.last_beat_ms > 0.0 && since_beat >= 2000.0 {
            "pause"
        } else if recent_ep("vtach", 30_000) {
            "vtach"
        } else if recent_ep("vrun", 30_000) {
            "vrun"
        } else if in_af {
            "afib"
        } else if recent_ep("ivr", 60_000) {
            "ivr"
        } else if recent_ep("bigeminy", 60_000) {
            "bigeminy"
        } else if recent_ep("trigeminy", 60_000) {
            "trigeminy"
        } else if recent_ep("svrun", 30_000) {
            "svrun"
        } else if s.pvc.len() >= 6 {
            "pvc"
        } else if unusable {
            "noise"
        } else if let Some(h) = hr {
            if h < 50.0 { "brady" } else if h > 100.0 { "tachy" } else { "nsr" }
        } else {
            "unknown"
        };
        if label != s.rhythm {
            s.rhythm = label.to_string();
            s.rhythm_since = ts_ms;
            s.dirty = true;
            s.pend_trace.push((ts_ms, label.to_string()));
        }
        // 요약 행 쓰기는 이벤트가 있었거나 1초(5패킷)마다 — 10k 패킷/s 마다 문자열·벡터를 복제하지 않는다
        if !s.dirty && seq.saturating_sub(s.row_seq) < 5 {
            return;
        }
        s.dirty = false;
        s.row_seq = seq;
        let marks = std::mem::take(&mut s.marks);
        let mut row = self.rows.entry(id).or_default();
        if row.engine.is_empty() || row.stages.is_empty() {
            row.engine = s.chan.engine().id.clone();
            row.stages = s.stages.clone();
        }
        row.hr = hr;
        row.rhythm = s.rhythm.clone();
        row.rhythm_since_ms = s.rhythm_since;
        row.q = s.status.quality;
        row.qs = s.status.quality_score;
        row.af = in_af;
        row.af_p = s.af_p;
        row.vf = in_vf;
        row.lead_off = lead_off;
        row.pvc_min = s.pvc.len() as u32;
        row.beats_total = s.beats_total;
        row.last_beat_ms = s.last_beat_ms as u64;
        row.pkt_ms = ts_ms;
        row.lag_ms = s.lag_ms as u32;
        if row.episodes.len() != s.episodes.len() || row.episodes.first().map(|e| e.1) != s.episodes.back().map(|e| e.1) {
            row.episodes = s.episodes.iter().rev().take(10).cloned().collect();
        }
        row.updated_ms = now_ms();
        row.marks.extend(marks);
        if row.marks.len() > 200 {
            let cut = row.marks.len() - 200;
            row.marks.drain(..cut);
        }
        {
            let mut q = self.pend_db.lock().unwrap();
            for x in s.pend_trace.drain(..) { q.0.push((id, x.0, x.1.clone())); row.trace.push_back(x); }
            for x in s.pend_v.drain(..) { q.1.entry((id, x / 60_000 * 60_000)).or_default().0 += 1; row.vbeats.push_back(x); }
            for x in s.pend_s.drain(..) { q.1.entry((id, x / 60_000 * 60_000)).or_default().1 += 1; row.sbeats.push_back(x); }
        }
        while row.trace.len() > 160 { row.trace.pop_front(); }
        while row.vbeats.len() > 300 { row.vbeats.pop_front(); }
        while row.sbeats.len() > 300 { row.sbeats.pop_front(); }
    }
}
