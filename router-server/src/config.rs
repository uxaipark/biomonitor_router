use std::env;

/// 라우터 설정. 환경변수로 오버라이드 가능.
#[derive(Clone, Debug)]
pub struct Config {
    /// 에뮬레이터(입력 채널)가 접속하는 TCP 주소
    pub ingest_addr: String,
    /// 분석 서버 주소 (라우터가 클라이언트로 접속)
    pub analysis_addr: String,
    /// DB API 주소 (NDJSON push — SQLite 실시간 갱신)
    pub db_addr: String,
    /// 출력 WS + 어드민 REST API 주소
    pub http_addr: String,
    /// 그룹 설정 영속화 파일
    pub groups_path: String,
    /// 디스플레이(센트럴 모니터) → 그룹 매핑 영속화 파일
    pub displays_path: String,
    /// 채널별 분석 대기 서큘러 버퍼 크기(패킷 수)
    pub ring_capacity: usize,
    /// 파형 저장 디렉토리 (채널별 8시간 세그먼트 바이너리 파일)
    pub wave_dir: String,
    /// 파형 세그먼트 단위 (시간). 채워지면 다음 파일 생성 — 삭제 없음
    pub wave_segment_hours: u64,
    /// 파형 저장소 용량 상한 (GB). 초과 시 오래된 압축 파일부터 삭제
    pub wave_max_gb: u64,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |k: &str, d: &str| env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            ingest_addr: get("ROUTER_INGEST_ADDR", "0.0.0.0:7000"),
            analysis_addr: get("ROUTER_ANALYSIS_ADDR", "127.0.0.1:7100"),
            db_addr: get("ROUTER_DB_ADDR", "127.0.0.1:7601"),
            http_addr: get("ROUTER_HTTP_ADDR", "0.0.0.0:7300"),
            groups_path: get("ROUTER_GROUPS_PATH", "groups.json"),
            displays_path: get("ROUTER_DISPLAYS_PATH", "displays.json"),
            ring_capacity: get("ROUTER_RING_CAPACITY", "512").parse().unwrap_or(512),
            wave_dir: get("ROUTER_WAVE_DIR", "waves"),
            wave_segment_hours: get("ROUTER_WAVE_SEGMENT_H", "8").parse().unwrap_or(8),
            wave_max_gb: get("ROUTER_WAVE_MAX_GB", "200").parse().unwrap_or(200),
        }
    }
}
