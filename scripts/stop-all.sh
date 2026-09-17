#!/usr/bin/env bash
# 전체 스택 종료. logs/*.pid 를 먼저 정리하고, 남은 포트 리스너도 정리한다.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOGS="$ROOT/logs"

if [[ -d "$LOGS" ]]; then
  for pidfile in "$LOGS"/*.pid; do
    [[ -e "$pidfile" ]] || continue
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    name="$(basename "$pidfile" .pid)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "종료: $name (pid $pid)"
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  done
fi

# 포트 기준 잔재 정리 (npm run dev 는 자식 프로세스를 남길 수 있음)
for port in 7700 7100 7300 7500 7600 7601 5173 5174; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "포트 $port 정리 (pid $pids)"
    kill $pids 2>/dev/null || true
  fi
done

echo "완료."
