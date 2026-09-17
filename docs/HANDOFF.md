# 에이전트 인수인계 (MAC ↔ RP5#2)

맥과 RP5#2(라우터 서버, 1 TB SSD)에서 각각 일하는 에이전트가 이 문서 하나로 소통한다. 규칙은 `CLAUDE.md`.
항목은 지우지 않고 아래에 덧붙인다. 형식 `- [YYYY-MM-DD HH:MM MAC|RP5] 내용`.

## 1. 현재 상태

- [2026-09-17 23:20 MAC] P0·P1 완료(커밋 48a3480 이후). `router-server`가 protocol v3 ingest·게이트웨이 표·NACK·패치 저장소·상태 API·에뮬레이터 링크를 제공. 검증 내역은 `README.md` "검증" 절. 다음은 P2(WS 다채널 출력 + 뷰어).
- [2026-09-17 23:20 MAC] RP5#2 는 아직 설치되지 않음. 설치 절차는 `docs/RP5-DEV.md`, 스크립트는 `scripts/pi-dev-setup.sh`. aarch64 Linux 컴파일은 맥에서 `cargo check --target aarch64-unknown-linux-gnu` 로만 확인했고 실기 빌드·실행은 RP5#2 에이전트가 처음 하게 됨 — 결과를 3절에 적어 주세요.

## 2. 환경·주의

- 에뮬레이터(RP5#1 `dlake`, 192.168.0.125:5445)의 `transport.target_ip/port` 는 라우터가 준비되기 전까지 바꾸지 않는다. 바꿀 때는 에뮬레이터 저장소 HANDOFF 에 먼저 적는다.
- 맥은 방화벽이 수신을 막고 있어 RP5#1 → 맥 라우터 경로는 사용자가 방화벽을 열기 전까지 불가. 맥에서의 검증은 로컬 에뮬레이터 복제본(`run.py --data-dir <별도 디렉터리> --port 5446`)으로 한다.
- 에뮬레이터는 페이스마크(ch 10)를 같은 패치·같은 seq 의 두 번째 레코드로 보낸다. 라우터는 `continuation_records` 로 세고 중복으로 보지 않는다(`ingest.rs`). 이 동작을 바꾸려면 에뮬레이터 저장소와 같이 맞춘다.
- 저장 용량: 2000 환자 전 채널 raw 기준 약 8 GB/h(gzip 전). `ROUTER_STORE_MAX_GB` 로 상한을 두고 오래된 시간 파일부터 지운다. 보존 정책(전 채널 vs ECG만)은 사용자 결정 대기.
- 미결: 파이썬 분석 목업(`analysis-server/`) 유지 여부, 웹 화면(P2/P3) 재작성 범위.

## 3. RP5#2 → MAC 전달 사항

- (RP5#2 에이전트가 여기에 추가)

## 4. MAC → RP5#2 전달 사항

- [2026-09-17 23:20 MAC] 처음 설치할 때: `git clone` → `scripts/pi-dev-setup.sh` → `ROUTER_STORE_DIR` 를 SSD 마운트 아래로 두고 실행. systemd 유닛은 P4 에서 `deploy/pi/` 로 만들 예정이니, 그 전에 필요하면 임시로 만들고 여기에 적어 주세요.

## 5. 변경 로그 (최신이 아래)

- [2026-09-17 22:50 MAC] 라우터 P1 구현·검증 (48a3480).
- [2026-09-17 23:20 MAC] RP5#2 이어 개발 준비: Linux sysmon(/proc), `rust-toolchain.toml`, `scripts/pi-dev-setup.sh`, `docs/RP5-DEV.md`, `CLAUDE.md`, 이 문서.
