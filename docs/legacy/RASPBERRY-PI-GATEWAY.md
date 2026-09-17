# 라즈베리파이 게이트웨이 연동 가이드

라즈베리파이가 에뮬레이터를 대체해 **32채널 ECG 결과를 맥 미니 라우터로 push** 하는 방법.
와이어 프로토콜의 전체 스키마는 [API.md](API.md) §1 을 따른다 — 이 문서는 게이트웨이 관점의 요약과
macOS 특이사항만 정리한다.

## 0. 네트워크 (가장 중요)

| 항목 | 값 |
|---|---|
| 라우터(맥 미니) IP | **192.168.0.22** (현재. `ipconfig getifaddr en0` 로 재확인) |
| **ingest 포트** | **7700** (TCP) — ⚠ 원본 문서의 7000 이 아님 |
| DB API (선택, 명단 조회) | 192.168.0.22:7600 (HTTP) |

> ⚠ **왜 7000 이 아니라 7700 인가**: macOS 는 포트 7000 을 Control Center(AirPlay Receiver)가
> 점유한다. 그래서 맥 미니 라우터의 ingest 는 7700 으로 띄운다(`ROUTER_INGEST_ADDR`).
> 게이트웨이도 **7700 으로 접속**해야 한다. 라즈베리파이(리눅스)에는 이 제약이 없으니
> 게이트웨이 자신의 리스닝 포트는 자유롭게 써도 된다.

방향: **게이트웨이가 클라이언트로 접속(push)**, 라우터가 리스닝. (실제 패치→게이트웨이→서버 흐름과 동일)

## 1. 연결 모델

- **채널(패치)당 TCP 연결 1개.** 32채널이면 **32개의 TCP 연결**을 라우터 `:7700` 으로 연다.
- 모든 메시지는 **NDJSON**: 한 줄 = JSON 하나, UTF-8, `\n` 종단.
- `channel_id` 는 전역 유일해야 한다. 병원 프리픽스 사용 권장 (서울A=`SA-0001`…`SA-0032`).
- 상태 보고용 별도 전용 연결 2개(같은 :7700): `gateway_status`(2초 주기), `appointment`(선택).

## 2. 채널당 전송 시퀀스

접속 직후 `meta` 1회 → 이후 `ecg` 를 주기 전송(기본 250Hz, 200ms = 50샘플) → 60초마다 `meta` 재전송.

### meta (접속 시 + 60초 주기)
```json
{"type":"meta","channel_id":"SA-0001","ts_ms":1786430000000,"hospital":"seoul-a",
 "patient":{"id":"P0001","name":"홍길동","building":"A","floor":"2","ward":"W1","zone":"Z1",
   "room":"201","doctor":"Dr.김","department":"Cardiology","nurse":"N.이",
   "profile_no":1,"sex":"M","birth":"1958-08-20","blood":"O+","conditions":["심방세동"]}}
```
- `patient` 필드는 그룹핑/평면도 배치/리포트에 쓰인다. 위치(building/floor/ward/zone/room)와
  gateway_id 가 일관돼야 평면도에 제대로 찍힌다.

### ecg (파형 패킷)
```json
{"type":"ecg","channel_id":"SA-0001","seq":1234,"ts_ms":1786430000200,
 "sample_rate":250,"samples":[0.01, 0.02, ...],
 "quality":"good","moving":false,"gateway_id":"GW-A2-201","space":"201호"}
```
- **`seq` 는 채널별로 단조 증가.** 미전송 구간(신호 끊김)은 **seq 를 건너뛰면** 라우터가
  갭으로 유실을 카운트한다.
- `samples` 는 mV 단위 float 배열. 200ms 패킷이면 sample_rate=250 → 50개.

### channel_close (채널 종료)
```json
{"type":"channel_close","channel_id":"SA-0001","hospital":"seoul-a","reason":"closed"}
```
- `closed`: 퇴원/교체 → DB 패치 retire. `suspend`: 일시 중단(패치 유지).

## 3. 최소 동작 (32채널 스트리밍만 목표라면)

1. `192.168.0.22:7700` 로 TCP 연결 32개.
2. 각 연결에서 `meta` 1줄 전송(채널 고유 id + 환자/위치 정보).
3. 200ms 마다 `ecg` 1줄씩, `seq` 를 1씩 증가시키며 전송.
4. 종료 시 `channel_close` (선택).

이것만으로 뷰어(:5173)/어드민(:5174)에 파형·HR·이벤트가 싱크되어 나타난다.
(HR/부정맥은 맥 미니의 분석 서버가 붙여준다 — 게이트웨이는 원파형만 보내면 됨.)

## 4. 역채널 — 라우터/어드민이 게이트웨이를 제어 (향후)

현재 에뮬레이터는 **HTTP 제어 API(:7500)** 를 노출하고, 어드민/DB API 가 이를 호출한다
(채널 추가·삭제, 환자 트랜스퍼, 병원 전환, 이동 동선 `/journeys`, DB 리셋용 `/roster`).
라즈베리파이가 에뮬레이터를 대체하면 **이 제어 표면을 게이트웨이가 이어받아야** 한다.

연동 지점(맥 미니 쪽 설정을 게이트웨이 IP 로 돌리면 됨):
- **DB API**: `--emulator-api http://<라즈베리파이IP>:7500` (start-all.sh 의 `EMU_HOST` 로 지정)
- **어드민 웹**: `web/admin/.env` 의 `VITE_EMU_HOST=<라즈베리파이IP>`

게이트웨이가 최소로 구현하면 좋은 제어 엔드포인트(현 에뮬레이터 API.md §5 참고):
`GET /status`, `GET /journeys`, `GET /roster`, `POST /channels/add|remove|reset|reload`,
`POST /channel/patient|replace|discharge`, `GET/POST /hospital`.
32채널 데모만이면 우선 **`GET /status`** 정도만 있어도 어드민 상태 표시가 동작한다.

> 설계 방향: "라우터가 게이트웨이를 제어" 하는 형태로 갈 경우, 위 제어를 라우터가 프록시하고
> 게이트웨이는 라우터의 명령만 수신하는 구조로 재배치할 수 있다. (추후 결정)

## 5. 체크리스트

- [ ] 맥 미니에서 `scripts/start-all.sh` 실행 (라우터 ingest :7700 확인)
- [ ] 맥 미니 방화벽에서 **7700**(그리고 어드민을 라파이가 부르면 7600) 인바운드 허용
- [ ] 라즈베리파이 → `192.168.0.22:7700` TCP 연결 32개, NDJSON meta/ecg 전송
- [ ] 어드민에서 32채널 파형 확인 (`http://192.168.0.22:5174`)
- [ ] (역제어 시) `EMU_HOST`/`VITE_EMU_HOST` 를 라즈베리파이 IP 로 설정
