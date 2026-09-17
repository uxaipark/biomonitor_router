# ECG 소켓 채널 라우터 (테스트 스택)

무선 ECG 패치를 착용한 입원 환자를 실시간 모니터링하기 위한 **소켓 기반 채널 라우터 테스트 스택**입니다.
수백 개 입력 채널(패치)의 파형 스트리밍을 분석 서버 경유로 HR/부정맥 이벤트와 **seq 기준 싱크를 맞춰 병합**하고,
건물/층/병동/구역/병실/주치의/진료과목/간호사 기준의 **동적 그룹**과 **게이트웨이/채널 단위 구독**으로 브로드캐스팅합니다.
환자 이동(도보 여정)·예약(검사/진료)·장애 시뮬레이션·파형 파일 보관·환자 리포트까지
병원 관제에 필요한 흐름 전체를 데모할 수 있습니다.

## 처음 받으신 분을 위한 안내

1. 아래 [빠른 시작](#빠른-시작)으로 전체 스택을 띄웁니다 (6개 서비스가 각자 창으로 열립니다).
2. 어드민(http://localhost:5174)을 열고 **테스트 > DB 리셋**을 한 번 실행하세요.
   병원별 SQLite DB(각 200채널 + 패치 재고 + 기본 그룹 10개)가 새로 만들어집니다.
3. 볼거리 동선:
   - **중앙관제 > ECG Channel Router Console** — 시스템 카드/이벤트/그룹/채널 테이블
   - **중앙관제 > ECG Patch Map** — 건축 평면도 위 실시간 환자 위치.
     우측 미니맵 최상단 **"이동 중" 카드** 클릭 → 동선 타임라인
   - 파형 모달(환자/게이트웨이 클릭)에서 **파형을 클릭** → 환자 리포트
     (얼굴/병변/치료 이력/저장 파형 전문 뷰어)
   - **중앙관제 > 예약 목록 / 타임 로그 / 패치 관리**
4. 상세 문서:

| 문서 | 내용 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 시스템 설계: 데이터 흐름, 싱크, 그룹핑, 다병원 DB, 예약, 파형 저장, 장애 시뮬레이션 |
| [API.md](API.md) | 와이어 프로토콜과 전체 API 레퍼런스 (라우터/에뮬레이터/DB API) |
| [FRONTEND.md](FRONTEND.md) | 어드민 전 페이지 가이드, 평면도·템플릿 JSON 스키마, 리포트/동선 뷰어 |

## 구성 요소

| 디렉토리 | 기술 | 역할 | 포트 |
|---|---|---|---|
| `router-server/` | Rust (tokio/axum) | 채널 라우터: ingest, 서큘러 버퍼, 분석 병합, 그룹핑, WS 출력, REST, **파형 파일 저장(8h 세그먼트)**, DB push 중계 | 7000 (ingest), 7300 (WS/API) |
| `analysis-server/` | Python (stdlib) | 목업 분석: 100ms 지연, HR 산출, 부정맥/해제 이벤트, 지연·스톨·크래시(재기동 15~45초) 시뮬레이션 | 7100 |
| `emulator/` | Python (stdlib) | ECG 패치 에뮬레이터: **1만 명 프로필 자체 보유**, DB 명단 기반 채널 생성, 게이트웨이/이동/예약/장애 시뮬레이션, 제어 API | 7500 (제어) |
| `db-api/` | Python (stdlib + sqlite3) | **병원별 SQLite** 영속화: 환자/패치 재고/예약/시계열 메트릭. 라우터가 실시간 push | 7600 (REST), 7601 (ingest) |
| `web/viewer/` | React (Vite) | 그룹별 실시간 모니터링 (스윕 파형, 자동 밀도) | 5173 |
| `web/admin/` | React (Vite) | 관제 콘솔 + Patch Map + 동선 타임라인 + 예약 목록 + 패치 관리 + 타임 로그 + 환자 리포트 | 5174 |

**역할 분담 원칙** — ① 정적/영속 정보는 DB(SQLite), ② 에뮬레이터가 만드는 다이내믹 데이터는
라우터가 ingest 로 받아 DB 로 중계, ③ 고속 시계열(파형)은 라우터가 파일로 직접 보관,
④ 에뮬레이터는 DB 와 독립 동작 가능하도록 필요한 데이터(프로필 명단)를 자체 보유.

## 요구 사항

- **Rust** (windows-gnu 툴체인) — `router-server/.cargo/config.toml` 이
  WinLibs mingw(`%USERPROFILE%\.local\mingw64`)의 gcc/dlltool 을 사용하도록 설정됨.
  ⚠ 재빌드 전 실행 중인 `router-server.exe` 를 먼저 종료해야 함 (파일 잠금)
- **Python 3.10+** — 서비스는 표준 라이브러리만 사용.
  (선택) 프로필/얼굴 생성 스크립트만 `pip install python-avatars resvg-py` 필요
- **Node.js 18+** — `web/viewer`, `web/admin` 에서 `npm install` 1회

## 빠른 시작

**처음 받은 컴퓨터**: 루트의 **`setup-and-run.bat` 더블클릭** 한 번이면 됩니다
(필수 프로그램 확인 → npm install → 6개 서비스 순차 기동. 실행 정책 설정 불필요).
라우터는 동봉된 `router-server\bin\router-server.exe` 를 사용하므로 **Rust 설치가 필요 없습니다.**

이미 설치된 환경에서 재기동만 할 때:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-all.ps1
```

- 채널은 **DB(SQLite) 명단 기반**으로 생성됩니다. DB 가 비어 있을 때만 `-Channels`(기본 200)개 생성 폴백.
- 개별 실행 (순서 무관 — 라우터가 분석 서버/DB API 에 자동 재접속):

```powershell
cd db-api          ; python main.py                                   # DB API (SQLite)
cd analysis-server ; python main.py                                   # 분석 서버
cd router-server   ; cargo run --release                              # 라우터
cd emulator        ; python main.py --hospital seoul-a                # 에뮬레이터
cd web\viewer      ; npm install ; npm run dev                        # 뷰어   http://localhost:5173
cd web\admin       ; npm install ; npm run dev                        # 어드민 http://localhost:5174
```

## 핵심 기능 요약

- **싱크 병합**: 채널별 서큘러 버퍼(512패킷)에 원본 파형을 보관, 분석 응답의 seq 로 병합.
  분석 지연 시 500ms 타임아웃 플러시로 파형이 밀리지 않음. 분석 다운 시 패스스루.
- **동적 그룹핑**: 속성 criteria(키 간 AND, 값 간 OR) + 수동 include/exclude, 저장 즉시 join/leave 전파.
  기본 `all` 그룹은 붙박이. **DB 리셋 시 실제 분포 기반 기본 그룹 10개 자동 시딩**
  (병실→구역→담당자→층→병동→진료과→건물 규모 순, 주요 사용자 지정).
- **병원별 SQLite**: `hospital-<id>.db` 분리, 패치 번호는 병원 프리픽스(SA-/BB-)로 전역 유일.
  **병원 전환은 재생성이 아니라 일시 중단(suspend)** — 이전 병원 데이터는 DB 에 그대로 보존되고
  복귀 시 동일 명단이 복원됨.
- **환자 프로필 1만 명**: 성별/출생 연대별 다빈도 한국 이름, 생년월일/혈액형/병변,
  **성별·연령 구분 가능한 얼굴 아바타 1만 장**(Avataaars, 시드 고정) — 에뮬레이터 자체 보유.
- **예약(검사/진료) 시나리오**: 에뮬레이터가 랜덤 예약 생성 → 시간이 되면 검사실 이동 →
  소요 시간이 정해져 있어 **복귀 예상 시각 추정 가능** → 복귀 기록. 전 과정 DB 연동.
- **동선 타임라인**: 이동 중/이동 예정/동선 기록 3탭 + 환자 검색. 과거 이력(최근 4구간) +
  현재 위치 + 예약 일정 칩. 임의 이동(화장실/산책/병문안)은 복귀 예측을 표시하지 않음(근거 없음).
- **파형 파일 보관**: 라우터가 채널별 **8시간 세그먼트 바이너리 파일**로 저장
  (8시간이 차면 다음 파일 생성, **삭제 없음**). REST 로 구간 조회(원본/요약).
- **환자 리포트**: 파형 클릭 → 얼굴/인적사항/병변/치료 이력 + **ECG 모눈(그래프 페이퍼) 전문 뷰어**
  (개요 클릭=15초 상세, 블록 드래그=구간 전체, 좌우 드래그 팬).
- **장애 시뮬레이션 (패치/게이트웨이 레벨만)**: 게이트웨이 1~2분 장애 + 동구역 간섭(일부 패치),
  동시 장애 상한 5%. 분석 엔진 지연/스톨/크래시(다운타임 실측 누적). 전체 네트워크 장애 없음.

## 상태 모델

채널 표시 상태 우선순위: **해제** (소켓 끊김) > **수신중단** (소켓 유지, 3초 이상 무패킷 — 게이트웨이 장애 등)
> **약신호** > **이동 중** > **정상**. 상태는 항상 색 + 텍스트 라벨로 이중 표기됩니다.

## 부가 도구

| 도구 | 용도 |
|---|---|
| `scripts/start-all.ps1` | 전체 스택 기동 (기존 프로세스 정리 → 6개 서비스 창 → 헬스체크) |
| `scripts/gen-profiles.py` | 프로필 1만 명 + 얼굴 아바타 1만 장 생성 (`pip install python-avatars resvg-py`) |
| `scripts/avatar_gen.py` | 아바타 스타일 매핑 모듈 (성별/연령 → Avataaars 조합) |
| `scripts/update-prompt-log.mjs` | 이 프로젝트의 프롬프트를 `prompt-logs/YYYY-MM-DD.log` 로 추출 |
| `router-server/groups.json`, `displays.json` | 그룹/디스플레이 설정 영속화 (자동 생성) |
| `router-server/waves/` | 파형 세그먼트 파일 (자동 생성) |
| `db-api/hospital-*.db` | 병원별 SQLite (테스트 > DB 리셋으로 재생성) |
