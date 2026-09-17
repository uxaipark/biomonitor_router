use crate::protocol::{AnalysisEvent, InboundMsg};
use crate::state::AppState;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tracing::{debug, info, warn};

/// 소스 IP 허용 여부. 루프백은 항상 허용(로컬 에뮬레이터), 그 외는 허용목록 기준.
fn source_allowed(state: &AppState, ip: std::net::IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    match &*state.ingest_allow.lock().unwrap() {
        None => true,
        Some(set) => set.contains(&ip),
    }
}

/// 입력 채널 TCP 리스너. 채널(에뮬레이터 연결)당 태스크 하나를 띄운다.
pub async fn run(state: Arc<AppState>) -> anyhow::Result<()> {
    let listener = TcpListener::bind(&state.cfg.ingest_addr).await?;
    info!("ingest listening on {}", state.cfg.ingest_addr);
    loop {
        let (stream, peer) = listener.accept().await?;
        if !source_allowed(&state, peer.ip()) {
            debug!("ingest connection from {} rejected (not in allowlist)", peer);
            continue; // stream drop → 즉시 종료
        }
        let st = state.clone();
        tokio::spawn(async move {
            debug!("ingest connection from {}", peer);
            if let Err(e) = handle_conn(st, stream, peer.ip()).await {
                debug!("ingest connection {} closed: {}", peer, e);
            }
        });
    }
}

/// ECG 패킷 1건 처리 (개별 ecg / 배치에서 풀린 패킷 공용).
/// raw_line 이 있으면 그대로 분석 서버에 forward, 없으면(배치 출신) ecg 라인으로 재직렬화
/// — 분석 서버는 개별 ecg 프로토콜만 이해하므로 배치는 라우터가 풀어서 전달한다.
fn process_ecg(state: &Arc<AppState>, pkt: crate::protocol::EcgPacket, raw_line: Option<&str>) {
    state.total_packets.fetch_add(1, Ordering::Relaxed);
    // 파형 파일 저장 (8시간 롤링) — 기록 태스크로 넘겨 핫패스를 막지 않는다
    state.send_wave(pkt.clone());
    let lost = state.registry.push_packet(&pkt);
    if lost > 0 {
        // seq 갭 = 미전송 구간 (게이트웨이 장애/접속 불량) 패킷 유실
        state.total_lost_packets.fetch_add(lost, Ordering::Relaxed);
    }
    if state.analysis_up() {
        // 분석 서버가 살아 있으면: 버퍼에 보관된 상태로 forward,
        // 분석 응답(seq) 도착 시 병합되어 출력된다.
        let line = match raw_line {
            Some(l) => l.to_string(),
            None => {
                #[derive(serde::Serialize)]
                struct EcgLine<'a> {
                    #[serde(rename = "type")]
                    t: &'static str,
                    #[serde(flatten)]
                    pkt: &'a crate::protocol::EcgPacket,
                }
                serde_json::to_string(&EcgLine { t: "ecg", pkt: &pkt }).unwrap_or_default()
            }
        };
        state.send_analysis(line);
    } else {
        // 패스스루 모드: 분석 없이 즉시 출력 (버퍼 항목은 회수)
        let taken = state.registry.take_matching(&pkt.channel_id, pkt.seq);
        state.emit_stream(taken.unwrap_or(pkt), None, Vec::new());
    }
}

async fn handle_conn(
    state: Arc<AppState>,
    stream: TcpStream,
    peer_ip: std::net::IpAddr,
) -> anyhow::Result<()> {
    let mut lines = BufReader::new(stream).lines();
    // 이 연결에서 패킷을 보낸 채널들 (레거시: 채널당 1개 / 배치: 게이트웨이 소속 전체)
    let mut conn_channels: std::collections::HashSet<String> = std::collections::HashSet::new();
    // 배치 연결의 게이트웨이 (EOF 시 "아직 이 게이트웨이 소속인 채널"만 해제 처리)
    let mut conn_gateway: Option<String> = None;
    state.ingest_conns.fetch_add(1, Ordering::Relaxed);
    *state.ingest_sources.lock().unwrap().entry(peer_ip).or_insert(0) += 1;

    loop {
        // EOF 뿐 아니라 연결 리셋(에러)도 동일하게 종료 처리로 흘려보낸다
        // (?를 쓰면 조기 리턴되어 아래의 연결해제 정리가 누락된다)
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => break,
            Err(_) => break,
        };
        // 허용목록에서 빠진 소스의 기존 연결은 즉시 끊는다 (선택 변경의 실시간 반영)
        if !source_allowed(&state, peer_ip) {
            debug!("ingest connection {} dropped (allowlist changed)", peer_ip);
            break;
        }
        state.total_bytes.fetch_add(line.len() as u64 + 1, Ordering::Relaxed);
        if line.trim().is_empty() {
            continue;
        }
        let msg: InboundMsg = match serde_json::from_str(&line) {
            Ok(m) => m,
            Err(e) => {
                warn!("ingest parse error: {} line={}", e, &line[..line.len().min(120)]);
                continue;
            }
        };
        match msg {
            InboundMsg::Meta { channel_id, hospital, patient, .. } => {
                conn_channels.insert(channel_id.clone());
                // DB API 로 환자 메타데이터 실시간 push (SQLite 갱신)
                if let Ok(op) = serde_json::to_string(&serde_json::json!({
                    "op": "upsert_patient",
                    "channel_id": &channel_id,
                    "hospital": &hospital,
                    "patient": &patient,
                })) {
                    state.send_db(op);
                }
                state.registry.upsert_meta(&channel_id, patient);
                // meta 는 그룹핑 기준이므로 수신 즉시 멤버십 재계산 → join/leave 전파
                state.recompute_channel_groups(&channel_id);
                if state.analysis_up() {
                    state.send_analysis(line);
                }
            }
            InboundMsg::Ecg(pkt) => {
                conn_channels.insert(pkt.channel_id.clone());
                process_ecg(&state, pkt, Some(&line));
            }
            InboundMsg::EcgBatch { gateway_id, ts_ms, space, channels } => {
                // 게이트웨이 단위 묶음: 채널별 패킷으로 풀어 기존 경로를 태운다.
                if channels.len() > 16 {
                    warn!(
                        "ecg_batch from {} exceeds 16 channels ({}) — 송신측 분할 필요",
                        gateway_id,
                        channels.len()
                    );
                }
                conn_gateway = Some(gateway_id.clone());
                for c in channels {
                    conn_channels.insert(c.channel_id.clone());
                    let pkt = crate::protocol::EcgPacket {
                        channel_id: c.channel_id,
                        seq: c.seq,
                        ts_ms: if c.ts_ms > 0 { c.ts_ms } else { ts_ms },
                        sample_rate: c.sample_rate,
                        samples: c.samples,
                        quality: c.quality,
                        moving: c.moving,
                        gateway_id: gateway_id.clone(),
                        space: if c.space.is_empty() { space.clone() } else { c.space },
                    };
                    process_ecg(&state, pkt, None);
                }
            }
            InboundMsg::DeviceEvent { channel_id, event, detail, .. } => {
                conn_channels.insert(channel_id.clone());
                state.emit_channel_event(
                    &channel_id,
                    vec![AnalysisEvent { kind: event, detail }],
                );
            }
            InboundMsg::Appointment { channel_id, hospital, appointment, .. } => {
                // 예약은 채널 데이터가 아니라 일정 정보 — DB API 로 중계만 한다
                if let Ok(op) = serde_json::to_string(&serde_json::json!({
                    "op": "upsert_appointment",
                    "hospital": &hospital,
                    "channel_id": &channel_id,
                    "appointment": &appointment,
                })) {
                    state.send_db(op);
                }
                let title = appointment.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let name = appointment.get("patient_name").and_then(|v| v.as_str()).unwrap_or("");
                let status = appointment.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let msg = match status {
                    "reserved" => format!("예약 등록: {} — {}", name, title),
                    "in_progress" => format!("예약 이동 시작: {} — {}", name, title),
                    "done" => format!("예약 완료·복귀: {} — {}", name, title),
                    _ => format!("예약 갱신: {} — {}", name, title),
                };
                state.push_event("appointment", Some(channel_id), msg);
            }
            InboundMsg::GatewayStatus { ts_ms, known, down } => {
                // 게이트웨이 상태 보고 (채널 아님 — conn_channel 미설정)
                *state.gateway_status.lock().unwrap() = (known, down, ts_ms);
            }
            InboundMsg::ChannelClose { channel_id, hospital, reason } => {
                info!("channel {} explicitly closed (reason={})", channel_id, reason);
                // DB API: 패치 폐기 처리 (퇴원/교체/삭제).
                // 병원 전환(suspend)은 일시 중단이므로 패치를 폐기하지 않는다 —
                // DB 에 in_use 로 남아 복귀 시 그대로 복원된다.
                if reason != "suspend" {
                    if let Ok(op) = serde_json::to_string(&serde_json::json!({
                        "op": "retire_patch",
                        "patch_id": &channel_id,
                        "hospital": &hospital,
                    })) {
                        state.send_db(op);
                    }
                }
                state.remove_channel(&channel_id);
                if state.analysis_up() {
                    // 분석 서버도 채널 상태를 정리하도록 전달
                    state.send_analysis(line);
                }
                // EOF 시 ingest_disconnected 를 내보내지 않도록 해제
                conn_channels.remove(&channel_id);
            }
        }
    }

    state.ingest_conns.fetch_sub(1, Ordering::Relaxed);
    {
        let mut src = state.ingest_sources.lock().unwrap();
        if let Some(n) = src.get_mut(&peer_ip) {
            *n -= 1;
            if *n == 0 {
                src.remove(&peer_ip);
            }
        }
    }

    // EOF: 입력 소켓이 끊긴 채널을 그룹 구독자에게 알린다.
    // 배치(게이트웨이) 연결은 여러 채널을 실어 나르므로, 환자 이동으로 이미 다른
    // 게이트웨이 연결로 옮겨간 채널은 건너뛴다 (현재 게이트웨이가 일치할 때만 해제).
    for channel_id in conn_channels {
        if let Some(gw) = &conn_gateway {
            if state.registry.gateway_of(&channel_id).as_deref() != Some(gw.as_str()) {
                continue;
            }
        }
        state.registry.set_connected(&channel_id, false);
        state.emit_channel_event(
            &channel_id,
            vec![AnalysisEvent {
                kind: "ingest_disconnected".into(),
                detail: "input socket closed".into(),
            }],
        );
        info!("channel {} ingest disconnected", channel_id);
    }
    Ok(())
}
