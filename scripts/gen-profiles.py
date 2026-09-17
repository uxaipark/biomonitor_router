# -*- coding: utf-8 -*-
"""환자 프로필 1만 명 + 256x256 얼굴 아바타 생성기 (1회 실행 빌드 스크립트).

산출물:
  emulator/data/patients.json          - 에뮬레이터가 자체 보유하는 프로필 명단
                                         (DB와 독립 동작: 필요한 데이터를 스스로 가짐)
  web/admin/public/faces/<n>.png       - 프로필 번호별 얼굴 (리포트 모달이 사용)

이름: emulator/names_ko.py 의 성별/출생 연대별 다빈도 이름 시드 데이터.
얼굴: python_avatars(Avataaars) + resvg — 성별/연령 구분 가능한 시드 고정
      일러스트 아바타 (실제 인물 아님). 스타일 매핑은 scripts/avatar_gen.py.
"""
import json
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACES_DIR = os.path.join(ROOT, "web", "admin", "public", "faces")
DATA_PATH = os.path.join(ROOT, "emulator", "data", "patients.json")
N = 10000

sys.path.insert(0, os.path.join(ROOT, "emulator"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from avatar_gen import render_face  # noqa: E402
from names_ko import full_name      # noqa: E402

CONDITIONS = ["고혈압", "당뇨", "심방세동", "심부전", "협심증", "부정맥",
              "고지혈증", "천식", "COPD", "만성신부전", "뇌졸중 과거력",
              "수면무호흡증", "갑상선기능저하증", "빈혈", "심근경색 과거력"]
BLOODS = ["A+", "A-", "B+", "B-", "O+", "O-", "AB+", "AB-"]


def make_profile(n: int) -> dict:
    rng = random.Random(20260812 * 31 + n)
    sex = rng.choice(["F", "M"])
    age = int(min(95, max(18, rng.gauss(62, 16))))
    year = 2026 - age
    # 성별/출생 연대에 맞는 다빈도 이름 (고령: 영자/영수 계열, 젊은층: 서연/민준 계열)
    name = full_name(sex, year, rng)
    birth = f"{year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}"
    k = rng.choices([1, 2, 3], weights=[45, 40, 15])[0]
    conditions = rng.sample(CONDITIONS, k)
    return {
        "profile_no": n,
        "name": name,
        "sex": sex,
        "birth": birth,
        "age": age,
        "blood": rng.choice(BLOODS),
        "conditions": conditions,
    }


def main():
    os.makedirs(FACES_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(DATA_PATH), exist_ok=True)
    profiles = []
    for n in range(1, N + 1):
        prof = make_profile(n)
        profiles.append(prof)
        render_face(n, prof, os.path.join(FACES_DIR, f"{n}.png"))
        if n % 1000 == 0:
            print(f"  {n}/{N} faces done", flush=True)
    with open(DATA_PATH, "w", encoding="utf-8") as f:
        json.dump({"profiles": profiles}, f, ensure_ascii=False)
    print(f"profiles: {DATA_PATH} ({len(profiles)})")
    print(f"faces   : {FACES_DIR} ({N} x 256x256 PNG, avataaars)")


if __name__ == "__main__":
    main()
