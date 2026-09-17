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
- [2026-09-18 00:20 RP5] RP5#2(hostname `rp5ai`) 첫 실기 빌드·실행 완료. `WITH_NODE=0 scripts/pi-dev-setup.sh` 그대로 통과(릴리스 빌드 1분 21초, 테스트 6/6). **SSD 없음 — SD 카드(476 GB) 하나뿐**이라 시험 실행은 `ROUTER_STORE_MAX_GB=20`. 1 TB SSD 전제(8 GB/h)는 이 장비에서 성립하지 않으니 보존 정책 결정 때 반영 필요.
- [2026-09-18 00:20 RP5] 에뮬레이터 `transport.target_ip` 가 사용자 승인으로 이 장비를 향함: 처음 192.168.0.56(wlan0) → 현재 **192.168.0.209:9100 (eth0 유선)**. 라우터는 `0.0.0.0:9100`/`:7300` 에서 실행 중(상태 API 는 9200 이 아니라 7300).
- [2026-09-18 00:20 RP5] 실부하 버그 2건 수정: (1) 에뮬레이터가 재배포로 재시작해 게이트웨이 seq 가 0 부터 다시 시작하자 `track_seq` 가 이후 모든 프레임을 `Reorder` 로 판정(20 s 동안 프레임 63,618 = reorder 63,618, 갭 감지·NACK 사실상 정지). 1024 넘게 뒤로 가면 재시작으로 보고 기준 재설정(`seq_restart`, 패치 seq 도 동일). (2) 에뮬레이터가 경로를 .56 → .209 로 옮긴 뒤 FIN 없이 사라진 소켓 1,880개가 ESTABLISHED 로 남음 → TCP keepalive(30 s/10 s×3). 리스너 백로그 128 → 4096(재시작 시 커널 `Possible SYN flooding on port 9100` 경고 해소).
- [2026-09-18 00:20 RP5] 수정 후 실측(2,190 GW, 99 s): 연결 2190 / 백로그 4096 / SYN 경고 0 / CPU 10~12 % / RSS 130 MB / nack·resend_lost·silent·dup_gw 0 / 이상 카운터 `patch_seq_reorder 14`(재접속 직후 SAF 재생분, 증가 없음). 참고: 에뮬레이터 송신량이 재배포 후 약 3.2k 프레임/s·0.7 MB/s 로 이전(약 5k/s·3 MB/s)보다 낮음 — 에뮬레이터 쪽 설정 변화로 보임.

- [2026-09-18 00:35 RP5] 재시작 판정 보완: 에뮬레이터가 짧은 간격(직전 실행 약 150 s, 게이트웨이 seq ≈ 750)으로 다시 재시작하자 새 seq 가 1024 기준 안쪽이라 150 s 가량 전 프레임이 다시 `Reorder` 로 집계됨. **새 소켓의 첫 프레임이 이전 seq 보다 뒤면 거리와 무관하게 재시작**으로 보도록 수정(SAF 재생은 이전 seq 뒤로 이어지므로 영향 없음). 라우터 재시작 후 71 s: 연결 389(에뮬레이터 환자 500명 규모), 이상 카운터 0.
- [2026-09-18 00:35 RP5] 실시간 소통은 에뮬레이터 채팅 채널을 씀(Mac 이탈 후 체제, 에뮬레이터 측 seq 12~15). RP5-2 는 이름 `rp5-2` 로 `ws://192.168.0.125:5445/ws/chat` 에 상시 접속. 상태 API 포트는 7300.

- [2026-09-18 01:45 RP5] P2 완료 + 알람 + 웹 콘솔 (커밋 참조). 라우터 WS 는 이제 v2 프레임(0xB2): items[].waves 레이아웃 + i16 블롭(ECG·가속도·PPG·호흡파형), items[].vitals(hr/temp/resp/spo2/glucose), pace, flags/battery/rssi. 뷰어는 첫 바이트로 v1/v2 구분. 알람: `alarms.rs`(수치 임계 10 s 지속·전극 탈락 30 s·배터리·패치 15 s 무응답·GW 다운/무응답/저하·저장 백프레셔), REST `/api/alarms*`, WS 의사 그룹 `alarms`, 상태 보고에 `alarms` 요약 포함. 에뮬레이터 EMR 프록시 `/api/emr/*`, `/api/emu/status|discovery`(TTL 캐시; 에뮬레이터에 CORS 가 없어 브라우저는 라우터만 봄).
- [2026-09-18 01:45 RP5] 웹 콘솔 `web/console`(React/Vite, 의존성 react 만): 대시보드(초당 프레임/바이트 = /api/stats 차분)·환자 표(1,000~2,500행, 검색/정렬/필터, 행 클릭 → 상세 모달: 전 파형·가속도·EMR 프로필·저장 인덱스·알람)·실시간 그리드(병동/GW 선택, 최대 48장, subscribe_channels 합집합)·병원 지도(에뮬레이터 layout JSON 폴리곤 + 게이트웨이 상태 + 환자 점 + 알람 색)·게이트웨이 표·알람(확인/이력/규칙 편집)·이벤트. `npm run build` 산출물을 라우터가 `/` 로 서빙(`ROUTER_WEB_DIR`). **브라우저 실검증은 못 함** — 이 장비의 headless chromium 이 http 페이지 로드를 시작조차 못 함(네트워크 이벤트 0, file:// 만 됨). 대신 `npm run smoke`(react-dom/server 로 전 페이지 렌더) 통과. 사용자가 http://192.168.0.209:7300/ 를 열어 보는 단계.
- [2026-09-18 01:45 RP5] 배포 준비 `deploy/pi/`: `biomonitor-router.service`(User=master, LimitNOFILE 65535), `/etc/biomonitor-router.env`, `99-biomonitor-router.conf`(somaxconn 4096 등), `install.sh`(빌드 → /opt/biomonitor-router, 데이터 /var/lib/biomonitor-router). 아직 설치하지 않음(사용자 결정 대기) — 현재는 `scripts/run-router-pi.sh` 로 백그라운드 실행 중.
- [2026-09-18 01:45 RP5] 관측: `patch_seq_reorder` 는 엘리베이터/복도 게이트웨이 핸드오버 중 두 게이트웨이가 같은 패치를 겹쳐 보낼 때 생기는 정상 현상(이동 환자 1명에서만, `/api/channels[].pseq_reorder` 로 확인). 재구축 직후 수천 건 폭증은 과도기. 알람 규칙 기본값으로 환자 1,000명 중 활성 알람 약 150건(에뮬레이터 심장질환 비율 70 %) — 임계 조정은 규칙 탭에서.

- [2026-09-18 05:10 RP5] 사용자 결정: 저장 상한 **200 GB**(`ROUTER_STORE_MAX_GB=200`, run 스크립트·deploy env 반영, 라우터 재시작). systemd 설치는 나중에 — 계속 `scripts/run-router-pi.sh` 백그라운드 실행.

- [2026-09-18 08:40 RP5] 뷰어 템플릿 시스템 추가(`web/console/src/viewer/`): 에뮬레이터 Central Station(n-up)·단일 침상 뷰어의 CSS/레이아웃 로직(csLayout·프리셋·숫자 보드·알람 색)을 라우터 콘솔로 이식. `#/viewer?tpl=central&gw=…|ward=…|room=…|ids=…` 새 탭 전체 화면. 알람 색은 라우터 알람 엔진(critical/high=적, medium/low=황) 기준. NIBP 는 채널이 없어 `--`. 템플릿 레지스트리 `templates.js` 에 대상별 템플릿을 추가하는 구조. 에뮬레이터 쪽 변경 없음.

## 4. MAC → RP5#2 전달 사항

- [2026-09-17 23:20 MAC] 처음 설치할 때: `git clone` → `scripts/pi-dev-setup.sh` → `ROUTER_STORE_DIR` 를 SSD 마운트 아래로 두고 실행. systemd 유닛은 P4 에서 `deploy/pi/` 로 만들 예정이니, 그 전에 필요하면 임시로 만들고 여기에 적어 주세요.

## 5. 변경 로그 (최신이 아래)

- [2026-09-17 22:50 MAC] 라우터 P1 구현·검증 (48a3480).
- [2026-09-17 23:20 MAC] RP5#2 이어 개발 준비: Linux sysmon(/proc), `rust-toolchain.toml`, `scripts/pi-dev-setup.sh`, `docs/RP5-DEV.md`, `CLAUDE.md`, 이 문서.
