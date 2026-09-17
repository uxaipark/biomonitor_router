# biomonitor_router — 생체신호 라우터 서버 (protocol v3)

`biomonitor_simulator`(에뮬레이터, RP5 #1)가 게이트웨이별 TCP 소켓으로 보내는 **protocol v3 프레임**을 받아
검증(CRC-32·시퀀스)·재전송 요청(NACK)·패치별 저장·실시간 브로드캐스트(WS)·상태 API 를 제공하는 서버입니다.
맥에서 개발한 뒤 **1 TB SSD 를 단 RP5 #2** 에 올립니다. 로드맵은 [docs/PLAN.md](docs/PLAN.md), **설계 문서는 [docs/DESIGN.md](docs/DESIGN.md)**.

## 구성

| 디렉토리 | 기술 | 상태 |
|---|---|---|
| `router-server/` | Rust (tokio/axum) | **P1 완료** — v3 ingest, 게이트웨이 표, NACK, 패치 저장소, 상태 API, 에뮬레이터 링크 |
| `web/admin`, `web/viewer` | React (Vite) | 레거시 화면 — P2/P3 에서 다채널·도면 JSON 으로 재작성 |
| `analysis-server/`, `db-api/` | Python | 레거시 목업 — 유지 여부 미정 (P3) |
| `docs/contract/` | JSON | 에뮬레이터 계약 fixture (discovery / layout / trips) |
| `docs/legacy/` | | 2026-08 스택 문서(ARCHITECTURE·API·FRONTEND)·구 에뮬레이터 소스 |

## router-server 동작 (P1)

```
게이트웨이 소켓 ─▶ wire::Decoder (26 B 헤더 + payload + CRC-32) ─▶ ingest
      ▲                                                        │
      └── NACK <B kind><I from><I to> (F_CTRL) ◀── gateways ◀──┤ 시퀀스 검사: gap → NACK, 재전송 도착 → recovered
                                                               ├─▶ patch_store (스레드): patches/<id>/<UTC 시간>.rec, 항목 CRC, gzip, 상한 정리
                                                               ├─▶ registry (패치 = 채널): META patches[] + 레코드 헤더 + EMR 동기화(이름·병동·의료진)
                                                               └─▶ ECG 채널 → 분석 링크 / WS stream_batch (레거시 파이프라인, P2 에서 다채널화)
```

* **저장 형식** — `[ts_ms u64][gw_id u32][patient_id u32][seq u32][flags][battery][rssi][n_ch]` + 채널 블록 + `[crc32]`.
  에뮬레이터 저장소의 파이썬 초안 `router/store.py` 와 바이트 호환(`verify_file()` 로 교차 검증됨).
  시간 파일이 닫히면 gzip(레벨 3), `ROUTER_STORE_MAX_GB` 초과 시 가장 오래된 시간 파일부터 삭제.
* **NACK 정책** — 게이트웨이당 0.5 s 에 1회, 같은 seq 최대 3회, 한 번에 200 프레임, 10 s 미응답 → `resend_lost`.
  CRC 불일치 프레임은 헤더 seq 로 재요청. 복구 프레임의 패치 seq 는 이상으로 세지 않음.
* **연속 레코드** — 에뮬레이터는 페이스마크(ch 10)를 같은 패치·같은 seq 의 두 번째 레코드로 보냄.
  라우터는 이를 `continuation_records` 로 세고 중복으로 취급하지 않음(저장은 그대로).
* **게이트웨이 표** — 소켓·최근 프레임·GW_STATUS·META 위치·패치 수·NACK/복구/이상 카운터, 10 s 침묵 감지, 중복 gw_id 감지.

### 실행

```bash
cd router-server
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk CC=/Library/Developer/CommandLineTools/usr/bin/cc cargo build --release
ROUTER_EMULATOR_ADDR=192.168.0.125:5445 ROUTER_STORE_DIR=/data/store ROUTER_STORE_MAX_GB=800 ./target/release/router-server
```

| 환경변수 | 기본 | 의미 |
|---|---|---|
| `ROUTER_INGEST_ADDR` | `0.0.0.0:9100` | 게이트웨이 TCP 수신 (에뮬레이터 `transport.target_port`) |
| `ROUTER_HTTP_ADDR` | `0.0.0.0:7300` | REST + WS |
| `ROUTER_STORE_DIR` / `ROUTER_STORE_MAX_GB` | `data/store` / `200` | 패치 저장소 루트 / 상한 (0 = 무제한) |
| `ROUTER_EMULATOR_ADDR` | (없음) | 에뮬레이터 HTTP. 설정 시 5 s 상태 보고(`POST /api/v1/router/status`) + 30 s EMR 동기화 + `/api/emr/*` 프록시 |
| `ROUTER_WEB_DIR` | `../web/console/dist` | 웹 콘솔(vite build) 정적 디렉터리. `/` 로 서빙, 없으면 API 만 |
| `ROUTER_ANALYSIS_ADDR` / `ROUTER_DB_ADDR` | `127.0.0.1:7100` / `:7601` | 레거시 분석·DB 링크 (없으면 재시도만) |

### API (P1 추가분)

| 경로 | 내용 |
|---|---|
| `GET /api/stats` | 수신 바이트·레코드·유실, 프로세스/시스템 자원, `gateways` 요약(프레임·NACK·복구·이상 카운터) |
| `GET /api/gateways` · `/api/gateways/summary` | 게이트웨이 표 / 요약 |
| `GET /api/channels` | 패치(채널) 표: 게이트웨이·공간·환자·MRN·배터리·RSSI·플래그 |
| `GET /api/patches/{id}` · `/api/patches/{id}/verify` | 저장 인덱스·파일 목록 / 전체 CRC 검증 |
| `GET /api/wave/{id}?mode=raw|overview&from_ms&to_ms` | 저장 ECG 읽기 (레거시 리포트 뷰어 호환) |
| `POST /api/wave/reset` | 저장소 전체 삭제 |
| `GET /api/events` | link / silent / bad_crc / nack / alarm 이벤트 링 |
| `GET /api/alarms` · `/api/alarms/history` · `POST /api/alarms/{id}/ack` · `GET/PUT /api/alarms/rules` | 알람 엔진 (P2 추가): 활성/이력/확인/규칙 |
| `GET /api/emr/{path}` · `/api/emu/status` · `/api/emu/discovery` | 에뮬레이터 EMR/상태 프록시 (TTL 캐시) |
| `WS /ws` | `subscribe`/`subscribe_channels`/`subscribe_gateway` + 의사 그룹 `alarms`. 스트림은 바이너리 `stream_batch` v2 (0xB2): items[].waves 레이아웃 + i16 블롭 |

### 검증

* `cargo test` — 프레이밍·CRC 재동기화·제어 프레임·저장 항목 CRC·시간 파일 회전 (6).
* 파이썬 가짜 게이트웨이 e2e(에뮬레이터 `protocol.py` 프레이밍): 갭 → NACK 6..8 → 복구 3, CRC 손상 → NACK, 중복 gw 소켓, 저장 파일 파이썬 교차 검증, API 뷰 — 19/19.
* 로컬 에뮬레이터 2000 환자(2390 GW 중 2190 소켓, 초당 약 10k 레코드) 부하: 드롭 0, 라우터 CPU ≈ 11 %, RSS ≈ 130 MB,
  `network_event` 드릴 → NACK 6 / 복구 6 / 유실 0, `gateway_fault` → 10 s 후 silent 이벤트, 라우터 재시작 후 35 s 내 전 게이트웨이 재접속·저장 이어짐.

## 다른 장비(RP5#2)에서 이어 개발하기

```bash
git clone https://github.com/uxaipark/biomonitor_router.git ~/biomonitor_router
cd ~/biomonitor_router && scripts/pi-dev-setup.sh      # apt → rustup(stable) → Node 20 → cargo build --release → cargo test
```

절차와 문제 해결은 [docs/RP5-DEV.md](docs/RP5-DEV.md), 에이전트 간 인수인계는 [docs/HANDOFF.md](docs/HANDOFF.md)·[CLAUDE.md](CLAUDE.md).
빌드 산출물(`target/`)·데이터(`data/`)·`node_modules/`는 커밋하지 않으므로 클론 후 빌드가 필요하다.
Rust 는 `router-server/rust-toolchain.toml`(stable) 로 고정되고, Linux 자원 지표는 `/proc` 로 수집된다.

## 웹 콘솔 (`web/console`)

```bash
cd web/console && npm install && npm run build     # → dist/, 라우터가 / 로 서빙
npm run dev                                         # 개발 서버 5175 (API/WS 는 7300 으로 프록시)
npm run smoke                                       # react-dom/server 로 전 페이지 렌더 스모크
```

대시보드 · 환자 표 · 실시간 파형(병동/게이트웨이 선택, 최대 48장) · 병원 지도(에뮬레이터 도면 JSON) · 게이트웨이 · 알람(확인/이력/규칙) · 이벤트.
RP5 서비스 설치는 `sudo deploy/pi/install.sh` (systemd 유닛 + sysctl + `/etc/biomonitor-router.env`).

## 다음 단계

P2 WS 다채널 출력 + 뷰어 → P3 DB/어드민(도면 JSON 폴리곤) → P4 RP5 #2 배포(1 TB SSD, systemd) → P5 보존·인증. 세부는 [docs/PLAN.md](docs/PLAN.md).
