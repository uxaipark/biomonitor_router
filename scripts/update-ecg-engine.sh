#!/usr/bin/env bash
# live_ecg 레포에서 최신 엔진을 받아 libecg.so 로 빌드·검사하고 보관함(data/engine/versions/<src해시>/)에 등록한 뒤 활성화한다.
# 라우터는 재빌드·재시작 없이 10초 안에 새 엔진으로 옮겨 간다. 이전 버전은 보관함에 남아 관리 페이지에서 되돌릴 수 있다.
#   scripts/update-ecg-engine.sh [live_ecg 경로|git URL] [활성 파일 경로]      (--no-activate: 보관함 등록만)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ACTIVATE=1; ARGS=()
for a in "$@"; do case "$a" in --no-activate) ACTIVATE=0;; *) ARGS+=("$a");; esac; done
SRC="${ARGS[0]:-${LIVE_ECG_DIR:-$HERE/../live_ecg}}"
DST="${ARGS[1]:-${ROUTER_ECG_LIB:-$HERE/data/engine/libecg.so}}"
if [[ "$SRC" == http* || "$SRC" == git@* ]]; then
  CLONE="$HERE/../live_ecg"; [ -d "$CLONE/.git" ] || git clone -q "$SRC" "$CLONE"; SRC="$CLONE"
fi
[ -f "$SRC/dist/ecg_engine.rs" ] || { echo "엔진 소스가 없습니다: $SRC/dist/ecg_engine.rs" >&2; exit 1; }
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q --ff-only || echo "(git pull 실패 — 있는 소스로 진행)" >&2; fi
ID=$(head -1 "$SRC/dist/ecg_engine.rs" | sed 's#^//! *##; s#: every engine crate in one file\.##')
KEY=$(echo "$ID" | sed -n 's/.* src \([0-9a-f]*\).*/\1/p'); [ -n "$KEY" ] || KEY=$(echo "$ID" | tr -c 'A-Za-z0-9.-' '_')
COMMIT=$(git -C "$SRC" rev-parse HEAD 2>/dev/null || echo "")
VDIR="$(dirname "$DST")/versions/$KEY"
mkdir -p "$VDIR"
if [ -f "$VDIR/libecg.so" ] && [ "$ACTIVATE" = 1 ] && cmp -s "$VDIR/libecg.so" "$DST" 2>/dev/null; then
  echo "이미 최신 엔진이 활성입니다: $ID"; exit 0
fi
TMP="$VDIR/libecg.so.new.$$"
echo "빌드: $ID"
rustc --edition 2021 -O -C panic=unwind --crate-name ecg --crate-type cdylib "$SRC/dist/ecg_engine.rs" -o "$TMP"
CONF_OK=null
if command -v cc >/dev/null 2>&1 && [ -f "$SRC/tools/ecg_conformance.c" ]; then
  CONF="$(dirname "$DST")/ecg_conformance"
  if cc -O2 -I "$SRC/dist" -o "$CONF" "$SRC/tools/ecg_conformance.c" -ldl -lm 2>/dev/null; then
    if "$CONF" "$TMP" >"$VDIR/conformance.log" 2>&1; then echo "적합성 검사: 통과"; CONF_OK=true; else echo "적합성 검사 실패 — 등록하지 않음 ($VDIR/conformance.log)" >&2; rm -f "$TMP"; exit 2; fi
  else
    echo "(적합성 검사기를 컴파일하지 못해 건너뜀)" >&2
  fi
fi
mv -f "$TMP" "$VDIR/libecg.so"
[ -f "$SRC/reports/PERFORMANCE.md" ] && cp -f "$SRC/reports/PERFORMANCE.md" "$VDIR/perf.md"
[ -f "$SRC/README.md" ] && cp -f "$SRC/README.md" "$VDIR/notes.md"
cat > "$VDIR/meta.json" <<JSON
{ "id": "$ID", "key": "$KEY", "built_ms": $(date +%s%3N), "commit": "$COMMIT", "source": "update-ecg-engine.sh", "conformance": $CONF_OK, "size": $(stat -c %s "$VDIR/libecg.so"), "abi": "1.x", "host": "$(hostname)" }
JSON
echo "보관함 등록: $VDIR"
if [ "$ACTIVATE" = 1 ]; then
  cp -f "$VDIR/libecg.so" "$DST.new.$$" && mv -f "$DST.new.$$" "$DST"
  echo "$ID" > "$DST.id"
  echo "활성화: $DST — 라우터가 10초 안에 새 엔진으로 바꿉니다 (관리 › ECG 분석 엔진 페이지에서 이력·되돌리기)"
fi
