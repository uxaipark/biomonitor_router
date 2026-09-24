use crate::protocol::{EcgPacket, Patient, Vitals};
use dashmap::DashMap;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 채널 하나의 런타임 상태.
/// `pending` 은 분석 응답을 기다리는 원본 패킷의 서큘러 버퍼로,
/// 분석 결과(seq)와 파형을 싱크 맞춰 병합하는 데 사용한다.
#[derive(Debug)]
pub struct ChannelState {
    pub patient: Option<Patient>,
    pub connected: bool,
    pub quality: String,
    pub moving: bool,
    pub gateway_id: String,
    pub space: String,
    pub last_seq: u64,
    pub last_ts_ms: u64,
    pub groups: Vec<String>,
    /// v3: 패치 자체 패킷 카운터 (갭 = 패치~라우터 사이 어딘가의 유실)
    pub last_pseq: Option<u32>,
    pub sample_rate: u32,
    pub patient_id: u32,
    pub mrn: String,
    pub profile_id: u64,
    pub flags: u8,
    pub battery: u8,
    pub rssi: i8,
    /// META bundle_ms — 파형 블록의 n 으로 채널별 fs 를 셈한다
    pub bundle_ms: u32,
    /// META patches[].channels[].key 목록 (이 패치가 보내는 채널)
    pub channel_keys: Vec<String>,
    /// 1 Hz 수치의 최신값과 그 수신 시각 (알람·표 표시용; 값은 다음 판독까지 유지)
    pub vitals: Vitals,
    pub vitals_ts_ms: u64,
    /// 패치 seq 역전 판정 횟수 (진단용)
    pub pseq_reorder: u64,
    /// 패치 발급(부착) 시각 — 에뮬레이터 패치 레지스트리 `issued_at`, 모르면 0
    pub patch_issued_ms: u64,
    /// 이 패치의 첫 레코드 시각 (발급 시각을 모를 때 착용 시작으로 씀)
    pub first_seen_ms: u64,
    /// 에뮬레이터 환자 목록의 `patch_wear_days` 로 정한 착용 시작 (있으면 최우선)
    pub wear_ms: u64,
    /// (수신 시각, 패킷) — 분석 응답 대기 서큘러 버퍼.
    /// 수신 시각은 분석 지연 시 타임아웃 방출(무분석 통과)에 사용된다.
    pub pending: VecDeque<(Instant, EcgPacket)>,
}

impl ChannelState {
    /// 착용 시작: 발급 시각이 있으면 그것, 없으면 첫 수신
    pub fn wear_start_ms(&self) -> u64 {
        if self.wear_ms > 0 { self.wear_ms } else if self.patch_issued_ms > 0 { self.patch_issued_ms } else { self.first_seen_ms }
    }

    fn new() -> Self {
        Self {
            patient: None,
            connected: false,
            quality: "good".into(),
            moving: false,
            gateway_id: String::new(),
            space: String::new(),
            last_seq: 0,
            last_ts_ms: 0,
            groups: Vec::new(),
            last_pseq: None,
            sample_rate: 250,
            patient_id: 0,
            mrn: String::new(),
            profile_id: 0,
            flags: 0,
            battery: 0,
            rssi: 0,
            bundle_ms: 200,
            channel_keys: Vec::new(),
            vitals: Vitals::default(),
            vitals_ts_ms: 0,
            pseq_reorder: 0,
            patch_issued_ms: 0,
            first_seen_ms: 0,
            wear_ms: 0,
            pending: VecDeque::new(),
        }
    }
}

/// 어드민 API 응답용 채널 요약
#[derive(Debug, Clone, Serialize)]
pub struct ChannelInfo {
    pub channel_id: String,
    pub connected: bool,
    /// 소켓은 살아 있으나 3초 이상 패킷이 없는 상태 (게이트웨이 장애 등)
    pub stale: bool,
    pub quality: String,
    pub moving: bool,
    pub gateway_id: String,
    pub space: String,
    pub last_seq: u64,
    pub last_ts_ms: u64,
    pub patient: Option<Patient>,
    pub groups: Vec<String>,
    pub patient_id: u32,
    pub mrn: String,
    pub profile_id: u64,
    pub sample_rate: u32,
    pub flags: u8,
    pub battery: u8,
    pub rssi: i8,
    pub channels: Vec<String>,
    pub vitals: Vitals,
    pub vitals_ts_ms: u64,
    pub pseq_reorder: u64,
    /// 패치 착용 시작 (발급 시각, 모르면 첫 수신 시각; 0 = 모름)
    pub wear_start_ms: u64,
    pub patch_issued_ms: u64,
}

/// 패치 시퀀스 판정 (v3 record.seq)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PatchSeq {
    Ok,
    Gap(u32),
    Dup,
    Reorder,
    /// 카운터가 크게 뒤로 감(패치/에뮬레이터 재시작): 기준을 다시 잡음
    Restart,
}

/// 전 채널 레지스트리. DashMap 으로 락 경합을 채널 단위로 분산한다.
/// 병실 id 첫 자리(1·2·3…) → 건물 이름. 자기 병실에 있는 환자의 게이트웨이 위치에서 배운다 (META).
pub static BUILDING_OF: std::sync::LazyLock<DashMap<char, String>> = std::sync::LazyLock::new(DashMap::new);

/// 병동 병실 id(`304B01`)면 첫 자리
pub fn ward_room_digit(room: &str) -> Option<char> {
    let b = room.as_bytes();
    (b.len() == 6 && b[..3].iter().all(|c| c.is_ascii_digit()) && b[3].is_ascii_uppercase() && b[4..].iter().all(|c| c.is_ascii_digit())).then(|| b[0] as char)
}
/// 입원 병실의 건물 이름 (모르면 빈 문자열)
pub fn home_building_of(room: &str) -> String {
    ward_room_digit(room).and_then(|d| BUILDING_OF.get(&d).map(|v| v.clone())).unwrap_or_default()
}

pub struct Registry {
    channels: DashMap<String, ChannelState>,
    ring_capacity: usize,
    /// EMR 입원 목록의 패치 번호 (에뮬레이터 연동 시). 있으면 목록에 없는 행은 화면·알람에서 뺀다(유령 금지).
    admitted: std::sync::RwLock<Option<std::collections::HashSet<String>>>,
}

impl Registry {
    pub fn new(ring_capacity: usize) -> Self {
        Self {
            channels: DashMap::new(),
            ring_capacity,
            admitted: std::sync::RwLock::new(None),
        }
    }

    /// 입원 목록 갱신 (None = 목록 모름 → 모든 행 표시)
    pub fn set_admitted(&self, set: Option<std::collections::HashSet<String>>) {
        *self.admitted.write().unwrap() = set;
    }

    /// 입원 목록에 있는 행인가 (목록을 모르면 true)
    pub fn is_listed(&self, channel_id: &str) -> bool {
        self.admitted.read().unwrap().as_ref().map(|s| s.contains(channel_id)).unwrap_or(true)
    }

    pub fn upsert_meta(&self, channel_id: &str, patient: Patient) {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        ch.patient = Some(patient);
        ch.connected = true;
    }

    /// EMR(입원 목록·환자 정보)에서 온 환자 정보만 갱신 — 연결 상태는 건드리지 않는다.
    /// 입원했지만 게이트웨이에 아직 안 붙은 패치(레코드 없음)를 '연결됨'으로 보이지 않게.
    pub fn upsert_patient(&self, channel_id: &str, patient: Patient) {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        ch.patient = Some(patient);
    }

    /// ECG 패킷 수신: 상태 갱신 + 서큘러 버퍼에 보관.
    /// 버퍼가 가득 차면 가장 오래된 패킷부터 폐기한다.
    /// 반환값: seq 갭으로 감지한 유실 패킷 수 (에뮬레이터가 미전송 구간의 seq 를 스킵)
    /// `keep`: park the packet in the analysis-merge buffer (only while an analysis server is connected —
    /// in passthrough mode nothing ever takes it out, so keeping it would just grow to ring_capacity per channel).
    pub fn push_packet(&self, pkt: &EcgPacket, keep: bool) -> u64 {
        let mut ch = self
            .channels
            .entry(pkt.channel_id.clone())
            .or_insert_with(ChannelState::new);
        let lost = if ch.last_seq > 0 && pkt.seq > ch.last_seq + 1 {
            pkt.seq - ch.last_seq - 1
        } else {
            0
        };
        ch.connected = true;
        ch.quality = pkt.quality.clone();
        ch.moving = pkt.moving;
        if !pkt.gateway_id.is_empty() {
            ch.gateway_id = pkt.gateway_id.clone();
            ch.space = pkt.space.clone();
        }
        ch.last_seq = pkt.seq;
        ch.last_ts_ms = pkt.ts_ms;
        if ch.first_seen_ms == 0 {
            ch.first_seen_ms = pkt.ts_ms;
        }
        if !pkt.vitals.is_empty() {
            let v = &pkt.vitals;
            if v.hr.is_some() { ch.vitals.hr = v.hr; }
            if v.temp.is_some() { ch.vitals.temp = v.temp; }
            if v.resp.is_some() { ch.vitals.resp = v.resp; }
            if v.spo2.is_some() { ch.vitals.spo2 = v.spo2; }
            if v.glucose.is_some() { ch.vitals.glucose = v.glucose; }
            ch.vitals_ts_ms = pkt.ts_ms;
        }
        if keep {
            if ch.pending.len() >= self.ring_capacity {
                ch.pending.pop_front();
            }
            ch.pending.push_back((Instant::now(), pkt.clone()));
        } else if !ch.pending.is_empty() {
            ch.pending.clear();
        }
        lost
    }

    /// Per-record state update without building a stream packet (nobody is listening: no analysis server,
    /// no WS session). Same effect on the row as `push_packet(_, false)`.
    pub fn note_record(&self, channel_id: &str, seq: u64, ts_ms: u64, flags: u8, vitals: &Vitals, gateway_id: &str, space: &str) {
        let mut ch = self.channels.entry(channel_id.to_string()).or_insert_with(ChannelState::new);
        ch.connected = true;
        let q = if flags & crate::wire::R_LEAD_OFF != 0 { "leadoff" } else if flags & crate::wire::R_MOTION != 0 { "noisy" } else { "good" };
        if ch.quality != q {
            ch.quality = q.to_string();
        }
        ch.moving = flags & crate::wire::R_MOTION != 0;
        if !gateway_id.is_empty() && ch.gateway_id != gateway_id {
            ch.gateway_id = gateway_id.to_string();
            ch.space = space.to_string();
        }
        ch.last_seq = seq;
        ch.last_ts_ms = ts_ms;
        if ch.first_seen_ms == 0 {
            ch.first_seen_ms = ts_ms;
        }
        if !vitals.is_empty() {
            if vitals.hr.is_some() { ch.vitals.hr = vitals.hr; }
            if vitals.temp.is_some() { ch.vitals.temp = vitals.temp; }
            if vitals.resp.is_some() { ch.vitals.resp = vitals.resp; }
            if vitals.spo2.is_some() { ch.vitals.spo2 = vitals.spo2; }
            if vitals.glucose.is_some() { ch.vitals.glucose = vitals.glucose; }
            ch.vitals_ts_ms = ts_ms;
        }
        if !ch.pending.is_empty() {
            ch.pending.clear();
        }
    }

    /// Fast path (no listener): patch seq check + header fields + vitals in ONE map lookup.
    /// Returns the seq verdict; on Dup/Reorder the row is left untouched (as the stream path does).
    #[allow(clippy::too_many_arguments)]
    pub fn observe_record(&self, channel_id: &str, patient_id: u32, flags: u8, battery: u8, rssi: i8, seq: u32, ts_ms: u64, vitals: &Vitals, gateway_id: &str, space: &str) -> PatchSeq {
        let mut ch = self.channels.entry(channel_id.to_string()).or_insert_with(ChannelState::new);
        let verdict = match ch.last_pseq {
            None => { ch.last_pseq = Some(seq); PatchSeq::Ok }
            Some(last) => {
                let d = seq.wrapping_sub(last);
                if d == 1 { ch.last_pseq = Some(seq); PatchSeq::Ok }
                else if d == 0 { PatchSeq::Dup }
                else if d < 1 << 31 { ch.last_pseq = Some(seq); PatchSeq::Gap(d - 1) }
                else if last.wrapping_sub(seq) > crate::gateways::SEQ_RESTART_BACK { ch.last_pseq = Some(seq); PatchSeq::Restart }
                else { ch.pseq_reorder += 1; PatchSeq::Reorder }
            }
        };
        if matches!(verdict, PatchSeq::Reorder) {
            return verdict;
        }
        ch.patient_id = patient_id;
        ch.flags = flags;
        ch.battery = battery;
        ch.rssi = rssi;
        if matches!(verdict, PatchSeq::Dup) {
            return verdict; // pace-mark continuation: header fields only
        }
        ch.connected = true;
        let q = if flags & crate::wire::R_LEAD_OFF != 0 { "leadoff" } else if flags & crate::wire::R_MOTION != 0 { "noisy" } else { "good" };
        if ch.quality != q {
            ch.quality = q.to_string();
        }
        ch.moving = flags & crate::wire::R_MOTION != 0;
        if !gateway_id.is_empty() && ch.gateway_id != gateway_id {
            ch.gateway_id = gateway_id.to_string();
            ch.space = space.to_string();
        }
        ch.last_seq = seq as u64;
        ch.last_ts_ms = ts_ms;
        if ch.first_seen_ms == 0 {
            ch.first_seen_ms = ts_ms;
        }
        if !vitals.is_empty() {
            if vitals.hr.is_some() { ch.vitals.hr = vitals.hr; }
            if vitals.temp.is_some() { ch.vitals.temp = vitals.temp; }
            if vitals.resp.is_some() { ch.vitals.resp = vitals.resp; }
            if vitals.spo2.is_some() { ch.vitals.spo2 = vitals.spo2; }
            if vitals.glucose.is_some() { ch.vitals.glucose = vitals.glucose; }
            ch.vitals_ts_ms = ts_ms;
        }
        if !ch.pending.is_empty() {
            ch.pending.clear();
        }
        verdict
    }

    /// Is this channel in any of the given groups? (no Vec clone)
    pub fn in_any_group(&self, channel_id: &str, groups: &dashmap::DashMap<String, usize>) -> bool {
        self.channels.get(channel_id).map(|c| c.groups.iter().any(|g| groups.contains_key(g))).unwrap_or(false)
    }

    /// Visit every row by reference (alarm engine): no per-row clones.
    pub fn for_each(&self, mut f: impl FnMut(&str, &ChannelState)) {
        for e in self.channels.iter() {
            f(e.key(), e.value());
        }
    }

    /// 분석 결과 seq 에 해당하는 원본 패킷을 꺼낸다.
    /// seq 보다 오래된 항목(응답 유실분)은 함께 폐기해 버퍼 밀림을 방지한다.
    pub fn take_matching(&self, channel_id: &str, seq: u64) -> Option<EcgPacket> {
        let mut ch = self.channels.get_mut(channel_id)?;
        while let Some((_, front)) = ch.pending.front() {
            if front.seq < seq {
                ch.pending.pop_front();
            } else if front.seq == seq {
                return ch.pending.pop_front().map(|(_, p)| p);
            } else if front.seq > seq + 1024 {
                // the patch counter restarted (emulator restart): everything parked is from the old run
                ch.pending.clear();
                return None;
            } else {
                return None;
            }
        }
        None
    }

    /// 분석 응답이 max_age 를 초과하도록 오지 않은 패킷들을 방출한다.
    /// (분석 서버 지연/스톨 시 파형이 밀리지 않고 무분석으로 계속 흐르게 하는 경로)
    pub fn take_expired(&self, max_age: Duration) -> Vec<EcgPacket> {
        let now = Instant::now();
        let mut out = Vec::new();
        for mut ch in self.channels.iter_mut() {
            while let Some((arrived, _)) = ch.pending.front() {
                if now.duration_since(*arrived) > max_age {
                    if let Some((_, pkt)) = ch.pending.pop_front() {
                        out.push(pkt);
                    }
                } else {
                    break;
                }
            }
        }
        out
    }

    /// 분석 서버 재접속 등으로 스테일해진 대기 버퍼 전체 폐기
    pub fn clear_all_pending(&self) {
        for mut ch in self.channels.iter_mut() {
            ch.pending.clear();
        }
    }

    /// 채널을 레지스트리에서 완전히 제거하고 마지막 상태를 반환
    pub fn remove(&self, channel_id: &str) -> Option<ChannelState> {
        self.channels.remove(channel_id).map(|(_, v)| v)
    }

    /// 연결이 끊긴 지 `max_age_ms` 넘은 행을 지운다 (에뮬레이터 재구축 뒤 남는 옛 패치 번호 정리).
    /// 반환: 지운 채널 ID.
    pub fn prune_disconnected(&self, max_age_ms: u64) -> Vec<String> {
        let now = crate::protocol::now_ms();
        let dead: Vec<String> = self
            .channels
            .iter()
            // A discharged / replaced patch stops sending but its gateway socket stays up, so the row still says
            // connected: judge by the last record instead of the socket.
            .filter(|e| e.last_ts_ms > 0 && now.saturating_sub(e.last_ts_ms) > max_age_ms)
            .map(|e| e.key().clone())
            .collect();
        for id in &dead {
            self.channels.remove(id);
        }
        dead
    }

    /// Sum of parked analysis-merge packets over all channels (debug/sizes).
    pub fn pending_total(&self) -> usize {
        self.channels.iter().map(|c| c.pending.len()).sum()
    }

    pub fn connected_count(&self) -> usize {
        self.channels.iter().filter(|e| e.connected).count()
    }

    /// 연결이 끊긴(해제) 채널 ID 목록 — 레지스트리 정리(prune)용
    pub fn disconnected_ids(&self) -> Vec<String> {
        self.channels
            .iter()
            .filter(|e| !e.connected)
            .map(|e| e.key().clone())
            .collect()
    }

    pub fn set_connected(&self, channel_id: &str, connected: bool) {
        if let Some(mut ch) = self.channels.get_mut(channel_id) {
            ch.connected = connected;
        }
    }

    pub fn groups_of(&self, channel_id: &str) -> Vec<String> {
        self.channels
            .get(channel_id)
            .map(|c| c.groups.clone())
            .unwrap_or_default()
    }

    pub fn set_groups(&self, channel_id: &str, groups: Vec<String>) -> Vec<String> {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        std::mem::replace(&mut ch.groups, groups)
    }

    /// 채널의 현재 게이트웨이 (배치 ingest 연결 EOF 시 소속 확인용)
    pub fn gateway_of(&self, channel_id: &str) -> Option<String> {
        self.channels.get(channel_id).map(|e| e.gateway_id.clone())
    }

    pub fn patient_of(&self, channel_id: &str) -> Option<Patient> {
        self.channels.get(channel_id).and_then(|c| c.patient.clone())
    }

    /// v3 패치 카운터 추적. 연결 직후 첫 패킷은 Ok.
    pub fn track_patch_seq(&self, channel_id: &str, seq: u32) -> PatchSeq {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        let Some(last) = ch.last_pseq else {
            ch.last_pseq = Some(seq);
            return PatchSeq::Ok;
        };
        let d = seq.wrapping_sub(last);
        if d == 1 {
            ch.last_pseq = Some(seq);
            PatchSeq::Ok
        } else if d == 0 {
            PatchSeq::Dup
        } else if d < 1 << 31 {
            ch.last_pseq = Some(seq);
            PatchSeq::Gap(d - 1)
        } else if last.wrapping_sub(seq) > crate::gateways::SEQ_RESTART_BACK {
            ch.last_pseq = Some(seq);
            PatchSeq::Restart
        } else {
            ch.pseq_reorder += 1;
            PatchSeq::Reorder
        }
    }

    pub fn bundle_ms_of(&self, channel_id: &str) -> Option<u32> {
        self.channels.get(channel_id).map(|c| c.bundle_ms)
    }

    /// META 의 번들 주기와 채널 키 목록
    pub fn set_stream_layout(&self, channel_id: &str, bundle_ms: u32, keys: Vec<String>) {
        if let Some(mut ch) = self.channels.get_mut(channel_id) {
            ch.bundle_ms = bundle_ms;
            ch.channel_keys = keys;
        }
    }

    /// 최신 수치·플래그 스냅샷 (알람 엔진용)
    pub fn vitals_of(&self, channel_id: &str) -> Option<(Vitals, u64, u8, u8)> {
        self.channels.get(channel_id).map(|c| (c.vitals.clone(), c.vitals_ts_ms, c.flags, c.battery))
    }

    pub fn sample_rate_of(&self, channel_id: &str) -> Option<u32> {
        self.channels.get(channel_id).map(|c| c.sample_rate)
    }

    /// META 의 패치 항목: 게이트웨이/공간/샘플레이트/식별자
    pub fn set_link(&self, channel_id: &str, gateway_id: &str, space: &str, fs: u32, mrn: &str, profile_id: u64) {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        ch.gateway_id = gateway_id.to_string();
        ch.space = space.to_string();
        ch.sample_rate = fs;
        ch.mrn = mrn.to_string();
        ch.profile_id = profile_id;
        ch.connected = true;
    }

    /// 레코드 헤더의 패치 상태 (환자번호·플래그·배터리·RSSI)
    /// 환자 목록의 착용 일수로 정한 착용 시작 (발급 시각보다 우선). 2시간 넘게 달라질 때만 바꾼다.
    pub fn set_wear_start(&self, channel_id: &str, ms: u64) {
        if let Some(mut ch) = self.channels.get_mut(channel_id) {
            if ch.wear_ms == 0 || ch.wear_ms.abs_diff(ms) > 2 * 3_600_000 {
                ch.wear_ms = ms;
            }
        }
    }

    /// 패치 레지스트리의 발급 시각 (있는 행만)
    pub fn set_patch_issued(&self, channel_id: &str, ms: u64) -> bool {
        match self.channels.get_mut(channel_id) {
            Some(mut ch) if ch.patch_issued_ms != ms => {
                ch.patch_issued_ms = ms;
                true
            }
            _ => false,
        }
    }

    pub fn note_patch(&self, channel_id: &str, patient_id: u32, flags: u8, battery: u8, rssi: i8) {
        if let Some(mut ch) = self.channels.get_mut(channel_id) {
            ch.patient_id = patient_id;
            ch.flags = flags;
            ch.battery = battery;
            ch.rssi = rssi;
        }
    }

    pub fn channels_of_gateway(&self, gateway_id: &str) -> Vec<String> {
        self.channels
            .iter()
            .filter(|e| e.gateway_id == gateway_id && e.connected)
            .map(|e| e.key().clone())
            .collect()
    }

    pub fn len(&self) -> usize {
        self.channels.len()
    }

    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }

    pub fn channel_ids(&self) -> Vec<String> {
        self.channels.iter().map(|e| e.key().clone()).collect()
    }

    /// 특정 그룹에 속한 채널의 (id, patient, connected) 스냅샷
    pub fn members_of(&self, group_id: &str) -> Vec<(String, Option<Patient>, bool)> {
        self.channels
            .iter()
            .filter(|e| e.groups.iter().any(|g| g == group_id))
            .map(|e| (e.key().clone(), e.patient.clone(), e.connected))
            .collect()
    }

    pub fn member_count(&self, group_id: &str) -> usize {
        self.channels
            .iter()
            .filter(|e| e.groups.iter().any(|g| g == group_id))
            .count()
    }

    pub fn snapshot(&self) -> Vec<ChannelInfo> {
        self.snapshot_where(|_, _| true)
    }

    /// Snapshot of the rows matching `keep` — a scoped viewer asks for its ~24 patches instead of all 1,500
    /// (the full list is 1.2 MB of JSON, and every tab parsing that on its main thread stalls the waveforms).
    pub fn snapshot_where(&self, keep: impl Fn(&str, &ChannelState) -> bool) -> Vec<ChannelInfo> {
        let now = crate::protocol::now_ms();
        let admitted = self.admitted.read().unwrap().clone();
        let mut v: Vec<ChannelInfo> = self
            .channels
            .iter()
            .filter(|e| keep(e.key(), e.value()))
            .filter(|e| admitted.as_ref().map(|s| s.contains(e.key())).unwrap_or(true))
            .map(|e| ChannelInfo {
                channel_id: e.key().clone(),
                connected: e.connected,
                stale: e.connected && e.last_ts_ms > 0 && now.saturating_sub(e.last_ts_ms) > 3000,
                quality: e.quality.clone(),
                moving: e.moving,
                gateway_id: e.gateway_id.clone(),
                space: e.space.clone(),
                last_seq: e.last_seq,
                last_ts_ms: e.last_ts_ms,
                patient: e.patient.clone(),
                groups: e.groups.clone(),
                patient_id: e.patient_id,
                mrn: e.mrn.clone(),
                profile_id: e.profile_id,
                sample_rate: e.sample_rate,
                flags: e.flags,
                battery: e.battery,
                rssi: e.rssi,
                channels: e.channel_keys.clone(),
                vitals: e.vitals.clone(),
                vitals_ts_ms: e.vitals_ts_ms,
                pseq_reorder: e.pseq_reorder,
                wear_start_ms: e.wear_start_ms(),
                patch_issued_ms: e.patch_issued_ms,
            })
            .collect();
        v.sort_by(|a, b| a.channel_id.cmp(&b.channel_id));
        v
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn ward_room_digits() {
        assert_eq!(super::ward_room_digit("304B01"), Some('3'));
        assert_eq!(super::ward_room_digit("B1-01-투석실"), None);
        assert_eq!(super::ward_room_digit("W103A"), None);
    }
}
