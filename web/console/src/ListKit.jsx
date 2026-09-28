import React, { useEffect, useRef, useState } from 'react'
import { roomText, wardText, wardRoom, gwLabel } from './model.js'
import { api } from './api.js'

/**
 * 목록 페이지(알람·이벤트·환자·게이트웨이) 공통 틀.
 *   요약 칩(누르면 그 조건으로 거름) → 필터 줄(검색·드롭다운·적용된 조건 칩 ✕) → 표 → 오른쪽 상세 패널(행 선택)
 * 조건은 주소에 남는다(#/alarms?ward=W103A&f=unacked&sel=…): 공유·새로고침·뒤로 가기가 그대로 된다.
 * 다른 목록으로 건너가는 링크(환자·게이트웨이·병실·병동)는 새 주소로 이동(뒤로 가기로 돌아옴),
 * 같은 목록 안의 필터 변경은 주소만 바꾼다(기록을 쌓지 않음).
 */

/** 현재 주소의 쿼리 (#/page?a=1&b=2) */
export function useQuery() {
  const read = () => new URLSearchParams((location.hash.split('?')[1]) || '')
  const [q, setQ] = useState(read)
  useEffect(() => {
    const f = () => setQ(read())
    window.addEventListener('hashchange', f)
    window.addEventListener('lk-query', f)
    return () => { window.removeEventListener('hashchange', f); window.removeEventListener('lk-query', f) }
  }, [])
  /** 쿼리 일부를 바꾼다 (빈 값 = 지움). 기록을 쌓지 않고 주소만 교체 */
  const set = (patch) => {
    const n = new URLSearchParams((location.hash.split('?')[1]) || '')
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === false) n.delete(k)
      else n.set(k, String(v))
    }
    const base = location.hash.split('?')[0] || '#/'
    const s = n.toString()
    history.replaceState(null, '', base + (s ? '?' + s : ''))
    window.dispatchEvent(new Event('lk-query'))
  }
  return [q, set]
}

/** 다른 목록으로 이동 (뒤로 가기로 돌아올 수 있게 기록을 남김) */
export const go = (page, params = {}) => {
  // 지도는 같은 곳을 다시 눌러도 강조를 다시 보여야 한다 — 주소가 같으면 브라우저가 이동으로 치지 않으므로 시각 값을 붙인다
  if (page === '#/map') params = { ...params, t: Date.now() }
  const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString()
  location.hash = page + (s ? '?' + s : '')
}

const stop = (f) => (e) => { e.stopPropagation(); e.preventDefault(); f() }

/** 게이트웨이 번호 → 이름(GW-101-0000). 목록이 커서(≈1.3 MB) 모든 화면이 한 번 받은 것을 1분 동안 같이 쓴다 */
let gwNames = new Map(), gwNamesAt = 0, gwNamesReq = null
const gwListeners = new Set()
function loadGwNames() {
  if (gwNamesReq || Date.now() - gwNamesAt < 60000) return
  gwNamesReq = api.gateways().then((rows) => {
    gwNames = new Map((rows || []).map((g) => [String(g.gw_id), g.name || '']))
    gwNamesAt = Date.now()
    gwListeners.forEach((f) => f(gwNames))
  }).catch(() => {}).finally(() => { gwNamesReq = null })
}
export function useGwNames() {
  const [m, setM] = useState(gwNames)
  useEffect(() => { gwListeners.add(setM); loadGwNames(); const t = setInterval(loadGwNames, 60000); return () => { gwListeners.delete(setM); clearInterval(t) } }, [])
  return m
}
/** GW-101-0000 → 앞은 흐리게, 뒤 번호는 굵게 */
export function GwName({ id, name }) {
  const names = useGwNames()
  const n = gwLabel(name || names.get(String(id)) || '')
  const m = /^(.*-)(\d+)$/.exec(n)
  if (!m) return <span className="gw-name">GW <b>{id}</b></span>
  return <span className="gw-name" title={`게이트웨이 #${id}`}><span className="gw-pre">{m[1]}</span><b>{m[2]}</b></span>
}

/** 링크로 넘어와 선택된 행: 그 행이 있는 쪽으로 넘기고, 화면 가운데로 스크롤 + 잠깐 반짝임 (sel 이 바뀔 때 한 번) */
export function useRevealSelected(sel, shown, keyOf, pageSize, setPage) {
  const done = useRef('')
  useEffect(() => {
    if (!sel || done.current === sel || !shown.length) return
    const i = shown.findIndex((r) => keyOf(r) === sel)
    if (i < 0) return
    done.current = sel
    // 표에서 직접 누른 행(이미 화면 안)은 그대로 둔다 — 다른 쪽이거나 화면 밖일 때(링크로 넘어온 경우)만 옮기고 반짝인다
    const vis = (el) => { if (!el) return false; const b = el.getBoundingClientRect(); return b.top >= 60 && b.bottom <= window.innerHeight }
    if (vis(document.querySelector('tr.selected'))) return
    setPage(Math.floor(i / pageSize))
    setTimeout(() => {
      const tr = document.querySelector('tr.selected')
      if (tr) { tr.scrollIntoView({ block: 'center', behavior: 'smooth' }); tr.classList.add('flash'); setTimeout(() => tr.classList.remove('flash'), 2400) }
    }, 80)
  }, [sel, shown]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** 교차 링크 — 표 안에서 눌러도 행 선택이 같이 일어나지 않게 전파를 막는다 */
export const PatientLink = ({ ch, children }) => ch ? <a className="lk-link" onClick={stop(() => go('#/patients', { sel: ch }))} title="환자 목록에서 보기">{children}</a> : <>{children}</>
export const GwLink = ({ id, name, children }) => id != null && id !== '' ? <a className="lk-link mono" onClick={stop(() => go('#/gateways', { sel: id }))} title="게이트웨이 목록에서 보기">{children ?? <GwName id={id} name={name} />}</a> : <span className="muted">—</span>
export const RoomLink = ({ room, children }) => room ? <a className="lk-link" onClick={stop(() => go('#/map', { room }))} title="병원 지도에서 보기">{children ?? roomText(room)}</a> : <span className="muted">—</span>
export const WardLink = ({ ward, children }) => ward ? <a className="lk-link" onClick={stop(() => go('#/patients', { ward }))} title="이 병동 환자 목록">{children ?? wardText(ward)}</a> : <span className="muted">—</span>
/** 병실 id(103A01) → 병동 코드(W103A) */
export const wardOfRoom = (room) => { const m = /^(\d\d\d[A-Z])\d\d/.exec(room || ''); return m ? `W${m[1]}` : '' }
export { wardRoom }

/** 요약 칩: [{ key, label, count, cls }] — 누르면 켜고 끄기 */
export function SummaryChips({ items, value, onChange, unit = '' }) {
  return (
    <div className="lk-chips">
      {items.map((it) => (
        <button key={it.key} className={'lk-chip' + (value === it.key ? ' on' : '') + (it.cls ? ` ${it.cls}` : '') + (!it.count && it.key !== 'all' ? ' zero' : '')} onClick={() => onChange(value === it.key ? '' : it.key)}>
          <span>{it.label}</span><b>{(it.count ?? 0).toLocaleString()}{unit}</b>
        </button>
      ))}
    </div>
  )
}

/** 필터 줄: 왼쪽 입력들, 오른쪽 결과 수·쪽 넘김. applied = [{ key, label, clear }] 는 칩으로 보이고 ✕ 로 뺀다 */
export function FilterBar({ children, applied = [], onReset, right }) {
  return (
    <div className="lk-filter">
      <div className="lk-inputs">{children}</div>
      {applied.length > 0 && (
        <div className="lk-applied">
          {applied.map((a) => <span key={a.key} className="lk-tagx">{a.label}<button onClick={a.clear} title="조건 빼기">✕</button></span>)}
          {onReset && applied.length > 1 && <button className="lk-reset" onClick={onReset}>모두 지우기</button>}
        </div>
      )}
      <span className="spacer" />
      {right}
    </div>
  )
}

/** 표 + 오른쪽 상세 패널 (detail 이 있으면 열림) */
export function ListLayout({ children, detail }) {
  return (
    <div className={'lk-body' + (detail ? ' with-detail' : '')}>
      <div className="lk-main">{children}</div>
      {detail}
    </div>
  )
}

export function DetailPanel({ title, sub, onClose, actions, children }) {
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [onClose])
  return (
    <aside className="lk-detail">
      <header>
        <div className="lk-dh"><h3>{title}</h3>{sub && <small>{sub}</small>}</div>
        <button className="lk-x" onClick={onClose} title="닫기 (Esc)">✕</button>
      </header>
      {actions && <div className="lk-actions">{actions}</div>}
      <div className="lk-dbody">{children}</div>
    </aside>
  )
}

export const KV = ({ k, children }) => (children == null || children === '' ? null : <><dt>{k}</dt><dd>{children}</dd></>)

/**
 * 고정 컬럼 폭: 실시간으로 값이 바뀌어도 열이 흔들리지 않게 (표에 className "tbl fixed" + 이 colgroup).
 * w = 열마다 px(숫자) 또는 null(남는 폭을 나눠 가짐). 표 최소 폭 = 고정 폭 합 + 가변 열 × minFlex.
 */
export function Cols({ w }) {
  return <colgroup>{w.map((x, i) => <col key={i} style={x ? { width: x } : undefined} />)}</colgroup>
}
export const tableMin = (w, minFlex = 200) => w.reduce((s, x) => s + (x || minFlex), 0)

/** 쪽 넘김 */
export function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return <span className="lk-pager"><button disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button><span className="muted">{page + 1} / {pages}</span><button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>›</button></span>
}

/* ───────────────────────── 목록 재설계 공통 부품 (2026-09-28 시안) ─────────────────────────
 * 여섯 목록(이벤트보드·알람·이벤트·환자·게이트웨이·뷰어)이 같은 문법을 쓴다:
 *   요약 칩 → 필터 줄 → 표(레일·두 줄 셀·값/임계 막대·미니 그래프·행 끝 동작) → 오른쪽 상세.
 * 색은 상태에만(sev 네 가지), 숫자는 고정폭·오른쪽 정렬, 동작 버튼은 행 끝 고정 폭·평소엔 흐리게.
 */

/** 심각도/상태 → 레일·알약 톤. sev: critical|high|medium|low, 또는 ok|warn|err|off */
export const TONE = { critical: 'crit', high: 'high', medium: 'med', low: 'low', ok: 'ok', warn: 'med', err: 'err', off: 'off' }

/** 두 줄 셀: 굵은 본문 + 회색 보조줄 (열 수를 줄이고 밀도를 올린다) */
export const TwoLine = ({ main, sub, mono = false }) => (
  <span className={'lk-two' + (mono ? ' mono' : '')}><b>{main}</b>{sub != null && sub !== '' && <small>{sub}</small>}</span>
)

/** 상태 점 (수신 중 ok · 주의 warn · 이상 err · 없음 off) */
export const Dot = ({ tone = 'ok', title }) => <i className={'lk-dot ' + tone} title={title} />

/** 알약 — tone 은 TONE 값 (crit|high|med|low|ok|err) 또는 생략(중립) */
export const Pill = ({ tone = '', children, title }) => <span className={'lk-pill' + (tone ? ' ' + tone : '')} title={title}>{children}</span>

/**
 * 값/임계 막대: value 가 limit 에 얼마나 가깝거나 넘었는지 (0~100 %). tone 은 넘었으면 crit, 80 % 이상 warn.
 * 숫자 옆에 두어 "얼마나 벗어났나" 를 숫자보다 먼저 전달한다.
 */
export function Bar({ pct, tone, width = 56, title }) {
  const p = Math.max(0, Math.min(100, pct || 0))
  const t = tone || (p >= 100 ? 'crit' : p >= 80 ? 'warn' : '')
  return <span className={'lk-bar ' + t} style={{ width }} title={title}><i style={{ width: `${p}%` }} /></span>
}

/**
 * 미니 그래프 (SVG 폴리라인). values: 숫자 배열(오래된 → 최근). 값이 없으면 회색 점선.
 * tone: ok|warn|crit|accent|muted. 세로 축은 자기 최대값 기준(0 바닥), flat 이면 가운데 평선.
 */
export function Spark({ values = [], tone = 'accent', width = 96, height = 22, dashed = false, title }) {
  const W = width, H = height, pad = 2
  const v = (values || []).filter((x) => typeof x === 'number' && !Number.isNaN(x))
  const color = `var(--lk-${tone})`
  if (v.length < 2) return <svg className="lk-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`}><title>{title || ''}</title><line x1={pad} x2={W - pad} y1={H / 2} y2={H / 2} stroke="var(--lk-muted)" strokeWidth="1.2" strokeDasharray="3 3" /></svg>
  const max = Math.max(1e-9, ...v), min = 0
  const x = (i) => pad + (i / (v.length - 1)) * (W - pad * 2)
  const y = (val) => H - pad - ((val - min) / (max - min || 1)) * (H - pad * 2)
  const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ')
  return (
    <svg className="lk-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <title>{title || ''}</title>
      <polyline fill="none" stroke={color} strokeWidth="1.4" strokeDasharray={dashed ? '3 3' : undefined} points={pts} />
      <circle cx={x(v.length - 1)} cy={y(v[v.length - 1])} r="1.8" fill={color} />
    </svg>
  )
}

/** 표 안 묶음 헤더 행 (예: "7A 병동 · 활성 9") */
export const GroupRow = ({ colSpan, children }) => <tr className="lk-grp"><td colSpan={colSpan}>{children}</td></tr>

/** 촘촘/보통 밀도 토글 — 값은 브라우저에 기억 (key 별) */
export function useDensity(key) {
  const [d, setD] = useState(() => { try { return localStorage.getItem('lk.density.' + key) || 'dense' } catch { return 'dense' } })
  const set = (v) => { setD(v); try { localStorage.setItem('lk.density.' + key, v) } catch { /* ignore */ } }
  return [d, set]
}
export const DensityToggle = ({ value, onChange }) => (
  <span className="seg lk-density" title="행 높이">
    <button className={value === 'dense' ? 'active' : ''} onClick={() => onChange('dense')}>촘촘</button>
    <button className={value === 'normal' ? 'active' : ''} onClick={() => onChange('normal')}>보통</button>
  </span>
)

/** 행 끝 동작 칸 — 평소엔 흐리고 행에 마우스를 올리면 진해진다 */
export const RowActions = ({ children }) => <td className="lk-acts" onClick={(e) => e.stopPropagation()}>{children}</td>

/** 상대 시간 (초·분·시간·일 전). title 로 절대 시각을 함께 준다 */
export function ago(ms, now = Date.now()) {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}초 전`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 전`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}
/** 경과 시간 (초 → "3분 12초" / "1시간 4분") */
export function dur(ms) {
  if (ms == null || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}분 ${String(s % 60).padStart(2, '0')}초`
  return `${Math.floor(m / 60)}시간 ${m % 60}분`
}
export const Ago = ({ ms, now }) => <span className="lk-ago" title={ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : ''}>{ago(ms, now)}</span>

/** 타임라인 (이벤트): items = [{ key, ts_ms, kindLabel, tone, body, count }], 날짜가 바뀌면 구분줄 */
export function Timeline({ items, renderBody, now = Date.now() }) {
  let lastDay = ''
  return (
    <ul className="lk-tl">
      {items.map((it) => {
        const day = new Date(it.ts_ms).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
        const sep = day !== lastDay; lastDay = day
        const t = new Date(it.ts_ms).toLocaleTimeString('ko-KR', { hour12: false })
        return (
          <React.Fragment key={it.key}>
            {sep && <li className="lk-tl-day">{day}{now - it.ts_ms < 86400000 && new Date(it.ts_ms).toDateString() === new Date(now).toDateString() ? ' · 오늘' : ''}</li>}
            <li className={'lk-tl-row' + (it.tone ? ' ' + it.tone : '')} onClick={it.onClick} style={it.onClick ? { cursor: 'pointer' } : undefined}>
              <span className="lk-tl-t mono" title={new Date(it.ts_ms).toLocaleString('ko-KR', { hour12: false })}>{it.range || t}</span>
              <span><Pill tone={it.tone}>{it.kindLabel}</Pill></span>
              <span className="lk-tl-body">{renderBody ? renderBody(it) : it.body}{it.count > 1 && <span className="lk-fold" onClick={(e) => { e.stopPropagation(); it.onExpand?.() }}> ×{it.count} 묶음{it.onExpand ? ' · 펼치기' : ''}</span>}</span>
            </li>
          </React.Fragment>
        )
      })}
      {!items.length && <li className="lk-tl-empty">기록이 없습니다.</li>}
    </ul>
  )
}

/** 카드 격자 (뷰어): 자식은 <Card> */
export const CardGrid = ({ children }) => <div className="lk-cards">{children}</div>
export function Card({ title, badge, meta = [], actions, star, onStar, open, className = '' }) {
  return (
    <div className={'lk-card' + (open ? ' open' : '') + (className ? ' ' + className : '')}>
      <div className="lk-card-t">
        {onStar && <button className={'lk-star' + (star ? ' on' : '')} onClick={onStar} title={star ? '즐겨찾기 해제' : '즐겨찾기'}>★</button>}
        <b>{title}</b>
        <span className="spacer" />
        {badge}
      </div>
      {meta.length > 0 && <div className="lk-card-meta">{meta.map((m, i) => <span key={i}>{m}</span>)}</div>}
      {open && <div className="lk-card-open">열려 있음 · <a className="lk-link" onClick={open}>탭으로 돌아가기</a></div>}
      {actions && <div className="lk-card-go">{actions}</div>}
    </div>
  )
}

/** 키보드 힌트 */
export const Kbd = ({ children }) => <kbd className="lk-kbd">{children}</kbd>
