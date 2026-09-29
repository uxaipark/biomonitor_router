import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtAgo, fmtTime } from '../api.js'
import { alarmIndex, flagNames, sortBy, SEV_LABEL, SEV_ORDER, FLAG_LABEL, FLAG_WARN, wardText, wardRoom, patchLife, fmtDays, nowPlace, spaceName, isAway } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'
import Trips from './Trips.jsx'
import { getStream } from '../waveStore.js'
import { claimLive, releaseLive } from '../ws.js'
import {
  useQuery, go, useRevealSelected, Cols, tableMin, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, GwLink, RoomLink, WardLink,
  TwoLine, Dot, Pill, Spark, GroupRow, useDensity, DensityToggle, RowActions, Ago, ago, TONE,
} from '../ListKit.jsx'

/**
 * 환자 목록 (2026-09-28 재설계): 요약 칩 → 필터 줄 → 표(상태 점 · 환자 두 줄 · 수치 4개 · ECG 미니 · 배터리/교체 · 알람 배지 · 행 끝 동작)
 * → 오른쪽 상세. 임계를 벗어난 수치만 색이 들어오고, 병동 묶음 헤더로 자기 구역을 바로 찾는다. 조건은 주소에 남는다.
 */
// 표 열 — [정렬 키, 머리글, 폭 px(null = 남는 폭), 숫자 열]
const COLS = [
  ['state', '', 26], ['name', '환자', 190], ['room', '병실', 128],
  ['hr', 'HR', 54, true], ['spo2', 'SpO₂', 56, true], ['resp', 'RR', 46, true], ['temp', '체온', 56, true],
  ['ecg', 'ECG (10초)', 112], ['battery', '배터리', 78, true], ['rssi', 'RSSI', 54, true],
  ['alarm', '알람', 132], ['gateway_id', '게이트웨이', 124], ['last', '마지막', 84], ['acts', '', 128],
]
const W = COLS.map((c) => c[2])
const PAGE = 100
const TONE_ORDER = ['low', 'medium', 'high', 'critical']
// 요약 칩 = 상태 · 조치가 필요한 조건 (누르면 그 조건만)
const CHIPS = [
  ['live', '수신 중', (r) => r.connected && !r.stale, 'c-ok'],
  ['stale', '무신호·해제', (r) => r.stale || !r.connected, 'c-warn'],
  ['alarm', '알람 있음', (r) => r.alarm, 'c-err'],
  ['leadoff', '전극 탈락', (r) => r.flags & 0x01, 'c-warn'],
  ['lowbat', '배터리 부족', (r) => r.flags & 0x04 || (r.battery > 0 && r.battery <= 15), 'c-warn'],
  ['replace', '패치 교체 1일 이내', (r) => r.replace != null && r.replace <= 1, 'c-warn'],
  ['away', '병실 밖·이동 중', (r) => r.away, ''],
]
const SORTS = [
  ['alarm', '알람 → 병실'], ['room', '병실'], ['name', '이름'], ['hr', 'HR 높은 순'], ['spo2', 'SpO₂ 낮은 순'], ['battery', '배터리 낮은 순'], ['replace', '패치 교체 임박'], ['last', '마지막 수신'],
]
const SORT_DIR = { alarm: 'desc', hr: 'desc', spo2: 'asc', battery: 'asc', replace: 'asc', last: 'desc', room: 'asc', name: 'asc' }
const SEX = { M: '남', F: '여' }
const ageOf = (birth) => { const y = +(String(birth || '').slice(0, 4)); return y > 1900 ? new Date().getFullYear() - y : null }

// 수치 색: 임계 밖만. (알람 규칙과 별개인 표시용 기본값 — HR <40|>150 위험, SpO₂ <88 위험 <92 주의, RR >30 주의, 체온 ≥38 주의)
const vc = (k, v) => {
  if (v == null) return 'v dim'
  if (k === 'hr') return v < 40 || v > 150 ? 'v bad' : v > 120 ? 'v warnv' : 'v'
  if (k === 'spo2') return v < 88 ? 'v bad' : v < 92 ? 'v warnv' : 'v'
  if (k === 'resp') return v > 30 || v < 8 ? 'v warnv' : 'v'
  if (k === 'temp') return v >= 39 ? 'v bad' : v >= 38 ? 'v warnv' : 'v'
  return 'v'
}

/** ECG 링(구독 중인 채널만 있다)에서 최근 10초를 96개 점으로 — 구독이 없으면 null */
function ecgPoints(channelId, n = 96, spanMs = 10000) {
  const ring = getStream(`${channelId}:ecg`)
  if (!ring || ring.len < 2) return null
  const last = ring.tAt(ring.len - 1)
  const from = last - spanMs
  let start = 0
  while (start < ring.len - 1 && ring.tAt(start) < from) start++
  const count = ring.len - start
  if (count < 2) return null
  const out = []
  const stride = Math.max(1, Math.floor(count / n))
  // 각 구간의 최대·최소를 번갈아 두어 R파가 사라지지 않게 (병상 모니터 방식)
  for (let i = start; i < ring.len; i += stride) {
    let mn = Infinity, mx = -Infinity
    for (let j = i; j < Math.min(ring.len, i + stride); j++) { const v = ring.vAt(j); if (v < mn) mn = v; if (v > mx) mx = v }
    out.push(mx, mn)
  }
  // Spark 는 0 을 바닥으로 그리므로 최소값을 0 으로 옮긴다
  const lo = Math.min(...out)
  return out.map((v) => v - lo)
}

/** 환자 목록: 요약 칩 · 병동/담당의/검색 필터(주소에 남음) · 표(병동 묶음) · 오른쪽 환자 상세 */
export default function Patients({ alarms }) {
  const [rows] = usePoll(api.channels, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', ward = qs.get('ward') || '', chip = qs.get('f') || '', sel = qs.get('sel') || '', doctor = qs.get('doc') || ''
  const [sort, setSort] = useState(['alarm', 'desc'])
  const [page, setPage] = useState(0)
  const [density, setDensity] = useDensity('patients')
  const [groupPref, setGroupPref] = useState(() => { try { return localStorage.getItem('lk.patients.group') !== '0' } catch { return true } })
  const setGroup = (v) => { setGroupPref(v); try { localStorage.setItem('lk.patients.group', v ? '1' : '0') } catch { /* ignore */ } }
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  // 채널별 활성 알람 수 (배지의 숫자)
  const acount = useMemo(() => { const m = new Map(); for (const a of alarms?.alarms || []) if (a.channel_id) m.set(a.channel_id, (m.get(a.channel_id) || 0) + 1); return m }, [alarms])
  const now = Date.now()

  const flat = useMemo(() => (rows || []).map((r) => {
    const p = r.patient || {}
    const al = aidx.get(r.channel_id)
    const life = patchLife(r, r.battery)
    return {
      ...r, name: p.name || '', ward: p.ward || '', room: p.room || r.space || '', doctor: p.doctor, nurse: p.nurse,
      life, replace: life?.left ?? null, away: isAway(p, r.space),
      hr: r.vitals?.hr ?? null, spo2: r.vitals?.spo2 ?? null, resp: r.vitals?.resp ?? null, temp: r.vitals?.temp ?? null,
      alarm: al ? (SEV_ORDER[al.severity] ?? 0) + 1 : 0, alarmObj: al, alarmN: acount.get(r.channel_id) || 0, last: r.last_ts_ms,
      state: r.connected && !r.stale ? 2 : r.connected ? 1 : 0,
    }
  }), [rows, aidx, acount])
  const wards = useMemo(() => {
    const c = new Map(), bld = new Map()
    for (const r of flat) if (r.ward) { c.set(r.ward, (c.get(r.ward) || 0) + 1); bld.set(r.ward, r.patient?.building) }
    return [{ value: '', label: '모든 병동', count: flat.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([w, n]) => ({ value: w, label: `${bld.get(w) || ''} ${wardText(w)}`.trim(), count: n }))]
  }, [flat])
  const doctors = useMemo(() => {
    const c = new Map()
    for (const r of flat) if (r.doctor) c.set(r.doctor, (c.get(r.doctor) || 0) + 1)
    return [{ value: '', label: '모든 담당의', count: flat.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([d, n]) => ({ value: d, label: d, count: n }))]
  }, [flat])
  const inWard = useMemo(() => flat.filter((r) => (!ward || r.ward === ward) && (!doctor || r.doctor === doctor)), [flat, ward, doctor])
  const chips = useMemo(() => [{ key: 'all', label: '전체', count: inWard.length }, ...CHIPS.map(([k, l, f, cls]) => ({ key: k, label: l, count: inWard.filter(f).length, cls }))], [inWard])
  // 병동 묶음: 병동 필터가 없을 때만 의미가 있다
  const grouped = groupPref && !ward
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = inWard.filter((r) => !needle || [r.channel_id, r.name, r.mrn, r.room, r.gateway_id, String(r.patient_id), r.doctor].some((x) => String(x || '').toLowerCase().includes(needle)))
    const c = CHIPS.find(([k]) => k === chip)
    if (c) v = v.filter(c[2])
    const key = sort[0] === 'channel_id' ? (r) => Number(r.channel_id) : sort[0] === 'state' ? (r) => r.state : sort[0]
    v = sortBy(v, key, sort[1])
    if (sort[0] === 'alarm') v = [...v].sort((a, b) => (b.alarm - a.alarm) || String(a.room).localeCompare(String(b.room), 'ko'))
    // 묶음일 때는 병동 순으로 안정 정렬 → 병동 안에서는 고른 정렬 유지
    if (grouped) v = [...v].sort((a, b) => String(a.ward).localeCompare(String(b.ward), 'ko'))
    return v
  }, [inWard, q, chip, sort, grouped])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const slice = shown.slice(cur * PAGE, cur * PAGE + PAGE)
  // ECG(10초)는 스냅샷: 페이지가 뜨면 보이는 환자(최대 100명)를 한 번 구독해 두고, 각자 링에 10초가 다 모인 순간에만 찍는다
  // (덜 모인 채로 찍지 않는다 — 짧은 파형이 들어오던 원인). 모두 찍히거나 30초가 지나면 구독을 풀고 더는 갱신하지 않는다.
  // 스냅샷은 ref 에 두어 한 명이 찍힐 때마다 구독이 풀렸다 다시 걸리는 일(시한 초기화·흐름 끊김)이 없게 한다.
  const liveIds = slice.filter((r) => r.connected && !r.stale).map((r) => String(r.channel_id)).join(',')
  const snaps = useRef(new Map()) // channel_id → 점 배열 (한 번 찍으면 고정)
  const [, bump] = useState(0)
  const [gen, setGen] = useState(0)
  const refreshEcg = (ids) => { for (const id of ids) snaps.current.delete(String(id)); bump((x) => x + 1); setGen((g) => g + 1) } // 지우고 다시 찍는다
  useEffect(() => {
    const ids = liveIds ? liveIds.split(',').filter((id) => !snaps.current.has(id)) : []
    if (!ids.length) { releaseLive('patients'); return }
    claimLive('patients', ids)
    const t0 = Date.now(), pending = new Set(ids)
    const t = setInterval(() => {
      for (const id of [...pending]) {
        const ring = getStream(`${id}:ecg`)
        const span = ring && ring.len > 1 ? ring.tAt(ring.len - 1) - ring.tAt(0) : 0
        if (span >= 9800) { const pts = ecgPoints(id); if (pts) { snaps.current.set(id, pts); pending.delete(id) } }
      }
      bump((x) => x + 1)
      if (!pending.size || Date.now() - t0 > 30000) { clearInterval(t); releaseLive('patients') }
    }, 1000)
    return () => { clearInterval(t); releaseLive('patients') }
  }, [liveIds, gen])
  const wardStats = useMemo(() => { const m = new Map(); for (const r of shown) { const s = m.get(r.ward) || { n: 0, alarms: 0 }; s.n++; if (r.alarm) s.alarms++; m.set(r.ward, s) } return m }, [shown])
  const selRow = sel ? flat.find((r) => r.channel_id === sel) : null
  useRevealSelected(sel, shown, (r) => r.channel_id, PAGE, setPage)
  const applied = [
    ward && { key: 'ward', label: `병동: ${wardText(ward)}`, clear: () => setQs({ ward: '' }) },
    doctor && { key: 'doc', label: `담당의: ${doctor}`, clear: () => setQs({ doc: '' }) },
    chip && { key: 'f', label: CHIPS.find(([k]) => k === chip)?.[1] || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  const th = (k, label, num) => (
    <th key={k} onClick={() => k && k !== 'acts' && k !== 'ecg' && setSort([k, sort[0] === k && sort[1] === (SORT_DIR[k] || 'asc') ? (SORT_DIR[k] === 'desc' ? 'asc' : 'desc') : (SORT_DIR[k] || 'asc')])}
      className={(k && k !== 'acts' && k !== 'ecg' ? 'sortable' : '') + (num ? ' num' : '')} title={k && k !== 'acts' && k !== 'ecg' ? '누르면 정렬' : undefined}>
      {label}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  )
  const view = qs.get('view') || ''
  const bedIndex = useMemo(() => new Map(flat.filter((r) => r.patient?.bed).map((r) => [r.patient.bed, r])), [flat])
  const tabs = (
    <div className="toolbar lk-tabs">
      <span className="seg">
        <button className={view !== 'trips' ? 'active' : ''} onClick={() => setQs({ view: '' })}>전체 환자 {flat.length.toLocaleString()}</button>
        <button className={view === 'trips' ? 'active' : ''} onClick={() => setQs({ view: 'trips' })}>이동 중 환자 · 타임테이블</button>
      </span>
    </div>
  )
  if (view === 'trips') return <div className="page lk">{tabs}<Trips bedIndex={bedIndex} /></div>
  const first = shown.length ? cur * PAGE + 1 : 0, lastIdx = Math.min(shown.length, (cur + 1) * PAGE)

  let lastWard = null
  const rowsOut = []
  for (const r of slice) {
    if (grouped && r.ward !== lastWard) {
      lastWard = r.ward
      const st = wardStats.get(r.ward) || { n: 0, alarms: 0 }
      rowsOut.push(<GroupRow key={'g:' + (r.ward || '-')} colSpan={COLS.length}>{r.ward ? wardText(r.ward) : '병동 미지정'} · {st.n.toLocaleString()}명{st.alarms ? ` · 알람 ${st.alarms}` : ''}</GroupRow>)
    }
    const lost = r.stale || !r.connected
    const ecg = lost ? null : snaps.current.get(String(r.channel_id)) || null
    const age = ageOf(r.patient?.birth)
    const sub = [r.channel_id, [SEX[r.patient?.sex] || r.patient?.sex, age != null && `${age}`].filter(Boolean).join(' '), r.patient?.department].filter(Boolean).join(' · ')
    const flags = flagNames(r.flags).filter((n) => FLAG_WARN.has(n))
    rowsOut.push(
      <tr key={r.channel_id} className={'clickable ' + (r.alarmObj ? `sev-${r.alarmObj.severity}` : '') + (lost ? ' stale' : '') + (sel === r.channel_id ? ' selected' : '')}
        onClick={() => setQs({ sel: sel === r.channel_id ? '' : r.channel_id })} onDoubleClick={() => openLive(r.channel_id)} title="누르면 상세 · 두 번 누르면 실시간 파형">
        <td><Dot tone={!r.connected ? 'off' : r.stale ? 'warn' : 'ok'} title={!r.connected ? '해제' : r.stale ? '수신 지연' : '수신 중'} /></td>
        <td><TwoLine main={r.name || r.mrn || r.channel_id} sub={sub} /></td>
        <td title={r.away ? `입원 ${r.room} · 지금 ${spaceName(r.space)}` : r.room}>
          <TwoLine mono main={<RoomLink room={r.room}>{wardRoom(r.room)?.room || r.room || '—'}</RoomLink>}
            sub={<>{r.patient?.home_building && <span>{r.patient.home_building} </span>}{r.ward ? wardText(r.ward) : ''}{r.away && <span className="away-to"> → {spaceName(r.space)}</span>}</>} />
        </td>
        <td className={'num ' + vc('hr', lost ? null : r.hr)}>{lost ? '—' : r.hr ?? '—'}</td>
        <td className={'num ' + vc('spo2', lost ? null : r.spo2)}>{lost ? '—' : r.spo2 ?? '—'}</td>
        <td className={'num ' + vc('resp', lost ? null : r.resp)}>{lost ? '—' : r.resp ?? '—'}</td>
        <td className={'num ' + vc('temp', lost ? null : r.temp)}>{lost ? '—' : r.temp != null ? r.temp.toFixed(1) : '—'}</td>
        <td className="ecg-cell">{lost ? <small className="muted">{r.connected ? '무신호' : '해제'} {ago(r.last, now).replace(' 전', '')}</small> : <span className="ecg-box" title={ecg ? '페이지를 열었을 때의 최근 10초 ECG — ↻ 로 최신 10초' : '10초를 모으는 중 (30초 안에 못 모으면 점선으로 남음 — 열 머리 ↻ 로 다시)'}>
          {ecg ? <Spark values={ecg} tone="ok" width={100} height={20} /> : <Spark values={[]} width={100} height={20} />}
          {ecg && <button className="ecg-refresh" onClick={(e) => { e.stopPropagation(); refreshEcg([r.channel_id]) }} title="이 환자의 최신 10초로">↻</button>}
        </span>}</td>
        <td className="num"><TwoLine mono main={<span className={r.battery != null && r.battery <= 15 ? 'warnv' : ''}>{r.battery != null ? `${r.battery}%` : '—'}</span>}
          sub={r.life ? <span className={r.life.level === 'err' ? 'err' : r.life.level ? 'warn' : ''} title={`착용 ${fmtDays(r.life.worn)}째 · 배터리 약 ${fmtDays(r.life.batLeft)} · ${r.life.reason} 기준`}>{r.life.left <= 0 ? '지금 교체' : `D-${fmtDays(r.life.left)}`}</span> : null} /></td>
        <td className="num v">{r.rssi ?? '—'}</td>
        <td title={r.alarmObj?.message}>
          {r.alarmObj ? <Pill tone={TONE[r.alarmObj.severity]}>{SEV_LABEL[r.alarmObj.severity]}{r.alarmN > 1 ? ` ${r.alarmN}` : ''}</Pill> : null}
          {flags.map((n) => <Pill key={n} tone="med" title={FLAG_LABEL[n] || n}>{FLAG_LABEL[n] || n}</Pill>)}
          {!r.alarmObj && !flags.length && <span className="muted">—</span>}
        </td>
        <td><GwLink id={r.gateway_id} /></td>
        <td className="muted"><Ago ms={r.last} now={now} /></td>
        <RowActions>
          <button onClick={() => openLive(r.channel_id)} title="실시간 파형">뷰어</button>
          <button onClick={() => go('#/alarms', { q: r.channel_id, tab: 'history' })} title="알람 이력">이력</button>
        </RowActions>
      </tr>,
    )
  }

  return (
    <div className="page lk">
      {tabs}
      <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="명" />
      <FilterBar applied={applied} onReset={() => setQs({ q: '', ward: '', doc: '', f: '' })}
        right={<><span className="muted">{first.toLocaleString()} – {lastIdx.toLocaleString()} / {shown.length.toLocaleString()}명</span><Pager page={cur} pages={pages} onPage={setPage} /></>}>
        <input placeholder="검색: 이름 · MRN · 패치 · 병실 · GW · 담당의" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
        <Dropdown value={ward} options={wards} onChange={(v) => { setQs({ ward: v }); setPage(0) }} placeholder="모든 병동" width={200} />
        {doctors.length > 1 && <Dropdown value={doctor} options={doctors} onChange={(v) => { setQs({ doc: v }); setPage(0) }} placeholder="모든 담당의" width={170} />}
        <Dropdown value={sort[0]} options={SORTS.map(([k, l]) => ({ value: k, label: `정렬: ${l}` }))} onChange={(v) => { setSort([v, SORT_DIR[v] || 'asc']); setPage(0) }} searchable={false} width={170} />
        <label className="chk" title={ward ? "병동 필터를 지우면 병동별로 묶어 볼 수 있습니다" : "켜면 표를 병동별 묶음 헤더로 나눠 보여 줍니다"}><input type="checkbox" checked={groupPref} disabled={!!ward} onChange={(e) => setGroup(e.target.checked)} /><span>병동 묶기</span></label>
        <DensityToggle value={density} onChange={setDensity} />
      </FilterBar>
      <ListLayout detail={selRow ? <PatientDetail r={selRow} alarms={alarms} onClose={() => setQs({ sel: '' })} /> : sel ? <DetailPanel title={`패치 ${sel}`} onClose={() => setQs({ sel: '' })}><p className="muted">목록에 없는 패치입니다 (퇴원·교체).</p></DetailPanel> : null}>
        <table className={'tbl fixed' + (density === 'dense' ? ' dense' : '')} style={{ minWidth: tableMin(W, 200) }}>
          <Cols w={W} />
          <thead><tr>{COLS.map(([k, l, , num]) => (k === 'ecg' ? <th key={k} className="ecg-th">{l} <button className="ecg-refresh on" onClick={() => refreshEcg(slice.map((r) => r.channel_id))} title="보이는 환자 모두 최신 10초로">↻</button></th> : th(k, l, num)))}</tr></thead>
          <tbody>
            {rowsOut}
            {!shown.length && <tr><td colSpan={COLS.length} className="muted">조건에 맞는 환자가 없습니다.</td></tr>}
          </tbody>
        </table>
        <p className="lk-legend">수치는 임계 밖일 때만 색(주황 = 주의, 빨강 = 위험). ECG 는 페이지를 열었을 때의 최근 10초 스냅샷이며(모이는 동안은 점선) 갱신하지 않습니다. 두 번 누르면 실시간 파형이 열립니다.</p>
      </ListLayout>
    </div>
  )
}

/** 환자 상세 패널: 기본 정보 · 바이탈 · 패치 · 이 환자의 알람, 다른 목록으로 가는 버튼 */
export function PatientDetail({ r, alarms, onClose }) {
  const p = r.patient || {}
  const v = r.vitals || {}
  const life = r.life || patchLife(r, r.battery)
  const age = ageOf(p.birth)
  const mine = (alarms?.alarms || []).filter((a) => a.channel_id === r.channel_id).sort((a, b) => (SEV_ORDER[b.severity] ?? 0) - (SEV_ORDER[a.severity] ?? 0))
  const lost = !r.connected || r.stale
  const ecg = lost ? null : ecgPoints(r.channel_id, 140)
  return (
    <DetailPanel title={p.name || r.mrn || r.channel_id} sub={[SEX[p.sex] || p.sex, age != null && `${age}세`, r.mrn, r.channel_id].filter(Boolean).join(' · ')} onClose={onClose}
      actions={<>
        <button className="primary" onClick={() => openLive(r.channel_id)}>실시간 파형</button>
        <button onClick={() => go('#/map', { pat: r.channel_id })}>지도에서 보기</button>
        <button onClick={() => go('#/alarms', { q: r.channel_id, tab: 'history' })}>알람 이력</button>
        <button onClick={() => go('#/events', { q: r.channel_id })}>이벤트</button>
      </>}>
      {ecg && <div style={{ margin: '0 0 8px' }}><Spark values={ecg} tone="ok" width={280} height={48} title="최근 10초 ECG" /></div>}
      {mine.map((a) => <div key={a.id} className={`lk-alarm sev-${a.severity}`}><Pill tone={TONE[a.severity]}>{SEV_LABEL[a.severity]}</Pill> {a.message} <small className="muted">{fmtTime(a.since_ms)}</small></div>)}
      <dl className="lk-kv">
        <KV k="병동"><WardLink ward={p.ward} /></KV>
        <KV k="병실 · 침대"><RoomLink room={p.room || r.space}>{wardRoom(p.room || r.space)?.room || p.room || r.space}</RoomLink>{p.bed ? ` · ${p.bed.slice(-1)} 침대` : ''}</KV>
        <KV k="지금 위치">{nowPlace(p, r.space) ? <RoomLink room={r.space}>{nowPlace(p, r.space)}</RoomLink> : null}</KV>
        <KV k="진료">{[p.department, p.diagnosis].filter(Boolean).join(' · ')}</KV>
        <KV k="담당">{[p.doctor && `의사 ${p.doctor}`, p.nurse && `간호사 ${p.nurse}`].filter(Boolean).join(' · ')}</KV>
        <KV k="바이탈">{lost ? <span className="muted">수신 없음</span> : <>HR <b className={vc('hr', v.hr)}>{v.hr ?? '—'}</b> · SpO₂ <b className={vc('spo2', v.spo2)}>{v.spo2 ?? '—'}</b> · RR <b className={vc('resp', v.resp)}>{v.resp ?? '—'}</b>{v.temp != null ? <> · <b className={vc('temp', v.temp)}>{v.temp.toFixed(1)}</b>°C</> : null}</>}</KV>
        <KV k="패치"><span className="mono">{r.channel_id}</span> · 배터리 {r.battery ?? '—'}%{life?.batLeft != null ? ` (약 ${fmtDays(life.batLeft)})` : ''}</KV>
        {life && <KV k="착용 · 교체"><span className={life.level ? `lk-${life.level}` : ''}>{fmtDays(life.worn)}째 · {life.left <= 0 ? '지금 교체' : `${fmtDays(life.left)} 뒤 교체`} ({life.reason})</span></KV>}
        <KV k="게이트웨이"><GwLink id={r.gateway_id} /> · RSSI {r.rssi ?? '—'} dBm</KV>
        <KV k="상태">{r.connected ? (r.stale ? '수신 지연' : '수신 중') : '해제'} · 마지막 {fmtAgo(r.last_ts_ms)}{flagNames(r.flags).length ? ` · ${flagNames(r.flags).map((n) => FLAG_LABEL[n] || n).join(', ')}` : ''}</KV>
      </dl>
    </DetailPanel>
  )
}
