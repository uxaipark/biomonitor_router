"""목업 분석 서버.

라우터가 클라이언트로 접속하며(기본 0.0.0.0:7100), 전 채널이 하나의
연결로 멀티플렉싱된다.

동작:
- ecg 패킷 수신 → 100ms 지연 후 {channel_id, seq, hr, events} 응답
  (seq 를 그대로 돌려주므로 라우터가 파형과 싱크를 맞출 수 있다)
- HR: 최근 4초 버퍼의 간이 R-peak 검출
- 부정맥 이벤트: 채널별 10초~2분 사이 랜덤 간격으로 발생
- watchdog: 5초 이상 무패킷 채널에 disconnected 이벤트(데이터 비움) 1회 발행,
  데이터 재개 시 reconnected 이벤트 포함

사용법:
    python main.py [--port 7100] [--delay-ms 100]
"""
import argparse
import asyncio
import json
import random
import time

from channel_state import ChannelState

SILENT_AFTER_S = 5.0


def now_ms() -> int:
    return int(time.time() * 1000)


class AnalysisServer:
    """목업 분석 서버 + 이상동작 시뮬레이터.

    정상: 패킷당 100ms 분석 지연.
    이상(랜덤 발생):
      - 개별 응답 저속화: 2% 확률로 0.3~2초 소요 (허용치 100ms 초과)
      - 엔진 스톨: 60~180초마다 발생, 3~10초(지연) 또는 61~90초(가용시간 1분 초과).
        스톨 중 응답은 폐기 → 라우터가 타임아웃 플러시로 무분석 주행.
      - 엔진 크래시: 5~10분마다 연결 강제 종료 → 라우터 패스스루 전환 후 자동 재접속.
    """

    def __init__(self, delay_ms: int):
        self.delay_s = delay_ms / 1000.0
        self.channels = {}  # channel_id -> ChannelState
        # 이상동작 상태
        self.slow_prob = 0.02
        self.stall_until = 0.0
        self.next_stall = time.time() + random.uniform(60.0, 180.0)
        self.next_crash = time.time() + random.uniform(300.0, 600.0)
        self.writers = set()
        # 리스너 핸들 (크래시 시뮬레이션이 재기동 동안 내렸다 다시 올린다)
        self.server = None
        self.host = "0.0.0.0"
        self.port = 7100

    async def anomaly_loop(self):
        """스톨/크래시 에피소드 스케줄러."""
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            if now >= self.next_stall:
                if random.random() < 0.25:
                    dur = random.uniform(61.0, 90.0)  # 분석 가용 시간(1분) 초과
                    label = "가용시간(1분) 초과"
                else:
                    dur = random.uniform(3.0, 10.0)   # 허용치(100ms) 초과 지연
                    label = "분석 지연"
                self.stall_until = now + dur
                self.next_stall = self.stall_until + random.uniform(60.0, 180.0)
                print(f"[analysis] !! 엔진 스톨 시작 ({label}, {dur:.0f}s) - 응답 폐기", flush=True)
            if now >= self.next_crash:
                self.next_crash = now + random.uniform(300.0, 600.0)
                # 크래시 = 연결 종료 + 재기동 시간 동안 리스너 다운.
                # (리스너가 살아 있으면 라우터가 수 ms 만에 재접속해
                #  다운타임이 사실상 0 으로 측정된다)
                recovery = random.uniform(15.0, 45.0)
                print(f"[analysis] xx 엔진 크래시 (알고리즘 오동작 시뮬레이션) - "
                      f"연결 종료, {recovery:.0f}s 후 재기동", flush=True)
                for w in list(self.writers):
                    try:
                        w.close()
                    except Exception:
                        pass
                if self.server is not None:
                    self.server.close()
                    await self.server.wait_closed()
                    await asyncio.sleep(recovery)
                    self.server = await asyncio.start_server(
                        self.handle_router, self.host, self.port)
                    print("[analysis] 엔진 재기동 완료 - 접속 재개", flush=True)

    def state_of(self, channel_id: str) -> ChannelState:
        st = self.channels.get(channel_id)
        if st is None:
            st = ChannelState(channel_id)
            self.channels[channel_id] = st
        return st

    async def handle_router(self, reader, writer):
        peer = writer.get_extra_info("peername")
        print(f"[analysis] router connected: {peer}", flush=True)
        self.writers.add(writer)
        out_q = asyncio.Queue()
        writer_task = asyncio.create_task(self._writer_loop(writer, out_q))
        watchdog_task = asyncio.create_task(self._watchdog_loop(out_q))
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "ecg":
                    st = self.state_of(msg["channel_id"])
                    st.feed(msg.get("samples", []), msg.get("sample_rate", 250))
                    # 100ms 분석 지연을 시뮬레이션 (수신 루프는 막지 않음)
                    asyncio.create_task(self._respond(out_q, msg, st))
                elif mtype == "meta":
                    self.state_of(msg["channel_id"])
                elif mtype == "channel_close":
                    # 명시적으로 삭제된 채널: 상태 제거 (watchdog 대상에서 제외)
                    self.channels.pop(msg["channel_id"], None)
        finally:
            self.writers.discard(writer)
            watchdog_task.cancel()
            writer_task.cancel()
            writer.close()
            print(f"[analysis] router disconnected: {peer}", flush=True)

    async def _respond(self, out_q, msg, st: ChannelState):
        # 엔진 스톨 중이면 응답을 그냥 폐기한다 (라우터가 타임아웃 플러시로 계속 주행)
        if time.time() < self.stall_until:
            return
        delay = self.delay_s
        if random.random() < self.slow_prob:
            # 개별 응답 저속화: 허용치(100ms)를 넘는 0.3~2초
            delay += random.uniform(0.3, 2.0)
        await asyncio.sleep(delay)  # 분석 소요 시간
        if time.time() < self.stall_until:
            return  # 대기 중 스톨 시작됨
        hr = st.estimate_hr()
        events = st.pop_events()
        await out_q.put({
            "type": "analysis",
            "channel_id": msg["channel_id"],
            "seq": msg["seq"],
            "ts_ms": msg.get("ts_ms", now_ms()),
            "hr": hr,
            "events": events,
        })

    async def _watchdog_loop(self, out_q):
        """무패킷 채널 감시: 데이터는 비우고 연결해제 이벤트만 발행.
        + 장기(10분) 무패킷 채널 상태 제거 — channel_close 없이 사라진 채널
        (게이트웨이 재시작 등)의 ChannelState(~40KB) 가 영구 누적되는 것을 방지."""
        STALE_EVICT_S = 600.0
        while True:
            await asyncio.sleep(1.0)
            now = time.time()
            stale = [cid for cid, st in self.channels.items()
                     if now - st.last_seen > STALE_EVICT_S]
            for cid in stale:
                del self.channels[cid]
            if stale:
                print(f"[analysis] 장기 무패킷 채널 {len(stale)}개 상태 제거 "
                      f"(잔여 {len(self.channels)})", flush=True)
            for st in self.channels.values():
                if not st.silent_reported and now - st.last_seen > SILENT_AFTER_S:
                    st.silent_reported = True
                    st.hr = None
                    await out_q.put({
                        "type": "analysis",
                        "channel_id": st.channel_id,
                        "seq": None,
                        "ts_ms": now_ms(),
                        "hr": None,
                        "events": [{
                            "kind": "disconnected",
                            "detail": f"no packet for {SILENT_AFTER_S:.0f}s",
                        }],
                    })

    async def _writer_loop(self, writer, out_q):
        """응답 쓰기를 큐로 직렬화 (동시 write 방지)."""
        while True:
            msg = await out_q.get()
            writer.write((json.dumps(msg) + "\n").encode("utf-8"))
            await writer.drain()


async def main():
    ap = argparse.ArgumentParser(description="mock ECG analysis server")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7100)
    ap.add_argument("--delay-ms", type=int, default=100)
    args = ap.parse_args()

    server_obj = AnalysisServer(args.delay_ms)
    server_obj.host, server_obj.port = args.host, args.port
    # 리스너는 anomaly_loop 가 크래시 재기동 시 내렸다 올리므로 핸들을 넘긴다
    server_obj.server = await asyncio.start_server(server_obj.handle_router, args.host, args.port)
    asyncio.create_task(server_obj.anomaly_loop())
    print(f"[analysis] listening on {args.host}:{args.port} (delay {args.delay_ms}ms, anomaly sim ON)", flush=True)
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
