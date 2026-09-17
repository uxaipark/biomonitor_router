# 프로토콜 & API 레퍼런스

모든 소켓 프로토콜은 **NDJSON**(한 줄 = 한 JSON 메시지, UTF-8)입니다.

| 포트 | 서비스 |
|---|---|
| 7000 | 라우터 ingest (에뮬레이터 → 라우터) |
| 7100 | 분석 서버 (라우터가 클라이언트) |
| 7300 | 라우터 HTTP REST + 출력 WS |
| 7500 | 에뮬레이터 제어 REST |
| 7600 / 7601 | DB API REST / ingest (라우터 → DB push) |
| 5173 / 5174 | 뷰어 / 어드민 (Vite dev) |

## 1. 입력 프로토콜: 에뮬레이터 → 라우터 (TCP 7000)

채널(패치)당 연결 1개. 게이트웨이 상태·예약 보고는 각각 별도 전용 연결 1개.

### meta — 환자 메타데이터 (최초 접속 + 60초 주기 + 트랜스퍼 시 즉시)

```jsonc
{"type":"meta","channel_id":"SA-0001","ts_ms":1786430000000,
 "hospital":"seoul-a",              // DB API 가 병원별 DB 로 정확히 라우팅 (전환 레이스 방지)
 "patient":{
   "id":"P0001","name":"고경자","building":"A","floor":"2","ward":"W1",
   "zone":"Z1","room":"201","doctor":"Dr.황선영","department":"Cardiology","nurse":"N.남경미",
   // ---- 프로필 (에뮬레이터가 data/patients.json 에서 배정) ----
   "profile_no":1,                  // 얼굴 이미지 faces/<n>.png 지정
   "sex":"F","birth":"1958-08-20","blood":"O+",
   "conditions":["심방세동","심근경색 과거력"]   // 병변/기저질환 (리포트 표시)
 }}
```

### ecg — 파형 패킷 (기본 250Hz, 200ms = 50샘플)

```jsonc
{"type":"ecg","channel_id":"SA-0001","seq":1234,"ts_ms":1786430000200,
 "sample_rate":250,"samples":[0.01, ...],
 "quality":"good|weak","moving":false,
 "gateway_id":"GW-A2-201","space":"201호"}
```

미전송 구간(접속 불량/게이트웨이 장애)은 **seq 를 건너뛰어** 라우터가 갭으로 유실을 카운트한다.

### device_event — 디바이스 이벤트

```jsonc
{"type":"device_event","channel_id":"SA-0001","ts_ms":...,
 "event":"weak_signal|moving|reconnected|gateway_down|gateway_up","detail":"..."}
```

### channel_close — 채널 명시적 종료

```jsonc
{"type":"channel_close","channel_id":"SA-0001",
 "hospital":"seoul-a",
 "reason":"closed"}    // closed(기본): 퇴원/교체/삭제 → DB 패치 retire
                       // suspend: 병원 전환 일시 중단 → DB 패치 유지 (복귀 시 복원)
```

라우터는 레지스트리에서 삭제하고 그룹에 leave 를 전파한다.
`reason != "suspend"` 일 때만 DB 로 `retire_patch` 를 중계한다.

### appointment — 예약(검사/진료) 생성/상태 변경 (전용 연결)

라우터는 내용을 해석하지 않고 DB 로 중계하며(`upsert_appointment`), 시스템 이벤트를 남긴다.

```jsonc
{"type":"appointment","channel_id":"SA-0001","hospital":"seoul-a","ts_ms":...,
 "appointment":{
   "id":"APT-SA-0001-1786430000000","patient_id":"P0001","patient_name":"고경자",
   "kind":"검사","title":"혈액검사","place":"A동 1층 검사실",
   "scheduled_ms":1786430300000,"duration_s":225,
   "eta_return_ms":null,          // in_progress 전환 시 채워짐 (복귀 예상)
   "returned_ms":null,            // done 전환 시 채워짐
   "status":"reserved"            // reserved → in_progress → done (또는 cancelled)
 }}
```

### gateway_status — 게이트웨이 상태 push (전용 연결, 2초 주기)

```jsonc
{"type":"gateway_status","ts_ms":...,"known":130,"down":["GW-A2-201","GW-B3-Z1-WC"]}
```

## 2. 분석 프로토콜: 라우터 ↔ 분석 서버 (TCP 7100, 라우터가 클라이언트)

- 라우터 → 분석: `meta` / `ecg` / `channel_close` 원문 forward (전 채널 멀티플렉싱, 단일 연결)
- 분석 → 라우터:

```jsonc
// 패킷 분석 결과 (seq 를 그대로 돌려줘 라우터가 파형과 병합)
{"type":"analysis","channel_id":"SA-0001","seq":1234,"ts_ms":...,
 "hr":72.4,"events":[{"kind":"arrhythmia","detail":"AFib suspected"}]}

// 무패킷 채널 상태 이벤트 (seq 없음)
{"type":"analysis","channel_id":"SA-0007","seq":null,"ts_ms":...,"hr":null,
 "events":[{"kind":"disconnected","detail":"no packet for 5s"}]}
```

크래시 시뮬레이션 시 분석 서버는 연결 종료 후 **리스너를 15~45초 내림** →
라우터 재접속이 실패해 다운타임이 실측 누적된다.

## 3. 출력 WS: `ws://localhost:7300/ws`

### 클라이언트 → 라우터 (구독 3종 — 조합 가능, OR 필터)

```jsonc
{"type":"subscribe","group_id":"all"}                        // 그룹 구독 (뷰어)
{"type":"unsubscribe","group_id":"all"}
{"type":"subscribe_gateway","gateway_id":"GW-A2-201"}        // 게이트웨이 구독 (파형 모달)
{"type":"unsubscribe_gateway","gateway_id":"GW-A2-201"}
{"type":"subscribe_channels","channel_ids":["SA-0001", ...]} // 채널 목록 구독 (코호트 모달)
{"type":"unsubscribe_channels"}
```

### 라우터 → 클라이언트

```jsonc
// 분석 병합(또는 무분석 통과) 스트림 — seq 로 파형·HR·이벤트 싱크 보장
{"type":"stream","group_ids":["all","ward-w1"],"channel_id":"SA-0001","seq":1234,"ts_ms":...,
 "sample_rate":250,"samples":[...],"hr":72.4,"events":[...],
 "quality":"good","moving":false,"gateway_id":"GW-A2-201","space":"201호","patient":{...}}

// 그룹 멤버십 변경/스냅샷 (구독 시작 시 snapshot 일괄 전송)
{"type":"membership","group_ids":["ward-w1"],"event":"join|leave|snapshot",
 "channel_id":"SA-0001","patient":{...},"connected":true}

// 데이터 없는 채널 이벤트
{"type":"channel_event","group_ids":[...],"channel_id":"SA-0001","ts_ms":...,
 "events":[{"kind":"disconnected|reconnected|ingest_disconnected|weak_signal|moving|gateway_down|gateway_up",...}]}
```

## 4. 라우터 REST API (HTTP 7300, CORS 허용)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/api/health` | `{ok, analysis_connected, channel_count}` |
| GET | `/api/stats` | 회선/수신·송신 바이트/패킷/**유실 누적**/가동 시간/**다운타임 누적(ms)**/CPU/메모리/디스크 |
| POST | `/api/stats/reset` | 수신/송신/패킷/유실 카운터 리셋 |
| POST | `/api/channels/prune` | **해제 상태 채널 일괄 정리** — 비정상 종료 잔재 제거 (DB 리셋/병원 전환 후 호출) |
| GET | `/api/events` | 최근 시스템 이벤트 100건: `analysis_delay/analysis_down/analysis_up/appointment/stats_reset/display_config/registry_prune` |
| GET | `/api/channels` | 전체 채널 스냅샷: `{channel_id, connected, stale, quality, moving, gateway_id, space, last_seq, last_ts_ms, patient(프로필 포함), groups}` |
| GET | `/api/groups` | 그룹 목록 + `member_count` (`all` 항상 최상단) |
| POST | `/api/groups` | 그룹 생성 — 즉시 전 채널 멤버십 재계산/전파 |
| PUT | `/api/groups/{id}` | 그룹 수정 |
| DELETE | `/api/groups/{id}` | 그룹 삭제 (`all` 은 403) |
| GET | `/api/displays` | 디스플레이 → 그룹 매핑 |
| PUT | `/api/displays/{id}` | 매핑 설정 (body: `{"group_id":"..."}`) |
| GET | `/api/gateways` | 게이트웨이 상태 `{known, down[], updated_ts_ms}` |
| GET | `/api/wave/{ch}/info` | **저장 파형 가용 범위** `{from_ms, to_ms, bytes}` (없으면 404) |
| GET | `/api/wave/{ch}?mode=raw&from_ms=&to_ms=` | **원본 파형** (범위 상한 120초). `{segments:[{t0, sample_rate, samples[]}]}` — 수신 공백(>500ms)은 세그먼트 분리 |
| GET | `/api/wave/{ch}?mode=overview&from_ms=&to_ms=&buckets=600` | **구간 요약** `{buckets:[[t,min,max],...]}` — 장구간 개요/블록용 |

GroupConfig:

```jsonc
{"id":"ward-w1","name":"병동 W1","description":"메모",
 "owner":"주요 사용자",   // 담당 간호사/주치의 이름, 전광판, 중앙관제 등 (≤10자)
 "criteria":{"ward":["W1"],"department":["Cardiology"]},  // 키 간 AND, 값 간 OR
 "include":["SA-0001"],"exclude":["SA-0002"]}             // exclude 최우선
```

## 5. 에뮬레이터 제어 API (HTTP 7500, CORS 허용)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/status` | `{count, channels[]}` |
| GET | `/gateways` | `{known, down[]}` |
| GET | `/hospital` | `{id, hospitals:[{id,name,prefix,beds}]}` |
| POST | `/hospital?id=busan-b` | **병원 전환 (suspend)** — 이전 채널 일시 중단(패치 폐기 없음) 후 새 병원 **DB 명단 로드**. 응답 `{id, count, source:"db"|"generated"}` |
| GET | `/journeys` | **이동 동선**: 여정 중/최근 30분 이력/예약 보유 채널의 `{channel_id, patient, moving, current{space,gw,since_ms}, log[{space,gw,start_ms,end_ms}], next_appt, eta_return_ms}` |
| GET | `/roster?hospital=&count=` | 명단 생성 미리보기 (DB 리셋이 시드용으로 호출) |
| GET | `/patches` | 미사용 채널 ID 후보 (수동 교체 폴백용) |
| POST | `/channels/add?count=20` | 채널 추가 |
| POST | `/channels/remove?count=20` | 앞(최저 인덱스) 채널 삭제 — `channel_close(closed)` |
| POST | `/channels/reset?count=100` | 전체 종료 후 재생성 |
| POST | `/channels/reload` | **DB 명단 기준 재동기화** (DB 리셋 직후 호출, suspend 종료 → DB 로드) |
| POST | `/channel/patient?id=SA-0001` | **환자 트랜스퍼** (body: 변경 필드) → meta 즉시 재전송, 위치 변경 시 간호사 자동 재배정 |
| POST | `/channel/replace?id=SA-0001&new=PT-SA-1001` | **패치 교체** — 새 채널 ID 로 재시작 (기존은 retire) |
| POST | `/channel/discharge?id=SA-0001` | **퇴원** — 채널 종료 및 라우터에서 제거 |

## 6. DB API (병원별 SQLite 영속화 계층)

### 라우터 → DB API (TCP 7601, NDJSON push — 라우터 db_link 상시 연결)

```jsonc
{"op":"upsert_patient","hospital":"seoul-a","channel_id":"SA-0001","patient":{...}}  // meta 수신 시마다
{"op":"retire_patch","hospital":"seoul-a","patch_id":"SA-0001"}                      // channel_close(closed) 시
{"op":"upsert_appointment","hospital":"seoul-a","channel_id":"SA-0001","appointment":{...}}
```

`hospital` 이 있으면 그 병원 DB 로, 없으면 현재 병원 DB 로 라우팅.

### REST (HTTP 7600, CORS 허용) — 모든 조회는 `?hospital=<id>` 지원 (생략 시 현재 병원)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | `{ok, ops, current_hospital, databases, patients, in_stock}` |
| GET | `/patients` | 환자 전체 (프로필 필드 포함, conditions 는 배열로 파싱됨) |
| GET | `/patches[?status=in_stock\|in_use\|retired]` | 패치 목록 — 어드민 교체 드롭다운은 `in_stock` 사용 |
| POST | `/patches/restock?count=100` | 재고 보충 (`PT-<프리픽스>-####` 신규 발급) |
| GET | `/appointments[?status=]` | **예약 목록** (scheduled_ms 내림차순, 최대 300) |
| GET | `/timeseries?range=hour\|day\|week\|month` | 시계열 (버킷: 60초/5분/30분/2시간) + 이벤트 — 타임 로그 페이지 소스 |
| POST | `/db/reset` | **병원별 DB 재생성**: 파일 삭제 → 재고 50 시드 → 에뮬레이터 roster 로 200명 시드 |

패치 라이프사이클: `in_stock` → `in_use`(meta 수신) → `retired`(channel_close 폐기).
예약 라이프사이클: `reserved` → `in_progress`(검사 시작, eta_return 기록) → `done`(복귀) /
`cancelled`(15분 경과 미실행 — reconcile 자동 취소).

## 7. 라우터 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ROUTER_INGEST_ADDR` | `0.0.0.0:7000` | 입력 채널 리스너 |
| `ROUTER_ANALYSIS_ADDR` | `127.0.0.1:7100` | 분석 서버 주소 |
| `ROUTER_HTTP_ADDR` | `0.0.0.0:7300` | WS/REST |
| `ROUTER_DB_ADDR` | `127.0.0.1:7601` | DB API push 주소 |
| `ROUTER_GROUPS_PATH` | `groups.json` | 그룹 영속화 |
| `ROUTER_DISPLAYS_PATH` | `displays.json` | 디스플레이 매핑 영속화 |
| `ROUTER_RING_CAPACITY` | `512` | 채널별 분석 대기 서큘러 버퍼 (패킷 수) |
| `ROUTER_WAVE_DIR` | `waves` | 파형 세그먼트 저장 디렉토리 |
| `ROUTER_WAVE_SEGMENT_H` | `8` | 파형 세그먼트 단위(시간) — 채워지면 다음 파일, 삭제 없음 |

## 8. CLI

```
# 에뮬레이터
python main.py [--host 127.0.0.1] [--port 7000] [--channels 300]
               [--sample-rate 250] [--packet-ms 200]
               [--control-port 7500] [--hospital seoul-a|busan-b]
               [--db-api http://127.0.0.1:7600]    # 기동 시 DB 명단 로드 (비면 --channels 생성)

# 분석 서버
python main.py [--port 7100] [--delay-ms 100]      # 이상동작 시뮬레이션 상시 활성

# DB API
python main.py [--http-port 7600] [--ingest-port 7601]
               [--router-api http://127.0.0.1:7300] [--emulator-api http://127.0.0.1:7500]

# 프로필/얼굴 재생성 (선택, pip install python-avatars resvg-py)
python scripts/gen-profiles.py
```
