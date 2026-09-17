"""분석 서버의 채널별 상태 관리 + 간이 HR 추정."""
import random
import time
from collections import deque


class ChannelState:
    """채널 하나의 분석 상태.

    - buffer: 최근 샘플 (HR 추정용, 약 5초)
    - next_arrhythmia: 다음 부정맥 이벤트 예정 시각 (10~120초 랜덤)
    - silent_reported: 무패킷 연결해제 이벤트를 이미 보냈는지
    """

    ARRHYTHMIA_KINDS = [
        ("arrhythmia", "AFib suspected"),
        ("arrhythmia", "VTach run detected"),
        ("arrhythmia", "PVC couplet"),
        ("arrhythmia", "Bradycardia episode"),
        ("arrhythmia", "Pause > 2s"),
    ]

    def __init__(self, channel_id: str):
        self.channel_id = channel_id
        self.sample_rate = 250
        self.buffer = deque(maxlen=250 * 5)
        self.last_seen = time.time()
        self.hr = None
        self.next_arrhythmia = time.time() + random.uniform(10.0, 120.0)
        self.silent_reported = False
        self.resumed = False

    def feed(self, samples: list, sample_rate: int):
        if sample_rate != self.sample_rate:
            self.sample_rate = sample_rate
            self.buffer = deque(self.buffer, maxlen=sample_rate * 5)
        if self.silent_reported:
            # 무패킷 상태에서 데이터 재개 → 다음 응답에 reconnected 이벤트 포함
            self.silent_reported = False
            self.resumed = True
        self.buffer.extend(samples)
        self.last_seen = time.time()

    def estimate_hr(self):
        """간이 R-peak 검출 기반 HR 추정 (목업 수준)."""
        sr = self.sample_rate
        window = list(self.buffer)[-sr * 4:]
        if len(window) < sr * 2:
            return self.hr
        peak = max(window)
        base = sum(window) / len(window)
        if peak - base < 0.3:  # 신호가 너무 약하면 추정 보류
            return self.hr
        threshold = base + 0.55 * (peak - base)
        min_gap = int(0.3 * sr)
        peaks = []
        last_idx = -min_gap
        for i in range(1, len(window) - 1):
            v = window[i]
            if v >= threshold and v >= window[i - 1] and v >= window[i + 1]:
                if i - last_idx >= min_gap:
                    peaks.append(i)
                    last_idx = i
        if len(peaks) < 3:
            return self.hr
        gaps = [b - a for a, b in zip(peaks, peaks[1:])]
        mean_gap = sum(gaps) / len(gaps)
        hr = 60.0 * sr / mean_gap
        if not (20.0 <= hr <= 250.0):
            return self.hr
        # 지수 평활
        self.hr = round(hr if self.hr is None else 0.7 * self.hr + 0.3 * hr, 1)
        return self.hr

    def pop_events(self):
        """이번 응답에 포함할 이벤트 목록."""
        events = []
        now = time.time()
        if self.resumed:
            events.append({"kind": "reconnected", "detail": "packet stream resumed"})
            self.resumed = False
        if now >= self.next_arrhythmia:
            kind, detail = random.choice(self.ARRHYTHMIA_KINDS)
            events.append({"kind": kind, "detail": detail})
            self.next_arrhythmia = now + random.uniform(10.0, 120.0)
        return events
