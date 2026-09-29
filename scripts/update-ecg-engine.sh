#!/usr/bin/env bash
# live_ecg 레포에서 최신 엔진을 받아 libecg.so 로 빌드하고 라우터에 설치한다 — 라우터 재빌드·재시작 없음.
#   scripts/update-ecg-engine.sh [live_ecg 경로|git URL] [설치 경로]
# 순서: git pull(또는 clone) → rustc 로 dist/ecg_engine.rs 를 cdylib 로 빌드 → (cc 가 있으면) 적합성 검사 통과 확인
#       → 원자적 교체(rename). 라우터 분석 스레드가 파일 변경(mtime)을 보고 채널을 새 엔진으로 다시 만든다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-${LIVE_ECG_DIR:-$HERE/../live_ecg}}"
DST="${2:-${ROUTER_ECG_LIB:-$HERE/data/engine/libecg.so}}"
if [[ "$SRC" == http* || "$SRC" == git@* ]]; then
  CLONE="$HERE/../live_ecg"; [ -d "$CLONE/.git" ] || git clone -q "$SRC" "$CLONE"; SRC="$CLONE"
fi
[ -f "$SRC/dist/ecg_engine.rs" ] || { echo "엔진 소스가 없습니다: $SRC/dist/ecg_engine.rs" >&2; exit 1; }
if [ -d "$SRC/.git" ]; then git -C "$SRC" pull -q --ff-only || echo "(git pull 실패 — 있는 소스로 진행)" >&2; fi
ID=$(head -1 "$SRC/dist/ecg_engine.rs" | sed 's#^//! *##')
mkdir -p "$(dirname "$DST")"
TMP="$DST.new.$$"
echo "빌드: $ID"
rustc --edition 2021 -O -C panic=unwind --crate-name ecg --crate-type cdylib "$SRC/dist/ecg_engine.rs" -o "$TMP"
if command -v cc >/dev/null 2>&1 && [ -f "$SRC/tools/ecg_conformance.c" ]; then
  CONF="$(dirname "$DST")/ecg_conformance"
  if cc -O2 -I "$SRC/dist" -o "$CONF" "$SRC/tools/ecg_conformance.c" -ldl -lm 2>/dev/null; then
    if "$CONF" "$TMP" >"$(dirname "$DST")/conformance.log" 2>&1; then echo "적합성 검사: 통과"; else echo "적합성 검사 실패 — 설치하지 않음 ($(dirname "$DST")/conformance.log)" >&2; rm -f "$TMP"; exit 2; fi
  else
    echo "(적합성 검사기를 컴파일하지 못해 건너뜀)" >&2
  fi
fi
mv -f "$TMP" "$DST"
echo "$ID" > "$DST.id"
echo "설치: $DST ($(stat -c %s "$DST") bytes) — 라우터가 10초 안에 새 엔진으로 바꿉니다"
