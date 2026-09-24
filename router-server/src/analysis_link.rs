use crate::protocol::AnalysisMsg;
use crate::state::AppState;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc::Receiver;
use tracing::{info, warn};

/// 분석 서버 링크.
/// - 라우터가 클라이언트로 접속하며 전 채널을 단일 연결로 멀티플렉싱한다.
/// - 끊기면 패스스루 모드로 전환하고 2초 백오프로 재접속한다.
/// - 분석 응답의 (channel_id, seq) 로 서큘러 버퍼의 원본 파형을 찾아 병합 출력한다.
pub async fn run(state: Arc<AppState>, mut rx: Receiver<String>) {
    // Retry stays at 2 s (reconnect quickly), but the log only gets the first failure and then one line every
    // 5 minutes — without an analysis server a WARN every 2 s grew router.log by ~8 MB a day.
    let mut fails: u64 = 0;
    loop {
        // 미연결 상태: 큐에 쌓인 스테일 패킷 폐기 (연결되면 새 데이터부터 전송)
        while rx.try_recv().is_ok() {}

        let addr = state.net.analysis();
        let stream = match TcpStream::connect(&addr).await {
            Ok(s) => s,
            Err(e) => {
                if fails % 150 == 0 {
                    warn!("analysis server connect failed ({}): retrying every 2s (attempt {}, pass-through meanwhile)", e, fails + 1);
                }
                fails += 1;
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };
        info!("analysis server connected: {} (after {} failed attempts)", addr, fails);
        fails = 0;
        state.registry.clear_all_pending();
        state.set_analysis_up(true);
        state.push_event("analysis_up", None, "분석 서버 연결됨 — 병합 모드".into());

        let (read_half, mut write_half) = stream.into_split();
        let mut lines = BufReader::new(read_half).lines();

        loop {
            tokio::select! {
                // ingest → 분석 서버 forward
                maybe_line = rx.recv() => {
                    let Some(mut line) = maybe_line else { return };
                    line.push('\n');
                    if write_half.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    state.add_tx_bytes(line.len());
                }
                // 분석 서버 → 병합 출력
                result = lines.next_line() => {
                    match result {
                        Ok(Some(line)) => handle_analysis_line(&state, &line),
                        _ => break,
                    }
                }
            }
        }

        state.set_analysis_up(false);
        state.registry.clear_all_pending();
        state.push_event(
            "analysis_down",
            None,
            "분석 서버 연결 끊김 (엔진 크래시/네트워크) — 패스스루 모드 전환".into(),
        );
        warn!("analysis link down: switching to passthrough mode");
    }
}

fn handle_analysis_line(state: &Arc<AppState>, line: &str) {
    if line.trim().is_empty() {
        return;
    }
    // type 태그 확인 후 파싱 (분석 서버 확장 메시지 무시 가능하도록)
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            warn!("analysis parse error: {}", e);
            return;
        }
    };
    if value.get("type").and_then(|t| t.as_str()) != Some("analysis") {
        return;
    }
    let msg: AnalysisMsg = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(e) => {
            warn!("analysis msg decode error: {}", e);
            return;
        }
    };

    match msg.seq {
        Some(seq) => {
            // 핵심 싱크 지점: 분석 결과 seq 와 동일한 원본 파형 패킷을 병합
            if let Some(pkt) = state.registry.take_matching(&msg.channel_id, seq) {
                state.emit_stream(pkt, msg.hr, msg.events);
            } else if !msg.events.is_empty() {
                // 원본 패킷이 버퍼에서 밀려났어도 이벤트는 유실시키지 않는다
                state.emit_channel_event(&msg.channel_id, msg.events);
            }
        }
        None => {
            // 데이터 없는 상태 이벤트 (무패킷 채널의 연결해제 등)
            if !msg.events.is_empty() {
                state.emit_channel_event(&msg.channel_id, msg.events);
            }
        }
    }
}
