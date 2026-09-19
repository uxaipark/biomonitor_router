#!/usr/bin/env bash
# CPU/alloc baseline for router-server over N seconds: process CPU-seconds (utime+stime), frames & records
# received in the window, PSS. Usage: scripts/cpu_baseline.sh [seconds]
N=${1:-60}; P=$(pgrep -x router-server) || { echo "router not running"; exit 1; }
read -r u0 s0 < <(awk '{print $14, $15}' /proc/$P/stat)
f0=$(curl -s localhost:7300/api/stats | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["gateways"]["frames"], d["total_packets"], d["ingest_connections"])')
sleep "$N"
read -r u1 s1 < <(awk '{print $14, $15}' /proc/$P/stat)
f1=$(curl -s localhost:7300/api/stats | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["gateways"]["frames"], d["total_packets"], d["ingest_connections"])')
set -- $f0; fa=$1; ra=$2; set -- $f1; fb=$1; rb=$2; conn=$3
hz=$(getconf CLK_TCK); cpu=$(python3 -c "print(round((($u1-$u0)+($s1-$s0))/$hz, 2))")
pss=$(awk '/^Pss:/{print int($2/1024)}' /proc/$P/smaps_rollup)
echo "window ${N}s | conn $conn | frames $((fb-fa)) ($(( (fb-fa)/N ))/s) | records $((rb-ra)) ($(( (rb-ra)/N ))/s) | cpu ${cpu}s ($(python3 -c "print(round($cpu/$N*100,1))")% of one core) | us/record $(python3 -c "print(round($cpu*1e6/max(1,$rb-$ra),1))") | PSS ${pss} MB"
