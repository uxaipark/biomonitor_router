import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import Dropdown from '../Dropdown.jsx'
import '../viewer/ds.css'

/**
 * Viewer picker. Lists the connected patients grouped by one category (ward / room / doctor / nurse /
 * specialty / diagnosis / gateway / group); clicking a row opens the chosen viewer template in a new tab
 * scoped to that entry. Groups are user-defined patient sets stored in the router's SQLite DB and can be
 * created, edited (search patients in / out) and deleted here.
 */
const KINDS = [
  ['ward', '병동'], ['room', '병실'], ['doctor', '담당의'], ['nurse', '간호사'],
  ['department', '진료과목'], ['diagnosis', '주진단'], ['gw', '게이트웨이'], ['group', '그룹'],
]
const SCOPE_KEY = { ward: 'ward', room: 'room', doctor: 'doctor', nurse: 'nurse', department: 'dept', diagnosis: 'dx', gw: 'gw', group: 'group' }
const pref = (k, d) => { try { return localStorage.getItem(k) || d } catch { return d } }

export default function Viewers({ alarms }) {
  const [rows, , refreshRows] = usePoll(api.channels, 10000)
  const [gws] = usePoll(api.gateways, 15000)
  const [groups, , refreshGroups] = usePoll(api.groups, 10000)
  const [staff, setStaff] = useState(new Map())
  const [kind, setKind] = useState(() => pref('viewers.kind', 'ward'))
  const [tpl, setTpl] = useState(() => pref('viewers.tpl', TEMPLATES[0].id))
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState(null) // group being edited (null = closed, {} = new)
  useEffect(() => { try { localStorage.setItem('viewers.kind', kind); localStorage.setItem('viewers.tpl', tpl) } catch { /* ignore */ } }, [kind, tpl])
  useEffect(() => { api.staff().then((d) => setStaff(new Map((d?.staff || []).map((s) => [s.id, s])))).catch(() => {}) }, [])

  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const alarmIds = useMemo(() => new Set((alarms?.alarms || []).map((a) => String(a.channel_id))), [alarms])
  const staffLabel = (id) => { const s = staff.get(id); return s ? `${s.name} (${id})` : id }
  const staffSub = (id) => { const s = staff.get(id); return s ? [s.title, s.specialty, s.ward && `병동 ${s.ward}`].filter(Boolean).join(' · ') : '' }

  // one list entry per distinct value of the chosen category, with connected-patient and alarm counts
  const entries = useMemo(() => {
    const m = new Map()
    const add = (key, r, label, sub) => {
      if (!key) return
      if (!m.has(key)) m.set(key, { key, label: label || key, sub: sub || '', count: 0, alarms: 0, gws: new Set() })
      const e = m.get(key); e.count++; if (alarmIds.has(r.channel_id)) e.alarms++; if (r.gateway_id) e.gws.add(r.gateway_id)
    }
    if (kind === 'group') {
      for (const g of groups || []) m.set(g.id, { key: g.id, label: g.name, sub: [g.description, g.owner && `작성 ${g.owner}`].filter(Boolean).join(' · '), count: 0, alarms: 0, gws: new Set(), group: g })
      for (const r of live) for (const gid of r.groups || []) { const e = m.get(gid); if (e) { e.count++; if (alarmIds.has(r.channel_id)) e.alarms++ } }
      return [...m.values()].sort((a, b) => (a.key !== 'all') - (b.key !== 'all') || a.label.localeCompare(b.label, 'ko'))
    }
    for (const r of live) {
      const p = r.patient || {}
      if (kind === 'ward') add(p.ward, r, p.ward, [p.building, p.floor && `${p.floor}F`].filter(Boolean).join(' '))
      else if (kind === 'room') add(p.room || r.space, r, p.room || r.space, p.ward && `병동 ${p.ward}`)
      else if (kind === 'doctor') add(p.doctor, r, staffLabel(p.doctor), staffSub(p.doctor))
      else if (kind === 'nurse') add(p.nurse, r, staffLabel(p.nurse), staffSub(p.nurse))
      else if (kind === 'department') add(p.department, r)
      else if (kind === 'diagnosis') add(p.diagnosis, r)
      else if (kind === 'gw') { const g = (gws || []).find((x) => String(x.gw_id) === r.gateway_id); add(r.gateway_id, r, `#${r.gateway_id}${g?.name ? ' ' + g.name : ''}`, g ? [g.location?.building, g.location?.floor && `${g.location.floor}F`, g.location?.room, g.type].filter(Boolean).join(' · ') : '') }
    }
    const v = [...m.values()]
    if (kind === 'gw') v.sort((a, b) => Number(a.key) - Number(b.key))
    else v.sort((a, b) => a.label.localeCompare(b.label, 'ko'))
    return v
  }, [kind, live, groups, gws, staff, alarmIds])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? entries.filter((e) => [e.key, e.label, e.sub].some((x) => String(x || '').toLowerCase().includes(needle))) : entries
  }, [entries, q])
  const kindCounts = useMemo(() => {
    const c = {}
    for (const [k] of KINDS) {
      if (k === 'group') { c[k] = (groups || []).length; continue }
      const s = new Set()
      for (const r of live) { const p = r.patient || {}; const v = k === 'gw' ? r.gateway_id : k === 'room' ? (p.room || r.space) : p[k]; if (v) s.add(v) }
      c[k] = s.size
    }
    return c
  }, [live, groups])

  const kindLabel = KINDS.find(([k]) => k === kind)[1]
  const urlFor = (e, t) => viewerUrl({ tpl: t, [SCOPE_KEY[kind]]: e.key, label: `${kindLabel} ${e.label}` })
  const open = (e, t = tpl) => window.open(urlFor(e, t), '_blank', 'noopener')
  const tplOpts = TEMPLATES.map((t) => ({ value: t.id, label: t.name }))
  const removeGroup = async (g) => {
    if (!window.confirm(`그룹 "${g.name}" 을(를) 삭제할까요?`)) return
    try { await api.deleteGroup(g.id); refreshGroups?.(); setTimeout(() => refreshRows?.(), 1200) } catch (e) { window.alert('삭제 실패: ' + e.message) }
  }

  return (
    <div className="page">
      <div className="toolbar">
        <span className="seg wrap">{KINDS.map(([k, l]) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); setQ('') }}>{l}<small className="muted"> {kindCounts[k] ?? 0}</small></button>)}</span>
        <input placeholder={`${kindLabel} 검색`} value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="spacer" />
        <span className="muted">클릭 시 열 뷰어</span>
        <Dropdown value={tpl} options={tplOpts} onChange={setTpl} searchable={false} width={260} />
        {kind === 'group' && <button className="primary" onClick={() => setEditing({})}>＋ 새 그룹</button>}
      </div>
      <p className="muted">{kindLabel}별 목록입니다. 행을 누르면 선택한 템플릿의 뷰어가 새 탭에서 전체 화면으로 열리고, 행의 버튼으로 다른 템플릿을 고를 수도 있습니다. 전체 연결 환자 {live.length.toLocaleString()}명.</p>
      <table className="tbl vw-table">
        <thead><tr><th>#</th><th>{kindLabel}</th>{kind === 'group' && <th>조건</th>}<th className="num">환자</th><th className="num">알람</th>{kind !== 'gw' && kind !== 'group' && <th className="num">GW</th>}<th>뷰어</th>{kind === 'group' && <th></th>}</tr></thead>
        <tbody>
          {shown.map((e, i) => (
            <tr key={e.key} className={'clickable' + (e.alarms ? ' sev-high' : '')} onClick={() => open(e)}>
              <td className="num muted">{i + 1}</td>
              <td className="lbl"><b>{e.label}</b>{e.sub && <small>{e.sub}</small>}</td>
              {kind === 'group' && <td className="muted">{describeGroup(e.group)}</td>}
              <td className="num">{e.count.toLocaleString()}</td>
              <td className="num">{e.alarms ? <span className="tag sev-high small">{e.alarms}</span> : <span className="muted">0</span>}</td>
              {kind !== 'gw' && kind !== 'group' && <td className="num">{e.gws.size}</td>}
              <td className="acts" onClick={(ev) => ev.stopPropagation()}>
                {TEMPLATES.map((t) => <button key={t.id} className={t.id === tpl ? 'tpl-default' : ''} title={t.desc} onClick={() => open(e, t.id)}>{t.name.split(' (')[0]}</button>)}
              </td>
              {kind === 'group' && <td className="acts" onClick={(ev) => ev.stopPropagation()}>
                <button onClick={() => setEditing(e.group)}>편집</button>
                {e.key !== 'all' && <button onClick={() => removeGroup(e.group)}>삭제</button>}
              </td>}
            </tr>
          ))}
          {!shown.length && <tr><td colSpan={8} className="muted">{kind === 'group' ? '그룹이 없습니다. "새 그룹"으로 만드세요.' : '표시할 항목이 없습니다.'}</td></tr>}
        </tbody>
      </table>
      {editing && <GroupEditor group={editing} rows={rows || []} staff={staff} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refreshGroups?.(); setTimeout(() => refreshRows?.(), 1200) }} />}
    </div>
  )
}

const CRIT_LABEL = { building: '건물', floor: '층', ward: '병동', zone: '구역', room: '병실', doctor: '담당의', department: '진료과', nurse: '간호사', diagnosis: '주진단' }
function describeGroup(g) {
  if (!g) return ''
  const parts = Object.entries(g.criteria || {}).map(([k, v]) => `${CRIT_LABEL[k] || k}: ${v.join('/')}`)
  if (g.include?.length) parts.push(`환자 ${g.include.length}명 지정`)
  if (g.exclude?.length) parts.push(`제외 ${g.exclude.length}명`)
  return parts.length ? parts.join(' · ') : (g.id === 'all' ? '모든 환자' : '조건 없음')
}

/** Group create / edit modal: name, memo, owner, and the member list built by searching patients. */
function GroupEditor({ group, rows, staff, onClose, onSaved }) {
  const isNew = !group.id
  const [name, setName] = useState(group.name || '')
  const [description, setDescription] = useState(group.description || '')
  const [owner, setOwner] = useState(group.owner || '')
  const [include, setInclude] = useState(() => [...(group.include || [])])
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const byId = useMemo(() => new Map(rows.map((r) => [String(r.channel_id), r])), [rows])
  const hasCriteria = Object.keys(group.criteria || {}).length > 0
  const who = (id) => {
    const r = byId.get(id); const p = r?.patient || {}
    return { name: p.name || r?.mrn || id, sub: [p.ward, p.room || r?.space, r?.mrn, `패치 ${id}`, r && !r.connected && '해제'].filter(Boolean).join(' · ') }
  }
  const results = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return []
    const inc = new Set(include)
    return rows.filter((r) => !inc.has(String(r.channel_id)) && [r.patient?.name, r.mrn, r.channel_id, r.patient?.room, r.patient?.ward, r.patient?.doctor, staff.get(r.patient?.doctor)?.name]
      .some((x) => String(x || '').toLowerCase().includes(needle))).slice(0, 60)
  }, [search, rows, include, staff])
  const save = async () => {
    if (!name.trim()) { setErr('그룹 이름을 입력하세요.'); return }
    setBusy(true); setErr('')
    const body = { ...group, id: group.id || 'g-' + Date.now().toString(36), name: name.trim(), description, owner, criteria: group.criteria || {}, include, exclude: group.exclude || [] }
    try {
      if (isNew) await api.createGroup(body); else await api.updateGroup(group.id, body)
      onSaved()
    } catch (e) { setErr('저장 실패: ' + e.message) } finally { setBusy(false) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 'min(1000px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{isNew ? '새 그룹' : `그룹 편집 · ${group.name}`}</h2><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
        <div className="grp-form">
          <label>이름</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 심전도 집중 관찰" autoFocus />
          <label>설명</label><input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="메모 (선택)" />
          <label>작성자</label><input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="이름 또는 부서 (선택)" />
          {hasCriteria && <><label>속성 조건</label><span className="muted">{describeGroup(group)} — 조건에 맞는 환자도 자동 포함됩니다</span></>}
        </div>
        <div className="grp-cols">
          <div className="grp-col">
            <h4>환자 검색 · 이름 / MRN / 패치 / 병실 / 담당의</h4>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="검색어 입력" style={{ width: '100%' }} />
            <div className="grp-list" style={{ marginTop: 6 }}>
              {results.map((r) => { const w = who(String(r.channel_id)); return <div key={r.channel_id} className="row"><span className="who"><b>{w.name}</b><small>{w.sub}</small></span><button onClick={() => setInclude([...include, String(r.channel_id)])}>추가</button></div> })}
              {search.trim() && !results.length && <div className="row muted">검색 결과 없음</div>}
              {!search.trim() && <div className="row muted">검색어를 입력하면 환자 목록이 나옵니다 (최대 60명)</div>}
            </div>
          </div>
          <div className="grp-col">
            <h4>그룹 환자 · {include.length}명</h4>
            <div className="grp-list">
              {include.map((id) => { const w = who(id); return <div key={id} className="row"><span className="who"><b>{w.name}</b><small>{w.sub}</small></span><button onClick={() => setInclude(include.filter((x) => x !== id))}>빼기</button></div> })}
              {!include.length && <div className="row muted">아직 담긴 환자가 없습니다{hasCriteria ? ' (속성 조건 멤버는 자동 포함)' : ''}.</div>}
            </div>
          </div>
        </div>
        {err && <p className="err">{err}</p>}
        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <span className="spacer" />
          <button onClick={onClose} disabled={busy}>취소</button>
          <button className="primary" onClick={save} disabled={busy}>{isNew ? '만들기' : '저장'}</button>
        </div>
      </div>
    </div>
  )
}
