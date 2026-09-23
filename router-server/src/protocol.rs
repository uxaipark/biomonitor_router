use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 환자 메타데이터. 그룹핑 기준 속성을 모두 포함한다.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Patient {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub building: String,
    #[serde(default)]
    pub floor: String,
    #[serde(default)]
    pub ward: String,
    #[serde(default)]
    pub zone: String,
    #[serde(default)]
    pub room: String,
    /// 침대 id (예: "106A01-A") — EMR admissions 의 bed. 평면도가 환자를 실제 침대에 놓는 데 쓴다.
    #[serde(default)]
    pub bed: String,
    #[serde(default)]
    pub doctor: String,
    #[serde(default)]
    pub department: String,
    /// 주진단 (EMR patients 피드의 disease)
    #[serde(default)]
    pub diagnosis: String,
    /// 재원 형태 (admissions.mode: inpatient | mcot …)
    #[serde(default)]
    pub mode: String,
    /// 집주소 지역명(원외/MCOT 환자 위치 표기용, 예 "서울 강남구") / 전체 주소 — EMR 이 주면 채움
    #[serde(default)]
    pub home_region: String,
    #[serde(default)]
    pub home_address: String,
    #[serde(default)]
    pub nurse: String,
    /// 프로필 번호 — 얼굴 이미지(faces/<n>.png) 지정 (에뮬레이터가 전달)
    #[serde(default)]
    pub profile_no: u64,
    #[serde(default)]
    pub sex: String,
    #[serde(default)]
    pub birth: String,
    #[serde(default)]
    pub blood: String,
    /// 병변/기저질환 목록 (리포트 모달 표시용)
    #[serde(default)]
    pub conditions: Vec<String>,
}

fn default_quality() -> String {
    "good".to_string()
}

/// 1 Hz 수치 채널의 최신 값 (있는 것만; 0 = 무효 판독은 None).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Vitals {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hr: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resp: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spo2: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glucose: Option<f32>,
}

impl Vitals {
    pub fn is_empty(&self) -> bool {
        self.hr.is_none() && self.temp.is_none() && self.resp.is_none() && self.spo2.is_none() && self.glucose.is_none()
    }
}

/// 파형 블록 하나의 레이아웃 — WS 블롭(i16, 리틀엔디언)에서 `n × axes` 값을 차지한다.
/// 물리값 = raw × scale (ecg mV, accel g, ppg/resp_wave a.u.).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaveBlock {
    pub ch: u8,
    pub key: String,
    pub fs: u32,
    pub axes: u8,
    pub n: u16,
    pub scale: f32,
}

/// 패치 스트림 패킷 (v3 레코드 1건 = 200 ms 번들). `samples` 는 ECG(mV, f32) 로 분석 서버 forward 용,
/// `wave_i16` 은 전 파형 채널의 원본 i16 을 `waves` 순서로 이어 붙인 것으로 WS 블롭이 된다.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EcgPacket {
    pub channel_id: String,
    pub seq: u64,
    pub ts_ms: u64,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub moving: bool,
    /// 현재 연결된 블루투스 게이트웨이 (공간 고정 매핑, 이동 시 전환)
    #[serde(default)]
    pub gateway_id: String,
    /// 현재 머무는 공간 (병실 호수 / 복도 / 화장실 / 검사실)
    #[serde(default)]
    pub space: String,
    #[serde(default)]
    pub flags: u8,
    #[serde(default)]
    pub battery: u8,
    #[serde(default)]
    pub rssi: i8,
    #[serde(default, skip_serializing_if = "Vitals::is_empty")]
    pub vitals: Vitals,
    /// 페이스메이커 스파이크 마크: bits 0-13 = 이 번들 ECG 블록 내 샘플 오프셋, bits 14-15 = 챔버
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pace: Vec<u16>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub waves: Vec<WaveBlock>,
    #[serde(skip)]
    pub wave_i16: Vec<i16>,
}

/// 게이트웨이 배치(ecg_batch) 안의 채널 항목.
/// gateway_id/space 는 배치 레벨에 있으므로 여기서는 생략 (space 는 오버라이드 가능).
#[derive(Debug, Clone, Deserialize)]
pub struct BatchChannel {
    pub channel_id: String,
    pub seq: u64,
    /// 채널별 개별 타임스탬프 (0 이면 배치 ts_ms 사용)
    #[serde(default)]
    pub ts_ms: u64,
    pub sample_rate: u32,
    pub samples: Vec<f32>,
    #[serde(default = "default_quality")]
    pub quality: String,
    #[serde(default)]
    pub moving: bool,
    /// 채널별 공간 오버라이드 (빈 값이면 배치 space 사용)
    #[serde(default)]
    pub space: String,
}

/// 입력(ingest) 소켓으로 들어오는 메시지
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum InboundMsg {
    #[serde(rename = "meta")]
    Meta {
        channel_id: String,
        #[serde(default)]
        ts_ms: u64,
        /// 소속 병원 ID — DB API 가 병원별 DB 로 정확히 라우팅 (전환 레이스 방지)
        #[serde(default)]
        hospital: String,
        patient: Patient,
    },
    #[serde(rename = "ecg")]
    Ecg(EcgPacket),
    /// 게이트웨이 단위 묶음 파형 — 게이트웨이당 소켓 1개, 틱(200ms)당 1패킷.
    /// 한 배치에 최대 16채널 (초과 시 송신측이 분할). 라우터는 채널별 EcgPacket
    /// 으로 풀어 기존 경로(버퍼/분석/파형저장)를 그대로 태운다.
    #[serde(rename = "ecg_batch")]
    EcgBatch {
        gateway_id: String,
        #[serde(default)]
        ts_ms: u64,
        #[serde(default)]
        space: String,
        channels: Vec<BatchChannel>,
    },
    #[serde(rename = "device_event")]
    DeviceEvent {
        channel_id: String,
        #[serde(default)]
        ts_ms: u64,
        event: String,
        #[serde(default)]
        detail: String,
    },
    /// 채널의 명시적 제거 (단순 접속 끊김과 구분).
    /// 수신 시 레지스트리에서 삭제하고 소속 그룹에 leave 를 전파한다.
    /// reason=suspend(병원 전환)면 DB 의 패치는 폐기하지 않는다.
    #[serde(rename = "channel_close")]
    ChannelClose {
        channel_id: String,
        #[serde(default)]
        hospital: String,
        #[serde(default)]
        reason: String,
    },
    /// 예약(검사/진료) 생성/상태 변경 — 라우터는 DB API 로 중계한다.
    /// (정적 정보는 DB 에 영속화, 다이내믹 업데이트 경로는 라우터가 관리)
    #[serde(rename = "appointment")]
    Appointment {
        channel_id: String,
        #[serde(default)]
        ts_ms: u64,
        #[serde(default)]
        hospital: String,
        appointment: serde_json::Value,
    },
    /// 게이트웨이 상태 보고 (에뮬레이터가 전용 연결로 2초 주기 push)
    #[serde(rename = "gateway_status")]
    GatewayStatus {
        #[serde(default)]
        ts_ms: u64,
        #[serde(default)]
        known: u64,
        #[serde(default)]
        down: Vec<String>,
    },
}

/// 분석 서버가 반환하는 이벤트
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisEvent {
    pub kind: String,
    #[serde(default)]
    pub detail: String,
}

/// 분석 서버 → 라우터 응답. seq 가 None 이면 데이터 없는 상태 이벤트(연결해제 등).
#[derive(Debug, Clone, Deserialize)]
pub struct AnalysisMsg {
    pub channel_id: String,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default)]
    pub ts_ms: u64,
    #[serde(default)]
    pub hr: Option<f32>,
    #[serde(default)]
    pub events: Vec<AnalysisEvent>,
}

/// 라우터 → 출력 WS 구독자 메시지
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum OutMsg {
    /// 분석 결과가 병합된 스트림 패킷 (파형 + HR + 이벤트, seq 로 싱크 보장)
    #[serde(rename = "stream")]
    Stream {
        group_ids: Vec<String>,
        channel_id: String,
        seq: u64,
        ts_ms: u64,
        sample_rate: u32,
        /// 바이너리 stream_batch 에서는 항상 비어 있음 (샘플은 i16 블롭으로) → 생략
        #[serde(skip_serializing_if = "Vec::is_empty")]
        samples: Vec<f32>,
        hr: Option<f32>,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        events: Vec<AnalysisEvent>,
        quality: String,
        moving: bool,
        gateway_id: String,
        space: String,
        flags: u8,
        battery: u8,
        rssi: i8,
        #[serde(skip_serializing_if = "Vitals::is_empty")]
        vitals: Vitals,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        pace: Vec<u16>,
        /// 블롭 레이아웃 (v2 프레임): 이 항목의 i16 값 수 = Σ n × axes
        #[serde(skip_serializing_if = "Vec::is_empty")]
        waves: Vec<WaveBlock>,
        /// 5초(25패킷)당 1회만 포함 — 프런트는 last-known 유지
        #[serde(skip_serializing_if = "Option::is_none")]
        patient: Option<Patient>,
    },
    /// 그룹 멤버십 변경 (join/leave/snapshot)
    #[serde(rename = "membership")]
    Membership {
        group_ids: Vec<String>,
        event: String,
        channel_id: String,
        patient: Option<Patient>,
        connected: bool,
    },
    /// 알람 발생/해제 (의사 그룹 `alarms` 구독자에게)
    #[serde(rename = "alarm")]
    Alarm { event: String, alarm: serde_json::Value },
    /// 데이터가 비어 있는 채널 상태 이벤트 (연결해제 등)
    #[serde(rename = "channel_event")]
    ChannelEvent {
        group_ids: Vec<String>,
        channel_id: String,
        ts_ms: u64,
        events: Vec<AnalysisEvent>,
    },
}

/// 출력 WS 클라이언트 → 라우터 제어 메시지
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMsg {
    #[serde(rename = "subscribe")]
    Subscribe { group_id: String },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { group_id: String },
    /// 게이트웨이 단위 구독 (Patch Map 의 게이트웨이 파형 모달이 사용)
    #[serde(rename = "subscribe_gateway")]
    SubscribeGateway { gateway_id: String },
    #[serde(rename = "unsubscribe_gateway")]
    UnsubscribeGateway { gateway_id: String },
    /// 채널 목록 단위 구독 (주치의/간호사 코호트 파형 모달이 사용)
    #[serde(rename = "subscribe_channels")]
    SubscribeChannels { channel_ids: Vec<String> },
    #[serde(rename = "unsubscribe_channels")]
    UnsubscribeChannels {},
}
