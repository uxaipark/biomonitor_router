#!/usr/bin/env python3
"""번역 묶음(chunkN.en.json / chunkN.ja.json)을 src/i18n/en.json·ja.json 으로 합친다. 자리표시자 수가 원문과 다른 항목은 버린다."""
import json, glob, re, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src_dir = sys.argv[1]
keys = json.load(open(os.path.join(ROOT, 'src', 'i18n', 'strings.json'), encoding='utf-8'))
ph = lambda s: sorted(re.findall(r'\{\d+\}', s))
for lang in ('en', 'ja'):
    path = os.path.join(ROOT, 'src', 'i18n', f'{lang}.json')
    out = json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {}
    bad = 0
    for f in sorted(glob.glob(os.path.join(src_dir, f'chunk*.{lang}.json'))):
        for k, v in json.load(open(f, encoding='utf-8')).items():
            if not isinstance(v, str) or k not in keys: continue
            if ph(k) != ph(v): bad += 1; continue
            out[k] = v
    out = {k: out[k] for k in sorted(out)}
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print(lang, len(out), '/', len(keys), 'bad placeholders', bad)
