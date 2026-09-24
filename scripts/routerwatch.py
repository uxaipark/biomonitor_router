#!/usr/bin/env python3
"""Long-running router health watch: one JSON line per round (default 600 s) with the round and the running totals.

  scripts/routerwatch.py [rounds]           # 0 (default) = until stopped
  ROUND_S=600 STALL_DEV=nvme0n1 scripts/routerwatch.py >> data/routerwatch.jsonl

Per round: SSD stalls (store queue > 2000) and queue percentiles, disk write MB/s + busy %, router CPU (avg/peak of the
2 s /api/stats window) and system CPU peak, PSS floor/peak (a leak raises the per-round floor; bursts do not), fds,
threads, retained store buffers, drop/lag/loss deltas, SoC temperature + throttle flags, records/s, patients.
Cumulative: least-squares slope of the per-round PSS floors (MB/h), reset when the router process restarts.
"""
import json, os, sys, time, itertools, subprocess, urllib.request
from collections import Counter
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import router_token  # noqa: E402  (bearer token for /api/*)

API = os.environ.get('ROUTER_API', 'http://127.0.0.1:7300')
DUR = int(os.environ.get('ROUND_S', 600))
STALL = 2000
DEV = os.environ.get('STALL_DEV') or next((d for d in ('nvme0n1', 'mmcblk0', 'sda') if os.path.exists('/sys/block/' + d)), 'mmcblk0')
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 else 0
DELTA = ('queue_dropped_wave', 'queue_dropped_db', 'ws_lagged', 'ws_ctrl_dropped', 'total_lost_packets')


def get(path):
    try:
        return json.load(urllib.request.urlopen(router_token.request(API + path), timeout=2))
    except Exception:
        return None


def disk():
    for l in open('/proc/diskstats'):
        f = l.split()
        if f[2] == DEV:
            return int(f[9]) * 512, int(f[12])  # bytes written, ms doing io
    return 0, 0


def pid():
    try:
        return int(subprocess.check_output(['pgrep', '-x', 'router-server']).split()[0])
    except Exception:
        return None


def proc(p):  # PSS MB, fds, threads
    try:
        pss = next(int(l.split()[1]) for l in open(f'/proc/{p}/smaps_rollup') if l.startswith('Pss:')) / 1024
        thr = next(int(l.split()[1]) for l in open(f'/proc/{p}/status') if l.startswith('Threads:'))
        return pss, len(os.listdir(f'/proc/{p}/fd')), thr
    except Exception:
        return None


def temp():
    try:
        return int(open('/sys/class/thermal/thermal_zone0/temp').read()) / 1000
    except Exception:
        return None


def throttled():
    try:
        return subprocess.check_output(['vcgencmd', 'get_throttled'], text=True).strip().split('=')[1]
    except Exception:
        return None


def pct(a, p):
    return a[min(len(a) - 1, int(len(a) * p))] if a else 0


def cpct(c, p):
    n = sum(c.values()); k = int(n * p); acc = 0
    for v in sorted(c):
        acc += c[v]
        if acc > k:
            return v
    return 0


def slope(pts):  # MB/h over [(t_s, MB)]
    if len(pts) < 3:
        return None
    n = len(pts); mx = sum(t for t, _ in pts) / n; my = sum(v for _, v in pts) / n
    den = sum((t - mx) ** 2 for t, _ in pts)
    return round(sum((t - mx) * (v - my) for t, v in pts) / den * 3600, 2) if den else None


T0 = time.time(); P0 = pid()
cum = dict(t=0.0, stalls=0, longest=0.0, wr=0, io=0, rec=0, qs=Counter(), qpeak=0, cpu_peak=0.0, sys_peak=0.0,
           temp_peak=0.0, floors=[], fd0=None, restarts=0, deltas={k: 0 for k in DELTA})
for r in (itertools.count(1) if ROUNDS == 0 else range(1, ROUNDS + 1)):
    t0 = time.time(); d0 = disk(); s0 = None
    while s0 is None:
        s0 = get('/api/stats'); time.sleep(0.2)
    qs = []; stalls = []; st = None; fails = 0; cpu = []; syscpu = []; pss = []; fds = []; thr = []; temps = []
    last_proc = 0
    while time.time() - t0 < DUR:
        s = get('/api/stats'); now = time.time()
        if s is None:
            fails += 1; time.sleep(0.5); continue
        q = s['store_queue']; qs.append(q); cpu.append(s['cpu_process_percent']); syscpu.append(s['cpu_percent'])
        if q > STALL and st is None:
            st = [now, q]
        elif st:
            st[1] = max(st[1], q)
            if q < 200:
                stalls.append((now - st[0], st[1])); st = None
        if now - last_proc >= 5:
            last_proc = now; p = pid()
            if p and p != P0:
                cum['restarts'] += 1; P0 = p; cum['floors'] = []  # new process: restart the leak baseline
            x = proc(p) if p else None
            if x:
                pss.append(x[0]); fds.append(x[1]); thr.append(x[2])
            tt = temp()
            if tt:
                temps.append(tt)
        time.sleep(0.05)
    s1 = get('/api/stats') or s0; d1 = disk(); el = time.time() - t0; sz = get('/api/debug/sizes') or {}
    wr, io = d1[0] - d0[0], d1[1] - d0[1]; rec = s1['total_packets'] - s0['total_packets']
    dl = {k: max(0, s1.get(k, 0) - s0.get(k, 0)) for k in DELTA}
    qs.sort()
    cum['t'] += el; cum['stalls'] += len(stalls); cum['wr'] += wr; cum['io'] += io; cum['rec'] += rec
    cum['qs'].update(qs); cum['qpeak'] = max(cum['qpeak'], qs[-1] if qs else 0)
    if stalls:
        cum['longest'] = max(cum['longest'], max(x[0] for x in stalls))
    cp, sp = max(cpu, default=0), max(syscpu, default=0)
    cum['cpu_peak'] = max(cum['cpu_peak'], cp); cum['sys_peak'] = max(cum['sys_peak'], sp)
    cum['temp_peak'] = max(cum['temp_peak'], max(temps, default=0))
    for k in DELTA:
        cum['deltas'][k] += dl[k]
    floor = min(pss) if pss else None
    if floor is not None:
        cum['floors'].append((time.time() - T0, floor))
    if cum['fd0'] is None and fds:
        cum['fd0'] = fds[0]
    print(json.dumps({
        'ts': time.strftime('%Y-%m-%d %H:%M'), 'round': r,
        'stalls': len(stalls), 'stall_longest_s': round(max((x[0] for x in stalls), default=0), 1),
        'q_p99': pct(qs, .99), 'q_max': qs[-1] if qs else None,
        'disk_mbps': round(wr / el / 1e6, 2), 'disk_busy': round(io / el / 10, 1),
        'cpu_avg': round(sum(cpu) / max(1, len(cpu)), 1), 'cpu_max': cp, 'sys_cpu_max': sp,
        'pss_floor': round(floor, 1) if floor else None, 'pss_max': round(max(pss), 1) if pss else None,
        'fd': fds[-1] if fds else None, 'threads': thr[-1] if thr else None,
        'store_bufs': sz.get('store_patch_bufs'), 'temp_max': max(temps, default=None), 'throttled': throttled(),
        'rec_s': round(rec / el), 'patients': s1['channels_connected'], 'api_fail': fails,
        **{k: dl[k] for k in DELTA},
        'cum': {
            'hours': round(cum['t'] / 3600, 2), 'stalls': cum['stalls'], 'stall_longest_s': round(cum['longest'], 1),
            'q_p99': cpct(cum['qs'], .99), 'q_p999': cpct(cum['qs'], .999), 'q_max': cum['qpeak'],
            'disk_gb': round(cum['wr'] / 1e9, 2), 'disk_busy': round(cum['io'] / cum['t'] / 10, 1),
            'cpu_max': cum['cpu_peak'], 'sys_cpu_max': cum['sys_peak'],
            'pss_floor_first': round(cum['floors'][0][1], 1) if cum['floors'] else None,
            'pss_floor_last': round(cum['floors'][-1][1], 1) if cum['floors'] else None,
            'pss_slope_mb_h': slope(cum['floors']), 'fd_first': cum['fd0'], 'temp_max': cum['temp_peak'],
            'router_restarts': cum['restarts'], 'rec_s': round(cum['rec'] / cum['t']), **cum['deltas'],
        },
    }, ensure_ascii=False), flush=True)
