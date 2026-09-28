import React, { useEffect, useMemo, useState } from 'react'
import { can, useMe } from '../auth.js'
import { api, usePoll } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import { sortBy, wardText, wardRoom, roomText, gwLabel, isAway } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import { Pill, go } from '../ListKit.jsx'
import { RENDER_MODES, setRenderMode, useRenderMode } from '../settings.js'
import '../viewer/ds.css'
import './Viewers.css'

/**
 * 뷰어 실행기 — ① 묶을 기준 → ② 대상 선택 → ③ 템플릿으로 새 탭에서 열기.
 * ① 왼쪽: 병동·병실·게이트웨이·그룹, 담당·임상 기준(담당의·간호사·진료과목·주진단·페이스메이커·MCOT) — 기준마다 개수.
 * ② 가운데: 그 기준의 대상 표. 행의 '열기' 는 오른쪽에서 고른 템플릿으로 그 대상만 연다. 여러 행을 체크하면 환자 합집합을
 *    한 뷰어(패치 id 목록, `ids=`)로 연다 — 뷰어 URL 은 병동/게이트웨이 등 범위 값을 하나만 받지만 `ids` 는 여러 개를 받는다.
 * ③ 오른쪽: 템플릿(templates.js), 표시 옵션(밀도·알람 있는 환자만·파형 그리기), 선택 N개 · 새 탭에서 열기.
 * 즐겨찾기(★, localStorage viewers.fav)는 표 맨 앞에, 열어 둔 탭은 창 핸들로 추적해 "열려 있음" 과 상단 카운터에 보인다.
 * 그룹은 라우터 DB 의 사용자 정의 환자 집합 — 그룹 기준에서 만들기·편집·삭제(권한 action.groups_edit).
 */
const KINDS = [
  ['ward', '병동'], ['room', '병실'], ['doctor', '담당의'], ['nurse', '간호사'],
  ['department', '진료과목'], ['diagnosis', '주진단'], ['pacemaker', '페이스메이커'], ['mcot', 'MCOT'], ['gw', '게이트웨이'], ['group', '그룹'],
]
const SCOPE_KEY = { ward: 'ward', room: 'room', doctor: 'doctor', nurse: 'nurse', department: 'dept', diagnosis: 'dx', gw: 'gw', group: 'group', pacemaker: 'ward', mcot: 'ward' }
// boolean categories: rows are the wards holding such patients, plus an all-wards row (key '')
const isPaced = (r) => (r.flags & 0x10) !== 0
// MCOT (원외) is a gateway property: a 1-patient mobile gateway (type "mobile", building "원외(MCOT)"); the frames are identical
export const isMobileGw = (g) => g?.type === 'mobile' || /원외|MCOT/i.test(g?.location?.building || '')
const isMcot = (r, mobile) => mobile.has(r.gateway_id) || (!!r.patient?.mode && r.patient.mode !== 'inpatient')
const BOOL_KIND = { pacemaker: { test: isPaced, scope: { paced: '1' }, all: '페이스메이커 환자 전체' }, mcot: { test: isMcot, scope: { mode: 'mcot' }, all: 'MCOT 환자 전체' } }
const pref = (k, d) => { try { return localStorage.getItem(k) || d } catch { return d } }

export default function Viewers({ alarms }) {
  const canGroups = can(useMe(), 'action.groups_edit', 2) // 그룹 만들기·편집·삭제
  const [rows, , refreshRows] = usePoll(api.channels, 10000)
  const [gws] = usePoll(api.gateways, 15000)
  const [groups, , refreshGroups] = usePoll(api.groups, 10000)
  const [staff, setStaff] = useState(new Map())
  const [kind, setKind] = useState(() => pref('viewers.kind', 'ward'))
  const [tpl, setTpl] = useState(() => pref('viewers.tpl', TEMPLATES[0].id))
  const [q, setQ] = useState('')
  const [subCat, setSubCat] = useState('') // sub-category ('' = all): ward → building, doctor/nurse → specialty
  // sort per category, remembered: { ward: ['count','desc'], ... }
  const [sorts, setSorts] = useState(() => { try { return JSON.parse(localStorage.getItem('viewers.sorts') || '{}') } catch { return {} } })
  const sort = sorts[kind] || ['label', 'asc'] // [column, dir]; column: label | building | floor | count | alarms
  const setSort = (v) => setSorts((o) => { const n = { ...o, [kind]: v }; try { localStorage.setItem('viewers.sorts', JSON.stringify(n)) } catch { /* ignore */ } return n })
  const [editing, setEditing] = useState(null) // group being edited (null = closed, {} = new)
  const [sel, setSel] = useState(() => new Set()) // ② 체크한 대상 키 (기준을 바꾸면 비움)
  // ③ 표시 옵션 — 뷰어 URL 이 읽는 값이 아니라 여기서 적용하거나(알람만 → ids 로 걸러 열기, 파형 그리기 → settings.js 공유) 기억만 한다(밀도)
  const [density, setDensity] = useState(() => pref('viewers.opt.density', 'compact'))
  const [alarmOnly, setAlarmOnly] = useState(() => pref('viewers.opt.alarmOnly', '0') === '1')
  const renderMode = useRenderMode()
  useEffect(() => { try { localStorage.setItem('viewers.kind', kind); localStorage.setItem('viewers.tpl', tpl); localStorage.setItem('viewers.opt.density', density); localStorage.setItem('viewers.opt.alarmOnly', alarmOnly ? '1' : '0') } catch { /* ignore */ } }, [kind, tpl, density, alarmOnly])
  useEffect(() => { api.staff().then((d) => setStaff(new Map((d?.staff || []).map((s) => [s.id, s])))).catch(() => {}) }, [])
  useEffect(() => { setSel(new Set()) }, [kind])

  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const mobile = useMemo(() => new Set((gws || []).filter(isMobileGw).map((g) => String(g.gw_id))), [gws])
  const alarmIds = useMemo(() => new Set((alarms?.alarms || []).map((a) => String(a.channel_id))), [alarms])
  // 채널별 가장 높은 심각도 (알람 배지 색: critical/high → crit, medium → med, low → 중립)
  const alarmSev = useMemo(() => {
    const rank = { critical: 3, high: 2, medium: 1, low: 0 }
    const m = new Map()
    for (const a of alarms?.alarms || []) { const id = String(a.channel_id); const r = rank[a.severity] ?? 0; if ((m.get(id) ?? -1) < r) m.set(id, r) }
    return m
  }, [alarms])
  // 즐겨찾기 (scope:key), 브라우저에 기억
  const [favs, setFavs] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('viewers.fav') || '[]')) } catch { return new Set() } })
  const toggleFav = (k) => setFavs((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); try { localStorage.setItem('viewers.fav', JSON.stringify([...n])) } catch { /* ignore */ } return n })
  // 열어 둔 뷰어 탭 (key → window): 닫혔는지 5초마다 확인해 "열려 있음" 표시와 상단 카운터를 갱신
  const wins = React.useRef(new Map())
  const [, tickOpen] = useState(0)
  useEffect(() => { const t = setInterval(() => { let changed = false; for (const [k, w] of wins.current) if (!w || w.closed) { wins.current.delete(k); changed = true } if (changed) tickOpen((n) => n + 1) }, 5000); return () => clearInterval(t) }, [])
  const openTabs = [...wins.current.values()].filter((w) => w && !w.closed).length
  const staffLabel = (id) => { const s = staff.get(id); return s ? `${s.name} (${id})` : id }
  const staffSub = (id) => { const s = staff.get(id); return s ? [s.title, s.specialty, s.ward && `병동 ${s.ward}`].filter(Boolean).join(' · ') : '' }

  // one list entry per distinct value of the chosen category, with connected-patient and alarm counts and member patch ids
  const entries = useMemo(() => {
    const m = new Map()
    const add = (key, r, label, sub) => {
      if (!key) return
      if (!m.has(key)) m.set(key, { key, label: label || key, sub: sub || '', count: 0, alarms: 0, sev: -1, gws: new Set(), mobile: 0, members: [] })
      const e = m.get(key); e.count++; e.members.push(String(r.channel_id)); if (alarmIds.has(r.channel_id)) { e.alarms++; e.sev = Math.max(e.sev, alarmSev.get(String(r.channel_id)) ?? 0) } if (r.gateway_id) { e.gws.add(r.gateway_id); if (mobile.has(r.gateway_id)) e.mobile++ }
    }
    if (kind === 'group') {
      for (const g of groups || []) m.set(g.id, { key: g.id, label: g.name, sub: [g.description, g.owner && `작성 ${g.owner}`].filter(Boolean).join(' · '), count: 0, alarms: 0, sev: -1, gws: new Set(), mobile: 0, members: [], group: g })
      for (const r of live) for (const gid of r.groups || []) { const e = m.get(gid); if (e) { e.count++; e.members.push(String(r.channel_id)); if (alarmIds.has(r.channel_id)) { e.alarms++; e.sev = Math.max(e.sev, alarmSev.get(String(r.channel_id)) ?? 0) } if (r.gateway_id) { e.gws.add(r.gateway_id); if (mobile.has(r.gateway_id)) e.mobile++ } } }
      return [...m.values()].sort((a, b) => (a.key !== 'all') - (b.key !== 'all') || a.label.localeCompare(b.label, 'ko'))
    }
    if (BOOL_KIND[kind]) {
      const { test, all } = BOOL_KIND[kind]
      const hits = live.filter((r) => test(r, mobile))
      for (const r of hits) {
        const p = r.patient || {}
        if (p.ward) { add(' ' + p.ward, r, p.ward, [p.building, p.floor && `${p.floor}F`].filter(Boolean).join(' ')); const e = m.get(' ' + p.ward); e.building = e.building || p.building || ''; e.floor = e.floor || p.floor || ''; continue }
        // outside the wards (MCOT): group by the patient's home region when the EMR provides it
        if (p.home_region) { add(' ' + p.home_region, r, `외부 · ${p.home_region}`, '집주소 지역'); const e = m.get(' ' + p.home_region); e.region = p.home_region; continue }
        add(' 기타', r, '병동 외부', '집주소 정보 없음')
        const e = m.get(' 기타'); (e.ids = e.ids || []).push(r.channel_id) // nothing to scope by: open by patch ids
      }
      const v = [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'))
      const total = { key: '', label: all, sub: `${[...m.keys()].length}개 병동`, count: hits.length, alarms: hits.filter((r) => alarmIds.has(r.channel_id)).length, sev: Math.max(-1, ...hits.map((r) => alarmSev.get(String(r.channel_id)) ?? -1)), gws: new Set(hits.map((r) => r.gateway_id).filter(Boolean)), mobile: hits.filter((r) => mobile.has(r.gateway_id)).length, members: hits.map((r) => String(r.channel_id)) }
      return [total, ...v.map((e) => ({ ...e, key: e.key.trim() }))]
    }
    for (const r of live) {
      const p = r.patient || {}
      if (kind === 'ward') { add(p.ward, r, p.ward, ''); const e = m.get(p.ward); if (e) { e.building = e.building || p.building || ''; e.floor = e.floor || p.floor || ''; e.sub2 = e.building } }
      else if (kind === 'room') {
        // 입원 병실 + (다르면) 지금 있는 공간 — 검사실·투석실 같은 비병실 공간도 모니터 목록에 나온다
        add(p.room || r.space, r, p.room || r.space, p.ward && `병동 ${p.ward}`)
        const e = m.get(p.room || r.space); if (e) { e.building = e.building || p.building || ''; e.floor = e.floor || p.floor || '' }
        if (isAway(p, r.space)) add(r.space, r, r.space, '현재 위치')
      }
      else if (kind === 'doctor') { add(p.doctor, r, staffLabel(p.doctor), staffSub(p.doctor)); const e = m.get(p.doctor); if (e) e.sub2 = staff.get(p.doctor)?.specialty || '' }
      else if (kind === 'nurse') { add(p.nurse, r, staffLabel(p.nurse), staffSub(p.nurse)); const e = m.get(p.nurse); if (e) e.sub2 = staff.get(p.nurse)?.specialty || '' }
      else if (kind === 'department') add(p.department, r)
      else if (kind === 'diagnosis') add(p.diagnosis, r)
      else if (kind === 'gw') { const g = (gws || []).find((x) => String(x.gw_id) === r.gateway_id); add(r.gateway_id, r, `#${r.gateway_id}${g?.name ? ' ' + gwLabel(g.name) : ''}`, g ? [g.location?.room, g.type].filter(Boolean).join(' · ') : ''); const e = m.get(r.gateway_id); if (e && g) { e.building = g.location?.building || ''; e.floor = g.location?.floor || '' } }
    }
    const v = [...m.values()]
    if (kind === 'gw') v.sort((a, b) => Number(a.key) - Number(b.key))
    else v.sort((a, b) => a.label.localeCompare(b.label, 'ko'))
    return v
  }, [kind, live, groups, gws, staff, alarmIds, alarmSev, mobile])
  // sub-category buttons: ward → building, doctor/nurse → specialty
  const SUB_LABEL = { ward: '건물', doctor: '진료과목', nurse: '진료과목' }
  const subCats = useMemo(() => {
    if (!SUB_LABEL[kind]) return []
    const c = new Map()
    for (const e of entries) { const b = e.sub2 || '기타'; const n = c.get(b) || { rows: 0, patients: 0 }; n.rows++; n.patients += e.count; c.set(b, n) }
    return [...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([name, n]) => ({ name, ...n }))
  }, [kind, entries])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = needle ? entries.filter((e) => [e.key, e.label, e.sub].some((x) => String(x || '').toLowerCase().includes(needle))) : entries
    if (SUB_LABEL[kind] && subCat) v = v.filter((e) => (e.sub2 || '기타') === subCat)
    const key = sort[0] === 'floor' ? (e) => Number(e.floor) || 0 : sort[0] === 'building' ? (e) => e.building || '' : sort[0] === 'label' && kind === 'gw' ? (e) => Number(e.key) : sort[0]
    let sorted = sortBy(v, key, sort[1])
    if (sort[0] === 'alarms') sorted = [...sorted].sort((a, b) => (b.alarms - a.alarms) * (sort[1] === 'desc' ? 1 : -1) || a.label.localeCompare(b.label, 'ko'))
    // 즐겨찾기(★)는 항상 앞, 전체(모든 환자) 행은 그 다음
    const favKey = (e) => `${kind}:${e.key}`
    const top = (e) => (favs.has(favKey(e)) ? 0 : (kind === 'group' && e.key === 'all') || (BOOL_KIND[kind] && e.key === '') ? 1 : 2)
    return [...sorted].sort((a, b) => top(a) - top(b))
  }, [entries, q, sort, kind, subCat, favs])
  const kindCounts = useMemo(() => {
    const c = {}
    for (const [k] of KINDS) {
      if (k === 'group') { c[k] = (groups || []).length; continue }
      if (BOOL_KIND[k]) { c[k] = live.filter((r) => BOOL_KIND[k].test(r, mobile)).length; continue }
      const s = new Set()
      for (const r of live) { const p = r.patient || {}; const v = k === 'gw' ? r.gateway_id : k === 'room' ? (p.room || r.space) : p[k]; if (v) s.add(v); if (k === 'room' && isAway(p, r.space)) s.add(r.space) }
      c[k] = s.size
    }
    return c
  }, [live, groups, mobile])

  const kindLabel = KINDS.find(([k]) => k === kind)[1]
  const tplObj = TEMPLATES.find((t) => t.id === tpl) || TEMPLATES[0]
  const urlFor = (e, t) => viewerUrl({ tpl: t, ...(BOOL_KIND[kind]?.scope || {}), ...(e.ids ? { ids: e.ids } : e.region ? { region: e.region } : { [SCOPE_KEY[kind]]: e.key }), label: BOOL_KIND[kind] ? (e.key ? `${kindLabel} · 병동 ${e.label}` : e.label) : `${kindLabel} ${e.label}` })
  const winKey = (e, t) => `${kind}:${e.key}:${t}`
  const launch = (url, k) => {
    const w = wins.current.get(k)
    if (w && !w.closed) { try { w.focus() } catch { /* ignore */ } return }
    // noopener 를 빼야 핸들을 쥐고 "열려 있음" 을 알 수 있다 (같은 출처의 우리 뷰어 탭이라 위험 없음)
    const nw = window.open(url, '_blank')
    if (nw) { wins.current.set(k, nw); tickOpen((n) => n + 1) }
  }
  // 행 하나 열기: 알람만 이면 그 대상의 알람 환자 id 목록으로, 아니면 범위 값으로
  const open = (e, t = tpl) => {
    if (alarmOnly) {
      const ids = e.members.filter((id) => alarmIds.has(id))
      if (!ids.length) { window.alert('알람 있는 환자가 없습니다.'); return }
      launch(viewerUrl({ tpl: t, ids, label: `${e.label} · 알람 ${ids.length}명` }), `${kind}:${e.key}:alarm:${t}`)
      return
    }
    launch(urlFor(e, t), winKey(e, t))
  }
  // 전체 연결 환자 (범위 없음)
  const openAll = (t = tpl) => {
    if (alarmOnly) { const ids = live.filter((r) => alarmIds.has(r.channel_id)).map((r) => String(r.channel_id)); if (!ids.length) { window.alert('알람 있는 환자가 없습니다.'); return } launch(viewerUrl({ tpl: t, ids, label: `알람 환자 ${ids.length}명` }), `all:alarm:${t}`); return }
    launch(viewerUrl({ tpl: t, label: '전체 환자' }), `all:${t}`)
  }
  // 체크한 대상들을 하나의 뷰어로: 환자 합집합을 ids 로 (뷰어 URL 의 범위 값은 하나만 받으므로 ids 가 유일한 합집합 방법)
  const selEntries = shown.filter((e) => sel.has(e.key))
  const selIds = useMemo(() => { const s = new Set(); for (const e of selEntries) for (const id of e.members) if (!alarmOnly || alarmIds.has(id)) s.add(id); return [...s] }, [selEntries, alarmOnly, alarmIds])
  const openSelected = () => {
    if (sel.has('*all*')) { openAll(); return }
    if (selEntries.length === 1) { open(selEntries[0]); return }
    if (!selIds.length) { window.alert(alarmOnly ? '선택한 대상에 알람 있는 환자가 없습니다.' : '선택한 대상에 연결된 환자가 없습니다.'); return }
    const label = `${kindLabel} ${selEntries.map((e) => e.label).slice(0, 4).join(' + ')}${selEntries.length > 4 ? ` 외 ${selEntries.length - 4}` : ''}${alarmOnly ? ' · 알람만' : ''}`
    launch(viewerUrl({ tpl, ids: selIds, label }), `multi:${kind}:${[...sel].sort().join(',')}:${alarmOnly ? 'a' : ''}:${tpl}`)
  }
  const openHandle = (e) => { for (const t of TEMPLATES) for (const k of [winKey(e, t.id), `${kind}:${e.key}:alarm:${t.id}`]) { const w = wins.current.get(k); if (w && !w.closed) return () => { try { w.focus() } catch { /* ignore */ } } } return null }
  const allOpen = (() => { for (const t of TEMPLATES) for (const k of [`all:${t.id}`, `all:alarm:${t.id}`]) { const w = wins.current.get(k); if (w && !w.closed) return () => { try { w.focus() } catch { /* ignore */ } } } return null })()
  // 환자 목록으로 가는 범위 매핑 (있는 것만)
  const listParams = (e) => {
    if (kind === 'ward' && e.key) return { ward: e.key }
    if (kind === 'room' && e.key) return { room: e.key }
    if (kind === 'gw' && e.key) return { gw: e.key }
    if (kind === 'doctor' && e.key) return { doctor: e.key }
    if (kind === 'nurse' && e.key) return { nurse: e.key }
    if (kind === 'group' && e.key) return { group: e.key }
    return null
  }
  const badgeTone = (e) => (e.alarms ? (e.sev >= 2 ? 'crit' : e.sev === 1 ? 'med' : 'low') : '')
  const removeGroup = async (g) => {
    if (!window.confirm(`그룹 "${g.name}" 을(를) 삭제할까요?`)) return
    try { await api.deleteGroup(g.id); refreshGroups?.(); setTimeout(() => refreshRows?.(), 1200) } catch (e) { window.alert('삭제 실패: ' + e.message) }
  }
  const toggleSel = (k) => setSel((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const Th = ({ col, children, num }) => <th className={'sortable' + (num ? ' num' : '') + (sort[0] === col ? ' on' : '')} onClick={() => setSort([col, sort[0] === col && sort[1] === 'asc' ? 'desc' : 'asc'])}>{children}{sort[0] === col ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  const KIND_GROUPS = [['위치 · 장비', ['ward', 'room', 'gw', 'group']], ['담당 · 임상 기준', ['doctor', 'nurse', 'department', 'diagnosis', 'pacemaker', 'mcot']]]
  const liveAlarms = live.filter((r) => alarmIds.has(r.channel_id)).length
  const selCount = sel.has('*all*') ? 1 : selEntries.length
  const selPatients = sel.has('*all*') ? (alarmOnly ? liveAlarms : live.length) : selIds.length
  const overMax = tplObj.maxRows && selPatients > tplObj.maxRows

  return (
    <div className="page vw">
      <div className="vw-head">
        <h2 className="h">뷰어</h2>
        <span className="muted vw-steps"><b>①</b> 묶을 기준 → <b>②</b> 대상 선택 → <b>③</b> 템플릿으로 새 탭에서 열기</span>
        <span className="spacer" />
        <span className={'pill ' + (openTabs ? 'ok' : '')} title="이 콘솔에서 연 뷰어 탭 (닫히면 5초 안에 줄어듭니다)">열린 뷰어 탭 <b>{openTabs}</b></span>
      </div>

      <div className="vw-launch">
        {/* ① 묶을 기준 */}
        <aside className="vw-col vw-kinds" aria-label="묶을 기준">
          <h4>① 묶을 기준</h4>
          {KIND_GROUPS.map(([title, keys]) => (
            <div key={title} className="vw-kgrp">
              <div className="vw-klabel">{title}</div>
              {keys.map((k) => { const l = KINDS.find(([x]) => x === k)[1]; return (
                <button key={k} className={'vw-kind' + (kind === k ? ' on' : '')} onClick={() => { setKind(k); setQ(''); setSubCat('') }}>
                  <span>{l}</span><b className="mono">{(kindCounts[k] ?? 0).toLocaleString()}</b>
                </button>) })}
            </div>
          ))}
        </aside>

        {/* ② 대상 선택 */}
        <section className="vw-col vw-targets" aria-label="대상 선택">
          <div className="vw-th">
            <h4>② 대상 선택 <small className="muted">{kindLabel} · 표시 {shown.length.toLocaleString()}개</small></h4>
            <span className="spacer" />
            <input className="vw-q" placeholder={`${kindLabel} 검색`} value={q} onChange={(e) => setQ(e.target.value)} />
            {kind === 'group' && canGroups && <button className="primary" onClick={() => setEditing({})}>＋ 새 그룹</button>}
          </div>
          {SUB_LABEL[kind] && subCats.length > 0 && (
            <div className="toolbar sub vw-subcat">
              <span className="muted">{SUB_LABEL[kind]}</span>
              <span className="seg wrap">
                <button className={subCat === '' ? 'active' : ''} onClick={() => setSubCat('')}>전체<small className="muted"> {entries.length}</small></button>
                {subCats.map((b) => <button key={b.name} className={subCat === b.name ? 'active' : ''} onClick={() => setSubCat(b.name)} title={`${b.rows}개 ${kindLabel} · ${b.patients}명`}>{b.name}<small className="muted"> {b.rows}</small></button>)}
              </span>
            </div>
          )}
          <div className="vw-tblwrap">
            <table className="tbl dense vw-tbl">
              <thead><tr>
                <th className="chk"><input type="checkbox" aria-label="모두 선택" checked={shown.length > 0 && shown.every((e) => sel.has(e.key))} onChange={(ev) => setSel(ev.target.checked ? new Set(shown.map((e) => e.key)) : new Set())} /></th>
                <th className="star" />
                <Th col="label">{kind === 'group' ? '그룹' : kind === 'gw' ? '게이트웨이' : kindLabel}</Th>
                {['ward', 'room', 'gw', 'pacemaker', 'mcot'].includes(kind) && <><Th col="building">건물</Th><Th col="floor" num>층</Th></>}
                <Th col="count" num>환자</Th>
                <Th col="alarms" num>알람</Th>
                <th>상태</th>
                <th className="act" />
              </tr></thead>
              <tbody>
                {!BOOL_KIND[kind] && kind !== 'group' && (
                  <tr className={'vw-all' + (sel.has('*all*') ? ' selected' : '')}>
                    <td className="chk"><input type="checkbox" checked={sel.has('*all*')} onChange={() => setSel((o) => (o.has('*all*') ? new Set() : new Set(['*all*'])))} aria-label="전체 연결 환자 선택" /></td>
                    <td className="star" />
                    <td><b>전체 연결 환자</b><small className="muted"> 범위 없이 모두</small></td>
                    {['ward', 'room', 'gw'].includes(kind) && <><td /><td /></>}
                    <td className="num mono">{live.length.toLocaleString()}</td>
                    <td className="num">{liveAlarms ? <Pill tone={liveAlarms ? 'med' : ''}>{liveAlarms}</Pill> : <span className="muted">0</span>}</td>
                    <td>{allOpen ? <a className="lk-link" onClick={allOpen}>열려 있음</a> : <span className="muted">—</span>}</td>
                    <td className="act"><button onClick={() => openAll()} title={tplObj.name}>열기</button></td>
                  </tr>
                )}
                {shown.map((e) => {
                  const fk = `${kind}:${e.key}`
                  const lp = listParams(e)
                  const oh = openHandle(e)
                  const title = kind === 'ward' && e.key && wardText(e.label) !== e.label ? <>{wardText(e.label)} <small className="mono muted">{e.label}</small></> : kind === 'room' && wardRoom(e.label) ? <>{roomText(e.label)} <small className="mono muted">{e.label}</small></> : e.label
                  const sub = [e.sub, kind === 'group' ? describeGroup(e.group) : '', e.mobile ? `이동형 ${e.mobile}` : '', kind !== 'gw' && e.gws.size ? `GW ${e.gws.size}` : ''].filter(Boolean).join(' · ')
                  return (
                    <tr key={e.key} className={(sel.has(e.key) ? 'selected' : '') + (e.alarms ? (e.sev >= 2 ? ' has-crit' : ' has-alarm') : '')} onClick={() => toggleSel(e.key)}>
                      <td className="chk" onClick={(ev) => ev.stopPropagation()}><input type="checkbox" checked={sel.has(e.key)} onChange={() => toggleSel(e.key)} aria-label={`${e.label} 선택`} /></td>
                      <td className="star" onClick={(ev) => ev.stopPropagation()}><button className={'lk-star' + (favs.has(fk) ? ' on' : '')} onClick={() => toggleFav(fk)} title={favs.has(fk) ? '즐겨찾기 해제' : '즐겨찾기'}>★</button></td>
                      <td className="name"><b>{title}</b>{sub && <small className="muted">{sub}</small>}</td>
                      {['ward', 'room', 'gw', 'pacemaker', 'mcot'].includes(kind) && <><td>{e.building || <span className="muted">—</span>}</td><td className="num mono">{e.floor ? `${e.floor}F` : ''}</td></>}
                      <td className="num mono">{e.count.toLocaleString()}</td>
                      <td className="num">{e.alarms ? <Pill tone={badgeTone(e)}>{e.alarms}</Pill> : <span className="muted">0</span>}</td>
                      <td>{oh ? <a className="lk-link" onClick={(ev) => { ev.stopPropagation(); oh() }}>열려 있음</a> : <span className="muted">—</span>}</td>
                      <td className="act" onClick={(ev) => ev.stopPropagation()}>
                        <button onClick={() => open(e)} title={`${tplObj.name} 으로 열기`}>열기</button>
                        {lp && <button className="ghost" onClick={() => go('#/patients', lp)} title="환자 목록에서 보기">목록</button>}
                        {kind === 'group' && canGroups && <button className="ghost" onClick={() => setEditing(e.group)}>편집</button>}
                        {kind === 'group' && canGroups && e.key !== 'all' && <button className="ghost danger" onClick={() => removeGroup(e.group)}>삭제</button>}
                      </td>
                    </tr>
                  )
                })}
                {!shown.length && <tr><td colSpan={9} className="muted vw-empty">{kind === 'group' ? '그룹이 없습니다. "새 그룹"으로 만드세요.' : '표시할 항목이 없습니다. 환자 연결 상태를 먼저 확인하세요.'}</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted vw-note">여러 행을 체크해 한 뷰어에 합쳐 열 수 있습니다(환자 합집합을 패치 목록으로 엽니다). 행의 <b>열기</b> 는 오른쪽에서 고른 템플릿을 씁니다. ★ 즐겨찾기는 맨 위에 옵니다.</p>
        </section>

        {/* ③ 템플릿 · 표시 옵션 */}
        <aside className="vw-col vw-tpl" aria-label="템플릿">
          <h4>③ 템플릿</h4>
          <div className="vw-tpls" role="radiogroup">
            {TEMPLATES.map((t) => (
              <label key={t.id} className={'vw-tplcard' + (tpl === t.id ? ' on' : '')}>
                <input type="radio" name="vw-tpl" checked={tpl === t.id} onChange={() => setTpl(t.id)} />
                <span className="vw-tplname">{t.name.split(' (')[0]}{t.name.includes('(') && <small className="muted"> {t.name.slice(t.name.indexOf('(') + 1, -1)}</small>}</span>
                <small className="muted">{t.audience}{t.maxRows ? ` · 최대 ${t.maxRows}명` : ''}</small>
              </label>
            ))}
          </div>
          <h4>표시 옵션</h4>
          <div className="vw-opts">
            <div className="vw-opt"><span>밀도</span><span className="seg">{[['normal', '크게'], ['compact', '보통'], ['dense', '촘촘']].map(([v, l]) => <button key={v} className={density === v ? 'active' : ''} onClick={() => setDensity(v)}>{l}</button>)}</span></div>
            <label className="vw-opt chk"><input type="checkbox" checked={alarmOnly} onChange={(e) => setAlarmOnly(e.target.checked)} /> 알람 있는 환자만</label>
            <div className="vw-opt"><span>파형 그리기</span><span className="seg">{RENDER_MODES.map(([v, l]) => <button key={v} className={renderMode === v ? 'active' : ''} onClick={() => setRenderMode(v)} title="열린 뷰어 탭에도 바로 적용">{l}</button>)}</span></div>
            <a className="lk-link small" href="#/settings/viewer">뷰어 설정 →</a>
          </div>
          <div className="vw-foot">
            <div className="muted small">선택 <b>{selCount}</b>개{selCount ? ` · 환자 ${selPatients.toLocaleString()}명` : ''}{alarmOnly ? ' · 알람만' : ''}</div>
            {overMax && <div className="warn small">템플릿 최대 {tplObj.maxRows}명 — 앞의 {tplObj.maxRows}명만 보입니다</div>}
            <button className="primary vw-go" disabled={!selCount} onClick={openSelected}>새 탭에서 열기</button>
          </div>
        </aside>
      </div>
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
