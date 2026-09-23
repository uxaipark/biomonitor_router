//! DB API 링크.
//!
//! 라우터가 DB API(:7601)에 상시 연결을 유지하고, 환자 메타데이터 갱신과
//! 패치 폐기 같은 op 를 NDJSON 으로 push 한다 → DB API 가 SQLite 를
//! 실시간 갱신한다. DB API 가 없어도 라우팅에는 영향이 없다
//! (미연결 시 op 는 폐기, 3초 백오프 재접속).

use crate::state::AppState;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::mpsc::Receiver;
use tracing::{info, warn};

pub async fn run(state: Arc<AppState>, mut rx: Receiver<String>) {
    loop {
        // 미연결 상태: 쌓인 op 폐기 (DB 는 다음 meta 주기에 다시 동기화됨)
        while rx.try_recv().is_ok() {}

        let addr = state.net.db_api();
        let mut stream = match TcpStream::connect(&addr).await {
            Ok(s) => s,
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
        };
        info!("db api connected: {}", addr);

        loop {
            let Some(mut line) = rx.recv().await else { return };
            line.push('\n');
            if stream.write_all(line.as_bytes()).await.is_err() {
                warn!("db api link down: retrying in 3s");
                break;
            }
        }
    }
}
