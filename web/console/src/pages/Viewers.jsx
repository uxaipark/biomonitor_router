import React, { useEffect, useMemo, useRef, useState } from 'react'
import { can, useMe } from '../auth.js'
import { api, usePoll } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import { wardText, wardRoom, roomText, gwLabel, isAway } from '../model.js'
import { Pill } from '../ListKit.jsx'
import '../viewer/ds.css'
import './Viewers.css'

/**
 * 뷰어 — 바로 열기 + 그룹 만들기 (⑬ 화면).
 * 바로 열기: 목록 옆 '열기' 로 그룹 없이 즉시 파형을 새 탭에 연다. 그룹으로 열기: 하위 대상(병동·병실 등)이나 세부 대상(환자)을
 * 오른쪽 '그룹 만들기' 패널로 끌어 담고 저장한 뒤 연다.
 * ① 그룹 기준(위치 / 담당·임상) → ② 그 기준의 하위 대상(값별 환자 수, 행 전체 끌기 가능, 클릭하면 좁히기) → ③ 세부 대상(환자, 체크·끌기·바로 열기).
 * 오른쪽: 저장된 그룹(편집·열기) + 그룹 만들기(놓기 영역, 구성, 저장·저장하고 열기). 그룹은 라우터 DB 의 사용자 정의 환자 집합
 * (GroupConfig.include 에 패치 id 목록) — 저장·편집·삭제는 권한 action.groups_edit.
 * 모든 '열기' 는 상단 '열기 템플릿' 을 쓴다. 열어 둔 탭은 창 핸들로 추적해 상단 카운터에 보인다.
 */
const KINDS = [
  ['ward', '병동'], ['room', '병실'], ['gw', '게이트웨이'],
  ['doctor', '담당의'], ['nurse', '간호사'], ['department', '진료과목'], ['diagnosis', '주진단'], ['pacemaker', '페이스메이커'], ['mcot', 'MCOT'],
]
const KIND_GROUPS = [['위치', ['ward', 'room', 'gw']], ['담당 · 임상', ['doctor', 'nurse', 'department', 'diagnosis', 'pacemaker', 'mcot']]]
const SCOPE_KEY = { ward: 'ward', room: 'room', doctor: 'doctor', nurse: 'nurse', department: 'dept', diagnosis: 'dx', gw: 'gw', pacemaker: 'ward', mcot: 'ward' }
// boolean categories: rows are the wards holding such patients, plus an all-wards row (key '')
const isPaced = (r) => (r.flags & 0x10) !== 0
// MCOT (원외) is a gateway property: a 1-patient mobile gateway (type "mobile", building "원외(MCOT)"); the frames are identical
export const isMobileGw = (g) => g?.type === 'mobile' || /원외|MCOT/i.test(g?.location?.building || '')
const isMcot = (r, mobile) => mobile.has(r.gateway_id) || (!!r.patient?.mode && r.patient.mode !== 'inpatient')
const BOOL_KIND = { pacemaker: { test: isPaced, scope: { paced: '1' }, all: '페이스메이커 환자 전체' }, mcot: { test: isMcot, scope: { mode: 'mcot' }, all: 'MCOT 환자 전체' } }
const pref = (k, d) => { try { return localStorage.getItem(k) || d } catch { return d } }
const SEV = { 3: ['위험', 'crit'], 2: ['높음', 'high'], 1: ['중간', 'med'], 0: ['낮음', 'low'] }
const roomOnly = (id) => wardRoom(id)?.room || id || ''
const shortTpl = (t) => t.name.split(' (')[0]

export default function Viewers({ alarms }) {
  const canGroups = can(useMe(), 'action.groups_edit', 2) // 그룹 저장·편집·삭제
  const [rows, , refreshRows] = usePoll(api.channels, 10000)
  const [gws] = usePoll(api.gateways, 15000)
  const [groups, , refreshGroups] = usePoll(api.groups, 10000)
  const [staff, setStaff] = useState(new Map())
  const [kind, setKind] = useState(() => (KINDS.some(([k]) => k === pref('viewers.kind', 'ward')) ? pref('viewers.kind', 'ward') : 'ward'))
  const [tpl, setTpl] = useState(() => pref('viewers.tpl', TEMPLATES[0].id))
  const [val, setVal] = useState(null) // ② 고른 하위 대상 키 (null = 전체)
  const [sub, setSub] = useState(null) // ② 하위 대상 안에서 더 좁힌 키
  const [sel, setSel] = useState(() => new Set()) // ③ 체크한 환자(패치 id)
  // 그룹 만들기 패널
  const [members, setMembers] = useState([]) // 담긴 패치 id (순서 유지)
  const [editing, setEditing] = useState(null) // 편집 중인 저장 그룹 (null = 새 그룹)
  const [name, setName] = useState(null) // null = 기본 이름("새 그룹 N")
  const [over, setOver] = useState(false) // 끌어서 패널 위에 있음
  const [dragN, setDragN] = useState(0) // 끌고 있는 환자 수 (0 = 끌기 아님)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const toastT = useRef(null)
  const notify = (msg) => { setToast(msg); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(''), 2600) }
  useEffect(() => () => clearTimeout(toastT.current), [])
  useEffect(() => { try { localStorage.setItem('viewers.kind', kind); localStorage.setItem('viewers.tpl', tpl) } catch { /* ignore */ } }, [kind, tpl])
  useEffect(() => { api.staff().then((d) => setStaff(new Map((d?.staff || []).map((s) => [s.id, s])))).catch(() => {}) }, [])
  useEffect(() => { setVal(null); setSub(null); setSel(new Set()) }, [kind])

  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const byId = useMemo(() => new Map((rows || []).map((r) => [String(r.channel_id), r])), [rows])
  const mobile = useMemo(() => new Set((gws || []).filter(isMobileGw).map((g) => String(g.gw_id))), [gws])
  const alarmIds = useMemo(() => new Set((alarms?.alarms || []).map((a) => String(a.channel_id))), [alarms])
  // 채널별 가장 높은 심각도 (critical 3 · high 2 · medium 1 · low 0)
  const alarmSev = useMemo(() => {
    const rank = { critical: 3, high: 2, medium: 1, low: 0 }
    const m = new Map()
    for (const a of alarms?.alarms || []) { const id = String(a.channel_id); const r = rank[a.severity] ?? 0; if ((m.get(id) ?? -1) < r) m.set(id, r) }
    return m
  }, [alarms])
  const sevOf = (id) => alarmSev.get(String(id))
  // 열어 둔 뷰어 탭 (key → window): 닫혔는지 5초마다 확인해 상단 카운터를 갱신
  const wins = useRef(new Map())
  const [, tickOpen] = useState(0)
  useEffect(() => { const t = setInterval(() => { let changed = false; for (const [k, w] of wins.current) if (!w || w.closed) { wins.current.delete(k); changed = true } if (changed) tickOpen((n) => n + 1) }, 5000); return () => clearInterval(t) }, [])
  const openTabs = [...wins.current.values()].filter((w) => w && !w.closed).length
  const staffLabel = (id) => { const s = staff.get(id); return s ? `${s.name} (${id})` : id }
  const staffSub = (id) => { const s = staff.get(id); return s ? [s.title, s.specialty, s.ward && `병동 ${s.ward}`].filter(Boolean).join(' · ') : '' }

  // ② one entry per distinct value of the chosen category, with connected-patient and alarm counts and member patch ids
  const entries = useMemo(() => {
    const m = new Map()
    const add = (key, r, label, sub) => {
      if (!key) return
      if (!m.has(key)) m.set(key, { key, label: label || key, sub: sub || '', count: 0, alarms: 0, sev: -1, gws: new Set(), mobile: 0, members: [] })
      const e = m.get(key); const id = String(r.channel_id)
      e.count++; e.members.push(id); if (alarmIds.has(id)) { e.alarms++; e.sev = Math.max(e.sev, alarmSev.get(id) ?? 0) } if (r.gateway_id) { e.gws.add(r.gateway_id); if (mobile.has(r.gateway_id)) e.mobile++ }
    }
    if (BOOL_KIND[kind]) {
      const { test, all } = BOOL_KIND[kind]
      const hits = live.filter((r) => test(r, mobile))
      for (const r of hits) {
        const p = r.patient || {}
        if (p.ward) { add(' ' + p.ward, r, wardText(p.ward), [p.building, p.floor && `${p.floor}F`].filter(Boolean).join(' ')); continue }
        // outside the wards (MCOT): group by the patient's home region when the EMR provides it
        if (p.home_region) { add(' ' + p.home_region, r, `외부 · ${p.home_region}`, '집주소 지역'); m.get(' ' + p.home_region).region = p.home_region; continue }
        add(' 기타', r, '병동 외부', '집주소 정보 없음')
        const e = m.get(' 기타'); (e.ids = e.ids || []).push(String(r.channel_id)) // nothing to scope by: open by patch ids
      }
      const v = [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'))
      const hitIds = hits.map((r) => String(r.channel_id))
      const total = { key: '', label: all, sub: `${m.size}개 병동`, count: hits.length, alarms: hitIds.filter((id) => alarmIds.has(id)).length, sev: Math.max(-1, ...hitIds.map((id) => alarmSev.get(id) ?? -1)), gws: new Set(hits.map((r) => r.gateway_id).filter(Boolean)), mobile: hits.filter((r) => mobile.has(r.gateway_id)).length, members: hitIds }
      return [total, ...v.map((e) => ({ ...e, key: e.key.trim() }))]
    }
    for (const r of live) {
      const p = r.patient || {}
      if (kind === 'ward') add(p.ward, r, wardText(p.ward), [p.building, p.floor && `${p.floor}F`].filter(Boolean).join(' '))
      else if (kind === 'room') {
        // 입원 병실 + (다르면) 지금 있는 공간 — 검사실·투석실 같은 비병실 공간도 목록에 나온다
        add(p.room || r.space, r, roomText(p.room || r.space), '')
        if (isAway(p, r.space)) add(r.space, r, r.space, '현재 위치')
      }
      else if (kind === 'doctor') add(p.doctor, r, staffLabel(p.doctor), staffSub(p.doctor))
      else if (kind === 'nurse') add(p.nurse, r, staffLabel(p.nurse), staffSub(p.nurse))
      else if (kind === 'department') add(p.department, r)
      else if (kind === 'diagnosis') add(p.diagnosis, r)
      else if (kind === 'gw') { const g = (gws || []).find((x) => String(x.gw_id) === r.gateway_id); add(r.gateway_id, r, `#${r.gateway_id}${g?.name ? ' ' + gwLabel(g.name) : ''}`, g ? [g.location?.building, g.location?.room, g.type].filter(Boolean).join(' · ') : '') }
    }
    const v = [...m.values()]
    if (kind === 'gw') v.sort((a, b) => Number(a.key) - Number(b.key))
    else v.sort((a, b) => a.label.localeCompare(b.label, 'ko'))
    return v
  }, [kind, live, gws, staff, alarmIds, alarmSev, mobile])
  const kindCounts = useMemo(() => {
    const c = {}
    for (const [k] of KINDS) {
      if (BOOL_KIND[k]) { c[k] = live.filter((r) => BOOL_KIND[k].test(r, mobile)).length; continue }
      const s = new Set()
      for (const r of live) { const p = r.patient || {}; const v = k === 'gw' ? r.gateway_id : k === 'room' ? (p.room || r.space) : p[k]; if (v) s.add(v); if (k === 'room' && isAway(p, r.space)) s.add(r.space) }
      c[k] = s.size
    }
    return c
  }, [live, mobile])

  const kindLabel = KINDS.find(([k]) => k === kind)[1]
  const tplObj = TEMPLATES.find((t) => t.id === tpl) || TEMPLATES[0]
  const tplName = shortTpl(tplObj)
  const picked = val != null ? entries.find((e) => e.key === val) || null : null
  // 하위 대상 안의 2단계: 병실 → 없음, 병동(·페이스메이커·MCOT) → 병실, 그 밖(담당의·게이트웨이 등) → 병동
  const hasSub = kind !== 'room'
  const subOf = (r) => (kind === 'ward' || BOOL_KIND[kind] ? (r.patient?.room || r.space || '') : (r.patient?.ward || ''))
  const subLabel = (k) => (!k ? '기타' : kind === 'ward' || BOOL_KIND[kind] ? roomOnly(k) : wardText(k))
  const subs = useMemo(() => {
    if (!picked || !hasSub) return []
    const m = new Map()
    for (const id of picked.members) { const r = byId.get(id); if (!r) continue; const k = subOf(r); if (!m.has(k)) m.set(k, { key: k, label: subLabel(k), ids: [] }); m.get(k).ids.push(id) }
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko'))
  }, [picked, hasSub, byId, kind]) // eslint-disable-line react-hooks/exhaustive-deps
  // ③ 세부 대상: 고른 값(·좁힌 값)의 환자, 아무것도 안 골랐으면 연결된 환자 전체
  const shown = useMemo(() => {
    let list = picked ? picked.members.map((id) => byId.get(id)).filter(Boolean) : live
    if (picked && hasSub && sub != null) list = list.filter((r) => subOf(r) === sub)
    const k = (r) => `${r.patient?.ward || '~'} ${r.patient?.room || r.space || '~'} ${r.patient?.name || ''}`
    return [...list].sort((a, b) => k(a).localeCompare(k(b), 'ko'))
  }, [picked, sub, hasSub, live, byId, kind]) // eslint-disable-line react-hooks/exhaustive-deps
  const crumb = picked ? `${picked.label}${hasSub && sub != null ? ' › ' + subLabel(sub) : ''}` : `${kindLabel} 전체`
  const crumbLast = picked ? (hasSub && sub != null ? `${picked.label} ${subLabel(sub)}` : picked.label) : `${kindLabel} 전체`
  const shownIds = shown.map((r) => String(r.channel_id))
  const selIds = shownIds.filter((id) => sel.has(id))
  const memberSet = useMemo(() => new Set(members), [members])

  // ---- 열기 ----
  const launch = (url, k) => {
    const w = wins.current.get(k)
    if (w && !w.closed) { try { w.focus() } catch { /* ignore */ } return }
    // noopener 를 빼야 핸들을 쥐고 열린 탭 수를 셀 수 있다 (같은 출처의 우리 뷰어 탭이라 위험 없음)
    const nw = window.open(url, '_blank')
    if (nw) { wins.current.set(k, nw); tickOpen((n) => n + 1) }
  }
  const said = (label, n) => notify(`새 탭에서 열림 · ${label} · ${n.toLocaleString()}명 · ${tplName}`)
  // ② 하위 대상 한 행: 범위 값으로 연다 (뷰어 URL 은 병동/게이트웨이 등 범위 값을 하나 받는다)
  const openEntry = (e) => {
    const label = BOOL_KIND[kind] ? (e.key ? `${kindLabel} · ${e.label}` : e.label) : `${kindLabel} ${e.label}`
    launch(viewerUrl({ tpl, ...(BOOL_KIND[kind]?.scope || {}), ...(e.ids ? { ids: e.ids } : e.region ? { region: e.region } : { [SCOPE_KEY[kind]]: e.key }), label }), `${kind}:${e.key}:${tpl}`)
    said(label, e.count)
  }
  // 환자 id 목록으로 연다 (부분 집합·선택·그룹 후보)
  const openIds = (label, ids) => {
    const u = [...new Set(ids)]
    if (!u.length) { window.alert('열 환자가 없습니다.') ; return }
    launch(viewerUrl({ tpl, ids: u, label }), `ids:${[...u].sort().join(',')}:${tpl}`)
    said(label, u.length)
  }
  const openGroup = (g) => { launch(viewerUrl({ tpl, group: g.id, label: g.name }), `group:${g.id}:${tpl}`); said(g.name, groupCount(g)) }
  const overMax = (n) => (tplObj.maxRows && n > tplObj.maxRows ? ` (템플릿 최대 ${tplObj.maxRows}명)` : '')

  // ---- 끌어 놓기 (HTML5 drag: text/plain = 패치 id 목록) ----
  const startDrag = (ids, ev) => { ev.dataTransfer.setData('text/plain', ids.join(',')); ev.dataTransfer.effectAllowed = 'copy'; setDragN(ids.length) }
  const endDrag = () => { setDragN(0); setOver(false) }
  const addMembers = (ids) => {
    setMembers((o) => { const s = new Set(o); const n = [...o]; for (const id of ids) if (id && !s.has(id)) { s.add(id); n.push(id) } return n })
    setSel(new Set())
  }
  const onDragOver = (ev) => { if (!canGroups) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; if (!over) setOver(true) }
  const onDragLeave = (ev) => { if (ev.currentTarget.contains(ev.relatedTarget)) return; setOver(false) }
  const onDrop = (ev) => {
    ev.preventDefault(); setOver(false); setDragN(0)
    if (!canGroups) return
    const ids = (ev.dataTransfer.getData('text/plain') || '').split(',').map((x) => x.trim()).filter(Boolean)
    if (ids.length) { addMembers(ids); notify(`${ids.length}명 담음`) }
  }

  // ---- 저장된 그룹 · 그룹 만들기 ----
  const groupMembers = (g) => { const s = new Set(live.filter((r) => (r.groups || []).includes(g.id)).map((r) => String(r.channel_id))); for (const id of g.include || []) s.add(String(id)); return [...s] }
  const groupCount = (g) => (g.id === 'all' ? live.length : groupMembers(g).length)
  const defaultName = `새 그룹 ${(groups || []).length + 1}`
  const nameShown = name == null ? defaultName : name
  const modeLabel = editing ? `편집 중 · ${editing.name}` : '새 그룹'
  const editGroup = (g) => { setEditing(g); setName(g.name); setMembers(groupMembers(g)); setSel(new Set()) }
  const clearBuilder = () => { setMembers([]); setEditing(null); setName(null) }
  const who = (id) => { const r = byId.get(id); const p = r?.patient || {}; return { name: p.name || r?.mrn || `패치 ${id}`, place: [wardText(p.ward), roomOnly(p.room || r?.space)].filter(Boolean).join(' '), off: !!r && !r.connected, unknown: !r } }
  const mix = useMemo(() => { const m = new Map(); for (const id of members) { const p = byId.get(id)?.patient; const w = p?.ward ? wardText(p.ward) : '기타'; m.set(w, (m.get(w) || 0) + 1) } return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko')) }, [members, byId])
  const save = async (andOpen) => {
    if (!canGroups || !members.length || busy) return
    const nm = nameShown.trim() || defaultName
    const body = editing
      ? { ...editing, name: nm, criteria: editing.criteria || {}, include: members, exclude: editing.exclude || [] }
      : { id: 'g-' + Date.now().toString(36), name: nm, description: '', owner: '', criteria: {}, include: members, exclude: [] }
    setBusy(true)
    try {
      if (editing) await api.updateGroup(editing.id, body); else await api.createGroup(body)
      refreshGroups?.(); setTimeout(() => refreshRows?.(), 1200)
      notify(`그룹 저장됨 · ${nm} · ${members.length}명`)
      if (andOpen) { launch(viewerUrl({ tpl, ids: members, label: nm }), `group:${body.id}:${tpl}`) }
      clearBuilder()
    } catch (e) { window.alert('저장 실패: ' + e.message) } finally { setBusy(false) }
  }
  const removeGroup = async (g) => {
    if (!window.confirm(`그룹 "${g.name}" 을(를) 삭제할까요?`)) return
    try { await api.deleteGroup(g.id); refreshGroups?.(); setTimeout(() => refreshRows?.(), 1200); if (editing?.id === g.id) clearBuilder(); notify(`그룹 삭제됨 · ${g.name}`) } catch (e) { window.alert('삭제 실패: ' + e.message) }
  }
  const toggleSel = (id) => setSel((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const dropText = over ? (dragN ? `놓으면 ${dragN}명 담기` : '여기에 놓아 담기') : dragN ? '여기에 놓아 담기' : members.length ? '여기에 더 놓기' : '하위 대상(병동·병실 등)을 통째로, 또는 세부 대상(환자)을 끌어 놓으세요'

  return (
    <div className="page vw" onDragEnd={endDrag}>
      <div className="vw-head">
        <h2 className="h">뷰어</h2>
        <span className="vw-how">
          <span><b>바로 열기</b> — 목록 옆 <i>열기</i>, 그룹 없이 즉시 파형</span>
          <em>또는</em>
          <span><b>그룹으로 열기</b> — 오른쪽으로 끌어 저장 후 열기</span>
        </span>
        <span className="spacer" />
        <span className="vw-tplsel" title="모든 '열기' 버튼이 쓰는 템플릿">
          <span className="muted">열기 템플릿</span>
          <span className="seg">{TEMPLATES.map((t) => <button key={t.id} className={tpl === t.id ? 'active' : ''} onClick={() => setTpl(t.id)} title={`${t.audience || ''}${t.maxRows ? ` · 최대 ${t.maxRows}명` : ''}`}>{shortTpl(t)}</button>)}</span>
        </span>
        <span className={'pill ' + (openTabs ? 'ok' : '')} title="이 콘솔에서 연 뷰어 탭 (닫히면 5초 안에 줄어듭니다)">열린 뷰어 탭 <b>{openTabs}</b></span>
      </div>

      <div className="vw-launch">
        {/* ① 그룹 기준 */}
        <aside className="vw-col" aria-label="그룹 기준">
          <div className="vw-colh"><span className="vw-n">1</span><h4>그룹 기준</h4></div>
          {KIND_GROUPS.map(([title, keys]) => (
            <div key={title} className="vw-kgrp">
              <div className="vw-klabel">{title}</div>
              {keys.map((k) => { const l = KINDS.find(([x]) => x === k)[1]; return (
                <button key={k} className={'vw-kind' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
                  <span>{l}</span><b className="mono">{(kindCounts[k] ?? 0).toLocaleString()}</b>
                </button>) })}
            </div>
          ))}
        </aside>

        {/* ② 하위 대상 */}
        <section className="vw-col" aria-label="하위 대상">
          <div className="vw-colh"><span className="vw-n">2</span><h4>{kindLabel} · 하위 대상</h4><small className="muted">{entries.length.toLocaleString()}개</small></div>
          <div className="vw-hint muted">클릭: 좁히기 · 끌기: 통째로 그룹에</div>
          <div className="vw-list">
            {entries.map((e) => {
              const on = val === e.key
              return (
                <React.Fragment key={e.key || '*'}>
                  <div className={'vw-val' + (on && sub == null ? ' on' : '') + (on ? ' open' : '') + (e.alarms ? (e.sev >= 2 ? ' has-crit' : ' has-alarm') : '')} draggable={canGroups} onDragStart={(ev) => startDrag(e.members, ev)}
                    onClick={() => { setVal(on ? null : e.key); setSub(null); setSel(new Set()) }} title={canGroups ? '끌어서 그룹에 담기' : undefined}>
                    <span className="vw-grip" aria-hidden>⋮⋮</span>
                    <span className="vw-vname"><b>{e.label}</b>{e.sub && <small className="muted">{e.sub}</small>}</span>
                    {e.alarms > 0 && <Pill tone={e.sev >= 3 ? 'crit' : e.sev === 2 ? 'high' : 'med'} title="알람 있는 환자">{e.alarms}</Pill>}
                    <b className="vw-cnt mono">{e.count.toLocaleString()}</b>
                    <button className="vw-open" onClick={(ev) => { ev.stopPropagation(); openEntry(e) }} title={`${tplName} 으로 바로 열기${overMax(e.count)}`}>열기</button>
                  </div>
                  {on && subs.map((s) => {
                    const son = sub === s.key
                    return (
                      <div key={s.key || '~'} className={'vw-val sub' + (son ? ' on' : '')} draggable={canGroups} onDragStart={(ev) => { ev.stopPropagation(); startDrag(s.ids, ev) }}
                        onClick={(ev) => { ev.stopPropagation(); setSub(son ? null : s.key); setSel(new Set()) }}>
                        <span className="vw-grip" aria-hidden>⋮⋮</span>
                        <span className="vw-vname">└ {s.label}</span>
                        <b className="vw-cnt mono">{s.ids.length.toLocaleString()}</b>
                        <button className="vw-open" onClick={(ev) => { ev.stopPropagation(); openIds(`${e.label} ${s.label}`, s.ids) }} title={`${tplName} 으로 바로 열기`}>열기</button>
                      </div>
                    )
                  })}
                </React.Fragment>
              )
            })}
            {!entries.length && <div className="vw-empty muted">표시할 항목이 없습니다. 환자 연결 상태를 먼저 확인하세요.</div>}
          </div>
        </section>

        {/* ③ 세부 대상 */}
        <section className="vw-col" aria-label="세부 대상">
          <div className="vw-colh"><span className="vw-n">3</span><h4>세부 대상 <span className="mono">{shown.length.toLocaleString()}</span>명</h4><span className="spacer" />
            <button onClick={() => openIds(crumbLast, shownIds)} disabled={!shown.length} title={`${tplName} 으로 바로 열기${overMax(shown.length)}`}>이 목록 바로 열기</button>
          </div>
          <div className="vw-crumb"><span className="muted">{crumb}</span></div>
          <div className="vw-list">
            {shown.map((r) => {
              const id = String(r.channel_id); const p = r.patient || {}
              const on = sel.has(id); const sv = sevOf(id); const added = memberSet.has(id)
              return (
                <div key={id} className={'vw-pt' + (on ? ' on' : '') + (added ? ' added' : '')} draggable={canGroups} onDragStart={(ev) => startDrag(on && selIds.length > 1 ? selIds : [id], ev)} onClick={() => toggleSel(id)}
                  title={canGroups ? (on && selIds.length > 1 ? `선택 ${selIds.length}명 끌어서 그룹에 담기` : '끌어서 그룹에 담기') : undefined}>
                  <span className="vw-grip" aria-hidden>⋮⋮</span>
                  <input type="checkbox" checked={on} onChange={() => toggleSel(id)} onClick={(ev) => ev.stopPropagation()} aria-label={`${p.name || id} 선택`} />
                  <span className="vw-pname"><b>{p.name || r.mrn || id}</b><small className="muted">{[wardText(p.ward), roomOnly(p.room || r.space), isAway(p, r.space) && `현재 ${r.space}`].filter(Boolean).join(' ')}</small></span>
                  {added && <span className="lk-pill vw-added" title="그룹 만들기에 담겨 있음">담김</span>}
                  {sv != null && <Pill tone={SEV[sv][1]}>{SEV[sv][0]}</Pill>}
                  <button className="vw-open" onClick={(ev) => { ev.stopPropagation(); openIds(p.name || id, [id]) }} title={`${tplName} 으로 바로 열기`}>열기</button>
                </div>
              )
            })}
            {!shown.length && <div className="vw-empty muted">환자가 없습니다.</div>}
          </div>
          <div className="vw-foot">
            <span className="muted">선택 <b>{selIds.length}</b>명</span>
            {selIds.length && selIds.length === shownIds.length
              ? <button className="ghost small" onClick={() => setSel(new Set())} title="선택 해제">해제</button>
              : <button className="ghost small" onClick={() => setSel(new Set(shownIds))} disabled={!shown.length} title="목록 전체 선택">모두 선택</button>}
            <span className="spacer" />
            <button disabled={!selIds.length} onClick={() => openIds('선택 환자', selIds)} title={`${tplName} 으로 바로 열기${overMax(selIds.length)}`}>선택 바로 열기</button>
            <button className="primary" disabled={!selIds.length || !canGroups} onClick={() => { addMembers(selIds); notify(`${selIds.length}명 담음`) }} title={canGroups ? '그룹 만들기에 담기' : '그룹 편집 권한 없음'}>그룹에 담기 →</button>
          </div>
        </section>

        {/* 저장된 그룹 · 그룹 만들기 */}
        <aside className="vw-right" aria-label="그룹">
          <section className="vw-col">
            <div className="vw-colh"><h4>저장된 그룹 <span className="mono">{(groups || []).length}</span></h4></div>
            <div className="vw-list saved">
              {(groups || []).map((g, i) => (
                <div key={g.id} className={'vw-saved' + (editing?.id === g.id ? ' on' : '')}>
                  <i className="vw-dot" style={{ background: `hsl(${(i * 47) % 360} 60% 55%)` }} />
                  <span className="vw-vname"><b>{g.name}</b><small className="muted">{describeGroup(g)}</small></span>
                  <b className="vw-cnt mono">{groupCount(g).toLocaleString()}명</b>
                  {canGroups && g.id !== 'all' && <button className="ghost" onClick={() => editGroup(g)}>편집</button>}
                  <button className="vw-open" onClick={() => openGroup(g)} title={`${tplName} 으로 열기`}>열기</button>
                </div>
              ))}
              {!(groups || []).length && <div className="vw-empty muted">저장된 그룹이 없습니다. 아래에서 만드세요.</div>}
            </div>
          </section>

          <section className={'vw-col vw-builder' + (over ? ' hot' : '') + (dragN ? ' dragging' : '')} onDragOver={onDragOver} onDragEnter={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} aria-label="그룹 만들기">
            <div className="vw-colh"><h4>그룹 만들기</h4><small className={'vw-mode' + (editing ? ' edit' : '')}>{modeLabel}</small></div>
            {!canGroups && <div className="vw-hint warn">읽기 전용 — 그룹 저장·편집 권한(action.groups_edit)이 없습니다. 바로 열기는 쓸 수 있습니다.</div>}
            <div className="vw-name">
              <input value={nameShown} onChange={(e) => setName(e.target.value)} placeholder="그룹 이름" disabled={!canGroups} aria-label="그룹 이름" />
              <b className="mono">{members.length.toLocaleString()}</b><span className="muted">명</span>
            </div>
            <div className="vw-mix">
              <span className="muted">구성</span>
              {mix.length ? mix.map(([w, n]) => <span key={w} className="lk-pill">{w} <b>{n}</b></span>) : <span className="muted">아직 비어 있음</span>}
            </div>
            {editing && Object.keys(editing.criteria || {}).length > 0 && <div className="vw-hint muted">속성 조건({describeGroup({ criteria: editing.criteria })})에 맞는 환자도 자동 포함됩니다.</div>}
            {members.length > 0 && (
              <div className="vw-list members">
                {members.map((id) => { const w = who(id); const sv = sevOf(id); return (
                  <div key={id} className="vw-mem">
                    <i className={'vw-dot sev' + (sv ?? -1)} />
                    <span className="vw-vname"><b>{w.name}</b><small className="muted">{w.place}{w.off ? ' · 해제' : ''}{w.unknown ? ' · 목록에 없음' : ''}</small></span>
                    <button className="ghost vw-x" onClick={() => setMembers((o) => o.filter((x) => x !== id))} disabled={!canGroups} title="빼기">×</button>
                  </div>) })}
              </div>
            )}
            <div className={'vw-drop' + (members.length ? '' : ' big')}>
              <b>{dropText}</b>
              {!members.length && !dragN && <small className="muted">②의 행(병동·병실·담당의 …)이나 ③의 환자를 끌어 놓거나, 체크 후 "그룹에 담기 →"</small>}
            </div>
            <div className="vw-foot">
              {editing && canGroups && <button className="ghost danger" onClick={() => removeGroup(editing)} disabled={busy}>삭제</button>}
              <button className="ghost" onClick={clearBuilder} disabled={!members.length && !editing}>비우기</button>
              <span className="spacer" />
              <button onClick={() => save(false)} disabled={!members.length || !canGroups || busy}>그룹 저장</button>
              <button className="primary" onClick={() => save(true)} disabled={!members.length || !canGroups || busy} title={`저장 후 ${tplName} 으로 열기${overMax(members.length)}`}>저장하고 열기</button>
            </div>
          </section>
        </aside>
      </div>
      {toast && <div className="vw-toast" role="status">{toast}</div>}
    </div>
  )
}

const CRIT_LABEL = { building: '건물', floor: '층', ward: '병동', zone: '구역', room: '병실', doctor: '담당의', department: '진료과', nurse: '간호사', diagnosis: '주진단' }
function describeGroup(g) {
  if (!g) return ''
  const parts = Object.entries(g.criteria || {}).map(([k, v]) => `${CRIT_LABEL[k] || k}: ${[].concat(v).join('/')}`)
  if (g.include?.length) parts.push(`환자 ${g.include.length}명 지정`)
  if (g.exclude?.length) parts.push(`제외 ${g.exclude.length}명`)
  return parts.length ? parts.join(' · ') : (g.id === 'all' ? '모든 환자' : '조건 없음')
}
