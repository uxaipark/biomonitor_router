# biomonitor_router — 생체신호 라우터 서버 (protocol v3)

`biomonitor_simulator`(에뮬레이터, RP5 #1)가 게이트웨이별 TCP 소켓으로 보내는 **protocol v3 프레임**을 받아
검증(CRC-32·시퀀스)·재전송 요청(NACK)·패치별 저장·실시간 브로드캐스트(WS)·상태 API 를 제공하는 서버입니다.
맥에서 개발한 뒤 **1 TB SSD 를 단 RP5 #2** 에 올립니다. 로드맵은 [docs/PLAN.md](docs/PLAN.md), **설계 문서는 [docs/DESIGN.md](docs/DESIGN.md)**.

## 구성

| 디렉토리 | 기술 | 상태 |
|---|---|---|
| `router-server/` | Rust (tokio/axum) | **P1 완료** — v3 ingest, 게이트웨이 표, NACK, 패치 저장소, 상태 API, 에뮬레이터 링크 |
| `web/console/` | React (Vite) | 웹 콘솔 — 대시보드·환자·실시간 파형·뷰어 템플릿·병원 지도·게이트웨이·알람·이벤트·설정. 라우터가 `dist` 를 `/` 로 서빙(:7300) |
| `analysis-server/`, `db-api/` | Python | 레거시 목업 — 라우터가 :7100 / :7601 로 접속 시도, 유지 여부 미정 (P3) |
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
  시간 파일이 닫히면 gzip(`ROUTER_STORE_GZIP` 수준, 0 = 압축 안 함 — SD 카드 권장), `ROUTER_STORE_MAX_GB` 초과 시 가장 오래된 시간 파일부터 삭제.
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
| `ROUTER_STORE_GZIP` | `1` | 닫힌 시간 파일 gzip 수준. `0` = 압축 안 함(SD 카드: 쓰기 +50 %·정각 CPU 20 % 버스트 회피). SSD 면 1 |
| `ROUTER_DB_PATH` | `router.db` | 라우터 로컬 SQLite(그룹 정의 등 설정). 비어 있으면 `ROUTER_GROUPS_PATH`(예전 groups.json)를 1회 가져온다. 런처 기본 `data/router.db` |
| `ROUTER_EMULATOR_ADDR` | (없음) | 에뮬레이터 HTTP. 설정 시 5 s 상태 보고(`POST /api/v1/router/status`) + 30 s EMR 동기화 + `/api/emr/*` 프록시 |
| `ROUTER_WEB_DIR` | `../web/console/dist` | 웹 콘솔(vite build) 정적 디렉터리. `/` 로 서빙, 없으면 API 만 |
| `ROUTER_ANALYSIS_ADDR` / `ROUTER_DB_ADDR` | `127.0.0.1:7100` / `:7601` | 레거시 분석·DB 링크 (없으면 재시도만) |
| `ROUTER_TENANT_ID` | `H001` | 이 라우터가 데이터를 받는 병원(테넌트) ID. 처음 실행 때 `router.db` 에 기록되고 이후엔 DB 값 |
| `ROUTER_DEV_MODE` | `1` | 개발 모드 초기값(수퍼 어드민 전체 권한, 로그인 화면에 시험용 계정 표시). 이후엔 관리 › 권한 설정의 스위치 |
| `ROUTER_SERVICE_TOKEN` | (없음) | 스크립트용 Bearer 토큰. 없으면 `router.db` 옆 `service_token`(0600)을 처음 실행 때 만든다 |

### 로그인 · 권한 · 병원(테넌트) (2026-09-24)

모든 `/api/*`·`/ws` 는 로그인 세션(쿠키 `bm_session`, 12시간·사용 시 연장) 또는 `Authorization: Bearer <서비스 토큰>` 이 필요하다
(`/api/health`·`/api/auth/login`·`/api/auth/test-accounts` 제외). `scripts/router_token.py` 가 서비스 토큰을 읽어 붙인다.

* **역할**: 플랫폼 — 수퍼 어드민·시스템 관리자·리셀러·CRM 영업, 병원 — 병원 IT 매니저·의사·간호사·스태프.
* **권한 매트릭스**: 역할 × 메뉴·동작·데이터 → 없음/보기/편집. 전역 표(수퍼 어드민) 위에 병원별 간호사·스태프 덮어쓰기(의사, 자기 권한 이하).
  저장할 때마다 판이 남는다(이전 설정 불러오기), 초기값 = `auth.rs` 의 `RESOURCES` 기본 열.
* **마스킹**: `data.phi` 없으면 이름·MRN·환자번호·연락처·주소·생년월일을 **서버가** 가리고, `data.biosignal` 없으면 수치·파형(`/api/wave`, `/api/patches`, `/ws`)을 내보내지 않는다.
* **병원 격리**: 요청마다 `site.tenant_id` 접근 여부를 먼저 확인 — 다른 병원 계정은 이 라우터의 환자·파형·알람·설정에 403.
* **로그인 = 병원 ID + 아이디 + 비밀번호.** 아이디는 병원 안에서만 유일(같은 `dr.kim` 이 병원마다 따로). 플랫폼 계정은 병원 ID 를 비우면
  플랫폼(담당 전체)으로, 담당 병원 ID 를 넣으면 그 병원 하나로 들어온다(세션이 그 병원으로 좁혀짐).
* **시험용 계정**(개발 모드에서 병원마다 자동 생성, 임시 비밀번호) — 병원 H001(이 라우터)·H002·H003 각각:
  `it.admin`/`It!2026`, `dr.kim`·`dr.lee`/`Doctor!2026`, `nurse.lee`·`nurse.choi`/`Nurse!2026`, `staff.park`/`Staff!2026`.
  플랫폼: `superadmin`/`Super!2026`, `sysadmin`/`Sys!2026`, `reseller1`/`Resell!2026`(H001·H002·H003), `sales1`/`Sales!2026`(H001·H003).
  개발 모드에서 병원을 새로 만들면 그 병원의 시험용 계정도 함께 만들어진다.
* API: `POST /api/auth/login`(`{tenant, username, password}`)`|logout|password`, `GET /api/auth/me|test-accounts`, `/api/admin/users[/{id}[/reset_password]]`,
  `/api/admin/tenants[/{id}]`, `GET|PUT /api/admin/permissions`, `GET /api/admin/permissions/versions`, `PUT /api/admin/dev_mode`, `GET /api/admin/audit`.

### EMR 연동 (2026-09-24, 설정 › EMR 연동)

패치 수치(HR·호흡수·SpO₂·체온)를 병원 EMR 에 간호 바이탈로 기록한다(`src/emr_link.rs`, `src/emr_api.rs`, `src/http_client.rs`).
연결 하나 = 이 라우터 병원 × 외부 EMR 한 곳. 연결마다 작업 하나: 인증(SMART Backend JWT·signed JWT·client_credentials basic/post·
Basic·고정 Bearer·API 키·RNDS 토큰, 401 → 재발급 1회) → 재원 명단(FHIR `Group/inpatient-census` 또는 `Encounter?status=in-progress&_include=Encounter:patient`
페이지 따라가기, HL7 `hl7/census`) → 환자 매칭(`mrn` 일치 / `pair` 시험용 짝짓기) → 전송(FHIR transaction Bundle, STU3 는 `context`;
HL7 v2 ORU^R01 over MLLP — PID·PV1 은 기관 명단의 세그먼트 그대로, 버전별 MSH-9·MSH-17/18/20, 시간대 오프셋 유무, ISO-2022-JP·8859-1
인코딩, 미국 °F) → 응답(201/200·ACK AA, 5xx 3연속이면 회차 중단, 지수 백오프 4 s → 5 분).
에뮬레이터 가상 EMR 카탈로그(`/api/v1/emrsim`)에서 기관을 골라 추가한다. 20곳 전부 지원: FHIR R4/STU3 10 · HL7 v2 6 · 국내 REST JSON(`RESULT_CD`) · EUC-KR XML 전문(`IF_ID` EMR_ADT_0001/EMR_VS_0002, `RSLT_CD`) · 진료정보교류 CDA R2(활력징후 문서 등록) · athena REST(Basic 토큰, 페이지, 열린 encounter, form-encoded vitals, °F).
HTTPS 는 아직 없음(`http_client.rs` — 실제 병원은 TLS 종단 필요). JWT 서명은 시험 기관이 검증하지 않아 더미 서명 — 실제 기관용 키 관리 필요.
입퇴원(ADT) 실시간 반영: HL7 `hl7/adt?since=`(A01·A02·A03·A08·A11), 국내 JSON `adm/events?FROM_SEQ=`, XML `EMR_ADT_0002`, athena `patients/changed` 구독,
FHIR `Encounter?_lastUpdated=gt…`(5초 겹쳐 읽기) — 15초마다. 변경분 피드가 없는 Epic·Oracle(Group)·CDA 는 60초마다 명단 다시 받기. 처음엔 피드 위치만 맞추고
(그 전 변경은 전체 명단에 이미 있음), 5분마다 전체 명단으로 한 번 더 맞춘다. 짝은 끈끈하게 유지(퇴원한 쪽 짝만 풀고 빈자리만 새로 채움).
매칭 `mrn`(식별자 일치): 에뮬레이터에서 연동 병원을 고르면(`POST /api/v1/emrsim/link {site}`) admissions 행에 붙는 `emr {site, mrn, fhir_patient_id, visit}` 로 같은 사람을 찾고(`Patient.emr`), 없으면 우리 MRN = 기관 등록번호. 한 회차가 전부 실패하면 곧바로 명단을 다시 받는다.
API: `GET/POST /api/integration`, `GET /api/integration/catalog`, `GET/PUT/DELETE /api/integration/{id}`, `POST /api/integration/{id}/run {what: census|send|adt_rewind}`, `GET /api/integration/{id}/received`.

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

대시보드 · 환자 표 · 실시간 파형(병동/게이트웨이 선택, 최대 48장) · 병원 지도(에뮬레이터 도면 JSON) · 게이트웨이 · 알람(확인/이력/규칙) · 이벤트 · **뷰어**.

### 뷰어 템플릿 (`web/console/src/viewer/`)

전체 화면 뷰어는 `#/viewer?tpl=<템플릿>&<범위>` 로 새 탭에서 열린다(콘솔 '뷰어' 탭에서 고르거나 병원 지도의 게이트웨이/병실에서 바로).
범위: `gw=<gw_id>` · `ward=<병동>` · `room=<병실>` · `ids=<패치,…>`. 템플릿은 `templates.js` 레지스트리에 추가한다(대상: 의료진·운영자·환자 등).

| id | 대상 | 내용 |
|---|---|---|
| `central` | 의료진 | 에뮬레이터 모니터링 화면(Central Station)의 n-up 격자를 그대로 이식: 침상 타일(ECG·Pleth·Resp 3행 + HR/SpO₂/RR/NIBP/Temp/GLU), 적/황 알람 헤더(라우터 알람 엔진 기준), 12-up 이상 2열 수치, 48 초과 숫자 보드, 고정 프리셋 페이지, 타일 클릭 → 단일 침상 뷰어(파형 3개 + 수치 타일 6개 + 추세 + 이벤트, Night 모드) |
| `grid` | 운영자 | 콘솔 카드형 파형 그리드 전체 화면 |

디자인 토큰·CSS(`ds.css`)는 에뮬레이터 `style.css` 의 `.ds/.cs-*/.vm-*` 를 옮긴 것이라 두 화면이 같게 보인다. 파형은 `Sweep.jsx`(ECG 용지 격자, 고정 범위, 페이스 마커)가 콘솔 공용 링버퍼·플레이아웃 클록으로 그린다.
RP5 서비스 설치는 `sudo deploy/pi/install.sh` (systemd 유닛 + sysctl + `/etc/biomonitor-router.env`).

## 성능 (RP5#2, 2026-09-19)

환자 2,000 · 게이트웨이 1,772 · 초당 프레임 4.6k / 레코드 10k 기준(`scripts/cpu_baseline.sh 60`):

| 상태 | CPU(1코어 기준) | 레코드당 | PSS |
|---|---|---|---|
| 최적화 전 | 19.1 % | 19.0 µs | 250 MB |
| 최적화 후, 구독자 없음 | 7.9 % | 7.9 µs | 106 MB |
| 콘솔 WS 구독(48채널+알람) | 11.6 % | 11.5 µs | 107 MB |

핵심 원칙: **아무도 듣지 않는 일은 하지 않는다** — 스트림 패킷은 구독된 패치에만 만들고, 변하지 않은 META 는 파싱하지 않으며, 알람 평가는 행을 복제하지 않는다. 파일 I/O 는 전용 스레드(SD 지연이 ingest 큐에 닿지 않음). 자원 추적은 `scripts/leakwatch.py`, 내부 구조 크기는 `GET /api/debug/sizes`.

## 다음 단계

P2 WS 다채널 출력 + 뷰어 → P3 DB/어드민(도면 JSON 폴리곤) → P4 RP5 #2 배포(1 TB SSD, systemd) → P5 보존·인증. 세부는 [docs/PLAN.md](docs/PLAN.md).
