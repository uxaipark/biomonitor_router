#!/usr/bin/env python3
"""Long-run resource watch for router-server: memory (PSS/RSS), fds, threads, socket states per port,
registry/gateway row counts, pending NACKs, queue drops. One CSV line per minute; `report` prints slopes.

  scripts/leakwatch.py run   [--every 60] [--out data/leakwatch.csv]      # sampler (run detached)
  scripts/leakwatch.py report [--hours 6] [--out data/leakwatch.csv]      # slopes + current vs first sample
"""
import argparse, csv, json, os, re, subprocess, sys, time, urllib.request

FIELDS = ["ts", "uptime_s", "pid", "pss_mb", "rss_mb", "anon_mb", "fds", "threads",
          "in_estab", "in_close_wait", "in_fin_wait", "in_other", "in_peers",
          "ws_estab", "ws_close_wait", "listen_9100_backlog",
          "gw_rows", "gw_conn", "ch_rows", "ch_conn", "ingest_conns", "resend_pending", "store_mb", "queue_drop", "store_queue",
          "events", "alarms_active", "alarm_hist", "rx_mb", "cpu_pct", "sys_avail_mb",
          "reg_pending", "store_bufs", "store_buffered_mb", "alarm_pending", "alarm_last_seen", "emr_cache_mb", "live_index",
          "cpu_proc", "ws_lagged", "ws_sessions", "ws_subs"]


def router_pid():
    try:
        return int(subprocess.check_output(["pgrep", "-x", "router-server"]).split()[0])
    except Exception:
        return None


def smaps(pid):
    d = {}
    try:
        for line in open(f"/proc/{pid}/smaps_rollup"):
            k, _, v = line.partition(":")
            v = v.strip().split()
            if v and v[-1] == "kB":
                d[k] = int(v[0]) / 1024
    except OSError:
        pass
    return d


def sockets(port):
    """Counts by TCP state for sockets whose local port is `port` (server side)."""
    out = subprocess.run(["ss", "-Htan", f"( sport = :{port} )"], capture_output=True, text=True).stdout
    c = {"ESTAB": 0, "CLOSE-WAIT": 0, "FIN-WAIT": 0, "other": 0, "peers": set(), "backlog": 0}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        st = parts[0]
        if st == "LISTEN":
            c["backlog"] = int(parts[1])  # Recv-Q on a listener = current accept backlog
            continue
        if st == "ESTAB":
            c["ESTAB"] += 1
            c["peers"].add(parts[4].rsplit(":", 1)[0])
        elif st == "CLOSE-WAIT":
            c["CLOSE-WAIT"] += 1
        elif st.startswith("FIN-WAIT"):
            c["FIN-WAIT"] += 1
        else:
            c["other"] += 1
    return c


def api(path):
    try:
        return json.load(urllib.request.urlopen(f"http://127.0.0.1:7300{path}", timeout=5))
    except Exception:
        return None


def sample():
    pid = router_pid()
    st = api("/api/stats") or {}
    g = st.get("gateways", {})
    al = api("/api/alarms") or {}
    hist = api("/api/alarms/history?limit=500") or []
    ev = api("/api/events") or []
    dbg = api("/api/debug/sizes") or {}
    sm = smaps(pid) if pid else {}
    s9100, s7300 = sockets(9100), sockets(7300)
    avail = 0
    try:
        for line in open("/proc/meminfo"):
            if line.startswith("MemAvailable"):
                avail = int(line.split()[1]) / 1024
    except OSError:
        pass
    fds = threads = 0
    if pid:
        try:
            fds = len(os.listdir(f"/proc/{pid}/fd"))
            threads = len(os.listdir(f"/proc/{pid}/task"))
        except OSError:
            pass
    return dict(ts=int(time.time()), uptime_s=st.get("uptime_s", 0), pid=pid or 0,
                pss_mb=round(sm.get("Pss", 0), 1), rss_mb=round(sm.get("Rss", 0), 1), anon_mb=round(sm.get("Anonymous", 0), 1),
                fds=fds, threads=threads,
                in_estab=s9100["ESTAB"], in_close_wait=s9100["CLOSE-WAIT"], in_fin_wait=s9100["FIN-WAIT"], in_other=s9100["other"], in_peers=len(s9100["peers"]),
                ws_estab=s7300["ESTAB"], ws_close_wait=s7300["CLOSE-WAIT"], listen_9100_backlog=s9100["backlog"],
                gw_rows=g.get("gateways", 0), gw_conn=g.get("connected", 0), ch_rows=st.get("channel_count", 0), ch_conn=st.get("channels_connected", 0),
                ingest_conns=st.get("ingest_connections", 0), resend_pending=g.get("resend_pending", 0),
                store_mb=round(st.get("wave_store_bytes", 0) / 2**20), queue_drop=st.get("queue_dropped_wave", 0), store_queue=st.get("store_queue", 0),
                events=len(ev), alarms_active=(al.get("summary") or {}).get("active", 0), alarm_hist=len(hist),
                rx_mb=round(st.get("total_bytes", 0) / 2**20), cpu_pct=round(st.get("cpu_percent", 0), 1), sys_avail_mb=round(avail),
                reg_pending=dbg.get("registry_pending_packets", 0), store_bufs=dbg.get("store_patch_bufs", 0), store_buffered_mb=round(dbg.get("store_buffered_bytes", 0) / 2**20, 1),
                alarm_pending=(dbg.get("alarms") or {}).get("pending", 0), alarm_last_seen=(dbg.get("alarms") or {}).get("last_seen", 0), emr_cache_mb=round(dbg.get("emr_cache_bytes", 0) / 2**20, 1), live_index=dbg.get("live_index_rows", 0),
                cpu_proc=round(st.get("cpu_process_percent", 0), 1), ws_lagged=st.get("ws_lagged", 0), ws_sessions=st.get("ws_sessions", 0), ws_subs=st.get("ws_subscribed_channels", 0))


def run(args):
    new = not os.path.exists(args.out) or os.path.getsize(args.out) == 0
    with open(args.out, "a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        if new:
            w.writeheader()
        while True:
            try:
                w.writerow(sample()); f.flush()
            except Exception as e:  # keep sampling through transient failures
                print("sample error:", e, file=sys.stderr, flush=True)
            time.sleep(args.every)


def slope_per_hour(rows, key):
    xs = [r["ts"] for r in rows]; ys = [r[key] for r in rows]
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den * 3600


def report(args):
    rows = []
    with open(args.out) as f:
        for r in csv.DictReader(f, restval=""):
            rows.append({k: (float(v) if re.fullmatch(r"-?\d+(\.\d+)?", v or "") else 0.0) for k, v in r.items()})
    if not rows:
        print("no samples"); return
    pid = rows[-1]["pid"]
    same = [r for r in rows if r["pid"] == pid]           # only the current process (restarts reset everything)
    win = [r for r in same if r["ts"] >= rows[-1]["ts"] - args.hours * 3600]
    first, last = win[0], win[-1]
    hrs = (last["ts"] - first["ts"]) / 3600
    print(f"router pid {int(pid)}  samples {len(win)}  window {hrs:.2f} h  uptime {last['uptime_s']/3600:.2f} h  ({len(rows)} samples total, {len(rows)-len(same)} from earlier pids)")
    print(f"{'metric':22} {'first':>10} {'last':>10} {'delta':>10} {'slope/h':>10}  verdict")
    checks = [("pss_mb", 5, "MB"), ("rss_mb", 5, "MB"), ("anon_mb", 5, "MB"), ("fds", 20, ""), ("threads", 2, ""),
              ("in_estab", 20, ""), ("in_close_wait", 1, ""), ("in_fin_wait", 5, ""), ("in_other", 5, ""), ("ws_estab", 3, ""), ("ws_close_wait", 1, ""),
              ("gw_rows", 20, ""), ("ch_rows", 50, ""), ("resend_pending", 20, ""), ("store_queue", 1000, ""), ("reg_pending", 100, ""), ("store_bufs", 50, ""), ("store_buffered_mb", 5, ""), ("alarm_pending", 100, ""), ("alarm_last_seen", 100, ""), ("emr_cache_mb", 5, ""), ("live_index", 50, ""), ("cpu_proc", 30, "%"), ("ws_sessions", 5, ""), ("ws_subs", 200, ""), ("events", 0, ""), ("alarm_hist", 0, ""), ("queue_drop", 1, ""), ("ws_lagged", 1, "")]
    for k, tol, unit in checks:
        s = slope_per_hour(win, k); d = last[k] - first[k]
        if k in ("events", "alarm_hist"):
            verdict = "ring (capped)" if last[k] <= 500 else "GROWING?"
        elif k in ("in_close_wait", "ws_close_wait", "queue_drop", "ws_lagged"):
            verdict = "ok" if d == 0 else f"CHECK (+{d:.0f} in window)"
        else:
            verdict = "ok" if abs(s) <= tol else ("GROWING" if s > 0 else "shrinking")
        print(f"{k:22} {first[k]:>10.1f} {last[k]:>10.1f} {d:>+10.1f} {s:>+10.2f}  {verdict}")
    print(f"gw_conn {int(last['gw_conn'])}/{int(last['gw_rows'])}  ch_conn {int(last['ch_conn'])}/{int(last['ch_rows'])}  ingest_conns(api) {int(last['ingest_conns'])} vs ESTAB(kernel) {int(last['in_estab'])}  peers {int(last['in_peers'])}  store {int(last['store_mb'])} MB  sys avail {int(last['sys_avail_mb'])} MB")
    if abs(last["ingest_conns"] - last["in_estab"]) > 5:
        print("!! ingest_conns (router counter) and kernel ESTAB differ: orphan tasks or half-open sockets")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["run", "report", "once"])
    ap.add_argument("--every", type=int, default=60)
    ap.add_argument("--hours", type=float, default=6)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "leakwatch.csv"))
    a = ap.parse_args()
    if a.cmd == "run":
        run(a)
    elif a.cmd == "once":
        print(json.dumps(sample(), ensure_ascii=False))
    else:
        report(a)
