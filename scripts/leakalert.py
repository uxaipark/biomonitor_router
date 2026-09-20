#!/usr/bin/env python3
"""Continuous watch on the leakwatch CSV + /api/stats: prints an ALERT line when something drifts, and one status
line every 10 minutes. Meant to run under a monitor (or `nohup … >> data/leakalert.log`).

  scripts/leakalert.py [--every 60] [--csv data/leakwatch.csv]

Checks (current router pid only):
  PSS slope over the last 30 min > 20 MB/h · fds slope > 30/h · router CPU (1 core = 100 %) > 150 % now or
  > 80 % 10-min average · system CPU > 85 % · store queue drops / WS lag increasing · CLOSE_WAIT sockets ·
  registry rows drifting from connected patches · router restart (pid change) · 15-min silence in the CSV.
"""
import argparse, csv, json, os, re, sys, time, urllib.request

def api(path):
    try:
        return json.load(urllib.request.urlopen(f"http://127.0.0.1:7300{path}", timeout=5))
    except Exception:
        return None

def rows(path):
    out = []
    try:
        with open(path) as f:
            for r in csv.DictReader(f, restval=""):
                out.append({k: (float(v) if re.fullmatch(r"-?\d+(\.\d+)?", v or "") else 0.0) for k, v in r.items() if k is not None})
    except OSError:
        pass
    return out

def slope_h(win, key):
    xs = [r["ts"] for r in win]; ys = [r.get(key, 0.0) for r in win]
    n = len(xs)
    if n < 3:
        return 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    den = sum((x - mx) ** 2 for x in xs)
    return 0.0 if den == 0 else sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den * 3600

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--every", type=int, default=60)
    ap.add_argument("--csv", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "leakwatch.csv"))
    a = ap.parse_args()
    last_pid = None; last_status = 0; peak_cpu = 0.0; peak_at = 0; last_alert = {}
    def alert(key, msg, every_s=600):
        now = time.time()
        if now - last_alert.get(key, 0) < every_s:
            return
        last_alert[key] = now
        print(f"[{time.strftime('%H:%M:%S')}] ALERT {msg}", flush=True)
    while True:
        st = api("/api/stats") or {}
        cpu = float(st.get("cpu_process_percent", 0)); sys_cpu = float(st.get("cpu_percent", 0))
        if cpu > peak_cpu:
            peak_cpu, peak_at = cpu, time.time()
        if cpu > 150:
            alert("cpu", f"router CPU {cpu:.0f} % (1 core = 100) · WS sessions {st.get('ws_sessions')} · subs {st.get('ws_subscribed_channels')}")
        if sys_cpu > 85:
            alert("syscpu", f"system CPU {sys_cpu:.0f} %")
        # alarm/membership messages have their own per-session queue; dropping one means a viewer missed an alarm
        if float(st.get("ws_ctrl_dropped", 0)) > 0:
            alert("ctrl", f"alarm/membership messages dropped for a session: {int(st['ws_ctrl_dropped'])} total")
        all_rows = rows(a.csv)
        if all_rows:
            pid = all_rows[-1]["pid"]
            if last_pid is not None and pid != last_pid:
                alert("pid", f"router restarted (pid {int(last_pid)} → {int(pid)})", 0)
            last_pid = pid
            if time.time() - all_rows[-1]["ts"] > 900:
                alert("csv", "leakwatch sampler silent for 15 min (is `scripts/leakwatch.py run` alive?)")
            same = [r for r in all_rows if r["pid"] == pid]
            # only samples taken after the 15-min startup ramp count towards drift slopes
            w30 = [r for r in same if r["ts"] >= all_rows[-1]["ts"] - 1800 and r.get("uptime_s", 0) >= 900]
            # memory is judged over an hour: every store stall / viewer stall burst steps the floor up a few MB
            # and plateaus, so a 30-min window flags those steps as drift
            w60 = [r for r in same if r["ts"] >= all_rows[-1]["ts"] - 3600 and r.get("uptime_s", 0) >= 900]
            w10 = [r for r in same if r["ts"] >= all_rows[-1]["ts"] - 600]
            # drift checks only once the router has warmed up: the first ~15 min after a start are a ramp
            # (buffers, index, allocator arenas) and read as a false +20..30 MB/h slope
            warm = float(st.get("uptime_s", 0)) >= 1200
            if len(w30) >= 20 and warm:
                # PSS is spiky (transient allocations from history reads / EMR sync return within minutes), so judge the
                # floor: the lowest sample of the last third vs the lowest of the first third of the 30-min window
                third = len(w30) // 3
                def floor_rise(key):
                    return min(r.get(key, 0) for r in w30[-third:]) - min(r.get(key, 0) for r in w30[:third])
                # each WS session costs one fd and ~0.6 MB of per-connection buffers (tungstenite write buffer,
                # session queue, stream batch Vec) — discount session count changes before judging drift
                d_ws = floor_rise("ws_sessions")
                d_fd = floor_rise("fds") - d_ws
                if len(w60) >= 40:
                    t60 = len(w60) // 3
                    d_ws60 = min(r.get("ws_sessions", 0) for r in w60[-t60:]) - min(r.get("ws_sessions", 0) for r in w60[:t60])
                    # allowance only for sessions that JOINED: memory a leaving session frees is not returned
                    # to the OS straight away, so crediting it back invents a rise that is not there
                    d_pss = (min(r.get("pss_mb", 0) for r in w60[-t60:]) - min(r.get("pss_mb", 0) for r in w60[:t60])) - 0.6 * max(0, d_ws60)
                    if d_pss > 25:
                        alert("pss", f"PSS floor up {d_pss:+.1f} MB within 60 min (sessions {int(d_ws60):+d}, now {w60[-1]['pss_mb']:.0f} MB)")
                if d_fd > 20:
                    alert("fds", f"fd floor up {d_fd:+.0f} within 30 min (now {int(w30[-1]['fds'])})")
                if w30[-1].get("queue_drop", 0) > w30[0].get("queue_drop", 0):
                    alert("drop", f"store queue drops +{w30[-1]['queue_drop'] - w30[0]['queue_drop']:.0f} in 30 min")
                if w30[-1].get("ws_lagged", 0) > w30[0].get("ws_lagged", 0):
                    # attribute from the minute the counter jumped, not the whole window: an idle store queue and
                    # normal router CPU in that minute means the viewer PC stalled, not the router
                    worst, step = w30[-1], 0
                    for a_, b_ in zip(w30, w30[1:]):
                        d = b_.get("ws_lagged", 0) - a_.get("ws_lagged", 0)
                        if d > step:
                            worst, step = b_, d
                    q, c = worst.get("store_queue", 0), worst.get("cpu_proc", 0)
                    side = "router side (store stall)" if q > 1000 else ("router side (CPU)" if c > 80 else "viewer side")
                    when = time.strftime("%H:%M", time.localtime(worst["ts"]))
                    alert("lag", f"WS lag skipped +{w30[-1]['ws_lagged'] - w30[0]['ws_lagged']:.0f} in 30 min — {side}; worst minute {when} +{int(step)} (store queue {int(q)}, router CPU {c:.0f} %, sessions {int(worst.get('ws_sessions', 0))})")
                if w30[-1].get("in_close_wait", 0) > 0 or w30[-1].get("ws_close_wait", 0) > 0:
                    alert("cw", f"CLOSE_WAIT sockets: ingest {int(w30[-1]['in_close_wait'])} ws {int(w30[-1]['ws_close_wait'])}")
                if abs(w30[-1].get("ch_rows", 0) - w30[-1].get("ch_conn", 0)) > 50:
                    alert("rows", f"registry rows {int(w30[-1]['ch_rows'])} vs connected {int(w30[-1]['ch_conn'])} (stale rows piling up?)")
            if len(w10) >= 5:
                avg = sum(r.get("cpu_proc", 0) for r in w10) / len(w10)
                if avg > 80:
                    alert("cpu10", f"router CPU 10-min average {avg:.0f} %")
        if time.time() - last_status >= 600:
            last_status = time.time()
            r = all_rows[-1] if all_rows else {}
            print(f"[{time.strftime('%H:%M:%S')}] status pss {r.get('pss_mb', 0):.0f} MB fds {int(r.get('fds', 0))} rows {int(r.get('ch_rows', 0))}/{int(r.get('ch_conn', 0))} ingest {int(r.get('in_estab', 0))} ws {st.get('ws_sessions')} subs {st.get('ws_subscribed_channels')} cpu {cpu:.0f} % (peak {peak_cpu:.0f} % @ {time.strftime('%H:%M', time.localtime(peak_at)) if peak_at else '-'}) sys {sys_cpu:.0f} % drops {int(r.get('queue_drop', 0))} lag {st.get('ws_lagged')} store {int(r.get('store_mb', 0))} MB avail {int(r.get('sys_avail_mb', 0))} MB", flush=True)
            peak_cpu = 0.0
        time.sleep(a.every)

if __name__ == "__main__":
    main()
