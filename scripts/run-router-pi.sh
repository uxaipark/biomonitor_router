#!/usr/bin/env bash
# RP5#2 개발용 실행 스크립트: 기존 인스턴스를 내리고 릴리스 바이너리를 백그라운드(setsid)로 띄운다.
# 로그: data/router.log. systemd 유닛(P5)이 생기기 전까지 쓴다.
set -euo pipefail
cd "$(dirname "$0")/.."
pkill -x router-server 2>/dev/null && sleep 1 || true
mkdir -p data/store
export ROUTER_INGEST_ADDR=${ROUTER_INGEST_ADDR:-0.0.0.0:9100}
export ROUTER_HTTP_ADDR=${ROUTER_HTTP_ADDR:-0.0.0.0:7300}
export ROUTER_STORE_DIR=${ROUTER_STORE_DIR:-$PWD/data/store}
export ROUTER_STORE_MAX_GB=${ROUTER_STORE_MAX_GB:-200}
export ROUTER_STORE_GZIP=${ROUTER_STORE_GZIP:-0}
export ROUTER_EMULATOR_ADDR=${ROUTER_EMULATOR_ADDR:-192.168.0.125:5445}
export ROUTER_WEB_DIR=${ROUTER_WEB_DIR:-$PWD/web/console/dist}
export ROUTER_DB_PATH=${ROUTER_DB_PATH:-$PWD/data/router.db}
export ROUTER_GROUPS_PATH=${ROUTER_GROUPS_PATH:-$PWD/data/groups.json}
export ROUTER_DISPLAYS_PATH=${ROUTER_DISPLAYS_PATH:-$PWD/data/displays.json}
[ -e data/groups.json ] || cp router-server/groups.json data/groups.json
[ -e data/displays.json ] || cp router-server/displays.json data/displays.json
export RUST_LOG=${RUST_LOG:-info}
# mimalloc: return freed pages to the OS promptly (default 10 ms delay keeps burst allocations — store-queue backlogs
# during SD stalls, hour-file reads — as a raised RSS floor for a long time)
export MIMALLOC_PURGE_DELAY=${MIMALLOC_PURGE_DELAY:-0}
setsid nohup router-server/target/release/router-server > data/router.log 2>&1 < /dev/null &
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${ROUTER_HTTP_ADDR##*:}/api/health" >/dev/null && { echo "router-server up ($ROUTER_HTTP_ADDR)"; exit 0; }; sleep 1; done
echo "router-server did not come up; see data/router.log" >&2; tail -20 data/router.log >&2; exit 1
