use crate::protocol::{ClientMsg, OutMsg};
use crate::state::AppState;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use tokio::sync::broadcast::error::RecvError;
use tracing::debug;

/// 출력 WS 핸들러. 클라이언트는 subscribe/unsubscribe 로 그룹을 구독한다.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Clients only ever send small JSON commands. tungstenite zero-fills its read buffer on every read
    // attempt (128 KiB by default), so keep it small.
    ws.read_buffer_size(4096)
        .on_upgrade(move |socket| client_task(state, socket))
}

/// 스트림 배칭 플러시 주기 (ms). 뷰어는 1초 지터버퍼로 재생하므로 100ms 묶음은
/// 표시 지연에 영향 없이 WS 프레임 수를 채널 수 → 1/틱 으로 줄인다.
const STREAM_FLUSH_MS: u64 = 100;
/// 플러시 전 버퍼 상한 (폭주 방어)
const STREAM_BUF_MAX: usize = 1024;

async fn client_task(state: Arc<AppState>, socket: WebSocket) {
    let (mut tx, mut rx_ws) = socket.split();
    // Socket reads run in their own task: a `select!` branch on `rx_ws.next()` would attempt a read (and
    // tungstenite's buffer zero-fill) on every one of the ~10k/s broadcast wake-ups, which profiled at
    // 80 % of router CPU with 20 sessions. The reader only wakes when the socket is actually readable.
    let (in_tx, mut in_rx) = tokio::sync::mpsc::channel::<Message>(32);
    tokio::spawn(async move {
        while let Some(Ok(msg)) = rx_ws.next().await {
            if in_tx.send(msg).await.is_err() {
                break;
            }
        }
    });
    let mut subs: HashSet<String> = HashSet::new();
    let mut gw_subs: HashSet<String> = HashSet::new();
    let mut ch_subs: HashSet<String> = HashSet::new();
    let mut brx = state.out_tx.subscribe();
    state.ws_sessions.fetch_add(1, Ordering::Relaxed);

    // 매칭된 stream 패킷을 모아 stream_batch 한 프레임으로 묶어 보낸다.
    // (membership/channel_event 는 즉시 전송 — 지연이 UI 상태 전환을 늦추면 안 됨)
    let mut stream_buf: Vec<Arc<crate::state::OutEnvelope>> = Vec::new();
    let mut flush = tokio::time::interval(std::time::Duration::from_millis(STREAM_FLUSH_MS));
    flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            incoming = in_rx.recv() => {
                let Some(msg) = incoming else { break };
                let Message::Text(text) = msg else { continue };
                let Ok(cmsg) = serde_json::from_str::<ClientMsg>(text.as_str()) else { continue };
                match cmsg {
                    ClientMsg::Subscribe { group_id } => {
                        // "alarms" is a pseudo group (alarm events only): it must not make every record look wanted
                        if subs.insert(group_id.clone()) && group_id != crate::alarms::GROUP {
                            *state.sub_groups.entry(group_id.clone()).or_insert(0) += 1;
                        }
                        // 구독 즉시 현재 멤버 스냅샷 전송 → 초기 화면을 매끄럽게 구성
                        for (channel_id, patient, connected) in state.registry.members_of(&group_id) {
                            let snap = OutMsg::Membership {
                                group_ids: vec![group_id.clone()],
                                event: "snapshot".into(),
                                channel_id,
                                patient,
                                connected,
                            };
                            if let Ok(json) = serde_json::to_string(&snap) {
                                let n = json.len();
                                if tx.send(Message::Text(json.into())).await.is_err() {
                                    return;
                                }
                                state.add_tx_bytes(n);
                            }
                        }
                    }
                    ClientMsg::Unsubscribe { group_id } => {
                        if subs.remove(&group_id) {
                            dec(&state.sub_groups, &group_id);
                        }
                    }
                    // 게이트웨이 단위 구독 (Patch Map 파형 모달)
                    ClientMsg::SubscribeGateway { gateway_id } => {
                        if gw_subs.insert(gateway_id.clone()) {
                            *state.sub_gateways.entry(gateway_id).or_insert(0) += 1;
                        }
                    }
                    ClientMsg::UnsubscribeGateway { gateway_id } => {
                        if gw_subs.remove(&gateway_id) {
                            dec(&state.sub_gateways, &gateway_id);
                        }
                    }
                    // 채널 목록 단위 구독 (주치의/간호사 코호트 파형 모달)
                    ClientMsg::SubscribeChannels { channel_ids } => {
                        for c in ch_subs.drain() {
                            dec(&state.sub_channels, &c);
                        }
                        ch_subs = channel_ids.into_iter().collect();
                        for c in &ch_subs {
                            *state.sub_channels.entry(c.clone()).or_insert(0) += 1;
                        }
                    }
                    ClientMsg::UnsubscribeChannels {} => {
                        for c in ch_subs.drain() {
                            dec(&state.sub_channels, &c);
                        }
                    }
                }
            }
            envelope = brx.recv() => {
                match envelope {
                    Ok(env) => {
                        let group_hit = env.groups.iter().any(|g| subs.contains(g));
                        let gw_hit = env
                            .gateway_id
                            .as_ref()
                            .map(|g| gw_subs.contains(g))
                            .unwrap_or(false);
                        let ch_hit = env
                            .channel_id
                            .as_ref()
                            .map(|c| ch_subs.contains(c))
                            .unwrap_or(false);
                        if group_hit || gw_hit || ch_hit {
                            if env.is_stream {
                                // 스트림은 모아서 주기 플러시 (버퍼 상한 초과 시 즉시)
                                stream_buf.push(env);
                                if stream_buf.len() >= STREAM_BUF_MAX {
                                    if flush_streams(&state, &mut tx, &mut stream_buf).await.is_err() {
                                        break;
                                    }
                                }
                            } else {
                                let n = env.json.len();
                                if tx.send(Message::Text(env.json.clone().into())).await.is_err() {
                                    break;
                                }
                                state.add_tx_bytes(n);
                            }
                        }
                    }
                    // 느린 소비자: 밀린 메시지는 건너뛰고 최신부터 계속
                    Err(RecvError::Lagged(n)) => {
                        state.ws_lagged.fetch_add(n, Ordering::Relaxed);
                        debug!("ws subscriber lagged, skipped {} messages", n);
                    }
                    Err(RecvError::Closed) => break,
                }
            }
            _ = flush.tick() => {
                if flush_streams(&state, &mut tx, &mut stream_buf).await.is_err() {
                    break;
                }
            }
        }
    }
    state.ws_sessions.fetch_sub(1, Ordering::Relaxed);
    for g in subs {
        dec(&state.sub_groups, &g);
    }
    for g in gw_subs {
        dec(&state.sub_gateways, &g);
    }
    for c in ch_subs {
        dec(&state.sub_channels, &c);
    }
}

fn dec(map: &dashmap::DashMap<String, usize>, key: &str) {
    if let Some(mut n) = map.get_mut(key) {
        if *n <= 1 {
            drop(n);
            map.remove(key);
        } else {
            *n -= 1;
        }
    }
}

/// 모인 stream 패킷들을 바이너리 stream_batch 프레임 하나로 전송.
///
/// 프레임 포맷 v2 (리틀엔디언):
///   [u8 0xB2][u32 header_len][header JSON][i16 블롭]
///   header = {"type":"stream_batch","v":2,"counts":[n,...],"items":[<stream 메타>...]}
/// counts[i] = 항목 i 가 블롭에서 차지하는 i16 값 수 (= Σ waves[].n × axes). 블롭은 items 순서로 이어지며
/// 항목 안에서는 items[i].waves 순서로 블록이 놓인다 (가속도는 x,y,z 인터리브). 물리값 = raw × waves[].scale.
/// v1(0xB1) 은 ECG 단일 블록이었다 — 뷰어는 첫 바이트로 구분한다.
async fn flush_streams(
    state: &Arc<AppState>,
    tx: &mut (impl SinkExt<Message> + Unpin),
    buf: &mut Vec<Arc<crate::state::OutEnvelope>>,
) -> Result<(), ()> {
    if buf.is_empty() {
        return Ok(());
    }
    let counts: Vec<usize> = buf
        .iter()
        .map(|e| e.samples_i16.as_ref().map(|s| s.len()).unwrap_or(0))
        .collect();
    let json_total: usize = buf.iter().map(|e| e.json.len() + 1).sum();
    let mut header = String::with_capacity(json_total + counts.len() * 4 + 48);
    header.push_str("{\"type\":\"stream_batch\",\"v\":2,\"counts\":[");
    for (i, n) in counts.iter().enumerate() {
        if i > 0 {
            header.push(',');
        }
        header.push_str(&n.to_string());
    }
    header.push_str("],\"items\":[");
    for (i, env) in buf.iter().enumerate() {
        if i > 0 {
            header.push(',');
        }
        header.push_str(&env.json);
    }
    header.push_str("]}");
    let blob_len: usize = counts.iter().sum::<usize>() * 2;
    let mut frame = Vec::with_capacity(5 + header.len() + blob_len);
    frame.push(0xB2);
    frame.extend_from_slice(&(header.len() as u32).to_le_bytes());
    frame.extend_from_slice(header.as_bytes());
    for env in buf.iter() {
        if let Some(s) = &env.samples_i16 {
            for v in s {
                frame.extend_from_slice(&v.to_le_bytes());
            }
        }
    }
    buf.clear();
    let n = frame.len();
    if tx.send(Message::Binary(frame.into())).await.is_err() {
        return Err(());
    }
    state.add_tx_bytes(n);
    Ok(())
}
