import React, { useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import Dropdown from '../Dropdown.jsx'
import '../viewer/ds.css'

/** Viewer template picker: choose a template and a scope (ward / gateway / room), open it in a new tab.
 *  Every list shows the number of connected patches (patients) it would display. */
export default function Viewers() {
  const [rows] = usePoll(api.channels, 10000)
  const [gws] = usePoll(api.gateways, 15000)
  const [scopeKind, setScopeKind] = useState('ward')
  const [scope, setScope] = useState('')
  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const countBy = (fn) => {
    const m = new Map()
    for (const r of live) { const k = fn(r); if (k) m.set(k, (m.get(k) || 0) + 1) }
    return m
  }
  const wards = useMemo(() => { const m = countBy((r) => r.patient?.ward); return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([k, n]) => ({ value: k, label: k, count: n })) }, [live])
  const rooms = useMemo(() => {
    const m = countBy((r) => r.patient?.room || r.space)
    const wardOf = new Map(live.map((r) => [r.patient?.room || r.space, r.patient?.ward || '기타']))
    return [...m.entries()].sort((a, b) => (wardOf.get(a[0]) || '').localeCompare(wardOf.get(b[0]) || '', 'ko') || a[0].localeCompare(b[0], 'ko')).map(([k, n]) => ({ value: k, label: k, count: n, group: wardOf.get(k) }))
  }, [live])
  const gwList = useMemo(() => {
    const m = countBy((r) => r.gateway_id)
    return (gws || []).filter((g) => m.get(String(g.gw_id))).sort((a, b) => a.gw_id - b.gw_id)
      .map((g) => ({ value: String(g.gw_id), label: `#${g.gw_id} ${g.name || ''} · ${g.location?.room || g.type || ''}`, count: m.get(String(g.gw_id)), group: [g.location?.building, g.location?.floor && `${g.location.floor}F`].filter(Boolean).join(' ') || undefined }))
  }, [gws, live])
  const count = useMemo(() => {
    if (scopeKind === 'all' || !scope) return scopeKind === 'all' ? live.length : 0
    if (scopeKind === 'ward') return live.filter((r) => r.patient?.ward === scope).length
    if (scopeKind === 'room') return live.filter((r) => (r.patient?.room || r.space) === scope).length
    if (scopeKind === 'gw') return live.filter((r) => r.gateway_id === scope).length
    return 0
  }, [live, scopeKind, scope])
  const scopeObj = scopeKind !== 'all' && scope ? { [scopeKind]: scope } : {}
  const ready = scopeKind === 'all' || !!scope
  const kinds = [['ward', '병동', wards.length], ['gw', '게이트웨이', gwList.length], ['room', '병실', rooms.length], ['all', '전체', null]]
  return (
    <div className="page">
      <div className="toolbar">
        <span className="seg">{kinds.map(([k, l, n]) => <button key={k} className={scopeKind === k ? 'active' : ''} onClick={() => { setScopeKind(k); setScope('') }}>{l}{n != null && <small className="muted"> {n}</small>}</button>)}</span>
        {scopeKind === 'ward' && <Dropdown value={scope} options={wards} onChange={setScope} placeholder="병동 선택" width={280} />}
        {scopeKind === 'room' && <Dropdown value={scope} options={rooms} onChange={setScope} placeholder="병실 선택" width={280} />}
        {scopeKind === 'gw' && <Dropdown value={scope} options={gwList} onChange={setScope} placeholder="게이트웨이 선택" width={360} />}
        <span className="muted">{ready ? `${count}명 표시` : '범위를 고르세요'} · 전체 연결 {live.length}명</span>
      </div>
      <p className="muted">뷰어는 별도 탭에서 전체 화면으로 열립니다. 템플릿은 대상(의료진·운영자·환자)에 따라 <code>src/viewer/templates.js</code>에 추가합니다. URL 형식: <code>#/viewer?tpl=central&amp;ward=W110A</code> · <code>gw=895</code> · <code>room=110A01</code> · <code>ids=1,2,3</code></p>
      <div className="tpl-cards">
        {TEMPLATES.map((t) => {
          const url = viewerUrl({ tpl: t.id, ...scopeObj })
          const over = t.maxRows && count > t.maxRows
          return (
            <div key={t.id} className="tpl-card">
              <h4>{t.name}</h4>
              <span className="aud">대상: {t.audience}{t.maxRows ? ` · 최대 ${t.maxRows}명` : ''}{ready && <> · <b>{Math.min(count, t.maxRows || count)}명</b>{over ? ` (${count}명 중 앞 ${t.maxRows}명)` : ''}</>}</span>
              <span>{t.desc}</span>
              <div className="row">
                <a href={ready ? url : undefined} target="_blank" rel="noopener" onClick={(e) => { if (!ready) e.preventDefault() }}><button className="primary" disabled={!ready}>새 탭에서 열기</button></a>
                <code className="mono muted">{url}</code>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
