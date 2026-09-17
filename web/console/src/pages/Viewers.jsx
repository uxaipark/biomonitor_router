import React, { useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import '../viewer/ds.css'

/** Viewer template picker: choose a template and a scope (ward / gateway / room), open it in a new tab. */
export default function Viewers() {
  const [rows] = usePoll(api.channels, 10000)
  const [gws] = usePoll(api.gateways, 15000)
  const [scopeKind, setScopeKind] = useState('ward')
  const [scope, setScope] = useState('')
  const wards = useMemo(() => [...new Set((rows || []).map((r) => r.patient?.ward).filter(Boolean))].sort(), [rows])
  const rooms = useMemo(() => [...new Set((rows || []).map((r) => r.patient?.room || r.space).filter(Boolean))].sort(), [rows])
  const gwList = useMemo(() => (gws || []).filter((g) => g.connected && g.patches > 0).sort((a, b) => a.gw_id - b.gw_id), [gws])
  const count = useMemo(() => {
    const v = (rows || []).filter((r) => r.connected)
    if (!scope) return v.length
    if (scopeKind === 'ward') return v.filter((r) => r.patient?.ward === scope).length
    if (scopeKind === 'room') return v.filter((r) => (r.patient?.room || r.space) === scope).length
    if (scopeKind === 'gw') return v.filter((r) => r.gateway_id === scope).length
    return v.length
  }, [rows, scopeKind, scope])
  const scopeObj = scope ? { [scopeKind]: scope } : {}
  return (
    <div className="page">
      <div className="toolbar">
        <span className="seg">{[['ward', '병동'], ['gw', '게이트웨이'], ['room', '병실'], ['all', '전체']].map(([k, l]) => <button key={k} className={scopeKind === k ? 'active' : ''} onClick={() => { setScopeKind(k); setScope('') }}>{l}</button>)}</span>
        {scopeKind === 'ward' && <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">병동 선택</option>{wards.map((w) => <option key={w}>{w}</option>)}</select>}
        {scopeKind === 'room' && <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">병실 선택</option>{rooms.map((w) => <option key={w}>{w}</option>)}</select>}
        {scopeKind === 'gw' && <select value={scope} onChange={(e) => setScope(e.target.value)}><option value="">게이트웨이 선택</option>{gwList.map((g) => <option key={g.gw_id} value={g.gw_id}>{g.gw_id} · {g.name} · {g.location?.room} ({g.patches})</option>)}</select>}
        <span className="muted">{count}명</span>
      </div>
      <p className="muted">뷰어는 별도 탭에서 전체 화면으로 열립니다. 템플릿은 대상(의료진·운영자·환자)에 따라 <code>src/viewer/templates.js</code>에 추가합니다. URL 형식: <code>#/viewer?tpl=central&amp;ward=W110A</code> · <code>gw=895</code> · <code>room=110A01</code> · <code>ids=1,2,3</code></p>
      <div className="tpl-cards">
        {TEMPLATES.map((t) => {
          const url = viewerUrl({ tpl: t.id, ...scopeObj })
          return (
            <div key={t.id} className="tpl-card">
              <h4>{t.name}</h4>
              <span className="aud">대상: {t.audience}{t.maxRows ? ` · 최대 ${t.maxRows}명` : ''}</span>
              <span>{t.desc}</span>
              <div className="row">
                <a className="btn-like" href={url} target="_blank" rel="noopener"><button className="primary" disabled={scopeKind !== 'all' && !scope}>새 탭에서 열기</button></a>
                <code className="mono muted">{url}</code>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
