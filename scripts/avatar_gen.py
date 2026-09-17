# -*- coding: utf-8 -*-
"""python_avatars(Avataaars 스타일) 기반 얼굴 이미지 생성 모듈.

성별/연령 구분이 가능한 조합으로 시드 고정 아바타를 만들고
resvg 로 256x256 PNG 로 렌더링한다. (실제 인물 아님)
"""
import random

import python_avatars as pa
import resvg_py

# 성별 헤어 스타일 (여성: 롱/보브/번 계열, 남성: 짧은 커트 계열)
HAIR_F = ["BIG_HAIR", "BOB", "BUN", "CURLY", "LONG_NOT_TOO_LONG",
          "MIA_WALLACE", "STRAIGHT_1", "STRAIGHT_2", "STRAIGHT_STRAND",
          "LOOSE_HAIR", "PIXIE", "BRAIDS"]
HAIR_M = ["CAESAR", "CAESAR_SIDE_PART", "SHORT_CURLY", "SHORT_FLAT",
          "SHORT_ROUND", "SHORT_WAVED", "SIDES", "BUZZCUT", "POMPADOUR", "QUIFF"]
# 고령 남성 일부는 머리숱 적음
HAIR_M_OLD_EXTRA = ["SIDES", "SIDES", "BUZZCUT", "NONE"]

HAIR_COLORS = ["#2C1B18", "#4A312C", "#724133", "#A55728", "#3B2E2A", "#59413A"]
GRAY_COLORS = ["#B7B7B7", "#D6D6D6", "#9E9E9E", "#E8E1E1"]
SKINS = [pa.SkinColor.PALE, pa.SkinColor.LIGHT, pa.SkinColor.LIGHT,
         pa.SkinColor.BROWN]
BGS = ["#DCEAF7", "#DFF0E8", "#F7EBE1", "#E8E4F5", "#DDEEF0", "#F5EFDD"]
# 환자복 느낌의 연한 상의 색
CLOTHES = [pa.ClothingType.SHIRT_SCOOP_NECK, pa.ClothingType.SHIRT_CREW_NECK,
           pa.ClothingType.SHIRT_V_NECK, pa.ClothingType.COLLAR_SWEATER]
CLOTH_COLORS = ["#BFD7E4", "#C3DFD2", "#E4CFC6", "#CFC9E8", "#D6D2C4", "#B8CCD9"]

EYES = [pa.EyeType.DEFAULT, pa.EyeType.DEFAULT, pa.EyeType.DEFAULT,
        pa.EyeType.HAPPY, pa.EyeType.SIDE, pa.EyeType.SQUINT]
BROWS_F = [pa.EyebrowType.DEFAULT_NATURAL, pa.EyebrowType.RAISED_EXCITED_NATURAL,
           pa.EyebrowType.DEFAULT, pa.EyebrowType.FLAT_NATURAL]
BROWS_M = [pa.EyebrowType.DEFAULT_NATURAL, pa.EyebrowType.DEFAULT,
           pa.EyebrowType.FLAT_NATURAL, pa.EyebrowType.UP_DOWN_NATURAL]
MOUTHS = [pa.MouthType.SMILE, pa.MouthType.DEFAULT, pa.MouthType.DEFAULT,
          pa.MouthType.SERIOUS, pa.MouthType.TWINKLE]
GLASSES = [pa.AccessoryType.PRESCRIPTION_1, pa.AccessoryType.PRESCRIPTION_2,
           pa.AccessoryType.ROUND]
FACIAL = [pa.FacialHairType.BEARD_LIGHT, pa.FacialHairType.BEARD_MEDIUM,
          pa.FacialHairType.MOUSTACHE_FANCY, pa.FacialHairType.MOUSTACHE_MAGNUM]


def render_face(n: int, prof: dict, path: str, size: int = 256):
    """프로필(성별/나이)에 맞는 아바타 PNG 생성 (시드 고정 결정적)."""
    rng = random.Random(424243 * n + 11)
    female = prof["sex"] == "F"
    old = prof["age"] >= 62

    if female:
        hair = pa.HairType[rng.choice(HAIR_F)]
    else:
        pool = HAIR_M + (HAIR_M_OLD_EXTRA if old else [])
        hair = pa.HairType[rng.choice(pool)]
    hair_color = rng.choice(GRAY_COLORS) if (old and rng.random() < 0.72) \
        else rng.choice(HAIR_COLORS)

    facial = pa.FacialHairType.NONE
    if not female and prof["age"] >= 45 and rng.random() < 0.35:
        facial = rng.choice(FACIAL)

    bg = rng.choice(BGS)
    avatar = pa.Avatar(
        style=pa.AvatarStyle.CIRCLE,
        background_color=bg,
        top=hair,
        hair_color=hair_color,
        eyebrows=rng.choice(BROWS_F if female else BROWS_M),
        eyes=rng.choice(EYES),
        nose=pa.NoseType.DEFAULT,
        mouth=rng.choice(MOUTHS),
        facial_hair=facial,
        facial_hair_color=hair_color,
        skin_color=rng.choice(SKINS),
        accessory=rng.choice(GLASSES) if rng.random() < 0.26 else pa.AccessoryType.NONE,
        clothing=rng.choice(CLOTHES),
        clothing_color=rng.choice(CLOTH_COLORS),
    )
    svg = avatar.render()
    # python_avatars 가 넣는 fill="" 를 resvg 가 검정으로 칠하는 문제 교정
    svg = svg.replace('fill=""', 'fill="none"')
    # 원형 외곽 투명 영역은 살짝 밝힌 같은 계열로 채워 원형 배지 느낌 유지
    lighter = "#" + "".join(f"{min(255, int(bg[i:i+2], 16) + 12):02X}" for i in (1, 3, 5))
    out = resvg_py.svg_to_bytes(svg_string=svg, width=size, height=size,
                                background=lighter)
    with open(path, "wb") as f:
        f.write(bytes(out))
