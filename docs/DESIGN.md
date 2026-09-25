# 생체신호 라우터 서버 설계 (protocol v3)

작성 2026-09-17. 대상 코드: `router-server/` (Rust). 계약 원본은 에뮬레이터 저장소 `emulator/runtime/protocol.py`,
스냅샷은 `docs/contract/`. 로드맵은 [PLAN.md](PLAN.md), 다른 장비에서 이어 개발하는 절차는 [RP5-DEV.md](RP5-DEV.md).
2026-08 스택의 설계는 [legacy/ARCHITECTURE.md](legacy/ARCHITECTURE.md)에 남겨 두었고, 이 문서는 v3 라우터가 그것과 어디가 다른지도 적는다.

## 1. 목표와 제약

| 항목 | 값 |
|---|---|
| 입력 | 병원 1곳, 게이트웨이 최대 2,390대(그중 상시 연결 약 2,190), 패치 최대 2,513개, 게이트웨이당 TCP 소켓 1개, 200 ms 번들 |
| 채널 | 패치당 최대 10채널 (ECG 250 Hz, PPG 100 Hz, 호흡 파형 25 Hz, 가속도 3축 50 Hz, HR/체온/호흡수/SpO2/혈당 1 Hz, 페이스마크) |
| 처리량 | 초당 프레임 약 11k, 레코드 약 10~13k, 수신 약 3~4 MB/s |
| 신뢰성 | 프레임 CRC-32, 게이트웨이/패치 두 단계 순번, 유실 구간 재전송 요청(NACK), 저장 항목 CRC |
| 저장 | 전 채널 원본을 패치별로 보관, 용량 상한 안에서 오래된 것부터 삭제 (RP5#2 1 TB SSD) |
| 배포 | 맥에서 개발·검증 → RP5#2 (Debian 12 aarch64) systemd 서비스. 단일 바이너리, 외부 DB 없이 기동 |
| 비목표 | 진단 알고리즘(분석 서버는 목업/교체 가능), 다병원, 인증·TLS (P5) |

## 2. 전체 구성

```
 RP5#1 에뮬레이터 (dlake:5445)                         RP5#2 / Mac  router-server
 ┌──────────────────────┐   TCP 9100 (게이트웨이당 1)  ┌──────────────────────────────────────────────┐
 │ 게이트웨이 2,390 ×    │ ───────────────────────────▶ │ ingest ── wire::Decoder ── gateways(표·NACK) │
 │  200 ms 프레임        │ ◀─── NACK (F_CTRL, 같은 소켓) │    │                                           │
 │ HTTP /api/v1/*        │                              │    ├─▶ patch_store (스레드, 시간 파일, CRC, gzip) │
 └──────────────────────┘                              │    ├─▶ registry (패치=채널, META+레코드 헤더)     │
        ▲      ▲                                        │    └─▶ state.emit_stream ─▶ output WS (뷰어)     │
        │      └── GET /emr/admissions (30 s)           │              └──▶ analysis_link (선택, NDJSON)  │
        └───────── POST /router/status (5 s)            │ admin_api (REST) · emu_link (HTTP 클라이언트)   │
                                                        └──────────────────────────────────────────────┘
```

역할 분담 원칙은 레거시와 같다. 정적 정보(환자·병실·도면)는 에뮬레이터 EMR API가 원본이고 라우터는 캐시만 갖는다.
동적 데이터(프레임)는 라우터가 받아 저장·중계한다. 고속 시계열은 DB가 아니라 파일에 둔다.

## 3. 와이어 프로토콜 (수신 측 해석)

`wire.rs`. 리틀엔디언. 에뮬레이터 `describe()`와 바이트 단위로 같아야 하며 바꿀 때는 두 저장소를 같이 올린다.

```
프레임   = 헤더 26 B  <HBBIIQHI>  magic 0x4742 · version 3 · flags · gw_id · seq · ts_ms · n_rec · payload_len
         + 페이로드   [GW_STATUS 11 B <BBBbBBIB>] [META u32 len + JSON] [레코드 × n_rec]
         + CRC-32 4 B (zlib, 헤더+페이로드)
레코드   = 헤더 16 B  <IIIBBbB>  patch_id · patient_id · seq · flags · battery · rssi · n_ch
         + 채널 블록 × n_ch  <BBH> ch · dtype · n  + data (n × axes × itemsize; ch 7 은 axes 3)
제어     = flags F_CTRL(0x08), n_rec 0, 페이로드 <BII> kind · seq_from · seq_to   (kind 1 = NACK)
```

* **디코더**는 소켓 바이트를 누적해 완전한 프레임만 꺼낸다. magic/version/길이 이상은 1바이트씩 밀며 다음 magic을 찾고(`resync`, `garbage_bytes`),
  CRC 불일치는 `BadCrc(header)`로 올려 헤더의 seq로 NACK 할 수 있게 한다(헤더 자체가 깨졌으면 magic 검색으로 넘어간다).
* 레코드 바이트는 `raw` 슬라이스로 그대로 보존해 저장소에 복사 없이 넘긴다.
* 플래그 의미: 레코드 `LEAD_OFF 0x01, MOTION 0x02, LOW_BATTERY 0x04, SPO2_OFF 0x08, PACEMAKER 0x10, CHARGING 0x20, NEW_PATCH 0x40`.

## 4. 시퀀스 검사와 재전송 요청

두 개의 카운터를 따로 본다. **게이트웨이 seq**(프레임)의 갭은 게이트웨이↔라우터 구간 유실, **패치 seq**(레코드)의 갭은 패치↔라우터 어디서든 생긴 유실이다.

게이트웨이 seq 판정(`gateways.rs`):

| 조건 (`d = seq − last`, u32 wrapping) | 판정 | 동작 |
|---|---|---|
| 이 seq가 대기 중인 NACK 항목 | `Recovered` | 대기 목록에서 제거, `recovered` +1, 레코드는 정상 처리 (패치 seq 검사는 건너뜀) |
| d = 1 | `Ok` | last 갱신 |
| d = 0 | `Dup` | 프레임 통째로 무시 (이미 저장·중계됨) |
| 1 < d < 2³¹ | `Gap(d−1)` | last 갱신, `last+1 .. seq−1` NACK. 200 초과면 최근 200개만 |
| 뒤로 1024 초과 (에뮬레이터·게이트웨이 재시작) | `Ok` + `seq_restart` | 기준 seq 재설정, 대기 NACK 비움 (패치 seq 도 같은 규칙, `patch_seq_restart`) |
| 그 외 (뒤로 감) | `Reorder` | 카운트만, 레코드는 정상 처리 |

NACK 정책: 게이트웨이당 0.5 s에 1회, 같은 seq 최대 3회, 한 요청 최대 200 프레임(에뮬레이터 keep 버퍼 10 s = 50 프레임보다 넉넉), 10 s 안에 안 오면 `resend_lost`.
제어 프레임은 그 게이트웨이의 소켓 쓰기 태스크(`mpsc` 64)로 보낸다. 소켓이 닫히면 대기 목록을 비운다.

패치 seq 판정(`registry.rs`): 같은 규칙으로 `Ok/Gap/Dup/Reorder`. 단 **ECG가 없는 같은 seq 레코드**는 연속 레코드(에뮬레이터가 페이스마크를 따로 보냄)로 보고 `continuation_records`에 센다. `Dup/Reorder`는 저장은 하되 실시간 중계는 건너뛴다.

관측값(2000 환자, 루프백): `network_event` 드릴에서 seq_gap 6 → nack 6 → recovered 6, resend_lost 0.

## 5. 게이트웨이 표

`GatewayTable`은 `DashMap<u32, GwEntry>`. 프레임마다 소켓 소유권을 확인해 **같은 gw_id가 다른 소켓에서 오면** `dup_conn`으로 세고 최신 소켓을 따른다(교체 장비가 옛 번호를 달고 온 경우, 드릴 `dup_id`).
행에는 마지막 seq/ts, 프레임·레코드·keepalive 수, GW_STATUS(cpu/mem/net/wan_rssi/n_conn/status/uptime/temp), META 요약(이름·유형·건물/층/실/좌표·패치 목록·`v`), NACK/복구/유실·이상 카운터가 있다.
1 Hz 하우스키핑이 NACK 만료와 **침묵**(소켓은 살아 있는데 10 s 무프레임 → `silent` 이벤트; `gateway_fault` 드릴이 이 경로)을 처리한다.

## 6. 레지스트리 (패치 = 채널)

레거시의 "채널"을 패치 번호 문자열로 그대로 쓴다. 그룹핑·WS 구독·분석 링크가 채널 ID 기반이라 바꾸지 않았다.
행 갱신 원천은 세 가지다.

1. **META patches[]** (게이트웨이당 5 s마다, `v`가 바뀔 때만 처리): patient_id, profile_id, mrn, 채널 구성(ECG fs), 게이트웨이·건물·층·실.
2. **레코드 헤더**: patient_id, flags, battery, rssi.
3. **EMR 동기화** (`emu_link`, 30 s): `/api/v1/emr/admissions`로 이름·병동·주치의·간호사·진료과. 이름이 오기 전에는 MRN을 이름 자리에 둔다.

행이 바뀌면 그룹 멤버십을 재계산해 join/leave를 구독자에게 보낸다. 소켓이 닫히면 그 게이트웨이의 패치들을 `connected=false`로 두고 `ingest_disconnected` 이벤트를 낸다.

## 7. 패치 저장소

`patch_store.rs`, 전용 OS 스레드(블로킹 I/O를 tokio 워커에서 분리). 큐 상한 65,536, 넘치면 드롭 카운트(`queue_dropped_store`).

```
<root>/patches/<patch_id 8자리>/<YYYYMMDD-HH>_<N>h.rec  UTC N시간 블록(저장 단위, 기본 2, HH = 블록 시작), 추가 전용
                                                        (2026-09-24 이전: 1시간 `<YYYYMMDD-HH>.rec` — 둘 다 읽음)
<root>/patches/<patch_id>/<key>.sum                     봉인: 닫힌 파일의 CRC-32·SHA-256·항목 수·CRC 오류 항목 수 (JSON)
<root>/patches/<patch_id>/index.json                    first/last ts, records, bytes, lost, last_seq, patient, gw, files
<root>/meta/gw_<gw_id>.json                             마지막 META (v 가 바뀔 때만 씀)
항목 = [ts_ms u64][gw_id u32][patient_id u32][seq u32][flags][battery][rssi][n_ch] + 채널 블록 + [crc32 u32]
```

* 항목은 수신 레코드의 `patch_id` 뒤 바이트를 그대로 붙이고 CRC를 단다. 에뮬레이터 저장소의 파이썬 `router/store.py`와 바이트 호환이라 `verify_file()`로 교차 검증했다.
* 쓰기는 패치별 버퍼에 모아 1 s마다 한 번 (초당 파일 쓰기 ≈ 패치 수, 프레임 수가 아님). 열린 핸들은 256개 LRU, 5분 유휴 시 닫음.
* 블록이 바뀌면 파일을 닫고 봉인 스레드에 넘긴다: 모든 항목 CRC 확인 → (gzip 설정 시 `.rec.gz`) → 파일 전체 CRC-32·SHA-256 → `<key>.sum`.
  봉인된 파일에 다시 쓰게 되면(같은 블록에 패치 복귀) 봉인을 지우고 닫힐 때 다시 봉인한다. 백업은 봉인이 있는 파일만, 봉인 SHA-256 으로
  원격을 검증하고 `.sum` 도 함께 올린다. 로컬에서 지운 과거 구간은 히스토리가 열 때 백업에서 받아 `<root>/.restore-cache/` 에 둔다(업로드 SHA-256 또는 원격 `.sum` 으로 검증, 최대 5 GB, 오래된 것부터 정리). 저장 단위는 설정 › 생체 데이터 관리 › 저장·백업 정책(`block_hours` 1·2·3·4·6·8·12·24).
* 인덱스는 메모리(`LIVE_INDEX`)에 즉시, 디스크에는 60 s마다/종료 시. `lost`는 앞으로 나간 seq 갭의 합(근사).
* 용량: `STORE_BYTES`를 증분 유지하고 10분마다 재스캔. 상한(`ROUTER_STORE_MAX_GB`) 초과 시 전 패치의 시간 파일을 오래된 순으로 지워 90 %까지 내린다. 쓰는 중인 시간 파일은 지우지 않는다.
* 읽기 API: 인덱스, 파일 목록, 전체 CRC 검증, ECG 구간 원본/개요(min·max 버킷).

**용량 계산** (2000 환자, 전 채널): 실측 약 8 GB/h 원본. gzip 후 대략 절반으로 잡으면 1 TB에 열흘 남짓. 보존 정책(전 채널 vs ECG+개요)은 미결이며 `PLAN.md` P5.

## 8. 실시간 중계와 분석 링크 (P1 범위)

레코드의 ECG 블록만 레거시 `EcgPacket`(f32 mV, seq = 패치 seq, quality = leadoff/noisy/good, moving = MOTION, gateway_id, space = 게이트웨이 실)으로 바꿔 기존 파이프라인에 넣는다.
분석 서버가 붙어 있으면 NDJSON으로 forward 하고 응답(seq)과 병합, 없으면 즉시 패스스루. 출력 WS는 100 ms 묶음 `stream_batch`(0xB1, JSON 헤더 + i16 블롭).
다채널 출력(PPG·호흡·가속도·수치)은 **P2**에서 별도 프레임 형식으로 확장한다. 후보: 헤더 JSON에 채널별 `counts`를 두고 블롭을 채널 순으로 잇는 방식(현 형식의 상위 호환).

## 9. 에뮬레이터 연동

`emu_link.rs`는 의존성 없는 HTTP/1.1 클라이언트(연결당 요청 1개, `Connection: close`, chunked 처리).
`ROUTER_EMULATOR_ADDR`가 있을 때만 (a) 5 s마다 `POST /api/v1/router/status`에 라우터 요약을 보고하고 (b) 30 s마다 입원 목록을 읽는다. 에뮬레이터가 없어도 라우터는 정상 동작한다(로그만).

## 10. API

| 경로 | 용도 |
|---|---|
| `GET /api/health` | 생존 |
| `GET /api/stats` | 수신 바이트·레코드·유실·큐 드롭·프로세스/시스템 자원·저장소 크기·`gateways` 요약(프레임·NACK·복구·이상 카운터) |
| `GET /api/gateways`, `/api/gateways/summary` | 게이트웨이 표 / 요약 |
| `GET /api/channels` | 패치 표(게이트웨이·실·환자·MRN·배터리·RSSI·플래그·그룹) |
| `GET /api/patches/{id}`, `/api/patches/{id}/verify` | 저장 인덱스·파일 / CRC 검증 |
| `GET /api/wave/{id}?mode=raw\|overview&from_ms&to_ms` | 저장 ECG 읽기 (raw 는 120 s 제한) |
| `POST /api/wave/reset` | 저장소 전체 삭제 |
| `GET /api/events` | link / silent / bad_crc / nack / analysis 이벤트 링 300개 |
| `GET/POST/PUT/DELETE /api/groups`, `/api/displays` | 레거시 그룹·디스플레이 (P4 에서 재검토) |
| `PUT /api/ingest/allow`, `GET /api/ingest/sources` | 수신 허용 IP 목록 / 소스별 연결 수 |
| `WS /ws` | 뷰어 구독 (subscribe / subscribe_gateway / subscribe_channels) |

환경변수는 `README.md` 표 참고. 기본 수신 포트는 에뮬레이터 `transport.target_port` 기본값과 같은 9100.

## 11. 동시성과 자원

* tokio 멀티스레드 런타임. 소켓당 태스크 1개(읽기) + 쓰기 태스크 1개(NACK 전용). 2,190 소켓에서 태스크 약 4,400개, 문제 없음.
* 공유 상태는 `DashMap`(게이트웨이 표·레지스트리)과 원자 카운터. 락을 오래 잡는 곳은 없다. 스냅샷 API는 표 전체를 순회하므로 1 Hz 이상 호출하지 않는다.
* 파일 I/O는 저장 스레드와 gzip 스레드 두 개의 OS 스레드로 격리.
* 실측(맥, 2000 환자): 라우터 CPU 8~16 %, RSS 135 MB로 4분간 증가 없음. RP5#2 에서는 `/proc` 기반 sysmon 으로 같은 지표를 낸다.

## 12. 장애 대응 표

| 상황 | 라우터 동작 | 관측 지표 |
|---|---|---|
| 게이트웨이 프레임 유실 | NACK → keep 버퍼 재전송 → 복구 | `seq_gap`, `nack_tx`, `recovered`, `resend_lost` |
| 프레임 손상(CRC) | 해당 seq NACK, 스트림 재동기화 | `bad_crc`, `resync`, `garbage_bytes` |
| 게이트웨이 다운(소켓 유지) | 10 s 후 silent 이벤트 | `silent` |
| 소켓 끊김 | 게이트웨이·패치 disconnected, 재접속 시 META 로 즉시 복구 | `link` 이벤트, `connected` |
| 라우터 재시작 | 에뮬레이터가 3 s 간격 재접속 + 저장 후 전송(SAF) 재생. 시간 파일에 이어 씀 | 재시작 후 35 s 내 전 게이트웨이 복귀 (실측) |
| 디스크 정체 | 큐 드롭(파형에 갭), 상한 초과 시 오래된 파일 삭제 | `queue_dropped_store`, `wave_store_bytes` |
| 분석 서버 없음/지연 | 패스스루 / 500 ms 후 무분석 방출 | `analysis_connected`, `downtime_ms` |

## 13. 레거시(2026-08)와 달라진 점

| 레거시 | v3 라우터 |
|---|---|
| 채널당 NDJSON 소켓, ECG 단일 채널 | 게이트웨이당 바이너리 소켓, 패치당 다채널 |
| 오류 검출 없음 | 프레임 CRC-32 + 저장 항목 CRC |
| seq 갭은 카운트만 | NACK 역채널로 재전송, 복구/유실 구분 |
| 채널별 8 h 세그먼트, ECG f32 | 패치별 UTC 시간 파일, 전 채널 원본, gzip, 용량 상한 |
| 게이트웨이 상태는 에뮬레이터 push JSON | 프레임 안 GW_STATUS·META 로 라우터가 직접 구성 |
| 환자 메타는 소켓 meta 메시지 | META(식별자) + EMR API(이름·병동·의료진) |
| Windows 중심 툴체인 | macOS(CLT) + Linux aarch64, `/proc` sysmon |

## 14. 검증 방법

* `cargo test`: 프레이밍 왕복, CRC 재동기화, 쓰레기 바이트, 제어 프레임, 저장 항목 CRC·시간 파일 회전.
* `scripts/e2e_fake_gateway.py`: 에뮬레이터 `protocol.py`로 만든 프레임을 라우터에 보내 NACK 왕복·손상·중복 gw·저장 교차 검증·API를 확인 (19 항목).
* 부하: 로컬 에뮬레이터 복제본(`run.py --data-dir <별도> --port 5446`, 전송 대상 127.0.0.1:19100)으로 2000 환자, 드릴 `network_event`/`gateway_fault`, 라우터 재시작.

## 15. 열린 결정

1. 파형 보존 정책 (전 채널 원본 vs ECG 원본 + 나머지 개요), 상한 기본값.
2. 파이썬 분석 목업 유지 여부와 실제 분석 엔진의 인터페이스.
3. 다채널 WS 프레임 형식 (P2) 과 뷰어 재작성 범위.
4. DB 계층 (P4): 레거시 db-api 유지 vs 라우터 내장 SQLite.
5. 저장소 루트의 Hailo 파일 (별도 저장소 또는 `docs/hailo/`).
