use crate::protocol::{EcgPacket, Patient};
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
    /// (수신 시각, 패킷) — 분석 응답 대기 서큘러 버퍼.
    /// 수신 시각은 분석 지연 시 타임아웃 방출(무분석 통과)에 사용된다.
    pub pending: VecDeque<(Instant, EcgPacket)>,
}

impl ChannelState {
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
}

/// 전 채널 레지스트리. DashMap 으로 락 경합을 채널 단위로 분산한다.
pub struct Registry {
    channels: DashMap<String, ChannelState>,
    ring_capacity: usize,
}

impl Registry {
    pub fn new(ring_capacity: usize) -> Self {
        Self {
            channels: DashMap::new(),
            ring_capacity,
        }
    }

    pub fn upsert_meta(&self, channel_id: &str, patient: Patient) {
        let mut ch = self
            .channels
            .entry(channel_id.to_string())
            .or_insert_with(ChannelState::new);
        ch.patient = Some(patient);
        ch.connected = true;
    }

    /// ECG 패킷 수신: 상태 갱신 + 서큘러 버퍼에 보관.
    /// 버퍼가 가득 차면 가장 오래된 패킷부터 폐기한다.
    /// 반환값: seq 갭으로 감지한 유실 패킷 수 (에뮬레이터가 미전송 구간의 seq 를 스킵)
    pub fn push_packet(&self, pkt: &EcgPacket) -> u64 {
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
        if ch.pending.len() >= self.ring_capacity {
            ch.pending.pop_front();
        }
        ch.pending.push_back((Instant::now(), pkt.clone()));
        lost
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
        let now = crate::protocol::now_ms();
        let mut v: Vec<ChannelInfo> = self
            .channels
            .iter()
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
            })
            .collect();
        v.sort_by(|a, b| a.channel_id.cmp(&b.channel_id));
        v
    }
}
