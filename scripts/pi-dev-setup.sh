#!/usr/bin/env bash
# RP5 (Debian 12 bookworm, aarch64) 개발 환경 준비 — 클론한 저장소 루트에서 실행.
#   git clone https://github.com/uxaipark/biomonitor_router.git ~/biomonitor_router
#   cd ~/biomonitor_router && scripts/pi-dev-setup.sh
# 하는 일: apt 빌드 의존성, rustup(stable, 최소 프로필), Node 20(웹 화면 개발 시), router-server 릴리스 빌드, 스모크 테스트.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "== apt packages"
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential pkg-config git curl ca-certificates python3 python3-venv python3-numpy sqlite3 >/dev/null

if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "== rustup (stable, minimal)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install stable --profile minimal
grep -q '.cargo/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$HOME/.profile"

if [ "${WITH_NODE:-1}" = "1" ] && ! command -v node >/dev/null 2>&1; then
  echo "== Node 20 (web/admin, web/viewer)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

echo "== router-server release build"
( cd router-server && cargo build --release )
( cd router-server && cargo test --release -q 2>&1 | tail -3 )

echo "== data dirs"
mkdir -p "${ROUTER_STORE_DIR:-$ROOT/data/store}" "$ROOT/data"

echo
echo "빌드 완료: $ROOT/router-server/target/release/router-server"
echo "실행 예:  ROUTER_EMULATOR_ADDR=192.168.0.125:5445 ROUTER_STORE_DIR=/data/store ROUTER_STORE_MAX_GB=800 \\"
echo "          $ROOT/router-server/target/release/router-server"
echo "이어서:   docs/HANDOFF.md 를 읽고 docs/PLAN.md 의 다음 단계(P2~)를 진행"
