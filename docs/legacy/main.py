"""ECG 입력 에뮬레이터.

채널당 TCP 연결 하나로 라우터(기본 127.0.0.1:7000)에 접속하여
- meta: 최초 접속 시 + 60초마다 재전송
- ecg: 패킷 단위(기본 250Hz, 200ms=50샘플), seq/타임스탬프 포함
- device_event: weak_signal / moving / reconnected
- channel_close: 채널 명시적 삭제 시 (라우터가 leave 전파 후 레지스트리에서 제거)
를 전송한다.

일부 채널(idx % 7 == 3)은 '불량 채널'로 주기적으로 소켓을 끊고
3~10초 뒤 재접속한다. seq 는 재접속 후에도 이어져 증가한다.

채널 동적 제어 HTTP API (기본 7500, 어드민 웹의 채널 제어 버튼이 사용):
    GET  /status                → {"count": N, "channels": [...]}
    POST /channels/add?count=20     → 새 채널 20개 추가
    POST /channels/remove?count=20  → 앞(인덱스가 가장 낮은) 채널 20개 삭제
    POST /channels/reset?count=100  → 전체 종료 후 CH0001 부터 count 개 재생성

사용법:
    python main.py --channels 24
    python main.py --channels 200 --host 127.0.0.1 --port 7000 --control-port 7500
"""
import argparse
import asyncio
import json
import random
import re
import time
import urllib.request
from urllib.parse import parse_qs, urlparse

from ecg_generator import EcgStream
from patients import HOSPITALS, _nurse, make_channel_id, make_patient, total_beds

META_INTERVAL_S = 60.0


def now_ms() -> int:
    return int(time.time() * 1000)


class GatewayManager:
    """블루투스 게이트웨이 상태 관리 (전 채널 공유).

    게이트웨이는 공간에 고정 매핑되므로 같은 병실/검사실의 패치들은
    같은 게이트웨이 인스턴스를 공유한다 → 장애 시 함께 업링크가 끊긴다.
    장애는 1분 이상(60~120초) 지속되며, 같은 구역(건물+층+구역)의
    다른 패치들에게도 간섭 영향(신호 저하/간헐 접속불량)을 준다.
    """

    def __init__(self):
        self.gateways = {}  # gw_id -> {"next_fail": t, "down_until": t, "area": str}

    @staticmethod
    def gw_area(gw: str) -> str:
        """게이트웨이가 속한 영역 키 (건물+층+구역)."""
        m = re.match(r"^GW-([A-Z])(\d+)-(Z\d)-", gw)
        if m:
            return f"{m.group(1)}{m.group(2)}-{m.group(3)}"
        m = re.match(r"^GW-([A-Z])(\d+)-EXAM$", gw)
        if m:
            return f"{m.group(1)}{m.group(2)}-EXAM"
        m = re.match(r"^GW-([A-Z])(\d+)-(\d+)$", gw)
        if m:
            r = int(m.group(3)) % 100
            zone = "Z1" if r <= 3 or 7 <= r <= 9 else "Z2"
            return f"{m.group(1)}{m.group(2)}-{zone}"
        return gw

    def _ensure(self, gw: str) -> dict:
        st = self.gateways.get(gw)
        if st is None:
            # 첫 장애 시점을 분산시켜 동시 장애 뭉침 방지
            st = {
                "next_fail": time.time() + random.uniform(30.0, 300.0),
                "down_until": 0.0,
                "area": self.gw_area(gw),
            }
            self.gateways[gw] = st
        return st

    def down_areas(self) -> set:
        """현재 장애 중인 게이트웨이가 속한 영역들 (간섭 영향 범위)."""
        now = time.time()
        return {st["area"] for st in self.gateways.values() if now < st["down_until"]}

    # 동시 장애 상한: 전체의 5% (장애는 패치/게이트웨이 레벨에서만 발생하며
    # 전체 네트워크 장애는 없다고 가정 — 광역 장애로 번지지 않도록 캡)
    MAX_DOWN_RATIO = 0.05

    def _down_count(self, now: float) -> int:
        return sum(1 for s in self.gateways.values() if now < s["down_until"])

    def is_down(self, gw: str) -> bool:
        st = self._ensure(gw)
        now = time.time()
        if now < st["down_until"]:
            return True
        if now >= st["next_fail"]:
            cap = max(1, int(len(self.gateways) * self.MAX_DOWN_RATIO))
            if self._down_count(now) >= cap:
                # 상한 도달: 이번 장애는 잠시 뒤로 미룸
                st["next_fail"] = now + random.uniform(20.0, 60.0)
                return False
            dur = random.uniform(60.0, 120.0)  # 1분 이상 지속 장애
            st["down_until"] = now + dur
            # 다음 장애는 복구 후 충분히 뒤에
            st["next_fail"] = st["down_until"] + random.uniform(300.0, 600.0)
            print(f"[emulator] !! gateway {gw} down ({dur:.0f}s, area {st['area']})", flush=True)
            return True
        return False

    def snapshot(self) -> dict:
        now = time.time()
        return {
            "known": len(self.gateways),
            "down": [g for g, st in self.gateways.items() if now < st["down_until"]],
        }


GATEWAYS = GatewayManager()


class ChannelEmulator:
    def __init__(self, idx: int, args, patient: dict = None, channel_id: str = None,
                 hospital: str = None):
        self.idx = idx
        self.hospital = hospital or args.hospital
        # channel_id 지정 시 그대로 사용 (패치 교체: 재고/수동 입력 패치 ID)
        self.channel_id = channel_id or f"CH{idx + 1:04d}"
        # 종료 사유: closed(퇴원/삭제 → 패치 폐기) | suspend(병원 전환 → 패치 유지)
        self.close_reason = "closed"
        self.args = args
        self.rng = random.Random(idx * 104729 + 7)
        # patient 를 넘기면 그대로 사용 (패치 교체: 같은 환자, 새 채널)
        self.patient = patient or make_patient(idx)
        self.resend_meta = False  # 환자 정보 변경(트랜스퍼) 시 즉시 meta 재전송
        self.gw_down_notified = False  # 게이트웨이 장애 이벤트 1회 발행용
        self.interference_notified = False  # 인접 게이트웨이 장애 간섭 이벤트 1회 발행용
        self.interference_affected = False  # 이번 간섭 에피소드에서 실제 영향 여부
        # 이동 중 신호 배리에이션: 걷는 동안 게이트웨이와의 거리/자세 변화로
        # 신호가 강해졌다 약해졌다 반복된다 (3~10초 주기 구간별 토글)
        self.move_sig_weak = False
        self.move_sig_until = 0.0
        self.last_pkt_ts = None  # 마지막 패킷 생성 시각 (유실 seq 스킵 계산용)
        self.ecg = EcgStream(self.rng, args.sample_rate)
        self.seq = 0
        self.weak_until = 0.0
        # 불량 채널: 접속 불량이 훨씬 잦음
        self.flaky = (idx % 7 == 3)
        self.was_dropped = False
        # 이동 여정: [(공간, 게이트웨이, 단계 종료 시각)] — 천천히 걷는 환자 전제.
        # 병실 → 복도(보행) → 목적지 체류 → 복도(보행) → 병실 순으로
        # 게이트웨이 핸드오프가 보행 속도로 단계별로 일어난다.
        self.journey = []
        # 동선 이력: [(공간, 게이트웨이, 진입 시각, 이탈 시각)] — 이동 타임라인용
        self.move_log = []
        self.cur_space = None
        self.cur_gw = None
        self.cur_since = time.time()
        # 예약(검사/진료) 일정: 스케줄러가 랜덤 생성 → 시간이 되면 검사실 여정 수행.
        # 예약 기반 이동은 소요 시간이 정해져 있어 복귀 예상 시각을 추정할 수 있다.
        self.appointments = []
        self.active_appt = None

    # --- 블루투스 게이트웨이 (공간 고정 매핑) ---------------------------
    # 게이트웨이는 공간에 고정 배치된다:
    #   병실   GW-{건물}{층}-{병실}        (같은 호실 환자는 같은 게이트웨이)
    #   복도   GW-{건물}{층}-{구역}-HALL   (건물/층/구역당 1대)
    #   화장실 GW-{건물}{층}-{구역}-WC     (건물/층/구역당 1대)
    #   검사실 GW-{건물}1-EXAM            (건물당 1대, 1층)
    def room_gateway(self):
        p = self.patient
        return f"GW-{p['building']}{p['floor']}-{p['room']}", f"{p['room']}호"

    def build_journey(self, now: float) -> str:
        """천천히 걷는 환자의 이동 여정 생성.

        보행(복도 20~60초) → 목적지 체류(화장실 1~3분, 검사실 3~8분) →
        보행(복도 20~60초) → 병실 복귀. 검사실은 1층이라 이동/엘리베이터
        경유 시간이 복도 단계에 포함된다.
        """
        p = self.patient
        hall_gw = f"GW-{p['building']}{p['floor']}-{p['zone']}-HALL"
        dest = self.rng.choice(["복도", "화장실", "검사실", "병문안"])
        j = []
        t = now + self.rng.uniform(20.0, 60.0)  # 병실 → 복도 보행
        j.append(("복도", hall_gw, t))
        if dest == "화장실":
            t += self.rng.uniform(60.0, 180.0)
            j.append(("화장실", f"GW-{p['building']}{p['floor']}-{p['zone']}-WC", t))
        elif dest == "검사실":
            t += self.rng.uniform(180.0, 480.0)
            j.append(("검사실", f"GW-{p['building']}1-EXAM", t))
        elif dest == "병문안":
            # 같은 층의 다른 병실 잠깐 방문 — 입실이 아니라 이동 중 상태 유지
            rooms = HOSPITALS[self.hospital]["rooms"]
            own_r = int(p["room"]) % 100
            r = self.rng.choice([x for x in range(1, rooms + 1) if x != own_r] or [own_r])
            visit_room = f"{p['floor']}{r:02d}"
            t += self.rng.uniform(60.0, 180.0)
            j.append((f"{visit_room}호", f"GW-{p['building']}{p['floor']}-{visit_room}", t))
        else:
            t += self.rng.uniform(60.0, 180.0)  # 복도 보행 연장 (산책)
            j[-1] = ("복도", hall_gw, t)
        t += self.rng.uniform(20.0, 60.0)  # 복도 → 병실 복귀 보행
        j.append(("복도", hall_gw, t))
        self.journey = j
        return dest

    def build_appt_journey(self, now: float, appt: dict):
        """예약(검사/진료) 기반 여정: 병실 → 복도 보행 → 검사실(예약 소요 시간)
        → 복도 보행 → 병실 복귀. 소요 시간이 정해져 있어 복귀 예상이 가능하다."""
        p = self.patient
        hall = f"GW-{p['building']}{p['floor']}-{p['zone']}-HALL"
        w1 = self.rng.uniform(20.0, 60.0)
        exam_end = now + w1 + appt["duration_s"]
        w2 = self.rng.uniform(20.0, 60.0)
        self.journey = [
            ("복도", hall, now + w1),
            ("검사실", f"GW-{p['building']}1-EXAM", exam_end),
            ("복도", hall, exam_end + w2),
        ]
        appt["status"] = "in_progress"
        appt["eta_return_ms"] = int((exam_end + w2) * 1000)
        self.active_appt = appt

    def pending_appt(self):
        """예약됨/진행 중 상태의 예약 (채널당 동시 1건만 유지)."""
        return next((a for a in self.appointments
                     if a["status"] in ("reserved", "in_progress")), None)

    def journey_phase(self, now: float):
        """현재 여정 단계 (지난 단계는 폐기). None 이면 병실에 있음."""
        while self.journey and now >= self.journey[0][2]:
            self.journey.pop(0)
        return self.journey[0] if self.journey else None

    def current_gateway(self, phase):
        """현재 공간의 게이트웨이. 여정 중이면 해당 단계 공간, 아니면 병실."""
        if phase:
            return phase[1], phase[0]
        return self.room_gateway()

    def current_area(self, phase) -> str:
        """현재 머무는 영역 키 (건물+층+구역) — 게이트웨이 장애 간섭 판정용."""
        if phase:
            return GatewayManager.gw_area(phase[1])
        p = self.patient
        return f"{p['building']}{p['floor']}-{p['zone']}"

    # --- 메시지 빌더 ---------------------------------------------------
    def meta_msg(self) -> dict:
        return {
            "type": "meta",
            "channel_id": self.channel_id,
            "ts_ms": now_ms(),
            "hospital": self.hospital,  # DB API 가 병원별 DB 로 정확히 라우팅
            "patient": self.patient,
        }

    def event_msg(self, event: str, detail: str = "") -> dict:
        return {
            "type": "device_event",
            "channel_id": self.channel_id,
            "ts_ms": now_ms(),
            "event": event,
            "detail": detail,
        }

    def ecg_msg(self, samples: list, weak: bool, moving: bool, gw: str, space: str) -> dict:
        self.seq += 1
        self.last_pkt_ts = time.time()
        return {
            "type": "ecg",
            "channel_id": self.channel_id,
            "seq": self.seq,
            "ts_ms": now_ms(),
            "sample_rate": self.args.sample_rate,
            # 소수 3자리(µV 해상도) 양자화 — 라우터 파형 파일(i16 ×1000)과 동일 정밀도,
            # JSON 직렬화 크기를 샘플당 ~20자 → ~6자로 절감 (WiFi 업링크 대역폭)
            "samples": [round(v, 3) for v in samples],
            "quality": "weak" if weak else "good",
            "moving": moving,
            "gateway_id": gw,
            "space": space,
        }

    # --- 랜덤 이벤트 ----------------------------------------------------
    def maybe_trigger_events(self, now: float, writer) -> bool:
        """확률적으로 상태 이벤트를 발생시킨다. True 반환 시 연결을 끊어야 함."""
        ticks_per_s = 1000.0 / self.args.packet_ms
        # 약신호: 평균 2분에 1회, 4~10초 지속 (정상 상태에서는 대부분 양호 유지)
        if now >= self.weak_until and self.rng.random() < 1.0 / (120.0 * ticks_per_s):
            self.weak_until = now + self.rng.uniform(4.0, 10.0)
            send_line(writer, self.event_msg("weak_signal", "low amplitude"))
        # 이동: 평균 20분에 1회, 도보 여정(수십 초 보행 + 수 분 체류)
        if not self.journey and self.rng.random() < 1.0 / (1200.0 * ticks_per_s):
            dest = self.build_journey(now)
            send_line(writer, self.event_msg("moving", f"{dest}(으)로 이동 시작 (도보)"))
        # 접속 불량: 불량 채널은 평균 45초, 일반 채널은 평균 10분에 1회
        mean_drop_s = 45.0 if self.flaky else 600.0
        if self.rng.random() < 1.0 / (mean_drop_s * ticks_per_s):
            return True
        return False

    # --- 메인 루프 ------------------------------------------------------
    async def run(self):
        try:
            while True:
                if MUX is not None:
                    # 배치 모드: 채널이 소켓을 갖지 않는다 — 라인은 BatchWriter 가
                    # 게이트웨이 멀티플렉서로 라우팅. '접속 불량' 은 소켓 종료 대신
                    # 전송 중단(+seq 스킵)으로 동일하게 재현된다.
                    writer = BatchWriter(MUX, self)
                else:
                    try:
                        reader, writer = await asyncio.open_connection(self.args.host, self.args.port)
                    except OSError:
                        await asyncio.sleep(3.0)
                        continue
                self.writer = writer
                try:
                    await self.stream_until_drop(writer)
                except (ConnectionError, OSError):
                    pass
                finally:
                    self.writer = None
                    writer.close()
                    try:
                        await writer.wait_closed()
                    except Exception:
                        pass
                # 접속 불량 상태 유지 후 재접속
                self.was_dropped = True
                await asyncio.sleep(self.rng.uniform(3.0, 10.0))
        except asyncio.CancelledError:
            # 명시적 삭제: 라우터에 channel_close 를 알리고 종료
            await self._notify_close()
            raise

    async def _notify_close(self):
        """채널 종료를 라우터에 통지 (필요 시 임시 연결 사용).
        reason=suspend(병원 전환)면 라우터가 패치 폐기를 생략한다."""
        msg = {"type": "channel_close", "channel_id": self.channel_id,
               "hospital": self.hospital, "reason": self.close_reason}
        try:
            w = self.writer
            temporary = False
            if w is None or w.is_closing():
                _, w = await asyncio.wait_for(
                    asyncio.open_connection(self.args.host, self.args.port), timeout=2.0)
                temporary = True
            send_line(w, msg)
            await asyncio.wait_for(w.drain(), timeout=2.0)
            if temporary:
                w.close()
        except Exception:
            pass  # 라우터가 죽어 있어도 삭제 자체는 진행

    async def stream_until_drop(self, writer):
        send_line(writer, self.meta_msg())
        if self.was_dropped:
            send_line(writer, self.event_msg("reconnected", "link restored"))
            self.was_dropped = False
        await writer.drain()
        last_meta = time.time()

        n_samples = int(self.args.sample_rate * self.args.packet_ms / 1000)
        interval = self.args.packet_ms / 1000.0
        # 접속 불량 등으로 전송이 끊겼던 구간은 seq 를 스킵 →
        # 라우터가 seq 갭으로 패킷 유실을 카운트할 수 있다
        if self.last_pkt_ts is not None:
            missed = int((time.time() - self.last_pkt_ts) / interval) - 1
            if missed > 0:
                self.seq += missed
        next_tick = time.time() + interval

        while True:
            now = time.time()
            if self.resend_meta or now - last_meta >= META_INTERVAL_S:
                send_line(writer, self.meta_msg())
                last_meta = now
                self.resend_meta = False

            if self.maybe_trigger_events(now, writer):
                # 접속 불량 시뮬레이션: 예고 없이 소켓 종료
                return

            phase = self.journey_phase(now)
            # 예약 시간 도래 → 검사실 여정 시작 (다른 여정이 없을 때)
            if phase is None and self.active_appt is None:
                appt = next((a for a in self.appointments
                             if a["status"] == "reserved"), None)
                if appt and now_ms() >= appt["scheduled_ms"]:
                    self.build_appt_journey(now, appt)
                    push_appt(self, appt)
                    send_line(writer, self.event_msg(
                        "moving", f"예약 이동: {appt['title']} ({appt['place']})"))
                    phase = self.journey_phase(now)
            # 예약 여정 종료 → 복귀 완료 기록
            if self.active_appt is not None and not self.journey:
                self.active_appt["status"] = "done"
                self.active_appt["returned_ms"] = now_ms()
                push_appt(self, self.active_appt)
                self.active_appt = None
            moving = phase is not None
            gw, space = self.current_gateway(phase)
            # 공간 전환 감지 → 동선 이력 기록 (이동 타임라인의 소스)
            if space != self.cur_space:
                if self.cur_space is not None:
                    self.move_log.append((self.cur_space, self.cur_gw, self.cur_since, now))
                    if len(self.move_log) > 40:
                        self.move_log.pop(0)
                self.cur_space, self.cur_gw, self.cur_since = space, gw, now
            own_gw_down = GATEWAYS.is_down(gw)

            # 인접(같은 건물+층+구역) 게이트웨이 장애 간섭.
            # 구역 내 '일부'(약 35%) 패치에만 영향 — 게이트웨이가 양호하면
            # 그 패치들의 절반 이상은 항상 양호하다 (전부 문제되는 경우 없음).
            if not own_gw_down and self.current_area(phase) in GATEWAYS.down_areas():
                if not self.interference_notified:
                    self.interference_notified = True
                    self.interference_affected = self.rng.random() < 0.35
                    if self.interference_affected:
                        send_line(writer, self.event_msg(
                            "weak_signal", "인접 게이트웨이 장애 영향 — 신호 저하"))
                if self.interference_affected:
                    self.weak_until = max(self.weak_until, now + 3.0)
                    # 간섭 중 간헐 접속 불량 (영향군만, 평균 60초에 1회 수준)
                    ticks_per_s = 1000.0 / self.args.packet_ms
                    if self.rng.random() < 1.0 / (60.0 * ticks_per_s):
                        return
            else:
                self.interference_notified = False
                self.interference_affected = False

            # 이동 중 신호 강약 배리에이션
            if moving:
                if now >= self.move_sig_until:
                    self.move_sig_weak = self.rng.random() < 0.35
                    self.move_sig_until = now + self.rng.uniform(3.0, 10.0)
            else:
                self.move_sig_weak = False

            weak = (now < self.weak_until) or self.move_sig_weak
            # 파형 위상은 항상 진행시킨다 (게이트웨이 장애 중에도 시간은 흐름)
            samples = self.ecg.next_samples(n_samples, weak, moving)
            # 패킷은 항상 생성해 seq 를 전진시킨다.
            # 게이트웨이 장애로 미전송된 패킷 = 유실 (라우터가 seq 갭으로 카운트)
            pkt = self.ecg_msg(samples, weak, moving, gw, space)
            if own_gw_down:
                # 게이트웨이 장애: 같은 공간의 모든 패치가 함께 업링크 중단
                if not self.gw_down_notified:
                    send_line(writer, self.event_msg("gateway_down", f"게이트웨이 {gw} 장애 — 업링크 중단"))
                    self.gw_down_notified = True
            else:
                if self.gw_down_notified:
                    send_line(writer, self.event_msg("gateway_up", f"게이트웨이 {gw} 복구"))
                    self.gw_down_notified = False
                send_line(writer, pkt)
            await writer.drain()

            next_tick += interval
            delay = next_tick - time.time()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                next_tick = time.time()  # 밀린 경우 리셋 (drift 방지)


def send_line(writer, msg: dict):
    writer.write((json.dumps(msg, ensure_ascii=False) + "\n").encode("utf-8"))


# ---------- 게이트웨이 배치 전송 (--batch-gateway) ----------
# 실제 게이트웨이(BLE 허브)처럼: 소켓은 게이트웨이당 1개, ecg 는 틱(packet_ms)당
# 게이트웨이당 1개의 ecg_batch 로 묶어 전송한다 (배치당 최대 16채널, 초과 시 분할).
# → 소켓 수 = 게이트웨이 수, 초당 패킷 수 = 5 × 게이트웨이 수.
MUX = None  # main() 에서 --batch-gateway 시 생성


class GatewayMux:
    MAX_PER_BATCH = 16  # 게이트웨이당 최대 패치 수

    def __init__(self, args):
        self.args = args
        self.conns = {}  # gw -> writer (게이트웨이당 소켓 1개)
        self.items = {}  # gw -> [채널 ecg 항목] (이번 틱 버퍼)
        self.ctrl = {}   # gw -> [meta/device_event/channel_close 라인]

    def route(self, ch, msg):
        """채널이 보낸 라인을 현재 게이트웨이 버킷으로 라우팅."""
        gw = ch.cur_gw or ch.current_gateway(None)[0]
        if msg.get("type") == "ecg":
            gw = msg.pop("gateway_id", "") or gw
            item = {k: msg[k] for k in
                    ("channel_id", "seq", "ts_ms", "sample_rate",
                     "samples", "quality", "moving")}
            item["space"] = msg.get("space", "")
            self.items.setdefault(gw, []).append(item)
        else:
            self.ctrl.setdefault(gw, []).append(msg)

    async def _conn(self, gw):
        w = self.conns.get(gw)
        if w is not None and not w.is_closing():
            return w
        try:
            _, w = await asyncio.open_connection(self.args.host, self.args.port)
            self.conns[gw] = w
            return w
        except OSError:
            self.conns.pop(gw, None)
            return None

    async def flush(self):
        for gw in list(set(self.items) | set(self.ctrl)):
            items = self.items.pop(gw, [])
            ctrl = self.ctrl.pop(gw, [])
            w = await self._conn(gw)
            if w is None:
                continue  # 접속 불가 — 이번 틱 유실 (seq 갭으로 카운트됨)
            try:
                for m in ctrl:  # meta 가 ecg 보다 먼저 가도록
                    send_line(w, m)
                for i in range(0, len(items), self.MAX_PER_BATCH):
                    send_line(w, {
                        "type": "ecg_batch", "gateway_id": gw, "ts_ms": now_ms(),
                        "space": "", "channels": items[i:i + self.MAX_PER_BATCH],
                    })
                await w.drain()
            except (ConnectionError, OSError):
                try:
                    w.close()
                except Exception:
                    pass
                self.conns.pop(gw, None)

    async def run(self):
        interval = self.args.packet_ms / 1000.0
        while True:
            await asyncio.sleep(interval)
            await self.flush()


class BatchWriter:
    """배치 모드용 가짜 소켓 writer.

    채널 루프(stream_until_drop)의 send_line 출력을 그대로 받아 GatewayMux 로
    라우팅한다 — 채널의 장애/이동/예약 로직을 수정 없이 재사용하기 위한 어댑터.
    """

    def __init__(self, mux, ch):
        self.mux = mux
        self.ch = ch
        self._closing = False

    def write(self, data: bytes):
        for line in data.decode("utf-8").splitlines():
            if line.strip():
                self.mux.route(self.ch, json.loads(line))

    async def drain(self):
        pass

    def close(self):
        self._closing = True

    def is_closing(self):
        return self._closing

    async def wait_closed(self):
        pass


# ---------- 예약(검사/진료) 일정 ----------
# 스케줄러가 랜덤 생성한 예약은 전용 연결로 라우터에 push 되고,
# 라우터가 DB API 로 중계해 SQLite 에 영속화된다 (정적 정보는 DB,
# 다이내믹 업데이트 경로는 라우터가 관리).
APPT_QUEUE = asyncio.Queue()
APPT_KINDS = [
    ("검사", "혈액검사", (120, 300)),
    ("검사", "심전도 검사", (120, 240)),
    ("검사", "X-ray 촬영", (120, 300)),
    ("검사", "CT 촬영", (240, 480)),
    ("진료", "외래 진료", (180, 420)),
    ("진료", "재활 치료", (300, 600)),
]


def push_appt(emu, appt: dict):
    """예약 생성/상태 변경을 라우터로 push (라우터 → DB API 중계)."""
    APPT_QUEUE.put_nowait({
        "type": "appointment",
        "channel_id": emu.channel_id,
        "hospital": emu.hospital,
        "ts_ms": now_ms(),
        "appointment": appt,
    })


async def appointment_reporter(args):
    """예약 큐를 라우터로 전송하는 전용 연결 (끊기면 재접속)."""
    while True:
        try:
            _, writer = await asyncio.open_connection(args.host, args.port)
        except OSError:
            await asyncio.sleep(3.0)
            continue
        try:
            while True:
                msg = await APPT_QUEUE.get()
                send_line(writer, msg)
                await writer.drain()
        except (ConnectionError, OSError):
            await asyncio.sleep(2.0)


async def appointment_scheduler(manager):
    """랜덤 예약 생성기: 평균 12초마다 예약 없는 환자 1명에게
    2~10분 뒤 검사/진료 예약을 잡는다."""
    while True:
        await asyncio.sleep(12.0)
        candidates = [emu for emu, _t in manager.tasks.values() if not emu.pending_appt()]
        if not candidates or random.random() > 0.9:
            continue
        emu = random.choice(candidates)
        kind, title, (dmin, dmax) = random.choice(APPT_KINDS)
        p = emu.patient
        appt = {
            "id": f"APT-{emu.channel_id}-{now_ms()}",
            "channel_id": emu.channel_id,
            "patient_id": p["id"],
            "patient_name": p["name"],
            "kind": kind,
            "title": title,
            "place": f"{p['building']}동 1층 검사실",
            "scheduled_ms": now_ms() + int(random.uniform(120.0, 600.0) * 1000),
            "duration_s": int(random.uniform(dmin, dmax)),
            "eta_return_ms": None,
            "returned_ms": None,
            "status": "reserved",
        }
        emu.appointments.append(appt)
        if len(emu.appointments) > 10:
            emu.appointments.pop(0)
        push_appt(emu, appt)
        print(f"[emulator] 예약: {p['name']}({emu.channel_id}) {title} "
              f"@ +{(appt['scheduled_ms'] - now_ms()) // 1000}s", flush=True)


class ChannelManager:
    """채널 태스크의 동적 추가/삭제를 관리한다."""

    def __init__(self, args):
        self.args = args
        self.tasks = {}  # idx -> (emulator, task)
        self.next_idx = 0
        self.hospital = args.hospital  # 현재 선택된 병원 (공간 구조 결정)

    async def load_from_db(self) -> int:
        """DB(SQLite) 의 현재 병원 환자 명단을 토대로 채널 생성.
        성공 시 생성 수, DB 비어있음/미기동이면 0 (호출측이 생성 폴백)."""
        loop = asyncio.get_event_loop()
        try:
            raw = await loop.run_in_executor(None, lambda: urllib.request.urlopen(
                f"{self.args.db_api}/patients?hospital={self.hospital}", timeout=3).read())
            rows = json.loads(raw).get("patients", [])
        except Exception:
            return 0
        if not rows:
            return 0
        # --db-limit: DB 명단이 커도 앞에서 N 명까지만 채널 생성 (로컬 테스트 소스용).
        # 0(기본)이면 제한 없음 — 기존(전체 명단) 동작 그대로.
        if getattr(self.args, "db_limit", 0) > 0:
            rows = rows[: self.args.db_limit]
        for i, r in enumerate(rows):
            patient = {
                "id": r.get("patient_id"), "name": r.get("name"),
                "building": r.get("building"), "floor": r.get("floor"),
                "ward": r.get("ward"), "zone": r.get("zone"), "room": r.get("room"),
                "doctor": r.get("doctor"), "department": r.get("department"),
                "nurse": r.get("nurse"),
            }
            # 프로필(얼굴 번호/성별/생년월일/병변) 복원 — 없으면 생략 (구 DB 호환)
            if r.get("profile_no"):
                patient.update({
                    "profile_no": r.get("profile_no"), "sex": r.get("sex") or "",
                    "birth": r.get("birth") or "", "blood": r.get("blood") or "",
                    "conditions": r.get("conditions") or [],
                })
            self.spawn(i, patient=patient, channel_id=r.get("channel_id") or None)
        self.next_idx = len(rows)
        print(f"[emulator] DB 명단 기반 채널 {len(rows)}개 생성 ({self.hospital})", flush=True)
        return len(rows)

    async def reload_from_db(self):
        """전 채널 종료 후 DB 명단 기준으로 재생성 (DB 리셋 후 호출).
        재동기화이므로 suspend — DB 패치를 폐기하지 않는다."""
        await self.remove_first(len(self.tasks), reason="suspend")
        GATEWAYS.gateways.clear()
        self.next_idx = 0
        n = await self.load_from_db()
        source = "db"
        if not n:
            n = len(self.add(100))
            source = "generated"
        return n, source

    async def set_hospital(self, hospital_id: str) -> int:
        """병원 전환: 이전 병원 채널을 일시 중단(suspend — 패치 폐기 없음)하고
        새 병원의 DB 명단을 로드한다. DB 가 있으면 재생성하지 않는다."""
        count = len(self.tasks) or 100
        # 이전 병원 채널 종료는 suspend — DB 에 in_use 로 남아 복귀 시 그대로 복원
        await self.remove_first(len(self.tasks), reason="suspend")
        self.hospital = hospital_id
        GATEWAYS.gateways.clear()  # 이전 병원 게이트웨이 목록 폐기
        self.next_idx = 0
        loaded = await self.load_from_db()
        source = "db"
        if not loaded:
            self.add(count)
            loaded = count
            source = "generated"
        print(f"[emulator] hospital -> {hospital_id} ({loaded} channels, source={source}, "
              f"{total_beds(hospital_id)} beds)", flush=True)
        return loaded, source

    # 트랜스퍼로 변경 가능한 환자 속성
    PATIENT_FIELDS = {"name", "building", "floor", "ward", "zone", "room",
                      "doctor", "department", "nurse"}

    def spawn(self, idx: int, patient: dict = None, channel_id: str = None) -> str:
        emu = ChannelEmulator(
            idx, self.args,
            patient=patient or make_patient(idx, self.hospital),
            channel_id=channel_id or make_channel_id(idx, self.hospital),
            hospital=self.hospital)
        task = asyncio.create_task(emu.run())
        self.tasks[idx] = (emu, task)
        return emu.channel_id

    def find(self, channel_id: str):
        for idx, (emu, _) in self.tasks.items():
            if emu.channel_id == channel_id:
                return idx
        return None

    def update_patient(self, channel_id: str, fields: dict) -> bool:
        """환자 트랜스퍼: 병실/병동/진료과/주치의 등 변경 → meta 즉시 재전송.
        게이트웨이는 병실에 고정 매핑이므로 병실 변경 시 자동으로 따라가고,
        위치(병동/구역)가 바뀌면 담당 간호사도 구역 담당제에 따라 자동 재배정된다."""
        idx = self.find(channel_id)
        if idx is None:
            return False
        emu = self.tasks[idx][0]
        loc_changed = any(k in fields for k in ("building", "floor", "ward", "zone", "room"))
        for k, v in fields.items():
            if k in self.PATIENT_FIELDS and isinstance(v, str) and v.strip():
                emu.patient[k] = v.strip()
        # 간호사는 건물×층×구역 담당제 — 위치가 바뀌면 새 구역 담당으로 자동 변경
        if loc_changed and "nurse" not in fields:
            try:
                p = emu.patient
                emu.patient["nurse"] = _nurse(p["building"], int(p["floor"]), p["zone"])
            except (KeyError, ValueError):
                pass
        emu.resend_meta = True
        print(f"[emulator] transfer {channel_id}: {fields}")
        return True

    async def discharge(self, channel_id: str):
        """퇴원: 채널 종료 (channel_close 통지 → 라우터에서 완전 제거)."""
        idx = self.find(channel_id)
        if idx is None:
            return None
        emu, task = self.tasks.pop(idx)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        print(f"[emulator] discharge {channel_id} ({emu.patient['name']})")
        return channel_id

    def available_patches(self, count: int = 12) -> list:
        """패치 재고 (폴백용): 아직 사용되지 않은 패치 ID — 병원 프리픽스 포함."""
        used = {emu.channel_id for emu, _ in self.tasks.values()}
        out, i = [], self.next_idx
        while len(out) < count:
            cid = make_channel_id(i, self.hospital)
            if cid not in used:
                out.append(cid)
            i += 1
        return out

    async def replace_patch(self, channel_id: str, new_id: str = None):
        """패치 교체: 기존 채널 종료 후 같은 환자로 새 패치 연결.
        new_id 지정 시(재고 선택/수동 입력) 그 ID 로, 아니면 자동 발급."""
        idx = self.find(channel_id)
        if idx is None:
            return None, "unknown channel"
        if new_id:
            new_id = new_id.strip().upper()
            if not re.fullmatch(r"[A-Z0-9\-]{2,16}", new_id):
                return None, "invalid patch id"
            if new_id == channel_id or self.find(new_id) is not None:
                return None, "patch id already in use"
        patient = dict(self.tasks[idx][0].patient)
        await self.discharge(channel_id)
        new_idx = self.next_idx
        self.next_idx += 1
        new_cid = self.spawn(new_idx, patient=patient, channel_id=new_id)
        print(f"[emulator] patch replaced {channel_id} -> {new_cid} ({patient['name']})")
        return new_cid, None

    def add(self, count: int) -> list:
        ids = []
        for _ in range(count):
            idx = self.next_idx
            self.next_idx += 1
            ids.append(self.spawn(idx))
        print(f"[emulator] +{count} channels: {ids[0]}..{ids[-1]} (total {len(self.tasks)})")
        return ids

    async def remove_first(self, count: int, reason: str = "closed") -> list:
        """인덱스가 가장 낮은 채널부터 count 개 종료 (channel_close 통지 포함).
        reason=suspend 면 패치를 폐기하지 않는다 (병원 전환용)."""
        idxs = sorted(self.tasks.keys())[:count]
        removed = []
        pending = []
        for idx in idxs:
            emu, task = self.tasks.pop(idx)
            emu.close_reason = reason
            task.cancel()
            pending.append(task)
            removed.append(emu.channel_id)
        await asyncio.gather(*pending, return_exceptions=True)
        if removed:
            print(f"[emulator] -{len(removed)} channels: {removed[0]}..{removed[-1]} (total {len(self.tasks)})")
        return removed

    async def reset(self, count: int) -> list:
        """모든 채널을 종료(channel_close 통지)한 뒤 count 개를 새로 생성.
        채널 번호는 CH0001 부터 다시 시작한다."""
        await self.remove_first(len(self.tasks))
        self.next_idx = 0
        ids = self.add(count)
        print(f"[emulator] reset -> {count} channels")
        return ids

    def channel_ids(self) -> list:
        return [self.tasks[i][0].channel_id for i in sorted(self.tasks.keys())]


def http_response(status: str, body: dict) -> bytes:
    """CORS 허용 JSON 응답 (어드민 웹에서 직접 호출)."""
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


async def handle_control(manager: ChannelManager, reader, writer):
    """초소형 HTTP 핸들러 (stdlib asyncio 만 사용)."""
    try:
        request_line = (await reader.readline()).decode("ascii", "ignore").strip()
        headers = {}
        while True:
            h = await reader.readline()
            if not h or h in (b"\r\n", b"\n"):
                break
            k, _, v = h.decode("latin1").partition(":")
            headers[k.strip().lower()] = v.strip()
        if not request_line:
            return
        body_len = int(headers.get("content-length", "0") or 0)
        payload = {}
        if body_len:
            try:
                payload = json.loads(await reader.readexactly(body_len))
            except (json.JSONDecodeError, asyncio.IncompleteReadError):
                payload = {}
        method, target, _ = request_line.split(" ", 2)
        url = urlparse(target)
        qs = parse_qs(url.query)
        default_count = "100" if url.path == "/channels/reset" else "20"
        count = max(1, min(2000, int(qs.get("count", [default_count])[0])))
        cid = qs.get("id", [None])[0]

        if method == "OPTIONS":
            writer.write(http_response("204 No Content", {}))
        elif method == "GET" and url.path == "/status":
            writer.write(http_response("200 OK", {
                "count": len(manager.tasks),
                "channels": manager.channel_ids(),
            }))
        elif method == "GET" and url.path == "/gateways":
            # 게이트웨이 상태 (Patch Map / 시스템 상태 타일이 폴링)
            writer.write(http_response("200 OK", GATEWAYS.snapshot()))
        elif method == "GET" and url.path == "/hospital":
            writer.write(http_response("200 OK", {
                "id": manager.hospital,
                "hospitals": [{"id": k, "name": v["name"], "prefix": v["prefix"],
                               "beds": total_beds(k)}
                              for k, v in HOSPITALS.items()],
            }))
        elif method == "GET" and url.path == "/roster":
            # 병원별 결정적 환자/패치 명단 (DB 리셋이 각 병원 DB 를 채울 때 사용)
            hid = qs.get("hospital", [manager.hospital])[0]
            if hid not in HOSPITALS:
                writer.write(http_response("404 Not Found", {"error": "unknown hospital"}))
            else:
                writer.write(http_response("200 OK", {
                    "hospital": hid,
                    "roster": [{"channel_id": make_channel_id(i, hid),
                                "patient": make_patient(i, hid)}
                               for i in range(count)],
                }))
        elif method == "GET" and url.path == "/journeys":
            # 이동 동선: 여정 진행 중 / 최근 30분 내 이동 이력 / 예약 보유 채널.
            # log = 지나온 구간, current = 현재 위치, next_appt = 예약 일정.
            now = time.time()
            out = []
            for idx in sorted(manager.tasks.keys()):
                emu, _task = manager.tasks[idx]
                recent = [e for e in emu.move_log if now - e[3] < 1800]
                if not emu.journey and not recent and not emu.pending_appt():
                    continue
                nxt = emu.pending_appt()
                out.append({
                    "channel_id": emu.channel_id,
                    "patient": emu.patient,
                    "moving": bool(emu.journey),
                    "current": {"space": emu.cur_space, "gw": emu.cur_gw,
                                "since_ms": int(emu.cur_since * 1000)},
                    "log": [{"space": s, "gw": g, "start_ms": int(a * 1000),
                             "end_ms": int(b * 1000)} for (s, g, a, b) in recent],
                    # 다음 예약 (검사/진료). 예약 기반 이동만 복귀 예상이 가능하다.
                    "next_appt": nxt,
                    "eta_return_ms": (nxt or {}).get("eta_return_ms")
                        if nxt and nxt["status"] == "in_progress" else None,
                })
            writer.write(http_response("200 OK",
                                       {"now_ms": int(now * 1000), "journeys": out}))
        elif method == "POST" and url.path == "/hospital":
            hid = qs.get("id", [None])[0]
            if hid in HOSPITALS:
                n, source = await manager.set_hospital(hid)
                writer.write(http_response("200 OK", {"id": hid, "count": n, "source": source}))
            else:
                writer.write(http_response("404 Not Found", {"error": "unknown hospital"}))
        elif method == "POST" and url.path == "/channels/add":
            ids = manager.add(count)
            writer.write(http_response("200 OK", {"added": ids, "count": len(manager.tasks)}))
        elif method == "POST" and url.path == "/channels/remove":
            ids = await manager.remove_first(count)
            writer.write(http_response("200 OK", {"removed": ids, "count": len(manager.tasks)}))
        elif method == "POST" and url.path == "/channels/reset":
            ids = await manager.reset(count)
            writer.write(http_response("200 OK", {"created": ids, "count": len(manager.tasks)}))
        elif method == "POST" and url.path == "/channels/reload":
            # DB 명단 기준 재생성 (DB 리셋 직후 호출)
            n, source = await manager.reload_from_db()
            writer.write(http_response("200 OK", {"count": n, "source": source}))
        # --- 환자 트랜스퍼 (id 쿼리 파라미터로 채널 지정) ---
        elif method == "POST" and url.path == "/channel/patient" and cid:
            ok = manager.update_patient(cid, payload)
            writer.write(http_response("200 OK" if ok else "404 Not Found",
                                       {"updated": ok, "channel_id": cid}))
        elif method == "POST" and url.path == "/channel/discharge" and cid:
            gone = await manager.discharge(cid)
            writer.write(http_response("200 OK" if gone else "404 Not Found",
                                       {"discharged": gone, "count": len(manager.tasks)}))
        elif method == "POST" and url.path == "/channel/replace" and cid:
            new_req = qs.get("new", [None])[0]
            new_id, err = await manager.replace_patch(cid, new_req)
            if new_id:
                writer.write(http_response("200 OK", {"old": cid, "new": new_id}))
            else:
                writer.write(http_response("400 Bad Request", {"error": err}))
        elif method == "GET" and url.path == "/patches":
            # 패치 재고 목록 (트랜스퍼 모달의 패치 교체 드롭다운)
            writer.write(http_response("200 OK", {"available": manager.available_patches()}))
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


async def gateway_status_reporter(args):
    """게이트웨이 상태를 라우터로 push 전송 (전용 연결, 2초 주기).

    라우터는 이 정보를 /api/gateways 로 노출하고, 어드민 Patch Map 이
    게이트웨이 상태 아이콘/장애 표시에 사용한다.
    """
    while True:
        try:
            _, writer = await asyncio.open_connection(args.host, args.port)
        except OSError:
            await asyncio.sleep(3.0)
            continue
        try:
            while True:
                snap = GATEWAYS.snapshot()
                send_line(writer, {
                    "type": "gateway_status",
                    "ts_ms": now_ms(),
                    "known": snap["known"],
                    "down": snap["down"],
                })
                await writer.drain()
                await asyncio.sleep(2.0)
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
        await asyncio.sleep(3.0)


async def main():
    ap = argparse.ArgumentParser(description="ECG channel input emulator")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7000)
    ap.add_argument("--channels", type=int, default=24, help="initial number of channels (200+ supported)")
    ap.add_argument("--sample-rate", type=int, default=250)
    ap.add_argument("--packet-ms", type=int, default=200, help="packet interval in ms")
    ap.add_argument("--control-port", type=int, default=7500, help="HTTP control API port")
    ap.add_argument("--hospital", default="seoul-a", choices=list(HOSPITALS),
                    help="initial hospital (space structure)")
    ap.add_argument("--db-limit", type=int, default=0,
                    help="DB 명단 로드 시 최대 채널 수 (0=무제한, 로컬 테스트 소스용)")
    ap.add_argument("--batch-gateway", action="store_true",
                    help="게이트웨이 단위 배치 전송: 소켓=게이트웨이당 1개, "
                         "ecg 는 틱당 ecg_batch(최대 16채널)로 묶음")
    ap.add_argument("--db-api", default="http://127.0.0.1:7600",
                    help="DB API 주소 — 채널은 DB 명단을 토대로 생성된다")
    args = ap.parse_args()

    if args.batch_gateway:
        global MUX
        MUX = GatewayMux(args)
        asyncio.create_task(MUX.run())
        print("[emulator] 게이트웨이 배치 모드: 소켓=게이트웨이당 1개, "
              "ecg_batch ≤16채널/틱", flush=True)

    manager = ChannelManager(args)
    # 채널은 DB(SQLite) 명단을 토대로 생성한다. DB 가 비어 있거나 미기동이면 생성 폴백.
    loaded = await manager.load_from_db()
    if not loaded:
        manager.add(args.channels)
        print(f"[emulator] DB 비어있음/미기동: {args.channels}채널 생성 (DB 는 push 로 동기화)", flush=True)

    asyncio.create_task(gateway_status_reporter(args))
    asyncio.create_task(appointment_reporter(args))   # 예약 push (라우터 → DB 중계)
    asyncio.create_task(appointment_scheduler(manager))  # 랜덤 예약 생성
    server = await asyncio.start_server(
        lambda r, w: handle_control(manager, r, w), "0.0.0.0", args.control_port)
    print(f"[emulator] {args.channels} channels -> {args.host}:{args.port}, "
          f"control API on :{args.control_port}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
