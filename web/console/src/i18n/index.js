// 콘솔 다국어(ko/en/ja) — DOM 번역기.
// 원문은 코드에 한국어로 그대로 두고, 화면에 그려진 텍스트 노드·속성(title/placeholder/aria-label)을 사전(en.json/ja.json)으로 바꾼다.
// 사전 키는 scripts/i18n-extract.py 가 코드(JS·JSX·Rust)에서 뽑는다: 고정 문자열 + 자리표시자 {0},{1}… 패턴(템플릿·format!).
// React 가 텍스트를 다시 쓰면 MutationObserver 가 새 원문으로 다시 번역한다. 한국어로 되돌리면 원문을 복원한다.
const HAN = /[가-힣]/
const NF = { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 } // NodeFilter (SSR·lint 안전)
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt']
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CANVAS', 'CODE', 'PRE']) // SVG 는 번역(지도·도면의 <text> 방·건물 이름)
export const LANGS = [['ko', '한국어'], ['en', 'English'], ['ja', '日本語']]
export const COUNTRY_LANG = { KR: 'ko', US: 'en', JP: 'ja' }

let lang = 'ko'
let dict = null // Map 원문 → 번역
let pats = [] // [{ re, out }]
let cache = new Map()
const textOrig = new WeakMap() // Text → { src, out }
const attrOrig = new WeakMap() // Element → { [attr]: { src, out } }
let observer = null
const listeners = new Set()

export const getLang = () => lang
export const onLang = (f) => { listeners.add(f); return () => listeners.delete(f) }

function compile(obj) {
  dict = new Map(); pats = []; cache = new Map()
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v !== 'string') continue
    if (/\{\d+\}/.test(k)) {
      const re = new RegExp('^' + k.split(/(\{\d+\})/).map((p) => (/^\{\d+\}$/.test(p) ? '(.+?)' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$', 's')
      const order = [...k.matchAll(/\{(\d+)\}/g)].map((m) => Number(m[1]))
      pats.push({ re, out: v, order, len: k.replace(/\{\d+\}/g, '').length })
    } else dict.set(k, v)
  }
  pats.sort((a, b) => b.len - a.len) // 고정 글자가 많은 패턴부터
}

/** 테스트용: 사전을 직접 넣고 언어 지정 (DOM 없이 tr() 확인) */
export function _testLoad(obj, l) { compile(obj); lang = l }

/** 사전·패턴으로만 찾기 (조각 나누기·낱말 대체 없이) */
function lookup(core) {
  const d = dict.get(core)
  if (d != null) return d
  for (const p of pats) {
    const mm = p.re.exec(core)
    if (!mm) continue
    // 자리표시자에 한국어가 들어가면 그 조각도 완전히 번역돼야 이 패턴을 쓴다 — "{0}초" 같은 짧은 패턴이 문장 전체를 삼키지 않게
    const vals = {}
    let ok = true
    p.order.forEach((n, i) => {
      const v = mm[i + 1]
      if (!HAN.test(v)) { vals[n] = v; return }
      const t = p.len >= 4 ? tr(v) : lookup(v)
      if (t == null || HAN.test(t)) ok = false
      vals[n] = t ?? v
    })
    if (!ok) continue
    return p.out.replace(/\{(\d+)\}/g, (_, n) => vals[n] ?? '')
  }
  return null
}

/** 문자열 하나 번역 (앞뒤 공백 보존). 못 찾으면 null */
export function tr(s) {
  if (lang === 'ko' || !dict || !s || !HAN.test(s)) return null
  if (cache.has(s)) return cache.get(s)
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)
  const core = m[2]
  let out = lookup(core)
  if (out == null) {
    // 앞머리(심각도·이름 등) 뒤의 문장: "[High] Jane Doe ECG 분석: 휴지 2.1초" → 앞 낱말을 하나씩 떼며 나머지를 찾는다
    const toks = core.split(' ')
    for (let i = 1; i < Math.min(toks.length, 7) && out == null; i++) {
      const rest = toks.slice(i).join(' ')
      if (!HAN.test(rest)) break
      const r = lookup(rest)
      if (r != null) out = toks.slice(0, i).join(' ') + ' ' + r
    }
  }
  if (out == null) {
    // 가운뎃점·세로막대로 이어진 조각은 조각별로
    const parts = core.split(/(\s·\s|\s\|\s|\s—\s|, )/)
    if (parts.length > 1) {
      let any = false
      const t = parts.map((p) => { if (!HAN.test(p)) return p; const x = tr(p); if (x != null) { any = true; return x } return p }).join('')
      if (any) out = t
    }
  }
  if (out == null) {
    // 마지막 수단: 한국어 낱말 단위로 용어 사전(병동·방·건물·진료과 등 데이터 용어)에서 바꾼다 — "B1-01-심초음파실" → "B1-01-Echo Lab"
    let any = false
    const t = core.replace(/[가-힣]+(?:\s[가-힣]+)*/g, (w) => {
      const x = dict.get(w)
      if (x != null) { any = true; return x }
      // 여러 낱말이면 낱말별로
      if (w.includes(' ')) return w.split(' ').map((p) => { const y = dict.get(p); if (y != null) { any = true; return y } return p }).join(' ')
      return w
    })
    if (any) out = t
  }
  const res = out == null ? null : m[1] + out + m[3]
  if (cache.size > 20000) cache.clear()
  cache.set(s, res)
  return res
}

function doText(node) {
  const cur = node.nodeValue
  const rec = textOrig.get(node)
  if (rec && cur === rec.out) return
  const src = cur
  if (!HAN.test(src)) { if (rec) textOrig.delete(node); return }
  const out = tr(src)
  if (out == null || out === src) return
  textOrig.set(node, { src, out })
  node.nodeValue = out
}
function doAttrs(el) {
  for (const a of ATTRS) {
    const cur = el.getAttribute(a)
    if (cur == null) continue
    const recs = attrOrig.get(el) || {}
    const rec = recs[a]
    if (rec && cur === rec.out) continue
    if (!HAN.test(cur)) continue
    const out = tr(cur)
    if (out == null || out === cur) continue
    recs[a] = { src: cur, out }
    attrOrig.set(el, recs)
    el.setAttribute(a, out)
  }
}
function walk(root) {
  if (!root) return
  if (root.nodeType === 3) { if (!skipParent(root)) doText(root); return }
  if (root.nodeType !== 1 || SKIP.has(root.nodeName.toUpperCase()) || root.closest?.('[data-no-i18n]')) return
  doAttrs(root)
  const w = document.createTreeWalker(root, NF.SHOW_TEXT | NF.SHOW_ELEMENT, {
    acceptNode: (n) => (n.nodeType === 1 && (SKIP.has(n.nodeName.toUpperCase()) || n.hasAttribute('data-no-i18n')) ? NF.FILTER_REJECT : NF.FILTER_ACCEPT),
  })
  let n
  while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n) }
}
const skipParent = (t) => { const p = t.parentElement; return !p || SKIP.has(p.nodeName.toUpperCase()) || !!p.closest('[data-no-i18n]') }

function restoreAll(root) {
  const w = document.createTreeWalker(root, NF.SHOW_TEXT | NF.SHOW_ELEMENT)
  let n
  while ((n = w.nextNode())) {
    if (n.nodeType === 3) { const r = textOrig.get(n); if (r && n.nodeValue === r.out) n.nodeValue = r.src; textOrig.delete(n) }
    else { const recs = attrOrig.get(n); if (recs) { for (const [a, r] of Object.entries(recs)) if (n.getAttribute(a) === r.out) n.setAttribute(a, r.src); attrOrig.delete(n) } }
  }
}

function start() {
  if (observer) return
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') { if (!skipParent(m.target)) doText(m.target) }
      else if (m.type === 'attributes') doAttrs(m.target)
      else for (const n of m.addedNodes) walk(n)
    }
  })
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
  walk(document.body)
  const t = document.querySelector('title'); if (t) walk(t)
}
function stop() { if (observer) { observer.disconnect(); observer = null } }

// confirm/alert/prompt 메시지도 번역
const W = typeof window !== 'undefined' ? window : null
const nat = W ? { confirm: W.confirm?.bind(W), alert: W.alert?.bind(W), prompt: W.prompt?.bind(W) } : {}
if (W && nat.confirm) {
  window.confirm = (msg) => nat.confirm(msg != null ? msg.split('\n').map((l) => tr(l) ?? l).join('\n') : msg)
  window.alert = (msg) => nat.alert(msg != null ? String(msg).split('\n').map((l) => tr(l) ?? l).join('\n') : msg)
  window.prompt = (msg, def) => nat.prompt(msg != null ? String(msg).split('\n').map((l) => tr(l) ?? l).join('\n') : msg, def)
}

// 날짜·숫자: 코드가 'ko-KR' 로 부르는 toLocale*String 을 현재 언어의 로케일로 (2026. 9. 30. → 9/30/2026 · 2026/9/30)
const LOCALE = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }
if (typeof Date !== 'undefined' && !Date.prototype.__i18n) {
  for (const [P, names] of [[Date.prototype, ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']], [Number.prototype, ['toLocaleString']]]) {
    for (const n of names) {
      const orig = P[n]
      P[n] = function (loc, opts) { return orig.call(this, (loc === 'ko-KR' || loc === undefined) && lang !== 'ko' ? LOCALE[lang] : loc, opts) }
    }
  }
  Date.prototype.__i18n = true
}

const loaders = { en: () => import('./en.json'), ja: () => import('./ja.json') }
/** 언어 바꾸기: 사전을 읽고(지연 로드) 화면 전체를 다시 번역. 'ko' 는 원문 복원 */
export async function setLang(next) {
  if (!['ko', 'en', 'ja'].includes(next)) next = 'ko'
  if (typeof document === 'undefined') { lang = next; return }
  if (next === lang && (next === 'ko' || observer)) return
  stop()
  restoreAll(document.documentElement)
  if (next !== 'ko') {
    const mod = await loaders[next]()
    compile(mod.default || mod)
  } else { dict = null; pats = []; cache = new Map() }
  lang = next
  document.documentElement.lang = next
  try { localStorage.setItem('ui.lang', next) } catch { /* ignore */ }
  if (next !== 'ko') start()
  for (const f of listeners) f(next)
}
/** 처음 시작: 브라우저에 기억된 언어 → (없으면) 라우터 사이트 국가 기본 */
export async function initLang() {
  let saved = null
  try { saved = localStorage.getItem('ui.lang') } catch { /* ignore */ }
  if (saved) return setLang(saved)
  try {
    const r = await fetch('/api/site/locale', { credentials: 'same-origin' })
    if (r.ok) { const d = await r.json(); const l = COUNTRY_LANG[d?.country]; if (l) return setLang(l) }
  } catch { /* ignore */ }
}
