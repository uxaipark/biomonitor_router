use router_core::{admin_api, analysis_link, config::Config, db_link, ingest, state::AppState};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let cfg = Config::from_env();
    info!("starting router server: {:?}", cfg);

    let (state, analysis_rx, db_rx, wave_rx, wave_reset_rx) = AppState::new(cfg.clone());

    // 파형 파일 저장 (채널별 8시간 세그먼트 — 채워지면 다음 파일, 삭제 없음.
    // 단, 어드민 테스트 > 저장소 리셋 신호가 오면 전체 삭제)
    tokio::spawn(router_core::wave_store::run_writer(
        cfg.wave_dir.clone(),
        cfg.wave_segment_hours,
        cfg.wave_max_gb,
        wave_rx,
        wave_reset_rx,
    ));

    // 입력(ingest) 리스너
    tokio::spawn(ingest::run(state.clone()));

    // 분석 서버 링크 (재접속 루프 포함)
    tokio::spawn(analysis_link::run(state.clone(), analysis_rx));

    // 분석 지연 플러셔: 응답이 늦는 패킷을 무분석으로 방출해 파형 연속성 보장
    tokio::spawn(router_core::state::run_flusher(state.clone()));

    // CPU 사용률 샘플러 (어드민 시스템 모니터링)
    tokio::spawn(router_core::sysmon::run_cpu_sampler());

    // DB API 링크: 환자 메타/패치 재고를 SQLite 로 실시간 push
    tokio::spawn(db_link::run(state.clone(), db_rx));

    // 출력 WS + 어드민 REST
    let app = admin_api::router(state.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.http_addr).await?;
    info!("http/ws listening on {}", cfg.http_addr);
    axum::serve(listener, app).await?;
    Ok(())
}
