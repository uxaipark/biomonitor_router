#!/usr/bin/env bash
# RP5 (Debian 12 bookworm, aarch64) 개발 환경 준비 — 클론한 저장소 루트에서 실행.
#   git clone https://github.com/uxaipark/biomonitor_router.git ~/biomonitor_router
#   cd ~/biomonitor_router && scripts/pi-dev-setup.sh
# 하는 일: apt 빌드 의존성, rustup(stable, 최소 프로필), Node 20, router-server 릴리스 빌드·테스트, 웹 콘솔 빌드.
# Debian 12 · Ubuntu 22.04/24.04 (x86_64 · aarch64) 공통. 실행은 scripts/run-router-pi.sh (포트 9100 게이트웨이, 7300 웹/API).
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

echo "== apt packages"
sudo apt-get update -qq
sudo apt-get install -y -qq build-essential pkg-config git curl ca-certificates python3 python3-venv python3-numpy sqlite3 smbclient >/dev/null  # smbclient: 파형 백업 SMB 대상

if ! command -v cargo >/dev/null 2>&1 && [ ! -x "$HOME/.cargo/bin/cargo" ]; then
  echo "== rustup (stable, minimal)"
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
fi
export PATH="$HOME/.cargo/bin:$PATH"
rustup show active-toolchain >/dev/null 2>&1 || rustup toolchain install stable --profile minimal
grep -q '.cargo/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.cargo/bin:$PATH"' >> "$HOME/.profile"

if [ "${WITH_NODE:-1}" = "1" ] && ! command -v node >/dev/null 2>&1; then
  echo "== Node 20 (web/console)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

echo "== router-server release build"
( cd router-server && cargo build --release )
( cd router-server && cargo test --release -q 2>&1 | tail -3 )

if command -v npm >/dev/null 2>&1; then
  echo "== web console build (web/console/dist — 라우터가 / 로 서빙)"
  ( cd web/console && npm ci --no-audit --no-fund --loglevel=error && npm run build >/dev/null )
else
  echo "!! npm 없음 — 웹 콘솔을 빌드하지 못했습니다 (API 만 동작). WITH_NODE=1 로 다시 실행하세요"
fi

echo "== data dirs"
mkdir -p "${ROUTER_STORE_DIR:-$ROOT/data/store}" "$ROOT/data"

echo
echo "빌드 완료: $ROOT/router-server/target/release/router-server"
echo "실행:     scripts/run-router-pi.sh   (에뮬레이터 주소는 ROUTER_EMULATOR_ADDR, 기본 192.168.0.125:5445)"
echo "직접 실행 예:  ROUTER_EMULATOR_ADDR=192.168.0.125:5445 ROUTER_STORE_DIR=/data/store ROUTER_STORE_MAX_GB=800 \\"
echo "          $ROOT/router-server/target/release/router-server"
echo "이어서:   docs/HANDOFF.md 를 읽고 docs/PLAN.md 의 다음 단계(P2~)를 진행"
