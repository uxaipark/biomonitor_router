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

enum Job {
    Packet { channel_id: String, seq: u64, ts_ms: u64, fs: u32, samples: Vec<f32> },
    Remove(String),
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
}

pub struct AnalysisHub {
    pub lib_path: String,
    pub preset: u32,
    pub stages_cfg: String,
    engine: RwLock<Option<Arc<Engine>>>,
    gen: AtomicU64,
    shards: Vec<mpsc::SyncSender<Job>>,
    rows: DashMap<String, AnaRow>,
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
}

fn now_ms() -> u64 {
    crate::protocol::now_ms()
}

impl AnalysisHub {
    /// 엔진을 읽고(없으면 꺼진 채로) 샤드 스레드와 감시 스레드를 띄운다.
    pub fn start(lib_path: &str, preset: u32, stages: &str, threads: usize) -> Arc<AnalysisHub> {
        let n = threads.clamp(1, 8);
        let mut shards = Vec::with_capacity(n);
        let mut rxs = Vec::with_capacity(n);
        for _ in 0..n {
            let (tx, rx) = mpsc::sync_channel::<Job>(8192);
            shards.push(tx);
            rxs.push(rx);
        }
        let hub = Arc::new(AnalysisHub {
            lib_path: lib_path.to_string(),
            preset,
            stages_cfg: stages.to_string(),
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
                *self.engine.write().unwrap() = Some(e);
                self.gen.fetch_add(1, Ordering::Relaxed);
                self.loaded_ms.store(now_ms(), Ordering::Relaxed);
                self.last_error.lock().unwrap().clear();
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

    fn shard_of(&self, channel_id: &str) -> usize {
        let mut h: u64 = 1469598103934665603;
        for b in channel_id.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(1099511628211);
        }
        (h % self.shards.len() as u64) as usize
    }

    /// ingest 에서: 패킷의 ECG 샘플(mV)을 분석 큐에 넣는다 (꽉 차면 드롭·계수)
    pub fn feed(&self, channel_id: &str, seq: u64, ts_ms: u64, fs: u32, samples: Vec<f32>) {
        if !self.enabled() || samples.is_empty() || fs == 0 {
            return;
        }
        let i = self.shard_of(channel_id);
        if self.shards[i].try_send(Job::Packet { channel_id: channel_id.to_string(), seq, ts_ms, fs, samples }).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    pub fn remove(&self, channel_id: &str) {
        let i = self.shard_of(channel_id);
        let _ = self.shards[i].try_send(Job::Remove(channel_id.to_string()));
        self.rows.remove(channel_id);
    }

    pub fn row(&self, channel_id: &str) -> Option<AnaRow> {
        self.rows.get(channel_id).map(|r| r.clone())
    }
    /// 스트림 헤더용 축약본 — 미전송 박동 마크를 비우며 가져간다
    pub fn brief(&self, channel_id: &str) -> Option<AnaBrief> {
        let mut r = self.rows.get_mut(channel_id)?;
        let beats = std::mem::take(&mut r.marks);
        Some(AnaBrief { hr: r.hr, rhythm: r.rhythm.clone(), q: r.q, af: r.af, vf: r.vf, pvc: r.pvc_min, beats })
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
            "preset": if self.preset == eng::ECG_PRESET_PATCH { "patch" } else { "clinical" },
            "stages_cfg": self.stages_cfg,
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
        })
    }

    fn shard_loop(self: Arc<Self>, rx: mpsc::Receiver<Job>) {
        let mut slots: HashMap<String, Slot> = HashMap::new();
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
                Job::Packet { channel_id, seq, ts_ms, fs, samples } => {
                    let t_start = Instant::now();
                    self.packets.fetch_add(1, Ordering::Relaxed);
                    self.packet(&mut slots, &mut ev, channel_id, seq, ts_ms, fs, samples);
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

    fn packet(&self, slots: &mut HashMap<String, Slot>, ev: &mut Vec<EcgEvent>, id: String, seq: u64, ts_ms: u64, fs: u32, samples: Vec<f32>) {
        let gen = self.gen.load(Ordering::Relaxed);
        let step = 1000.0 / fs as f64;
        let n = samples.len() as u64;
        let need_new = match slots.get(&id) {
            Some(s) => s.gen != gen || s.fs != fs || s.chan.poisoned(),
            None => true,
        };
        if need_new {
            let Some(engine) = self.engine() else { return };
            match engine.channel(fs as f64, self.preset, &self.stages_cfg) {
                Ok(chan) => {
                    let stages = chan.stages();
                    if !slots.contains_key(&id) {
                        self.channels_live.fetch_add(1, Ordering::Relaxed);
                    }
                    slots.insert(
                        id.clone(),
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
        s.status = s.chan.status();
        // HR: 최근 10초 안 박동의 RR (최대 8개 간격) 평균
        let recent: Vec<f64> = s.beats.iter().rev().take(9).filter(|(t, _)| *t >= ts_ms as f64 - 10_000.0).map(|(t, _)| *t).collect();
        let hr = if recent.len() >= 3 {
            let mut rr = 0.0;
            for w in recent.windows(2) {
                rr += w[0] - w[1];
            }
            let mean = rr / (recent.len() - 1) as f64;
            if mean > 200.0 { Some((60_000.0 / mean) as f32) } else { None }
        } else {
            None
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
    }
}
