#!/usr/bin/env bash
# ────────────────────────────────────────────────────────────────────────────
# macOS 전체 스택 기동 (start-all.ps1 의 macOS 대체).
#
# 맥 미니 = 서버 역할: db-api → analysis → router → viewer → admin.
# 에뮬레이터는 기본적으로 기동하지 않는다 (노트북에서 밀어 넣는 구성).
# 로컬 검증용으로 에뮬레이터까지 한 머신에서 돌리려면 --with-emulator.
#
# 각 서비스는 백그라운드 프로세스로 뜨고 logs/<name>.log 에 로그, logs/<name>.pid 에 PID.
# 종료: scripts/stop-all.sh
#
# 사용법:
#   scripts/start-all.sh [--with-emulator] [--channels N] [--emu-host IP] [--no-kill]
#
# 환경변수(플래그와 동일):
#   CHANNELS=200         에뮬레이터/DB 시드 채널 수
#   EMU_HOST=127.0.0.1   db-api 가 호출할 에뮬레이터 제어 API 호스트 (노트북 IP)
#   INGEST_PORT=7700     라우터 ingest 포트 (노트북/게이트웨이가 push 하는 포트)
#
# ⚠ macOS 주의: 포트 7000 은 Control Center(AirPlay Receiver)가 점유하므로
#   ingest 는 7700 을 기본값으로 쓴다 (원본 문서의 7000 대체). 에뮬레이터/게이트웨이도
#   이 포트로 접속해야 한다.
# ────────────────────────────────────────────────────────────────────────────
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

CHANNELS="${CHANNELS:-200}"
EMU_HOST="${EMU_HOST:-127.0.0.1}"
INGEST_PORT="${INGEST_PORT:-7700}"
WITH_EMULATOR=0
NO_KILL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-emulator) WITH_EMULATOR=1; shift ;;
    --channels)      CHANNELS="$2"; shift 2 ;;
    --emu-host)      EMU_HOST="$2"; shift 2 ;;
    --no-kill)       NO_KILL=1; shift ;;
    *) echo "알 수 없는 인자: $1"; exit 1 ;;
  esac
done

PY="$(command -v python3)"
NPM="$(command -v npm)"
ROUTER_BIN="$ROOT/router-server/target/release/router-server"

# ---- 0) 기존 인스턴스 정리 (포트 리스너 기준) ----
if [[ "$NO_KILL" -eq 0 ]]; then
  for port in "$INGEST_PORT" 7100 7300 7500 7600 7601 5173 5174; do
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "기존 서비스 종료: 포트 $port (pid $pids)"
      kill $pids 2>/dev/null || true
    fi
  done
  sleep 1
fi

# ---- 라우터 바이너리 확인 (없으면 빌드) ----
if [[ ! -x "$ROUTER_BIN" ]]; then
  echo "router-server 릴리스 빌드 중... (cargo 필요)"
  ( cd "$ROOT/router-server" && cargo build --release )
fi

start() {  # start <name> <workdir> <cmd...>
  local name="$1" workdir="$2"; shift 2
  echo "기동: $name"
  ( cd "$workdir" && exec "$@" ) >"$LOGS/$name.log" 2>&1 &
  echo $! > "$LOGS/$name.pid"
}

# ---- 1) DB API (HTTP 7600 / ingest 7601) ----
#   EMU_HOST 는 쉼표로 여러 개 지정 가능 (예: "192.168.1.71,192.168.1.166")
#   → db-api 가 순서대로 시도해 성공하는 곳을 쓴다.
EMU_URLS="$(echo "$EMU_HOST" | awk -F, '{for(i=1;i<=NF;i++){gsub(/ /,"",$i); printf "%shttp://%s:7500", (i>1?",":""), $i}}')"
start db-api "$ROOT/db-api" "$PY" main.py --emulator-api "$EMU_URLS"

# ---- 2) 분석 서버 (TCP 7100) ----
start analysis-server "$ROOT/analysis-server" "$PY" main.py

# ---- 3) 라우터 (ingest $INGEST_PORT, http/ws 7300) ----
#   macOS: 7000 은 AirPlay Receiver 점유 → ROUTER_INGEST_ADDR 로 우회
export ROUTER_INGEST_ADDR="0.0.0.0:$INGEST_PORT"
start router-server "$ROOT/router-server" "$ROUTER_BIN"

sleep 3

# ---- 4) (선택) 로컬 에뮬레이터 — 검증용. 실제로는 노트북에서 push. ----
if [[ "$WITH_EMULATOR" -eq 1 ]]; then
  start emulator "$ROOT/emulator" "$PY" main.py --channels "$CHANNELS" --port "$INGEST_PORT"
fi

# ---- 5) 뷰어(5173) / 어드민(5174) ----
#   동봉 node_modules 는 Windows 에서 만들어져 .bin 실행권한이 없을 수 있다 → 복구.
for app in viewer admin; do
  chmod +x "$ROOT/web/$app/node_modules/.bin/"* 2>/dev/null || true
  chmod +x "$ROOT/web/$app/node_modules/@esbuild/darwin-arm64/bin/esbuild" 2>/dev/null || true
done
start viewer "$ROOT/web/viewer" "$NPM" run dev
start admin  "$ROOT/web/admin"  "$NPM" run dev

# ---- 6) 헬스체크 ----
echo ""
echo "기동 확인 중 (라우터 :7300)..."
health=""
for _ in $(seq 1 45); do
  sleep 2
  if health="$(curl -fsS --max-time 2 http://localhost:7300/api/health 2>/dev/null)"; then
    break
  fi
done

LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo localhost)"
echo ""
if [[ -n "$health" ]]; then
  echo "라우터 정상: $health"
else
  echo "경고: 라우터(:7300) 응답 없음 — logs/router-server.log 확인"
fi
echo ""
echo "모든 서비스 시작됨 (로그: $LOGS/*.log):"
echo "  뷰어    : http://$LAN_IP:5173   (localhost:5173)"
echo "  어드민  : http://$LAN_IP:5174   (localhost:5174)"
echo "  라우터  : http://$LAN_IP:7300/api/health"
echo "  DB API  : http://$LAN_IP:7600/health"
echo "  ingest  : $LAN_IP:$INGEST_PORT  ← 노트북 에뮬레이터/게이트웨이가 push (macOS: 7000 대신 $INGEST_PORT)"
if [[ "$WITH_EMULATOR" -eq 0 ]]; then
  echo ""
  echo "노트북(에뮬레이터)에서:"
  echo "  python main.py --host $LAN_IP --port $INGEST_PORT --db-api http://$LAN_IP:7600"
  echo "그리고 db-api 가 에뮬레이터를 호출하도록 EMU_HOST=<노트북IP> 로 이 스크립트를 재기동."
fi
