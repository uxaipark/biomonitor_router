use crate::config::Config;
use crate::grouping::GroupStore;
use crate::protocol::{now_ms, AnalysisEvent, EcgPacket, OutMsg};
use crate::registry::Registry;
use crate::gateways::GatewayTable;
use crate::alarms::AlarmBook;
use crate::patch_store::StoreOp;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

/// 어드민 실시간 이벤트 목록에 표시되는 시스템 이벤트 (분석 지연/다운 등)
#[derive(Debug, Clone, Serialize)]
pub struct SystemEvent {
    pub ts_ms: u64,
    pub kind: String,
    pub channel_id: Option<String>,
    pub message: String,
}

const MAX_EVENTS: usize = 300;

/// 출력 브로드캐스트에 실리는 봉투.
/// 직렬화는 패킷당 1회만 수행하고, WS 세션은 group 교집합만 확인해 전달한다.
#[derive(Debug, Clone)]
pub struct OutEnvelope {
    pub groups: Vec<String>,
    /// 스트림 패킷의 게이트웨이 (게이트웨이 단위 구독 필터용)
    pub gateway_id: Option<String>,
    /// 스트림 패킷의 채널 (채널 목록 단위 구독 필터용)
    pub channel_id: Option<String>,
    /// stream 패킷 여부 — WS 세션이 stream 만 모아 stream_batch 로 묶어 보낸다
    /// (membership/channel_event 는 즉시 개별 전송)
    pub is_stream: bool,
    /// stream 패킷의 양자화 샘플 (×1000, µV). 바이너리 프레임의 블롭으로 전송.
    pub samples_i16: Option<Vec<i16>>,
    pub json: String,
}

pub struct AppState {
    pub cfg: Config,
    pub registry: Registry,
    pub groups: GroupStore,
    pub out_tx: broadcast::Sender<Arc<OutEnvelope>>,
    /// 분석 서버로 forward 할 NDJSON 라인 큐.
    /// **상한 있음** — 소비자(링크)가 느리면 무한 성장하는 대신 드롭한다
    /// (드롭된 패킷은 플러셔가 500ms 후 무분석 방출하므로 파형은 계속 흐름).
    pub analysis_tx: mpsc::Sender<String>,
    /// DB API 로 push 할 op 큐 (SQLite 실시간 갱신). 상한 있음 — 포화 시 드롭.
    pub db_tx: mpsc::Sender<String>,
    /// 패치 저장소 큐 (patch_store 기록 스레드). 상한 있음 — 디스크가 못
    /// 따라오면 드롭 (패치 파일에 seq 갭으로 남음).
    pub store_tx: mpsc::Sender<StoreOp>,
    /// 게이트웨이 표 (v3 링크 상태·시퀀스 검사·NACK)
    pub gateways: GatewayTable,
    /// 큐 포화로 드롭된 건수 (analysis / db / wave)
    pub dropped_analysis: AtomicU64,
    pub dropped_db: AtomicU64,
    pub dropped_wave: AtomicU64,
    /// 분석 서버 연결 여부. false 면 패스스루 모드(파형 즉시 통과, hr 없음).
    pub analysis_up: AtomicBool,
    /// ingest 수신 통계 (어드민 실시간 표시용)
    pub ingest_conns: AtomicU64,
    pub total_bytes: AtomicU64,
    pub total_packets: AtomicU64,
    /// 송신 통계: 출력 WS 전송 + 분석 서버 forward 바이트
    pub total_tx_bytes: AtomicU64,
    /// seq 갭으로 감지한 유실 패킷 누적
    pub total_lost_packets: AtomicU64,
    /// 분석 링크 다운타임 누적(ms) + 현재 다운 시작 시각
    pub analysis_downtime_ms: AtomicU64,
    pub analysis_down_since: Mutex<Option<Instant>>,
    pub started_at: Instant,
    /// 최근 시스템 이벤트 링 (어드민 /api/events)
    pub events: Mutex<VecDeque<SystemEvent>>,
    /// 디스플레이(센트럴 모니터) ID → 그룹 ID 매핑 (displays.json 영속화)
    pub displays: Mutex<std::collections::HashMap<String, String>>,
    /// ingest 소스 IP 허용목록. None = 전체 허용, Some(set) = 목록 내 IP 만
    /// (루프백은 항상 허용 — 로컬 에뮬레이터용). 어드민 입력 소스 선택이 설정한다.
    pub ingest_allow: Mutex<Option<std::collections::HashSet<std::net::IpAddr>>>,
    /// ingest 소스 IP 별 활성 연결 수 (어드민 입력 소스 현황 표시용)
    pub ingest_sources: Mutex<std::collections::HashMap<std::net::IpAddr, u64>>,
    /// 알람 장부 (규칙·활성·이력)
    pub alarms: AlarmBook,
    /// 마지막 저장 큐 드롭 시각 (ms) — 알람 엔진의 백프레셔 판정
    pub last_store_drop_ms: AtomicU64,
    /// 에뮬레이터 EMR 프록시 캐시: path → (만료 시각 ms, 본문)
    pub emr_cache: Mutex<std::collections::HashMap<String, (u64, Arc<String>)>>,
}

impl AppState {
    pub fn new(
        cfg: Config,
    ) -> (
        Arc<Self>,
        mpsc::Receiver<String>,
        mpsc::Receiver<String>,
        mpsc::Receiver<StoreOp>,
    ) {
        let (out_tx, _) = broadcast::channel(4096);
        // 큐 상한: 정상 운영에서 절대 차지 않는 크기.
        //  - analysis 8192 ≈ 1400ch 기준 ~1.2초분. TCP 백프레셔로 링크가 느려지면
        //    초과분은 드롭 → 플러셔가 무분석 방출 (사실상 부분 패스스루).
        //  - db 16384 ops ≈ 전 채널 meta 폭주(재접속) 수 회분. db-api 장기 다운 시
        //    무한 성장 대신 드롭 (reconcile 이 어차피 재동기화).
        //  - wave 16384 pkt ≈ ~3MB. 디스크 정체 시 드롭.
        let (analysis_tx, analysis_rx) = mpsc::channel(8192);
        let (db_tx, db_rx) = mpsc::channel(16384);
        // store 262,144 ops ≈ 25 s of records at 10k/s (~90 MB worst case): absorbs the store-and-forward replay
        // burst every gateway sends after an emulator restart. Ingest waits up to 200 ms before dropping (backpressure).
        let (store_tx, store_rx) = mpsc::channel(262_144);
        let displays = std::fs::read_to_string(&cfg.displays_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let state = Arc::new(Self {
            registry: Registry::new(cfg.ring_capacity),
            groups: GroupStore::load(&cfg.groups_path),
            cfg,
            out_tx,
            analysis_tx,
            db_tx,
            store_tx,
            gateways: GatewayTable::new(),
            dropped_analysis: AtomicU64::new(0),
            dropped_db: AtomicU64::new(0),
            dropped_wave: AtomicU64::new(0),
            analysis_up: AtomicBool::new(false),
            ingest_conns: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            total_packets: AtomicU64::new(0),
            total_tx_bytes: AtomicU64::new(0),
            total_lost_packets: AtomicU64::new(0),
            analysis_downtime_ms: AtomicU64::new(0),
            analysis_down_since: Mutex::new(None),
            started_at: Instant::now(),
            events: Mutex::new(VecDeque::new()),
            displays: Mutex::new(displays),
            ingest_allow: Mutex::new(None),
            ingest_sources: Mutex::new(std::collections::HashMap::new()),
            alarms: AlarmBook::new(),
            last_store_drop_ms: AtomicU64::new(0),
            emr_cache: Mutex::new(std::collections::HashMap::new()),
        });
        (state, analysis_rx, db_rx, store_rx)
    }

    pub fn analysis_up(&self) -> bool {
        self.analysis_up.load(Ordering::Relaxed)
    }

    /// 큐 포화 시 드롭하는 논블로킹 send 3종. 1000건마다 경고 로그.
    pub fn send_analysis(&self, line: String) {
        if self.analysis_tx.try_send(line).is_err() {
            let n = self.dropped_analysis.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 1000 == 1 {
                tracing::warn!("analysis 큐 포화 — 누적 {}건 드롭 (플러셔가 무분석 방출)", n);
            }
        }
    }

    pub fn send_db(&self, op: String) {
        if self.db_tx.try_send(op).is_err() {
            let n = self.dropped_db.fetch_add(1, Ordering::Relaxed) + 1;
            if n % 1000 == 1 {
                tracing::warn!("db 큐 포화 — 누적 {}건 드롭 (reconcile 이 재동기화)", n);
            }
        }
    }

    pub fn send_store(&self, op: StoreOp) {
        if self.store_tx.try_send(op).is_err() {
            self.note_store_drop();
        }
    }

    /// Async variant for ingest: wait up to 200 ms for queue space (TCP backpressure toward the gateway) before
    /// dropping, so a reconnect replay burst is absorbed instead of punched through the queue.
    pub async fn send_store_wait(&self, op: StoreOp) {
        if self.store_tx.send_timeout(op, Duration::from_millis(200)).await.is_err() {
            self.note_store_drop();
        }
    }

    fn note_store_drop(&self) {
        let n = self.dropped_wave.fetch_add(1, Ordering::Relaxed) + 1;
        self.last_store_drop_ms.store(now_ms(), Ordering::Relaxed);
        if n % 1000 == 1 {
            tracing::warn!("store 큐 포화 — 누적 {}건 드롭 (디스크 정체)", n);
        }
    }

    /// 에뮬레이터 `POST /api/v1/router/status` 보고 본문
    pub fn status_report(&self) -> serde_json::Value {
        serde_json::json!({
            "name": "biomonitor-router",
            "version": env!("CARGO_PKG_VERSION"),
            "protocol_version": crate::wire::VERSION,
            "uptime_s": self.started_at.elapsed().as_secs(),
            "ingest_connections": self.ingest_conns.load(Ordering::Relaxed),
            "rx_bytes": self.total_bytes.load(Ordering::Relaxed),
            "records": self.total_packets.load(Ordering::Relaxed),
            "patches": self.registry.channel_ids().len(),
            "lost_packets": self.total_lost_packets.load(Ordering::Relaxed),
            "store_bytes": crate::patch_store::STORE_BYTES.load(Ordering::Relaxed),
            "store_patches": crate::patch_store::STORE_PATCHES.load(Ordering::Relaxed),
            "queue_dropped_store": self.dropped_wave.load(Ordering::Relaxed),
            "analysis_connected": self.analysis_up(),
            "gateways": self.gateways.summary(),
            "alarms": self.alarms.summary(),
        })
    }

    pub fn add_tx_bytes(&self, n: usize) {
        self.total_tx_bytes.fetch_add(n as u64, Ordering::Relaxed);
    }

    pub fn push_event(&self, kind: &str, channel_id: Option<String>, message: String) {
        let mut ev = self.events.lock().unwrap();
        ev.push_back(SystemEvent {
            ts_ms: now_ms(),
            kind: kind.to_string(),
            channel_id,
            message,
        });
        while ev.len() > MAX_EVENTS {
            ev.pop_front();
        }
    }

    /// 최신 이벤트부터 limit 개 반환
    pub fn recent_events(&self, limit: usize) -> Vec<SystemEvent> {
        let ev = self.events.lock().unwrap();
        ev.iter().rev().take(limit).cloned().collect()
    }

    pub fn list_displays(&self) -> std::collections::HashMap<String, String> {
        self.displays.lock().unwrap().clone()
    }

    /// 디스플레이 → 그룹 매핑 설정 + 파일 영속화
    pub fn set_display(&self, display_id: &str, group_id: &str) {
        let map = {
            let mut d = self.displays.lock().unwrap();
            d.insert(display_id.to_string(), group_id.to_string());
            d.clone()
        };
        if let Ok(json) = serde_json::to_string_pretty(&map) {
            let _ = std::fs::write(&self.cfg.displays_path, json);
        }
        self.push_event(
            "display_config",
            None,
            format!("디스플레이 {} → 그룹 '{}' 지정", display_id, group_id),
        );
    }

    pub fn set_analysis_up(&self, up: bool) {
        let was = self.analysis_up.swap(up, Ordering::Relaxed);
        if was == up {
            return;
        }
        // 분석 링크 연결 해제 → 다운타임 누적 기록
        let mut since = self.analysis_down_since.lock().unwrap();
        if up {
            if let Some(t) = since.take() {
                self.analysis_downtime_ms
                    .fetch_add(t.elapsed().as_millis() as u64, Ordering::Relaxed);
            }
        } else {
            *since = Some(Instant::now());
        }
    }

    /// 분석 링크 다운타임 누적 (진행 중인 다운 포함, ms)
    pub fn downtime_ms(&self) -> u64 {
        let base = self.analysis_downtime_ms.load(Ordering::Relaxed);
        let ongoing = self
            .analysis_down_since
            .lock()
            .unwrap()
            .map(|t| t.elapsed().as_millis() as u64)
            .unwrap_or(0);
        base + ongoing
    }

    pub fn publish(&self, groups: &[String], msg: &OutMsg) {
        self.publish_with_gateway(groups, None, None, msg, None)
    }

    pub fn publish_with_gateway(
        &self,
        groups: &[String],
        gateway_id: Option<String>,
        channel_id: Option<String>,
        msg: &OutMsg,
        samples_i16: Option<Vec<i16>>,
    ) {
        if groups.is_empty() && gateway_id.is_none() && channel_id.is_none() {
            return;
        }
        if let Ok(json) = serde_json::to_string(msg) {
            let _ = self.out_tx.send(Arc::new(OutEnvelope {
                groups: groups.to_vec(),
                gateway_id,
                channel_id,
                is_stream: matches!(msg, OutMsg::Stream { .. }),
                samples_i16,
                json,
            }));
        }
    }

    /// 분석 결과와 병합된(또는 패스스루) 스트림 패킷 송출.
    /// 샘플은 JSON 에 싣지 않고 i16(×1000, µV) 으로 양자화해 envelope 에 별도 보관 —
    /// WS 세션이 바이너리 stream_batch 프레임의 샘플 블롭으로 내보낸다 (~4× 절감).
    pub fn emit_stream(&self, pkt: EcgPacket, hr: Option<f32>, events: Vec<AnalysisEvent>) {
        let groups = self.registry.groups_of(&pkt.channel_id);
        if groups.is_empty() {
            return;
        }
        // 환자 메타(~400B)는 매 패킷 싣지 않고 5초(25패킷)에 1회만 — 구독자는
        // membership 스냅샷/조인과 주기 갱신으로 유지한다 (프런트는 last-known 보존).
        let include_patient = pkt.seq % 25 == 0 || pkt.seq <= 2;
        let patient = if include_patient {
            self.registry.patient_of(&pkt.channel_id)
        } else {
            None
        };
        let gateway_id = pkt.gateway_id.clone();
        // 블롭 = 전 파형 채널의 원본 i16 (waves 레이아웃 순). 파형 없는 패킷(수치/페이스마크만)은 빈 블롭.
        let samples_i16 = pkt.wave_i16;
        let msg = OutMsg::Stream {
            group_ids: groups.clone(),
            channel_id: pkt.channel_id,
            seq: pkt.seq,
            ts_ms: pkt.ts_ms,
            sample_rate: pkt.sample_rate,
            samples: Vec::new(), // 바이너리 블롭으로 대체 (JSON 헤더는 메타만)
            hr,
            events,
            quality: pkt.quality,
            moving: pkt.moving,
            gateway_id: gateway_id.clone(),
            space: pkt.space,
            flags: pkt.flags,
            battery: pkt.battery,
            rssi: pkt.rssi,
            vitals: pkt.vitals,
            pace: pkt.pace,
            waves: pkt.waves,
            patient,
        };
        let gw = if gateway_id.is_empty() { None } else { Some(gateway_id) };
        let ch = match &msg {
            OutMsg::Stream { channel_id, .. } => Some(channel_id.clone()),
            _ => None,
        };
        self.publish_with_gateway(&groups, gw, ch, &msg, Some(samples_i16));
    }

    /// 데이터 없는 채널 상태 이벤트 송출 (연결해제 등)
    pub fn emit_channel_event(&self, channel_id: &str, events: Vec<AnalysisEvent>) {
        let groups = self.registry.groups_of(channel_id);
        if groups.is_empty() {
            return;
        }
        let msg = OutMsg::ChannelEvent {
            group_ids: groups.clone(),
            channel_id: channel_id.to_string(),
            ts_ms: now_ms(),
            events,
        };
        self.publish(&groups, &msg);
    }

    /// 채널 하나의 그룹 멤버십을 재계산하고, 변경분(join/leave)을 구독자에게 전파한다.
    /// meta 갱신 시와 그룹 설정 변경 시 호출된다. 매끄러운 편입/이탈의 핵심 경로.
    pub fn recompute_channel_groups(&self, channel_id: &str) {
        let patient = self.registry.patient_of(channel_id);
        let new_groups = self.groups.groups_for(channel_id, patient.as_ref());
        let old_groups = self.registry.set_groups(channel_id, new_groups.clone());

        let joined: Vec<String> = new_groups
            .iter()
            .filter(|g| !old_groups.contains(g))
            .cloned()
            .collect();
        let left: Vec<String> = old_groups
            .iter()
            .filter(|g| !new_groups.contains(g))
            .cloned()
            .collect();

        if !joined.is_empty() {
            let msg = OutMsg::Membership {
                group_ids: joined.clone(),
                event: "join".into(),
                channel_id: channel_id.to_string(),
                patient: patient.clone(),
                connected: true,
            };
            self.publish(&joined, &msg);
        }
        if !left.is_empty() {
            let msg = OutMsg::Membership {
                group_ids: left.clone(),
                event: "leave".into(),
                channel_id: channel_id.to_string(),
                patient,
                connected: true,
            };
            self.publish(&left, &msg);
        }
    }

    /// 채널 명시적 제거: 레지스트리에서 삭제 + 소속 그룹에 leave 전파
    /// (접속 끊김과 달리 뷰어/어드민에서 채널이 완전히 사라진다)
    pub fn remove_channel(&self, channel_id: &str) {
        if let Some(st) = self.registry.remove(channel_id) {
            if !st.groups.is_empty() {
                let msg = OutMsg::Membership {
                    group_ids: st.groups.clone(),
                    event: "leave".into(),
                    channel_id: channel_id.to_string(),
                    patient: st.patient,
                    connected: false,
                };
                self.publish(&st.groups, &msg);
            }
        }
    }

    /// 그룹 설정 변경 후 전체 채널 멤버십 재계산
    pub fn recompute_all(&self) {
        for id in self.registry.channel_ids() {
            self.recompute_channel_groups(&id);
        }
    }
}

/// 분석 지연 플러셔.
/// 분석 서버가 허용치(100ms)보다 느려지거나 스톨/크래시로 응답이 오지 않으면,
/// FLUSH_AFTER 를 초과해 대기 중인 패킷을 분석 결과 없이 방출해 파형이 계속 흐르게 한다.
/// 발생 사실은 시스템 이벤트("분석 지연 발생")로 어드민에 기록된다.
pub async fn run_flusher(state: Arc<AppState>) {
    const FLUSH_AFTER: Duration = Duration::from_millis(500);
    const EVENT_COOLDOWN: Duration = Duration::from_secs(3);
    let mut last_event = Instant::now() - EVENT_COOLDOWN;
    let mut ticker = tokio::time::interval(Duration::from_millis(100));
    loop {
        ticker.tick().await;
        if !state.analysis_up() {
            continue; // 패스스루 모드에서는 ingest 가 직접 방출하므로 대기 버퍼가 없다
        }
        let expired = state.registry.take_expired(FLUSH_AFTER);
        if expired.is_empty() {
            continue;
        }
        let channels: HashSet<String> =
            expired.iter().map(|p| p.channel_id.clone()).collect();
        let n_packets = expired.len();
        for pkt in expired {
            state.emit_stream(pkt, None, Vec::new());
        }
        if last_event.elapsed() >= EVENT_COOLDOWN {
            last_event = Instant::now();
            state.push_event(
                "analysis_delay",
                None,
                format!(
                    "분석 지연 발생 — {}개 채널 {}개 패킷을 분석 결과 없이 전달 (대기 {}ms 초과)",
                    channels.len(),
                    n_packets,
                    FLUSH_AFTER.as_millis()
                ),
            );
        }
    }
}
