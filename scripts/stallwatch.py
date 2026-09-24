#!/usr/bin/env python3
"""Watch the router store queue and the SD/SSD write stats together: prints every stall (queue > 2000) with
its duration, peak depth and how much was written during it, then a summary (MB/s, device busy %, records/s).

  scripts/stallwatch.py [seconds]      # default 180
"""
import json, os, time, urllib.request, sys
import os as _os, sys as _sys; _sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
import router_token  # noqa: E402  (bearer token for /api/*)
# SD Pi: mmcblk0, SSD Pi: nvme0n1 (override with STALL_DEV=sda etc.)
DEV=os.environ.get('STALL_DEV') or next((d for d in ('mmcblk0','nvme0n1','sda') if os.path.exists('/sys/block/'+d)), 'mmcblk0')
def disk():
    for l in open('/proc/diskstats'):
        f=l.split()
        if f[2]==DEV:
            # 6: sectors read, 10: sectors written, 13: ms doing io, 7/11: ms reading/writing
            return dict(wr_sect=int(f[9]), wr_ms=int(f[10]), io_ms=int(f[12]), wr_ios=int(f[7]))
def q():
    try:
        s=json.load(urllib.request.urlopen(router_token.request('http://127.0.0.1:7300/api/stats'), timeout=2))
        return s['store_queue'], s['total_packets']
    except Exception:
        return None, None
dur=int(sys.argv[1]) if len(sys.argv)>1 else 180
t0=time.time(); d0=disk(); p0=None
stall=None; stalls=[]; last=t0; samples=0; wr_total=0
print(f"watching store queue + {DEV} writes for {dur}s (stall = queue > 2000)")
while time.time()-t0 < dur:
    qd, pk = q()
    now=time.time()
    if qd is None: time.sleep(0.05); continue
    if p0 is None: p0=pk
    samples+=1
    if qd > 2000 and stall is None:
        stall={'t': now, 'peak': qd, 'd': disk()}
    elif stall:
        stall['peak']=max(stall['peak'], qd)
        if qd < 200:
            d1=disk()
            sec=(d1['wr_sect']-stall['d']['wr_sect'])*512
            stalls.append((time.strftime('%H:%M:%S', time.localtime(stall['t'])), now-stall['t'], stall['peak'], sec,
                           d1['wr_ms']-stall['d']['wr_ms'], d1['wr_ios']-stall['d']['wr_ios']))
            print("  stall %s  %.2fs  peak queue %d  wrote %.1f MB in %d write-ops (device busy %d ms)" % (stalls[-1][0], stalls[-1][1], stalls[-1][2], sec/1e6, stalls[-1][5], stalls[-1][4]))
            stall=None
    time.sleep(0.05)
d1=disk(); el=time.time()-t0
print("\nover %.0f s: wrote %.1f MB (%.2f MB/s) in %d ops, device busy %.1f%% of the time" % (
    el, (d1['wr_sect']-d0['wr_sect'])*512/1e6, (d1['wr_sect']-d0['wr_sect'])*512/1e6/el,
    d1['wr_ios']-d0['wr_ios'], (d1['io_ms']-d0['io_ms'])/10/el))
print("records: %.0f/s" % ((pk-p0)/el))
print("stalls: %d in %.0f s" % (len(stalls), el))
if stalls:
    print("  longest %.2f s, largest peak %d, most written in one stall %.1f MB" % (max(s[1] for s in stalls), max(s[2] for s in stalls), max(s[3] for s in stalls)/1e6))
