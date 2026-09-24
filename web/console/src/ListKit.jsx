import React, { useEffect, useRef, useState } from 'react'
import { roomText, wardText, wardRoom } from './model.js'
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
  const n = name || names.get(String(id)) || ''
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

/** 쪽 넘김 */
export function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null
  return <span className="lk-pager"><button disabled={page === 0} onClick={() => onPage(page - 1)}>‹</button><span className="muted">{page + 1} / {pages}</span><button disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>›</button></span>
}
