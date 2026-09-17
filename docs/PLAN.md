# 라우터(2단계) 개발 계획

기존 스택(2026-08, NDJSON 채널당 소켓, 400채널)을 바탕으로 **바이오시그널 에뮬레이터 프로토콜 v3**(게이트웨이당 소켓, 바이너리 프레임 + CRC-32, 패치당 다채널, META/GW_STATUS, NACK 역채널)를 받는 라우터로 재구성한다.
개발은 Mac에서 끝내고, 1 TB SSD가 달린 두 번째 RP5에 배포한다. 에뮬레이터(1단계)는 https://github.com/uxaipark/biomonitor_simulator (RP5 `dlake`, 192.168.0.125:5445)에서 실행 중이다.

## 구성

| 디렉터리 | 기술 | 역할 |
|---|---|---|
| `router-server/` | Rust (tokio/axum) | v3 ingest(2000+ GW 소켓, CRC·순번 검증, NACK), 패치 레지스트리(=채널), 링버퍼·분석 병합, 그룹핑, WS 출력(다채널 stream_batch), 파형 저장(패치별 세그먼트·항목 CRC·gzip·용량 상한), 어드민 REST, 에뮬레이터 연동(디스커버리·EMR·상태 보고), DB push |
| `analysis-server/` | Python | 목업 분석(HR/부정맥, 지연·스톨·크래시 시뮬레이션). 나중에 실제 엔진으로 교체 |
| `db-api/` | Python + SQLite | 병원별 영속화(환자·패치·예약·메트릭·이벤트). 명단은 에뮬레이터 EMR API에서 시드 |
| `web/admin`, `web/viewer` | React/Vite | 관제 콘솔·Patch Map(에뮬레이터 도면 JSON)·동선·예약·패치·타임로그·리포트 / 그룹별 뷰어 |
| `deploy/` | systemd·스크립트 | RP5 설치(SSD 경로), Mac 개발 실행 |
| `tests/` | Rust + Python | 프로토콜·ingest·저장·API 테스트, 에뮬레이터 드릴(T-02/04/07/11/12/13) 연동 검증 |

## 단계

- **P0** 저장소·툴체인(rustup/Homebrew rust, Node), 기존 코드 컴파일 확인, CI.
- **P1** v3 ingest·레지스트리·게이트웨이 표·NACK·파형 저장·상태 API → 파이썬 초안 대체. 에뮬레이터 드릴로 검증.
- **P2** WS 출력 다채널 + 뷰어.
- **P3** 분석 링크·싱크·이벤트·다운타임.
- **P4** DB API·어드민(그룹, Patch Map 폴리곤 도면, 이동 타임라인 = `/api/v1/emr/trips`).
- **P5** RP5 배포(systemd, sysctl, SSD 데이터 경로), 2000 GW 성능, 보존 정책(ECG 원본 + 나머지 개요), 인증/TLS.

## 계약 (에뮬레이터 측, 변경 시 두 저장소 함께)

- 프레임: 헤더 26바이트 `<HBBIIQHI` + 페이로드 + CRC-32. 레코드 헤더 16바이트 `<IIIBBbB`(patch_id, patient_id, seq, flags, battery, rssi, n_ch). 제어 프레임 F_CTRL 0x08 `<B kind><I from><I to>`.
- 디스커버리 `GET /api/v1`, EMR `GET /api/v1/emr/*`, 상태 보고 `POST /api/v1/router/status`.
- 검증 참조 구현: `emulator/runtime/verify.py`, `tools/receiver.py`, `router/`(파이썬 초안).
