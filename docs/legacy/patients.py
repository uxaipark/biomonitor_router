"""채널 인덱스 → 환자 메타데이터 생성.

채널 인덱스로 시드를 고정하므로 에뮬레이터를 재시작해도 같은 채널은
항상 같은 환자/병실/주치의를 갖는다 (라우터 그룹핑 테스트의 재현성 확보).

환자 프로필(이름/성별/생년월일/병변/얼굴 번호)은 data/patients.json 의
2000명 명단에서 배정한다 — 에뮬레이터는 DB와 독립적으로 동작해야 하므로
필요한 데이터를 스스로 보유한다 (scripts/gen-profiles.py 로 생성).
"""
import json
import os
import random

from names_ko import adult_name, full_name

# 자체 보유 프로필 명단 (없으면 이름 생성 폴백)
_PROFILES = []
try:
    _p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "patients.json")
    with open(_p, encoding="utf-8") as _f:
        _PROFILES = json.load(_f)["profiles"]
except Exception:
    pass

_SURNAMES = ["김", "이", "박", "최", "정", "강", "조", "윤", "장", "임", "한", "오", "서", "신", "권",
             "황", "안", "송", "전", "홍", "유", "고", "문", "양", "손", "배", "백", "허", "남", "심",
             "노", "하", "곽", "성", "차", "주", "우", "구", "민", "류"]
# 이름은 음절 조합으로 생성 (첫 음절 × 끝 음절 = 수백 가지) + 외자 이름 일부
_GIVEN_FIRST = ["민", "서", "도", "지", "하", "예", "수", "은", "현", "채",
                "유", "시", "다", "건", "주", "연", "태", "재", "윤", "가",
                "나", "세", "준", "혜", "정", "경", "승", "진", "소", "영"]
_GIVEN_LAST = ["준", "연", "윤", "우", "은", "호", "아", "민", "원", "빈",
               "율", "인", "영", "석", "희", "랑", "온", "결", "찬", "솔",
               "람", "별", "혁", "성", "화", "경", "림", "안", "규", "담"]
_GIVEN_SINGLE = ["준", "윤", "솔", "결", "온", "빈", "율", "찬", "환", "혁"]
_DEPARTMENTS = ["Cardiology", "InternalMedicine", "Neurology", "Pulmonology"]

PATIENTS_PER_DOCTOR = 20  # 주치의 1명당 담당 환자 수 (환자 수에 비례해 의사 증가)


def _doctor(idx: int) -> str:
    """주치의: 환자 20명당 1명씩 결정적으로 생성 (채널 수 증가 → 의사 수 증가)."""
    di = idx // PATIENTS_PER_DOCTOR
    rng = random.Random(f"doctor-{di}")
    return f"Dr.{adult_name(rng)}"


def _nurse(building: str, floor: int, zone: str) -> str:
    """담당 간호사: 건물×층×구역당 1명 (사용 층이 늘면 간호사도 자동 증가)."""
    rng = random.Random(f"nurse-{building}{floor}-{zone}")
    return f"N.{adult_name(rng)}"


# 병원별 공간 구조. rooms 는 층당 병실 수(상/하 절반 배치), beds 는 병실당 병상.
# 병상 슬롯을 시드 고정 셔플로 채널 인덱스에 매핑 → 병실당 최대 beds 명 보장.
HOSPITALS = {
    # floors 는 최대 확장 층. 병상은 저층부터 순차 충전되므로
    # 채널 수에 맞춰 사용 층수가 자동으로 늘어난다 (어드민은 사용 층만 표시).
    # prefix 는 패치(채널) ID 프리픽스 — 병원 간 패치 번호가 절대 겹치지 않게 한다.
    "seoul-a": {"name": "서울 A 병원", "prefix": "SA", "buildings": ("A", "B"),
                "floors": tuple(range(2, 16)), "rooms": 12, "beds": 6},   # 층당 144병상, 최대 2,016
    "busan-b": {"name": "부산 B 병원", "prefix": "BB", "buildings": ("W", "E"),
                "floors": tuple(range(9, 22)), "rooms": 20, "beds": 4},   # 층당 160병상, 최대 2,080
}


def make_channel_id(idx: int, hospital: str = "seoul-a") -> str:
    """병원 프리픽스가 붙은 고유 패치(채널) ID (예: SA-0001, BB-0001)."""
    return f"{HOSPITALS[hospital]['prefix']}-{idx + 1:04d}"

_slot_cache = {}


def _slots(hospital: str):
    """병상 슬롯: 층 순서(저층 우선)로 채우되, 층 안에서는 셔플.
    → 채널 수가 늘어나면 위층이 순서대로 열린다."""
    if hospital not in _slot_cache:
        h = HOSPITALS[hospital]
        rng = random.Random(20260811)
        slots = []
        for f in h["floors"]:
            floor_slots = [(b, f, r)
                           for b in h["buildings"]
                           for r in range(1, h["rooms"] + 1)
                           for _ in range(h["beds"])]
            rng.shuffle(floor_slots)
            slots.extend(floor_slots)
        _slot_cache[hospital] = slots
    return _slot_cache[hospital]


def total_beds(hospital: str) -> int:
    return len(_slots(hospital))


def make_patient(idx: int, hospital: str = "seoul-a") -> dict:
    h = HOSPITALS[hospital]
    rng = random.Random(idx * 7919 + 17)
    building, f, r = _slots(hospital)[idx % total_beds(hospital)]
    floor = str(f)
    room = f"{f}{r:02d}"
    # 구역은 평면도와 일치: 각 열(상/하)의 왼쪽 절반 Z1 / 오른쪽 절반 Z2
    half = h["rooms"] // 2
    zone = "Z1" if (r - 1) % half < half // 2 else "Z2"
    # 병동은 층 밴드 3분할 (W1/W2/W3)
    band = h["floors"].index(f) * 3 // len(h["floors"])
    ward = ("W1", "W2", "W3")[band]
    # 프로필 배정: 병원 오프셋 + 인덱스 (병원 간 같은 프로필 재사용 방지)
    prof = None
    if _PROFILES:
        offset = 0 if hospital == "seoul-a" else len(_PROFILES) // 2
        prof = _PROFILES[(offset + idx) % len(_PROFILES)]
    if prof:
        name = prof["name"]
    else:
        # 프로필 명단이 없을 때 폴백: 성별/연대별 다빈도 이름 생성
        sex = rng.choice(["F", "M"])
        name = full_name(sex, rng.randint(1935, 2005), rng)
    p = {
        "id": f"P{idx + 1:04d}",
        "name": name,
        "building": building,
        "floor": floor,
        "ward": ward,
        "zone": zone,
        "room": room,
        "doctor": _doctor(idx),
        "department": rng.choice(_DEPARTMENTS),
        "nurse": _nurse(building, f, zone),
    }
    if prof:
        # 프로필 번호는 라우터로 전달돼 얼굴 이미지(faces/<n>.png)를 지정한다
        p.update({
            "profile_no": prof["profile_no"],
            "sex": prof["sex"],
            "birth": prof["birth"],
            "blood": prof["blood"],
            "conditions": prof["conditions"],
        })
    return p
