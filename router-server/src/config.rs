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
    /// 라우터 로컬 DB (SQLite): 그룹 정의 등 설정 영속화
    pub db_path: String,
    /// 예전 그룹 설정 JSON — DB 가 비어 있을 때 1회 가져오기 원본
    pub groups_path: String,
    /// 디스플레이(센트럴 모니터) → 그룹 매핑 영속화 파일
    pub displays_path: String,
    /// 채널별 분석 대기 서큘러 버퍼 크기(패킷 수)
    pub ring_capacity: usize,
    /// 패치별 레코드 저장 루트 (patches/<id>/<hour>.rec[.gz], meta/gw_<id>.json)
    pub store_dir: String,
    /// 저장소 용량 상한 (GB). 초과 시 오래된 시간 파일부터 삭제 (0 = 무제한)
    pub store_max_gb: u64,
    /// 닫힌 시간 파일 gzip 수준 (0 = 압축 안 함). SD 카드에서는 압축이 읽기 2 MB + 쓰기 1 MB 를 더 일으키고
    /// 정각마다 CPU 한 코어의 20 % 를 수십 분 쓰므로 0 을 권장; SSD 면 1.
    pub store_gzip: u32,
    /// 에뮬레이터 HTTP 주소 (host:port). 상태 보고 + EMR 동기화. None = 비활성
    pub emulator_addr: Option<String>,
    /// 상태 보고 주기 (초)
    pub report_every_s: u64,
    /// EMR(입원/환자) 동기화 주기 (초)
    pub emr_sync_s: u64,
    /// 웹 콘솔 정적 파일 디렉터리 (vite build 산출물). 없으면 API 만 서빙
    pub web_dir: String,
}

impl Config {
    pub fn from_env() -> Self {
        let get = |k: &str, d: &str| env::var(k).unwrap_or_else(|_| d.to_string());
        Self {
            ingest_addr: get("ROUTER_INGEST_ADDR", "0.0.0.0:9100"),
            analysis_addr: get("ROUTER_ANALYSIS_ADDR", "127.0.0.1:7100"),
            db_addr: get("ROUTER_DB_ADDR", "127.0.0.1:7601"),
            http_addr: get("ROUTER_HTTP_ADDR", "0.0.0.0:7300"),
            db_path: get("ROUTER_DB_PATH", "router.db"),
            groups_path: get("ROUTER_GROUPS_PATH", "groups.json"),
            displays_path: get("ROUTER_DISPLAYS_PATH", "displays.json"),
            ring_capacity: get("ROUTER_RING_CAPACITY", "512").parse().unwrap_or(512),
            store_dir: get("ROUTER_STORE_DIR", "data/store"),
            store_max_gb: get("ROUTER_STORE_MAX_GB", "200").parse().unwrap_or(200),
            store_gzip: get("ROUTER_STORE_GZIP", "1").parse().unwrap_or(1),
            emulator_addr: env::var("ROUTER_EMULATOR_ADDR").ok().filter(|s| !s.is_empty()),
            report_every_s: get("ROUTER_REPORT_EVERY_S", "5").parse().unwrap_or(5),
            emr_sync_s: get("ROUTER_EMR_SYNC_S", "30").parse().unwrap_or(30),
            web_dir: get("ROUTER_WEB_DIR", "../web/console/dist"),
        }
    }
}
