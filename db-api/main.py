"""DB API 서비스 — SQLite3 영속화 계층 (병원별 DB 분리).

라우터 서버가 이 API 를 호출하면(NDJSON push) SQLite 가 실시간 갱신되는 구조.
병원마다 **개별 DB 파일**(hospital-<병원id>.db)을 가지며, 모든 갱신(push/샘플러/
정합성 보정)은 에뮬레이터에서 **현재 선택된 병원**의 DB 에만 적용된다.

패치 ID 는 병원 프리픽스로 전역 유일성을 보장한다:
  - 사용 패치(채널): SA-0001 / BB-0001 ...
  - 재고 패치:       PT-SA-1001 / PT-BB-1001 ...

포트:
  - TCP 7601 (NDJSON ingest): 라우터가 op push
  - HTTP 7600 (REST, CORS): /health /patients /patches /patches/restock
                            /timeseries /db/reset  (?hospital= 로 병원 지정, 기본=현재)

사용법: python main.py [--http-port 7600] [--ingest-port 7601]
        [--router-api http://127.0.0.1:7300] [--emulator-api http://127.0.0.1:7500]
"""
import argparse
import asyncio
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

STOCK_SEED = 50  # 병원별 최초 재고 패치 수


class Store:
    """병원 하나의 SQLite 접근 (단일 커넥션 + 락)."""

    def __init__(self, path: str, stock_prefix: str = "PT-"):
        self.path = path
        self.stock_prefix = stock_prefix
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.lock = threading.Lock()
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS patients(
                patient_id TEXT PRIMARY KEY,
                name TEXT, building TEXT, floor TEXT, ward TEXT, zone TEXT,
                room TEXT, doctor TEXT, department TEXT, nurse TEXT,
                channel_id TEXT, updated_ts INTEGER
            );
            CREATE TABLE IF NOT EXISTS patches(
                patch_id TEXT PRIMARY KEY,
                status TEXT NOT NULL DEFAULT 'in_stock'
                    CHECK(status IN ('in_stock','in_use','retired')),
                patient_id TEXT, updated_ts INTEGER
            );
            CREATE TABLE IF NOT EXISTS metrics(
                ts INTEGER PRIMARY KEY,
                pkt_rate REAL, lost_rate REAL, channels INTEGER,
                gw_down INTEGER, gw_known INTEGER, analysis_up INTEGER
            );
            CREATE TABLE IF NOT EXISTS events(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
            CREATE TABLE IF NOT EXISTS appointments(
                id TEXT PRIMARY KEY,
                channel_id TEXT, patient_id TEXT, patient_name TEXT,
                kind TEXT, title TEXT, place TEXT,
                scheduled_ms INTEGER, duration_s INTEGER,
                eta_return_ms INTEGER, returned_ms INTEGER,
                status TEXT NOT NULL DEFAULT 'reserved'
                    CHECK(status IN ('reserved','in_progress','done','cancelled')),
                updated_ms INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_appt_sched ON appointments(scheduled_ms);
        """)
        self.db.commit()
        # 프로필 컬럼 마이그레이션 (구버전 DB 파일 호환)
        for col, typ in [("profile_no", "INTEGER"), ("sex", "TEXT"),
                         ("birth", "TEXT"), ("blood", "TEXT"), ("conditions", "TEXT")]:
            try:
                self.db.execute(f"ALTER TABLE patients ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass
        self.db.commit()
        self._seed_stock()

    def close(self):
        try:
            self.db.close()
        except Exception:
            pass

    def _seed_stock(self):
        with self.lock:
            n = self.db.execute(
                "SELECT COUNT(*) FROM patches WHERE status='in_stock'").fetchone()[0]
            if n == 0:
                self.restock(STOCK_SEED)

    def restock(self, count: int) -> list:
        """병원 프리픽스가 붙은 새 재고 패치 발급 (예: PT-SA-1001)."""
        now = int(time.time() * 1000)
        row = self.db.execute(
            "SELECT patch_id FROM patches WHERE patch_id LIKE ? ORDER BY patch_id DESC LIMIT 1",
            (f"{self.stock_prefix}%",)).fetchone()
        start = int(row[0][len(self.stock_prefix):]) + 1 if row else 1001
        ids = [f"{self.stock_prefix}{start + i}" for i in range(count)]
        self.db.executemany(
            "INSERT OR IGNORE INTO patches(patch_id, status, updated_ts) VALUES(?, 'in_stock', ?)",
            [(i, now) for i in ids])
        self.db.commit()
        return ids

    def _event_locked(self, kind: str, detail: str):
        self.db.execute(
            "INSERT INTO events(ts, kind, detail) VALUES(?,?,?)",
            (int(time.time() * 1000), kind, detail))

    def add_event(self, kind: str, detail: str):
        with self.lock:
            self._event_locked(kind, detail)
            self.db.commit()

    def add_metric(self, pkt_rate, lost_rate, channels, gw_down, gw_known, analysis_up):
        with self.lock:
            self.db.execute(
                "INSERT OR REPLACE INTO metrics VALUES(?,?,?,?,?,?,?)",
                (int(time.time() * 1000), pkt_rate, lost_rate, channels,
                 gw_down, gw_known, analysis_up))
            cutoff = int((time.time() - 35 * 86400) * 1000)
            self.db.execute("DELETE FROM metrics WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM events WHERE ts < ?", (cutoff,))
            self.db.commit()

    def timeseries(self, since_ms: int, bucket_ms: int):
        with self.lock:
            rows = self.db.execute("""
                SELECT (ts/?)*? AS t,
                       AVG(pkt_rate), AVG(lost_rate),
                       AVG(CASE WHEN gw_known>0 THEN gw_down*100.0/gw_known ELSE 0 END),
                       AVG(channels), MIN(analysis_up)
                FROM metrics WHERE ts >= ?
                GROUP BY t ORDER BY t
            """, (bucket_ms, bucket_ms, since_ms)).fetchall()
            evs = self.db.execute(
                "SELECT ts, kind, detail FROM events WHERE ts >= ? ORDER BY ts DESC LIMIT 800",
                (since_ms,)).fetchall()
        return (
            [{"t": r[0], "pkt": round(r[1] or 0, 1), "lost": round(r[2] or 0, 2),
              "gw_fault": round(r[3] or 0, 2), "channels": round(r[4] or 0, 1),
              "analysis_up": r[5]} for r in rows],
            [{"ts": e[0], "kind": e[1], "detail": e[2]} for e in evs],
        )

    def upsert_patient(self, channel_id: str, p: dict):
        now = int(time.time() * 1000)
        with self.lock:
            prev = self.db.execute(
                "SELECT status FROM patches WHERE patch_id=?", (channel_id,)).fetchone()
            if prev and prev[0] == "in_stock":
                self._event_locked("patch_deployed", channel_id)
            self.db.execute("""
                INSERT INTO patients(patient_id, name, building, floor, ward, zone,
                                     room, doctor, department, nurse, channel_id, updated_ts,
                                     profile_no, sex, birth, blood, conditions)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(patient_id) DO UPDATE SET
                    name=excluded.name, building=excluded.building, floor=excluded.floor,
                    ward=excluded.ward, zone=excluded.zone, room=excluded.room,
                    doctor=excluded.doctor, department=excluded.department,
                    nurse=excluded.nurse, channel_id=excluded.channel_id,
                    updated_ts=excluded.updated_ts,
                    profile_no=excluded.profile_no, sex=excluded.sex,
                    birth=excluded.birth, blood=excluded.blood,
                    conditions=excluded.conditions
            """, (p.get("id"), p.get("name"), p.get("building"), p.get("floor"),
                  p.get("ward"), p.get("zone"), p.get("room"), p.get("doctor"),
                  p.get("department"), p.get("nurse"), channel_id, now,
                  p.get("profile_no"), p.get("sex"), p.get("birth"), p.get("blood"),
                  json.dumps(p.get("conditions") or [], ensure_ascii=False)))
            self.db.execute("""
                INSERT INTO patches(patch_id, status, patient_id, updated_ts)
                VALUES(?, 'in_use', ?, ?)
                ON CONFLICT(patch_id) DO UPDATE SET
                    status='in_use', patient_id=excluded.patient_id,
                    updated_ts=excluded.updated_ts
            """, (channel_id, p.get("id"), now))
            self.db.commit()

    def retire_patch(self, patch_id: str):
        now = int(time.time() * 1000)
        with self.lock:
            self._event_locked("patch_retired", patch_id)
            self.db.execute("""
                INSERT INTO patches(patch_id, status, updated_ts)
                VALUES(?, 'retired', ?)
                ON CONFLICT(patch_id) DO UPDATE SET
                    status='retired', updated_ts=excluded.updated_ts
            """, (patch_id, now))
            self.db.commit()

    def reconcile_in_use(self, active_ids: set) -> list:
        now = int(time.time() * 1000)
        with self.lock:
            rows = self.db.execute(
                "SELECT patch_id FROM patches WHERE status='in_use'").fetchall()
            stale = [r[0] for r in rows if r[0] not in active_ids]
            if stale:
                self.db.executemany(
                    "UPDATE patches SET status='retired', updated_ts=? WHERE patch_id=?",
                    [(now, pid) for pid in stale])
                self.db.commit()
            return stale

    def patients(self) -> list:
        with self.lock:
            cur = self.db.execute(
                "SELECT patient_id,name,building,floor,ward,zone,room,doctor,"
                "department,nurse,channel_id,updated_ts,"
                "profile_no,sex,birth,blood,conditions FROM patients ORDER BY patient_id")
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, r)) for r in cur.fetchall()]
        for r in rows:
            try:
                r["conditions"] = json.loads(r.get("conditions") or "[]")
            except (TypeError, ValueError):
                r["conditions"] = []
        return rows

    def patches(self, status: str = None) -> list:
        with self.lock:
            q = "SELECT patch_id,status,patient_id,updated_ts FROM patches"
            args = ()
            if status:
                q += " WHERE status=?"
                args = (status,)
            cur = self.db.execute(q + " ORDER BY patch_id", args)
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]

    def upsert_appointment(self, channel_id: str, a: dict):
        """예약 생성/상태 갱신 (에뮬레이터 → 라우터 중계로 도착)."""
        with self.lock:
            self.db.execute("""
                INSERT INTO appointments(id, channel_id, patient_id, patient_name,
                    kind, title, place, scheduled_ms, duration_s,
                    eta_return_ms, returned_ms, status, updated_ms)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET
                    status=excluded.status, eta_return_ms=excluded.eta_return_ms,
                    returned_ms=excluded.returned_ms, updated_ms=excluded.updated_ms
            """, (a.get("id"), channel_id, a.get("patient_id"), a.get("patient_name"),
                  a.get("kind"), a.get("title"), a.get("place"),
                  a.get("scheduled_ms"), a.get("duration_s"),
                  a.get("eta_return_ms"), a.get("returned_ms"),
                  a.get("status", "reserved"), int(time.time() * 1000)))
            # 오래된 완료 예약 정리 (7일)
            cutoff = int((time.time() - 7 * 86400) * 1000)
            self.db.execute(
                "DELETE FROM appointments WHERE status='done' AND scheduled_ms < ?",
                (cutoff,))
            self.db.commit()

    def cancel_stale_appointments(self) -> int:
        """예약 시간이 15분 이상 지나도록 진행되지 않은 예약을 취소 처리.
        (에뮬레이터 재시작 등으로 실행 주체가 사라진 고아 예약 정리)"""
        now = int(time.time() * 1000)
        with self.lock:
            cur = self.db.execute(
                "UPDATE appointments SET status='cancelled', updated_ms=? "
                "WHERE status IN ('reserved','in_progress') AND scheduled_ms < ?",
                (now, now - 900_000))
            self.db.commit()
            return cur.rowcount

    def appointments(self, status: str = None, limit: int = 300) -> list:
        with self.lock:
            q = ("SELECT id,channel_id,patient_id,patient_name,kind,title,place,"
                 "scheduled_ms,duration_s,eta_return_ms,returned_ms,status,updated_ms "
                 "FROM appointments")
            args = []
            if status:
                q += " WHERE status=?"
                args.append(status)
            q += " ORDER BY scheduled_ms DESC LIMIT ?"
            args.append(limit)
            cur = self.db.execute(q, args)
            cols = [c[0] for c in cur.description]
            return [dict(zip(cols, r)) for r in cur.fetchall()]


# ---------- 병원별 스토어 관리 ----------
STORES = {}          # hospital_id -> Store
HOSPITAL_INFO = {}   # hospital_id -> {id, name, prefix, beds}
CURRENT = {"id": None}
STATS = {"ops": 0}
ARGS = None


def db_path(hid: str) -> str:
    return f"hospital-{hid}.db"


def store_for(hid: str) -> Store:
    if hid not in STORES:
        prefix = HOSPITAL_INFO.get(hid, {}).get("prefix", hid.upper().replace("-", "")[:2])
        STORES[hid] = Store(db_path(hid), stock_prefix=f"PT-{prefix}-")
    return STORES[hid]


def current_store() -> Store:
    hid = CURRENT["id"]
    if hid is None:
        hid = next(iter(HOSPITAL_INFO), "seoul-a")
    return store_for(hid)


def http_get(url: str):
    return json.loads(urllib.request.urlopen(url, timeout=5).read())


# 에뮬레이터 제어 API 폴백: --emulator-api 에 쉼표로 여러 베이스 URL 을 주면
# 마지막으로 성공한 곳부터 순서대로 시도해 첫 성공 응답을 쓴다.
EMU_LAST_GOOD = {"i": 0}


def emu_get(path: str):
    bases = [b.strip().rstrip("/") for b in ARGS.emulator_api.split(",") if b.strip()]
    order = list(range(len(bases)))
    order = order[EMU_LAST_GOOD["i"]:] + order[:EMU_LAST_GOOD["i"]]
    last_err = None
    for i in order:
        try:
            j = json.loads(urllib.request.urlopen(bases[i] + path, timeout=3).read())
            EMU_LAST_GOOD["i"] = i
            return j
        except Exception as e:  # 접속 실패/타임아웃 → 다음 후보
            last_err = e
    raise last_err


def refresh_hospital_info():
    """에뮬레이터에서 병원 목록/현재 병원 갱신 (동기 — executor 에서 호출)."""
    j = emu_get("/hospital")
    for h in j.get("hospitals", []):
        HOSPITAL_INFO[h["id"]] = h
    CURRENT["id"] = j.get("id")
    return j


# ---------- NDJSON ingest (라우터 → DB API, 현재 병원 DB 로 라우팅) ----------
async def handle_ingest(reader, writer):
    peer = writer.get_extra_info("peername")
    print(f"[db-api] router connected: {peer}", flush=True)
    try:
        while True:
            try:
                line = await reader.readline()
            except (ConnectionResetError, OSError):
                break  # 라우터 강제 종료/재시작 시 연결 리셋 — 정상 종료 경로
            if not line:
                break
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            op = msg.get("op")
            # op 에 병원이 명시되면 그 병원 DB 로 (전환 폴링 지연 레이스 방지),
            # 없으면 현재 병원 DB 로 라우팅
            hid = msg.get("hospital")
            st = store_for(hid) if hid else current_store()
            if op == "upsert_patient" and msg.get("patient"):
                st.upsert_patient(msg.get("channel_id", ""), msg["patient"])
                STATS["ops"] += 1
            elif op == "retire_patch" and msg.get("patch_id"):
                st.retire_patch(msg["patch_id"])
                STATS["ops"] += 1
            elif op == "upsert_appointment" and msg.get("appointment"):
                st.upsert_appointment(msg.get("channel_id", ""), msg["appointment"])
                STATS["ops"] += 1
    finally:
        writer.close()
        print(f"[db-api] router disconnected: {peer}", flush=True)


# ---------- HTTP REST ----------
def http_response(status: str, body) -> bytes:
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    headers = (
        f"HTTP/1.1 {status}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        f"Content-Length: {len(payload)}\r\n"
        "Access-Control-Allow-Origin: *\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
        "Access-Control-Allow-Headers: Content-Type\r\n"
        "Connection: close\r\n\r\n"
    )
    return headers.encode("ascii") + payload


async def db_reset() -> dict:
    """병원별 DB 개별 재생성: 각 200채널 데이터 + 병원별 재고 시드.
    패치 번호는 병원 프리픽스로 전역 유일."""
    loop = asyncio.get_event_loop()
    info = await loop.run_in_executor(None, refresh_hospital_info)
    results = {}
    for h in info.get("hospitals", []):
        hid = h["id"]
        # 기존 스토어 폐기 + 파일 삭제 → 새 DB
        if hid in STORES:
            STORES.pop(hid).close()
        for suffix in ("", "-journal", "-wal", "-shm"):
            try:
                os.remove(db_path(hid) + suffix)
            except OSError:
                pass
        st = store_for(hid)  # 새 DB 생성 + 재고 50 시드 (PT-<prefix>-1001~)
        roster = await loop.run_in_executor(
            None, lambda hid=hid: emu_get(f"/roster?hospital={hid}&count=200"))
        for r in roster.get("roster", []):
            st.upsert_patient(r["channel_id"], r["patient"])
        st.add_event("db_reset", f"{hid}: 200채널 데이터 재생성")
        results[hid] = {
            "name": h.get("name", hid),
            "patients": len(roster.get("roster", [])),
            "stock": len(st.patches("in_stock")),
        }
    return results


# ---------- 로컬 에뮬레이터 (테스트 입력 소스 — 어드민이 원격/로컬 선택) ----------
_BASE = os.path.dirname(os.path.abspath(__file__))
EMU_DIR = os.path.normpath(os.path.join(_BASE, "..", "emulator"))
EMU_LOG = os.path.normpath(os.path.join(_BASE, "..", "logs", "emulator-local.log"))
EMU_PROC = {"p": None}


def emulator_local_status():
    p = EMU_PROC["p"]
    running = p is not None and p.poll() is None
    return {"running": running, "pid": p.pid if running else None}


def emulator_local_start(channels: int, ingest_port: int, batch: bool = True):
    if emulator_local_status()["running"]:
        return emulator_local_status()
    os.makedirs(os.path.dirname(EMU_LOG), exist_ok=True)
    log = open(EMU_LOG, "a")
    cmd = [sys.executable, "main.py",
           "--host", "127.0.0.1", "--port", str(ingest_port),
           "--channels", str(channels), "--control-port", "7500",
           # DB 명단이 커도 요청 채널 수까지만 생성 (2000명 명단 전체 로드 방지)
           "--db-limit", str(channels),
           "--db-api", f"http://127.0.0.1:{ARGS.http_port}"]
    if batch:
        cmd.append("--batch-gateway")  # 게이트웨이 단위 배치 전송 (신규 기본)
    EMU_PROC["p"] = subprocess.Popen(
        cmd, cwd=EMU_DIR, stdout=log, stderr=subprocess.STDOUT)
    return emulator_local_status()


def emulator_local_stop():
    p = EMU_PROC["p"]
    if p is not None and p.poll() is None:
        p.terminate()
        try:
            p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            p.kill()
    EMU_PROC["p"] = None
    return {"running": False, "pid": None}


async def handle_http(reader, writer):
    try:
        request_line = (await reader.readline()).decode("ascii", "ignore").strip()
        while True:
            hline = await reader.readline()
            if not hline or hline in (b"\r\n", b"\n"):
                break
        if not request_line:
            return
        method, target, _ = request_line.split(" ", 2)
        url = urlparse(target)
        qs = parse_qs(url.query)
        # 병원 지정 (기본: 현재 선택 병원)
        hid = qs.get("hospital", [None])[0]
        st = store_for(hid) if hid else current_store()

        if method == "OPTIONS":
            writer.write(http_response("204 No Content", {}))
        elif method == "GET" and url.path == "/health":
            writer.write(http_response("200 OK", {
                "ok": True, "ops": STATS["ops"], "current_hospital": CURRENT["id"],
                "databases": {h: db_path(h) for h in HOSPITAL_INFO},
                "patients": len(st.patients()),
                "in_stock": len(st.patches("in_stock")),
            }))
        elif method == "GET" and url.path == "/patients":
            writer.write(http_response("200 OK", {"patients": st.patients()}))
        elif method == "GET" and url.path == "/patches":
            status = qs.get("status", [None])[0]
            writer.write(http_response("200 OK", {"patches": st.patches(status)}))
        elif method == "GET" and url.path == "/appointments":
            status = qs.get("status", [None])[0]
            writer.write(http_response("200 OK",
                                       {"appointments": st.appointments(status)}))
        elif method == "POST" and url.path == "/patches/restock":
            count = max(1, min(200, int(qs.get("count", ["20"])[0])))
            ids = st.restock(count)
            writer.write(http_response("200 OK", {"restocked": ids}))
        elif method == "GET" and url.path == "/timeseries":
            rng = qs.get("range", ["day"])[0]
            spec = {
                "hour": (3600, 60),               # 1시간 / 1분 버킷
                "day": (24 * 3600, 5 * 60),
                "week": (7 * 24 * 3600, 30 * 60),
                "month": (30 * 24 * 3600, 2 * 3600),
            }.get(rng, (24 * 3600, 5 * 60))
            since = int((time.time() - spec[0]) * 1000)
            metrics, events = st.timeseries(since, spec[1] * 1000)
            writer.write(http_response("200 OK", {
                "range": rng, "since": since, "bucket_s": spec[1],
                "metrics": metrics, "events": events,
            }))
        elif method == "POST" and url.path == "/db/reset":
            results = await db_reset()
            writer.write(http_response("200 OK", {"reset": results}))
        elif method == "GET" and url.path == "/emulator/local":
            writer.write(http_response("200 OK", emulator_local_status()))
        elif method == "POST" and url.path == "/emulator/start":
            channels = max(1, min(500, int(qs.get("channels", ["32"])[0])))
            port = int(qs.get("port", ["7700"])[0])
            batch = qs.get("batch", ["1"])[0] != "0"
            writer.write(http_response("200 OK",
                                       emulator_local_start(channels, port, batch)))
        elif method == "POST" and url.path == "/emulator/stop":
            writer.write(http_response("200 OK", emulator_local_stop()))
        else:
            writer.write(http_response("404 Not Found", {"error": "unknown endpoint"}))
        await writer.drain()
    except Exception as e:
        try:
            writer.write(http_response("500 Internal Server Error", {"error": str(e)}))
            await writer.drain()
        except Exception:
            pass
    finally:
        writer.close()


# ---------- 백그라운드 루프 ----------
async def hospital_poll_loop():
    """5초 주기로 현재 병원 추적 (모든 갱신을 그 병원 DB 로 라우팅)."""
    loop = asyncio.get_event_loop()
    while True:
        try:
            prev = CURRENT["id"]
            await loop.run_in_executor(None, refresh_hospital_info)
            if prev is not None and prev != CURRENT["id"]:
                print(f"[db-api] current hospital: {prev} -> {CURRENT['id']}", flush=True)
        except Exception:
            pass
        await asyncio.sleep(5.0)


async def sampler_loop():
    """10초 주기 시계열 샘플러 (현재 병원 DB 에 기록)."""
    loop = asyncio.get_event_loop()
    prev = {"packets": None, "lost": None, "t": None, "gwdown": set(), "analysis": None,
            "hospital": None}
    while True:
        await asyncio.sleep(10.0)
        try:
            stats = await loop.run_in_executor(None, lambda: http_get(f"{ARGS.router_api}/api/stats"))
            gws = await loop.run_in_executor(None, lambda: http_get(f"{ARGS.router_api}/api/gateways"))
        except Exception:
            continue
        st = current_store()
        # 병원이 바뀌면 rate 기준점 리셋
        if prev["hospital"] != CURRENT["id"]:
            prev = {"packets": None, "lost": None, "t": None, "gwdown": set(),
                    "analysis": None, "hospital": CURRENT["id"]}
        now_s = time.time()
        pkt_rate = lost_rate = 0.0
        if (prev["packets"] is not None and prev["t"] is not None
                and stats["total_packets"] >= prev["packets"]):
            dt = max(now_s - prev["t"], 1.0)
            pkt_rate = (stats["total_packets"] - prev["packets"]) / dt
            lost_rate = max(0.0, (stats["total_lost_packets"] - prev["lost"]) / dt)
        st.add_metric(pkt_rate, lost_rate, stats["channel_count"],
                      len(gws.get("down", [])), gws.get("known", 0),
                      1 if stats["analysis_connected"] else 0)
        down = set(gws.get("down", []))
        for g in sorted(down - prev["gwdown"]):
            st.add_event("gateway_down", g)
        for g in sorted(prev["gwdown"] - down):
            st.add_event("gateway_up", g)
        if prev["analysis"] is not None and prev["analysis"] != stats["analysis_connected"]:
            st.add_event(
                "downtime_start" if not stats["analysis_connected"] else "downtime_end",
                "분석 링크")
        prev.update({"packets": stats["total_packets"], "lost": stats["total_lost_packets"],
                     "t": now_s, "gwdown": down, "analysis": stats["analysis_connected"],
                     "hospital": CURRENT["id"]})


async def reconcile_loop():
    """10초 주기 정합성 보정 (현재 병원 DB)."""
    loop = asyncio.get_event_loop()
    while True:
        await asyncio.sleep(10.0)
        try:
            raw = await loop.run_in_executor(
                None, lambda: http_get(f"{ARGS.router_api}/api/channels"))
            active = {c["channel_id"] for c in raw}
            if not active:
                continue
            # 병원 전환 레이스 가드: 현재 병원을 직전 재확인하고,
            # 라우터 레지스트리에 그 병원 채널(접두사)이 실제로 있을 때만 보정.
            # (전환 과도기에 이전 병원 in_use 패치를 폐기하는 것을 방지)
            await loop.run_in_executor(None, refresh_hospital_info)
            hid = CURRENT["id"]
            prefix = HOSPITAL_INFO.get(hid, {}).get("prefix", "")
            if prefix and not any(c.startswith(prefix + "-") for c in active):
                continue
            stale = current_store().reconcile_in_use(active)
            if stale:
                print(f"[db-api] reconcile: {len(stale)} stale in_use -> retired "
                      f"({', '.join(stale[:5])}{' ...' if len(stale) > 5 else ''})", flush=True)
            n_cxl = current_store().cancel_stale_appointments()
            if n_cxl:
                print(f"[db-api] reconcile: {n_cxl} stale appointments -> cancelled", flush=True)
        except Exception:
            pass


async def main():
    global ARGS
    ap = argparse.ArgumentParser(description="SQLite DB API service (병원별 DB 분리)")
    ap.add_argument("--http-port", type=int, default=7600)
    ap.add_argument("--ingest-port", type=int, default=7601)
    ap.add_argument("--router-api", default="http://127.0.0.1:7300")
    ap.add_argument("--emulator-api", default="http://127.0.0.1:7500")
    ARGS = ap.parse_args()

    # 초기 병원 정보 (에뮬레이터 미기동 시 폴링 루프가 이어서 시도)
    try:
        await asyncio.get_event_loop().run_in_executor(None, refresh_hospital_info)
    except Exception:
        pass

    ingest = await asyncio.start_server(handle_ingest, "0.0.0.0", ARGS.ingest_port)
    http = await asyncio.start_server(handle_http, "0.0.0.0", ARGS.http_port)
    asyncio.create_task(hospital_poll_loop())
    asyncio.create_task(reconcile_loop())
    asyncio.create_task(sampler_loop())
    print(f"[db-api] per-hospital sqlite · ingest :{ARGS.ingest_port} · http :{ARGS.http_port} "
          f"· current={CURRENT['id']}", flush=True)
    async with ingest, http:
        await asyncio.gather(ingest.serve_forever(), http.serve_forever())


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
