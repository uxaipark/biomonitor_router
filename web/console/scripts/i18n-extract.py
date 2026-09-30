#!/usr/bin/env python3
"""콘솔(src/**/*.jsx|js)과 라우터(router-server/src/*.rs)의 한국어 문자열을 뽑아 src/i18n/strings.json 으로.
- 고정 문자열: 그대로 키
- JS 템플릿 `...${expr}...` / Rust format!("...{x}...") : 자리표시자 {0},{1}… 로 바꾼 패턴 키
- 콘솔은 DOM 번역기(src/i18n/index.js)가 이 키로 ko→en/ja 를 찾는다. 새 문자열이 생기면 다시 실행하고 번역 파일에 빈 키를 채운다."""
import re, json, glob, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HAN = re.compile(r'[가-힣]')
out = {}
def add(s, src, kind):
    s = s.strip()
    if not s or not HAN.search(s) or len(s) > 400: return
    if '\n' in s: return
    e = out.setdefault(s, {"kind": kind, "src": set()})
    e["src"].add(src)
def strip_js_comments(s):
    s = re.sub(r'/\*.*?\*/', '', s, flags=re.S)
    return re.sub(r'(?<![:"\'`])//[^\n]*', '', s)
for f in sorted(glob.glob(os.path.join(ROOT, 'src', '**', '*.js*'), recursive=True)):
    if '/i18n/' in f: continue
    rel = os.path.relpath(f, ROOT)
    s = strip_js_comments(open(f, encoding='utf-8').read())
    for m in re.finditer(r"'((?:[^'\\\n]|\\.)*)'", s): add(m.group(1).replace("\\'", "'"), rel, 'str')
    for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', s): add(m.group(1).replace('\\"', '"'), rel, 'str')
    for m in re.finditer(r'`((?:[^`\\]|\\.)*)`', s):
        t = m.group(1)
        if '<' in t or '`' in t: continue
        n = [0]
        def rep(mm):
            n[0] += 1; return '{%d}' % (n[0] - 1)
        # 중첩 ${ ... } 를 한 단계만 처리
        pat = re.sub(r'\$\{(?:[^{}]|\{[^{}]*\})*\}', rep, t)
        if '${' in pat: continue
        add(pat, rel, 'tpl' if n[0] else 'str')
    for m in re.finditer(r'>([^<>{}]*[가-힣][^<>{}]*)<', s): add(m.group(1), rel, 'jsx')
    # JSX 속 조각: {...}텍스트{...} 사이의 한국어 (e.g. "{n}명", "{a} · 분석 {b}")
    for m in re.finditer(r'\}([^<>{}]*[가-힣][^<>{}]*)\{', s): add(m.group(1), rel, 'jsx')
    for m in re.finditer(r'\}([^<>{}]*[가-힣][^<>{}]*)<', s): add(m.group(1), rel, 'jsx')
    for m in re.finditer(r'>([^<>{}]*[가-힣][^<>{}]*)\{', s): add(m.group(1), rel, 'jsx')
rs_root = os.path.join(os.path.dirname(os.path.dirname(ROOT)), 'router-server', 'src')
for f in sorted(glob.glob(os.path.join(rs_root, '*.rs'))):
    rel = 'router-server/src/' + os.path.basename(f)
    s = open(f, encoding='utf-8').read()
    s = re.sub(r'//[^\n]*', '', s)
    for m in re.finditer(r'"((?:[^"\\\n]|\\.)*)"', s):
        t = m.group(1).replace('\\"', '"')
        if not HAN.search(t): continue
        n = [0]
        def rep(mm):
            n[0] += 1; return '{%d}' % (n[0] - 1)
        pat = re.sub(r'\{[a-zA-Z0-9_.:\?]*\}', rep, t.replace('{{', '\x01').replace('}}', '\x02')).replace('\x01', '{').replace('\x02', '}')
        add(pat, rel, 'rs-tpl' if n[0] else 'rs')
res = {k: {"kind": v["kind"], "src": sorted(v["src"])[:3]} for k, v in sorted(out.items())}
json.dump(res, open(os.path.join(ROOT, 'src', 'i18n', 'strings.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
from collections import Counter
print(len(res), 'strings', Counter(v['kind'] for v in res.values()), sum(len(k) for k in res), 'chars')
