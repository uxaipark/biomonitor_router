#!/usr/bin/env python3
"""데이터 용어(에뮬레이터·EMR 이 주는 진료과·병동·방·건물·진단 등) 번역(dchunk*.en/ja.json)을 src/i18n/en.json·ja.json 에 더한다.
코드 문자열과 겹치면 코드 쪽 번역을 유지한다."""
import json, glob, re, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ph = lambda s: sorted(re.findall(r'\{\d+\}', s))
for lang in ('en', 'ja'):
    path = os.path.join(ROOT, 'src', 'i18n', f'{lang}.json')
    out = json.load(open(path, encoding='utf-8'))
    add = 0
    for f in sorted(glob.glob(os.path.join(sys.argv[1], f'dchunk*.{lang}.json'))):
        for k, v in json.load(open(f, encoding='utf-8')).items():
            if isinstance(v, str) and v and k not in out and ph(k) == ph(v):
                out[k] = v; add += 1
    json.dump({k: out[k] for k in sorted(out)}, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print(lang, '+', add, '→', len(out))
