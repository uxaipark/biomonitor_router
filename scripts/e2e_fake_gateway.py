"""Rust router e2e: Python fake gateway (emulator protocol.py framing) -> router-server; NACK round trip, dup gw,
corrupt frame, store files byte-compatible with router/store.py verify_file, admin API views."""
import json, os, socket, struct, subprocess, sys, time, urllib.request, shutil
import numpy as np
# Needs the emulator repo (for protocol.py framing and the Python store reader) next to this repo or at $BIOSIM_REPO.
EMU = os.environ.get("BIOSIM_REPO", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "biomonitor_simulator"))
sys.path.insert(0, os.path.abspath(EMU))
from emulator.runtime.protocol import frame, gwstat_block, meta_block, F_GWSTAT, F_META, HEADER, CRC, parse_ctrl, CTRL_NACK
from router.store import verify_file, iter_entries

S = os.environ.get("E2E_TMP", "/tmp/router-e2e"); os.makedirs(S, exist_ok=True)
STORE = os.path.join(S, "store"); shutil.rmtree(STORE, ignore_errors=True)
BIN = os.environ.get("ROUTER_BIN", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "router-server", "target", "release", "router-server"))
env = dict(os.environ, ROUTER_INGEST_ADDR="127.0.0.1:19100", ROUTER_HTTP_ADDR="127.0.0.1:17300", ROUTER_STORE_DIR=STORE,
           ROUTER_GROUPS_PATH=os.path.join(S, "groups.json"), ROUTER_DISPLAYS_PATH=os.path.join(S, "displays.json"),
           ROUTER_ANALYSIS_ADDR="127.0.0.1:1", ROUTER_DB_ADDR="127.0.0.1:1", RUST_LOG="info",
           ROUTER_DB_PATH=os.path.join(S, "router.db"), ROUTER_SERVICE_TOKEN="e2e-service-token-0123456789")
log = open(os.path.join(S, "router.log"), "w")
proc = subprocess.Popen([BIN], env=env, stdout=log, stderr=subprocess.STDOUT)
def api(path):
    req = urllib.request.Request(f"http://127.0.0.1:17300{path}", headers={"Authorization": "Bearer e2e-service-token-0123456789"})
    return json.load(urllib.request.urlopen(req, timeout=5))
for _ in range(50):
    try: api("/api/health"); break
    except Exception: time.sleep(0.1)

_PSEQ = {}
def rec(patch_id, patient_id, n_ecg=50, pseq=None):
    if pseq is None:
        _PSEQ[patch_id] = _PSEQ.get(patch_id, 0) + 1; pseq = _PSEQ[patch_id]
    ecg = (np.arange(n_ecg, dtype=np.int16) * 3).tobytes()
    body = struct.pack("<IIIBBbB", patch_id, patient_id, pseq, 0, 97, -55, 2)
    body += struct.pack("<BBH", 1, 1, n_ecg) + ecg + struct.pack("<BBH", 2, 2, 1) + bytes([72])
    return body
def read_frame(sock, timeout=3.0):
    sock.settimeout(timeout); buf = b""
    while len(buf) < HEADER.size: buf += sock.recv(4096)
    plen = HEADER.unpack_from(buf, 0)[7]
    while len(buf) < HEADER.size + plen + CRC.size: buf += sock.recv(4096)
    return buf
ok = True
def check(cond, msg):
    global ok
    print(("PASS " if cond else "FAIL ") + msg)
    ok = ok and bool(cond)
try:
    c = socket.create_connection(("127.0.0.1", 19100))
    meta = {"v": 11, "gw": "GW-0007", "type": "ward", "location": {"building": "본관", "floor": 3, "room": "301", "x": 1, "y": 2},
            "patches": [{"patch_id": 1001, "patient_id": 55, "profile_id": 5, "mrn": "MRN55", "channels": [{"id": 1, "fs": 250}]},
                        {"patch_id": 1002, "patient_id": 56, "profile_id": 6, "mrn": "MRN56", "channels": [{"id": 1, "fs": 250}]}]}
    t0 = int(time.time() * 1000)
    c.sendall(frame(7, 1, t0, 2, gwstat_block(10, 20, 30, -40, 2, 0, 1000, 45) + meta_block(meta) + rec(1001, 55) + rec(1002, 56), F_GWSTAT | F_META))
    for seq in range(2, 6):
        c.sendall(frame(7, seq, t0 + seq * 200, 2, rec(1001, 55) + rec(1002, 56), 0))
    c.sendall(frame(8, 1, t0 + 5000, 1, rec(2001, 77), 0))
    time.sleep(1.5)
    st = api("/api/stats"); g = st["gateways"]
    check(g["gateways"] == 2 and g["frames"] == 6 and g["records"] == 11 and g["meta_blocks"] == 1, f"stats after 6 frames: {g}")
    check(g["anomalies"] == {}, f"no anomalies: {g['anomalies']}")
    gws = api("/api/gateways"); g7 = next(x for x in gws if x["gw_id"] == 7)
    check(g7["status"]["cpu"] == 10 and g7["last_seq"] == 5 and g7["records"] == 10 and g7["name"] == "GW-0007" and g7["location"]["room"] == "301", f"gw7 row: {g7}")
    chans = api("/api/channels"); c1001 = next(x for x in chans if x["channel_id"] == "1001")
    check(c1001["gateway_id"] == "7" and c1001["space"] == "301" and c1001["patient"]["building"] == "본관" and c1001["mrn"] == "MRN55" and c1001["patient_id"] == 55 and c1001["battery"] == 97,
          f"registry row 1001: {c1001}")
    # gap -> NACK
    c.sendall(frame(7, 9, t0 + 9000, 2, rec(1001, 55, pseq=9) + rec(1002, 56, pseq=9), 0))
    nack = read_frame(c); hdr = HEADER.unpack_from(nack, 0)
    check(hdr[2] & 0x08 and hdr[3] == 7 and parse_ctrl(nack[HEADER.size:-CRC.size]) == (CTRL_NACK, 6, 8), f"NACK 6..8 received: {parse_ctrl(nack[HEADER.size:-CRC.size])}")
    for q in (6, 7, 8):
        c.sendall(frame(7, q, t0 + q * 1000, 2, rec(1001, 55, pseq=q) + rec(1002, 56, pseq=q), 0))
    time.sleep(0.8)
    g = api("/api/gateways/summary")
    check(g["nack_tx"] == 1 and g["recovered"] == 3 and g["resend_pending"] == 0 and g["anomalies"].get("seq_reorder", 0) == 0, f"recovery: {g}")
    check(g["anomalies"].get("patch_seq_gap", 0) >= 2 and g["anomalies"].get("patch_seq_reorder", 0) == 0, f"patch seq gap flagged, recovered frames not counted as reorder: {g['anomalies']}")
    # duplicate gw on a second socket
    c2 = socket.create_connection(("127.0.0.1", 19100))
    c2.sendall(frame(7, 10, t0 + 10000, 1, rec(1001, 55, pseq=10), 0))
    time.sleep(0.5)
    g = api("/api/gateways/summary"); check(g["dup_gw_frames"] >= 1, f"dup gw flagged: {g['dup_gw_frames']}")
    # corrupt frame -> bad_crc + NACK for that seq (on c2, which now owns gw 7)
    time.sleep(0.6)
    bad = bytearray(frame(7, 11, t0 + 11000, 1, rec(1001, 55, pseq=11), 0)); bad[HEADER.size + 2] ^= 0xFF
    c2.sendall(bytes(bad)); c2.sendall(frame(7, 12, t0 + 12000, 1, rec(1001, 55, pseq=12), 0))
    n2 = read_frame(c2)
    check(parse_ctrl(n2[HEADER.size:-CRC.size])[1:] == (11, 11), f"NACK for corrupt seq 11: {parse_ctrl(n2[HEADER.size:-CRC.size])}")
    time.sleep(0.3)
    g = api("/api/gateways/summary"); check(g["anomalies"].get("bad_crc") == 1, f"bad_crc counted: {g['anomalies']}")
    # store: flush happens every second; verify with the Python draft reader (byte compatibility)
    time.sleep(1.5)
    d = os.path.join(STORE, "patches", "00001001"); files = [f for f in os.listdir(d) if f.endswith(".rec")]
    check(len(files) == 1, f"one hour file for patch 1001: {files}")
    v = verify_file(os.path.join(d, files[0])); ents = list(iter_entries(os.path.join(d, files[0])))
    seqs = [e[3] for e in ents]
    check(v["ok"] and v["entries"] == 11 and seqs == [1, 2, 3, 4, 5, 9, 6, 7, 8, 10, 12], f"python verify_file: {v} seqs={seqs}")
    check(ents[0][1] == 7 and ents[0][2] == 55 and 1 in ents[0][7] and ents[0][7][1][1] == 50, "entry fields (gw, patient, ecg n=50)")
    mj = json.load(open(os.path.join(STORE, "meta", "gw_7.json"))); check(mj["gw"] == "GW-0007", "meta json stored")
    r = api("/api/patches/1001/verify"); check(r["ok"] and r["entries"] == 11, f"api verify: {r}")
    ix = api("/api/patches/1001")["index"]; check(ix["records"] == 11 and ix["patient_id"] == 55, f"index: {ix}")
    w = api(f"/api/wave/1001?mode=raw&from_ms={t0-1000}&to_ms={t0+20000}")
    check(len(w["segments"]) >= 1 and abs(w["segments"][0]["samples"][1] - 0.003) < 1e-6, f"wave raw read: {len(w['segments'])} segments")
    # link close -> disconnected
    c.close(); c2.close(); time.sleep(0.5)
    gws = api("/api/gateways"); check(all(not x["connected"] for x in gws), "gateways disconnected after socket close")
    ev = api("/api/events"); kinds = sorted({e["kind"] for e in ev}); check("link" in kinds and "bad_crc" in kinds, f"events: {kinds}")
finally:
    proc.terminate(); proc.wait(timeout=5); log.close()
print("ALL PASS" if ok else "SOME FAILED")
print(open(os.path.join(S, "router.log")).read()[-1500:])
