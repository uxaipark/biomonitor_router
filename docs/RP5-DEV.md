# RP5#2 에서 라우터 개발 이어 하기

대상: Raspberry Pi 5, Debian 12 bookworm aarch64, 1 TB SSD. 에뮬레이터는 RP5#1(`dlake`, 192.168.0.125:5445)에서 돌고 있다.

## 1. 설치

```bash
git clone https://github.com/uxaipark/biomonitor_router.git ~/biomonitor_router
cd ~/biomonitor_router
scripts/pi-dev-setup.sh          # apt 의존성 → rustup(stable) → Node 20 → cargo build --release → cargo test
```

* Rust 는 `rust-toolchain.toml` 로 stable 에 고정된다. 첫 릴리스 빌드는 RP5 에서 약 3~5분.
* 웹 화면을 만지지 않으면 `WITH_NODE=0 scripts/pi-dev-setup.sh`.
* SSD 는 `/data` 등에 마운트하고 저장소 루트를 그 아래로 둔다(`ROUTER_STORE_DIR=/data/store`).

## 2. 실행

```bash
export PATH="$HOME/.cargo/bin:$PATH"
ROUTER_INGEST_ADDR=0.0.0.0:9100 ROUTER_HTTP_ADDR=0.0.0.0:7300 \
ROUTER_STORE_DIR=/data/store ROUTER_STORE_MAX_GB=800 \
ROUTER_EMULATOR_ADDR=192.168.0.125:5445 RUST_LOG=info \
~/biomonitor_router/router-server/target/release/router-server
```

에뮬레이터를 이 라우터로 향하게 하려면 RP5#1 에서(또는 GUI 전송 탭에서) `transport.target_ip` 를 RP5#2 주소로, `target_port` 를 9100 으로 바꾼다.
**바꾸기 전에 에뮬레이터 저장소 `docs/HANDOFF.md` 에 적는다** — 에뮬레이터 쪽 관측 스택이 같은 스트림을 보고 있다.

확인:

```bash
curl -s localhost:7300/api/stats | python3 -m json.tool | head -40     # gateways.connected ≈ 2190, anomalies 비어 있음
curl -s localhost:7300/api/gateways/summary
curl -s localhost:7300/api/patches/<patch_id>/verify                     # 저장 파일 CRC
```

## 3. 개발 루프

```bash
cd ~/biomonitor_router/router-server
cargo build --release && cargo test
```

* 파이썬 가짜 게이트웨이 e2e(에뮬레이터 저장소 `emulator/runtime/protocol.py` 의 프레이밍 사용)는 에뮬레이터 저장소를 옆에 클론해 두면 돌릴 수 있다.
  `~/biomonitor_simulator` 에 클론 후 `.venv` 를 만들고(`python3 -m venv .venv && .venv/bin/pip install numpy`), 라우터 저장소의 `scripts/e2e_fake_gateway.py` 를 실행한다.
* 코드 지도: `wire.rs`(프레이밍) → `ingest.rs`(수신) → `gateways.rs`(게이트웨이 표·NACK) / `patch_store.rs`(저장) / `registry.rs`(패치=채널) → `state.rs`(브로드캐스트) → `output.rs`(WS) · `admin_api.rs`(REST).
* 다음 단계와 미결 사항은 `docs/PLAN.md`, 다른 에이전트와의 소통은 `docs/HANDOFF.md`.

## 4. 문제 해결

| 증상 | 확인 |
|---|---|
| `connected` 가 0 | 에뮬레이터 `transport.target_ip/port`, RP5#2 방화벽(`sudo nft list ruleset` 또는 ufw), `ss -ltnp | grep 9100` |
| `anomalies.bad_crc` 증가 | 에뮬레이터·라우터 프로토콜 버전 불일치(헤더 26 B + CRC 트레일러). `GET /api/v1` 의 `stream_protocol.version` 이 3인지 |
| `resend_lost` 증가 | 게이트웨이 keep 버퍼(`transport.resend_keep_s`)보다 늦게 NACK 됨. 네트워크 지연·라우터 정지 시간 확인 |
| `queue_dropped_store` 증가 | 디스크가 못 따라옴. SSD 마운트 여부, `iostat -x 1` |
| 저장소가 상한까지 찼다 | 정상 동작(오래된 시간 파일부터 삭제). `ROUTER_STORE_MAX_GB` 조정 |
