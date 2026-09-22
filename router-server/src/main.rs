use router_core::{admin_api, analysis_link, config::Config, db_link, ingest, state::AppState};
use tracing::info;

// glibc malloc fragments under ~10k short-lived allocations/s across the tokio workers (PSS grew ~100 MB/h);
// mimalloc keeps the heap compact.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;
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

    let (state, analysis_rx, db_rx, store_rx) = AppState::new(cfg.clone());

    // 패치별 레코드 저장 (시간 단위 파일 + 항목 CRC, 닫힌 파일 gzip, 상한 초과 시 오래된 것부터 삭제)
    // — 전용 OS 스레드 (블로킹 파일 I/O 를 tokio 워커에서 분리)
    {
        let root = std::path::PathBuf::from(&cfg.store_dir);
        let cap = cfg.store_max_gb << 30;
        let gz = cfg.store_gzip;
        std::thread::Builder::new()
            .name("patch-store".into())
            .spawn(move || router_core::patch_store::run_writer(root, cap, gz, store_rx))
            .expect("store thread");
    }

    // 게이트웨이 표 하우스키핑: NACK 만료·침묵 감지 (1 Hz)
    {
        let st = state.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(std::time::Duration::from_secs(1));
            let mut n: u64 = 0;
            loop {
                t.tick().await;
                for gw in st.gateways.housekeeping() {
                    st.push_event("silent", None, format!("gw {} silent: socket up, no frames for 10 s", gw));
                }
                // 옛 패치 행 정리: 15분 넘게 끊긴 채널 (에뮬레이터 재구축·패치 교체 뒤 남는 번호)
                n += 1;
                if n % 60 == 0 {
                    let dead = st.registry.prune_disconnected(15 * 60 * 1000);
                    if !dead.is_empty() {
                        for id in &dead {
                            st.remove_channel(id);
                        }
                        st.push_event("registry_prune", None, format!("15분 넘게 레코드 없는 패치 {}개 정리 (퇴원·교체)", dead.len()));
                    }
                }
            }
        });
    }

    // 에뮬레이터 링크: 상태 보고 + EMR 동기화 (ROUTER_EMULATOR_ADDR 설정 시)
    tokio::spawn(router_core::emu_link::run_reporter(state.clone(), cfg.report_every_s));
    tokio::spawn(router_core::emu_link::run_emr_sync(state.clone(), cfg.emr_sync_s));

    // 입력(ingest) 리스너
    tokio::spawn(ingest::run(state.clone()));

    // 분석 서버 링크 (재접속 루프 포함)
    tokio::spawn(analysis_link::run(state.clone(), analysis_rx));

    // 분석 지연 플러셔: 응답이 늦는 패킷을 무분석으로 방출해 파형 연속성 보장
    tokio::spawn(router_core::state::run_flusher(state.clone()));

    // 알람 엔진 (1 Hz): 수치 임계·전극 탈락·배터리·패치/게이트웨이 무응답
    tokio::spawn(router_core::alarms::run(state.clone()));

    // CPU 사용률 샘플러 (어드민 시스템 모니터링)
    tokio::spawn(router_core::sysmon::run_cpu_sampler());

    // 장기 운영 통계: 2 s 샘플 → 분 단위 행 → 시간 롤업 (자체 스레드, SQLite 쓰기)
    router_core::metrics::spawn(state.clone());

    // 파형 백업: 닫힌 시간 파일 → NAS/SMB/FTP/SFTP, 검증된 파일만 저장소가 삭제
    router_core::backup::start(state.clone());

    // DB API 링크: 환자 메타/패치 재고를 SQLite 로 실시간 push
    tokio::spawn(db_link::run(state.clone(), db_rx));

    // 출력 WS + 어드민 REST
    let app = admin_api::router(state.clone());
    let listener = tokio::net::TcpListener::bind(&cfg.http_addr).await?;
    info!("http/ws listening on {}", cfg.http_addr);
    // Graceful shutdown: a 24/7 service is restarted for upgrades, and killing it outright threw away the
    // store batcher's buffer (up to 5 s of records for every patch) and left index.json stale. On SIGTERM /
    // Ctrl-C we stop accepting, flush the store and wait for the file writer before exiting.
    let store_tx = state.store_tx.clone();
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            shutdown_signal().await;
            info!("shutdown: flushing patch store");
            let t0 = std::time::Instant::now();
            let _ = store_tx.send(router_core::patch_store::StoreOp::Flush).await;
            // the batcher answers only once the writer has the data on disk; bound the wait anyway
            for _ in 0..200 {
                if store_tx.capacity() == store_tx.max_capacity() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            info!("shutdown: store flushed in {} ms", t0.elapsed().as_millis());
        })
        .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
