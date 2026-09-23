# 라우터(2단계) 개발 계획

기존 스택(2026-08, NDJSON 채널당 소켓, 400채널)을 바탕으로 **바이오시그널 에뮬레이터 프로토콜 v3**(게이트웨이당 소켓, 바이너리 프레임 + CRC-32, 패치당 다채널, META/GW_STATUS, NACK 역채널)를 받는 라우터로 재구성한다.
개발은 Mac에서 끝내고, 1 TB SSD가 달린 두 번째 RP5에 배포한다. 에뮬레이터(1단계)는 https://github.com/uxaipark/biomonitor_simulator (RP5 `dlake`, 192.168.0.125:5445)에서 실행 중이다.

## 구성

| 디렉터리 | 기술 | 역할 |
|---|---|---|
| `router-server/` | Rust (tokio/axum) | v3 ingest(2000+ GW 소켓, CRC·순번 검증, NACK), 패치 레지스트리(=채널), 링버퍼·분석 병합, 그룹핑, WS 출력(다채널 stream_batch), 파형 저장(패치별 세그먼트·항목 CRC·gzip·용량 상한), 어드민 REST, 에뮬레이터 연동(디스커버리·EMR·상태 보고), DB push |
| `analysis-server/` | Python | 목업 분석(HR/부정맥, 지연·스톨·크래시 시뮬레이션). 나중에 실제 엔진으로 교체 |
| `db-api/` | Python + SQLite | 병원별 영속화(환자·패치·예약·메트릭·이벤트). 명단은 에뮬레이터 EMR API에서 시드 |
| `web/console/` | React/Vite | 웹 콘솔 — 대시보드·환자·실시간 파형·뷰어 템플릿(중앙 모니터·침상·이력)·병원 지도·게이트웨이·알람·이벤트·설정(뷰어 설정·생체신호 관리). 라우터가 `dist` 를 서빙 |
| `deploy/` | systemd·스크립트 | RP5 설치(SSD 경로), Mac 개발 실행 |
| `tests/` | Rust + Python | 프로토콜·ingest·저장·API 테스트, 에뮬레이터 드릴(T-02/04/07/11/12/13) 연동 검증 |

## 단계

- **P0** ✅ 저장소·툴체인(rustup + CLT 링커, Node), 기존 코드 컴파일 확인. (2026-09-17)
- **P1** ✅ v3 ingest·레지스트리·게이트웨이 표·NACK·패치 저장소·상태 API·에뮬레이터 링크(상태 보고/EMR 동기화) → 파이썬 초안 대체. 단위 6 + e2e 19 + 2000 환자 부하/드릴 검증. (2026-09-17)
  - 발견: 에뮬레이터가 페이스마크를 같은 seq 의 두 번째 레코드로 보냄 → 라우터는 continuation 으로 허용. 에뮬레이터 쪽 병합은 선택.
  - 미결: 파형 보존 정책(전 채널 raw 저장 중, 2000 환자 기준 약 5 GB/h, gzip 후 절반 예상), 분석 목업 유지 여부.
- **P2** ✅ WS 출력 다채널(stream_batch v2: 전 파형 i16 블롭 + 수치 + 페이스마크 + 플래그) + 새 웹 콘솔 `web/console`(대시보드·환자·실시간 파형·병원 지도·게이트웨이·알람·이벤트, 라우터가 `/`로 서빙). (2026-09-18, RP5#2)
  - 알람 엔진(`alarms.rs`)과 에뮬레이터 EMR 프록시(`/api/emr/*`)를 함께 넣음 — 원래 P3/P4 항목이던 알람·도면을 앞당김.
  - 레거시 `web/admin`·`web/viewer`는 죽은 서비스(:7500 에뮬 제어, :7600 db-api)에 묶여 있어 참고용으로만 남겼다가 2026-09-23 삭제(옛 원클릭 실행 스크립트 `setup-and-run.*`·`scripts/start-all|stop-all` 도 함께). 화면은 `web/console` 하나, 실행은 `scripts/run-router-pi.sh`.
- **P3** 분석 링크·싱크·이벤트·다운타임.
- **P4** DB API·어드민(그룹, Patch Map 폴리곤 도면, 이동 타임라인 = `/api/v1/emr/trips`).
- **P5** RP5 배포: systemd 유닛·sysctl·설치 스크립트는 `deploy/pi/` 에 준비됨(2026-09-18). 남은 것: 2000 GW 성능 장기 관측, 보존 정책(ECG 원본 + 나머지 개요), 인증/TLS. **rp5ai 에는 SSD 가 없어(SD 476 GB) 상한 40 GB 로 시작.**

## 계약 (에뮬레이터 측, 변경 시 두 저장소 함께)

- 프레임: 헤더 26바이트 `<HBBIIQHI` + 페이로드 + CRC-32. 레코드 헤더 16바이트 `<IIIBBbB`(patch_id, patient_id, seq, flags, battery, rssi, n_ch). 제어 프레임 F_CTRL 0x08 `<B kind><I from><I to>`.
- 디스커버리 `GET /api/v1`, EMR `GET /api/v1/emr/*`, 상태 보고 `POST /api/v1/router/status`.
- 검증 참조 구현: `emulator/runtime/verify.py`, `tools/receiver.py`, `router/`(파이썬 초안).
