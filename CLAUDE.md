# 에이전트 공통 지침 (MAC · RP5#2)

- 세션을 시작하면 먼저 `docs/HANDOFF.md`를 읽는다. 작업을 끝내면 그 문서의 해당 섹션 맨 아래에 항목을 추가하고(형식 `- [YYYY-MM-DD HH:MM MAC|RP5] ...`) 커밋·푸시한다. 남의 항목은 지우지 않는다.
- 자신이 어느 쪽인지는 `hostname`으로 안다: `dlake` = RP5#1(에뮬레이터, 이 저장소의 대상 아님), 그 외 라즈베리파이 = RP5#2(라우터), 맥 = MAC.
- 로드맵은 `docs/PLAN.md`(P0~P5). 프로토콜 계약은 에뮬레이터 저장소(`uxaipark/biomonitor_simulator`)의 `emulator/runtime/protocol.py`가 원본이고, 이 저장소의 `docs/contract/*.json`은 스냅샷이다. 프로토콜·EMR API를 바꿔야 하면 에뮬레이터 저장소 `docs/HANDOFF.md`에 먼저 적는다.
- 변경 후 `router-server`에서 `cargo build --release && cargo test`를 돌린다. 맥에서는 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk CC=/Library/Developer/CommandLineTools/usr/bin/cc`를 앞에 붙인다(Xcode 라이선스 문제). RP5는 그대로 `cargo`.
- 저장 형식(`patch_store.rs` 항목 레이아웃)과 와이어 형식(`wire.rs`)을 바꾸면 에뮬레이터 저장소의 `router/store.py`·`verify.py`와 `README`·`docs/RP5-DEV.md`를 같이 맞춘다.
- 실행 중인 라우터의 상태를 바꾸는 작업(재시작, 저장소 리셋, 설정 변경)은 HANDOFF.md에 남긴다. `data/`, `target/`, `node_modules/`는 커밋하지 않는다.
- 커밋 메시지 끝: `Co-Authored-By: Claude <model> <noreply@anthropic.com>` 트레일러 유지.
