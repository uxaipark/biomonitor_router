import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtAgo, fmtTime } from '../api.js'
import { alarmIndex, flagNames, sortBy, SEV_LABEL, FLAG_LABEL, FLAG_WARN, wardText, wardRoom, patchLife, fmtDays } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'
import { useQuery, go, useRevealSelected, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, GwLink, RoomLink, WardLink } from '../ListKit.jsx'

const COLS = [
  ['channel_id', '패치'], ['name', '환자'], ['mrn', 'MRN'], ['ward', '병동'], ['room', '병실'], ['gateway_id', 'GW'],
  ['hr', 'HR'], ['spo2', 'SpO₂'], ['resp', 'RR'], ['temp', '체온'], ['battery', '배터리'], ['replace', '패치 교체'], ['rssi', 'RSSI'], ['flags', '상태'], ['alarm', '알람'], ['last', '수신'],
]
const PAGE = 100
const NUM = new Set(['hr', 'spo2', 'resp', 'temp', 'battery', 'replace', 'rssi'])
// 요약 칩 = 조치가 필요한 조건 (누르면 그 조건만)
const CHIPS = [
  ['alarm', '알람 있음', (r) => r.alarm, 'c-err'],
  ['leadoff', '전극 탈락', (r) => r.flags & 0x01, 'c-warn'],
  ['stale', '수신 없음/해제', (r) => r.stale || !r.connected, 'c-warn'],
  ['lowbat', '배터리 부족', (r) => r.flags & 0x04 || (r.battery > 0 && r.battery <= 15), 'c-warn'],
  ['replace', '패치 교체 1일 이내', (r) => r.replace != null && r.replace <= 1, 'c-warn'],
]
const SEX = { M: '남', F: '여' }

/** 환자 목록: 요약 칩 · 병동/검색 필터(주소에 남음) · 표 · 오른쪽 환자 상세 */
export default function Patients({ alarms }) {
  const [rows] = usePoll(api.channels, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', ward = qs.get('ward') || '', chip = qs.get('f') || '', sel = qs.get('sel') || ''
  const [sort, setSort] = useState(['alarm', 'desc'])
  const [page, setPage] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])

  const flat = useMemo(() => (rows || []).map((r) => {
    const p = r.patient || {}
    const al = aidx.get(r.channel_id)
    const life = patchLife(r, r.battery)
    return {
      ...r, name: p.name || '', ward: p.ward || '', room: p.room || r.space || '', doctor: p.doctor, nurse: p.nurse,
      life, replace: life?.left ?? null,
      hr: r.vitals?.hr ?? null, spo2: r.vitals?.spo2 ?? null, resp: r.vitals?.resp ?? null, temp: r.vitals?.temp ?? null,
      alarm: al ? ({ critical: 3, high: 2, medium: 1, low: 0 })[al.severity] + 1 : 0, alarmObj: al, last: r.last_ts_ms,
    }
  }), [rows, aidx])
  const wards = useMemo(() => {
    const c = new Map(), bld = new Map()
    for (const r of flat) if (r.ward) { c.set(r.ward, (c.get(r.ward) || 0) + 1); bld.set(r.ward, r.patient?.building) }
    return [{ value: '', label: '모든 병동', count: flat.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([w, n]) => ({ value: w, label: `${bld.get(w) || ''} ${wardText(w)}`.trim(), count: n }))]
  }, [flat])
  const inWard = useMemo(() => flat.filter((r) => !ward || r.ward === ward), [flat, ward])
  const chips = useMemo(() => [{ key: 'all', label: '전체', count: inWard.length }, ...CHIPS.map(([k, l, f, cls]) => ({ key: k, label: l, count: inWard.filter(f).length, cls }))], [inWard])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = inWard.filter((r) => !needle || [r.channel_id, r.name, r.mrn, r.room, r.gateway_id, String(r.patient_id)].some((x) => String(x || '').toLowerCase().includes(needle)))
    const c = CHIPS.find(([k]) => k === chip)
    if (c) v = v.filter(c[2])
    const key = sort[0] === 'channel_id' ? (r) => Number(r.channel_id) : sort[0]
    return sortBy(v, key, sort[1])
  }, [inWard, q, chip, sort])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const selRow = sel ? flat.find((r) => r.channel_id === sel) : null
  useRevealSelected(sel, shown, (r) => r.channel_id, PAGE, setPage)
  const applied = [
    ward && { key: 'ward', label: `병동: ${wardText(ward)}`, clear: () => setQs({ ward: '' }) },
    chip && { key: 'f', label: CHIPS.find(([k]) => k === chip)?.[1] || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  const th = (k, label) => (
    <th key={k} onClick={() => setSort([k, sort[0] === k && sort[1] === 'asc' ? 'desc' : 'asc'])} className={'sortable' + (NUM.has(k) ? ' num' : '')}>{label}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  )
  return (
    <div className="page lk">
      <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="명" />
      <FilterBar applied={applied} onReset={() => setQs({ q: '', ward: '', f: '' })}
        right={<><span className="muted">{shown.length.toLocaleString()} / {flat.length.toLocaleString()}명</span><Pager page={cur} pages={pages} onPage={setPage} /></>}>
        <input placeholder="검색: 이름 · MRN · 패치 · 병실 · GW" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
        <Dropdown value={ward} options={wards} onChange={(v) => { setQs({ ward: v }); setPage(0) }} placeholder="모든 병동" width={200} />
      </FilterBar>
      <ListLayout detail={selRow ? <PatientDetail r={selRow} alarms={alarms} onClose={() => setQs({ sel: '' })} /> : sel ? <DetailPanel title={`패치 ${sel}`} onClose={() => setQs({ sel: '' })}><p className="muted">목록에 없는 패치입니다 (퇴원·교체).</p></DetailPanel> : null}>
        <table className="tbl dense">
          <thead><tr>{COLS.map(([k, l]) => th(k, l))}</tr></thead>
          <tbody>
            {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((r) => (
              <tr key={r.channel_id} className={'clickable ' + (r.alarmObj ? `sev-${r.alarmObj.severity}` : '') + (r.stale || !r.connected ? ' stale' : '') + (sel === r.channel_id ? ' selected' : '')} onClick={() => setQs({ sel: sel === r.channel_id ? '' : r.channel_id })} onDoubleClick={() => openLive(r.channel_id)} title="누르면 상세 · 두 번 누르면 실시간 파형">
                <td className="mono">{r.channel_id}</td><td><b>{r.name || r.mrn}</b></td><td className="mono muted">{r.mrn}</td>
                <td title={r.ward}>{r.patient?.building && <span className="muted">{r.patient.building} </span>}<WardLink ward={r.ward} /></td>
                <td title={r.room}><RoomLink room={r.room}>{wardRoom(r.room)?.room || r.room}</RoomLink></td>
                <td><GwLink id={r.gateway_id} /></td>
                <td className="num">{r.hr ?? '—'}</td><td className="num">{r.spo2 ?? '—'}</td><td className="num">{r.resp ?? '—'}</td><td className="num">{r.temp != null ? r.temp.toFixed(1) : '—'}</td>
                <td className="num">{r.battery}%</td>
                <td className={'num' + (r.life?.level ? ` ${r.life.level === 'err' ? 'err' : 'warn'}` : '')} title={r.life ? `착용 ${fmtDays(r.life.worn)}째 · 배터리 약 ${fmtDays(r.life.batLeft)} · ${r.life.reason} 기준` : '착용 시작 모름'}>{r.life ? (r.life.left <= 0 ? '지금' : `D-${fmtDays(r.life.left)}`) : '—'}</td>
                <td className="num">{r.rssi}</td>
                <td>{flagNames(r.flags).map((n) => <span key={n} className={'tag small' + (FLAG_WARN.has(n) ? ' warn' : '')}>{FLAG_LABEL[n] || n}</span>)}{!r.connected && <span className="tag err small">해제</span>}{r.stale && r.connected && <span className="tag warn small">수신 없음</span>}</td>
                <td>{r.alarmObj && <span className={`tag small sev-${r.alarmObj.severity}`}>{SEV_LABEL[r.alarmObj.severity]} · {r.alarmObj.message}</span>}</td>
                <td className="muted">{fmtAgo(r.last)}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={COLS.length} className="muted">조건에 맞는 환자가 없습니다.</td></tr>}
          </tbody>
        </table>
      </ListLayout>
    </div>
  )
}

const ageOf = (birth) => { const y = +(String(birth || '').slice(0, 4)); return y > 1900 ? new Date().getFullYear() - y : null }

/** 환자 상세 패널: 기본 정보 · 바이탈 · 패치 · 이 환자의 알람, 다른 목록으로 가는 버튼 */
export function PatientDetail({ r, alarms, onClose }) {
  const p = r.patient || {}
  const v = r.vitals || {}
  const life = r.life || patchLife(r, r.battery)
  const age = ageOf(p.birth)
  const mine = (alarms?.alarms || []).filter((a) => a.channel_id === r.channel_id)
  const lost = !r.connected || r.stale
  return (
    <DetailPanel title={p.name || r.mrn || r.channel_id} sub={[SEX[p.sex] || p.sex, age != null && `${age}세`, r.mrn].filter(Boolean).join(' · ')} onClose={onClose}
      actions={<>
        <button className="primary" onClick={() => openLive(r.channel_id)}>실시간 파형</button>
        <button onClick={() => go('#/map', { pat: r.channel_id })}>지도에서 보기</button>
        <button onClick={() => go('#/alarms', { q: r.channel_id, tab: 'history' })}>알람 이력</button>
        <button onClick={() => go('#/events', { q: r.channel_id })}>이벤트</button>
      </>}>
      {mine.map((a) => <div key={a.id} className={`lk-alarm sev-${a.severity}`}><span className={`tag small sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span> {a.message} <small className="muted">{fmtTime(a.since_ms)}</small></div>)}
      <dl className="lk-kv">
        <KV k="병동"><WardLink ward={p.ward} /></KV>
        <KV k="병실 · 침대"><RoomLink room={p.room || r.space}>{wardRoom(p.room || r.space)?.room || p.room || r.space}</RoomLink>{p.bed ? ` · ${p.bed.slice(-1)} 침대` : ''}</KV>
        <KV k="진료">{[p.department, p.diagnosis].filter(Boolean).join(' · ')}</KV>
        <KV k="담당">{[p.doctor && `의사 ${p.doctor}`, p.nurse && `간호사 ${p.nurse}`].filter(Boolean).join(' · ')}</KV>
        <KV k="바이탈">{lost ? <span className="muted">수신 없음</span> : <>HR <b>{v.hr ?? '—'}</b> · SpO₂ <b>{v.spo2 ?? '—'}</b> · RR <b>{v.resp ?? '—'}</b>{v.temp != null ? <> · <b>{v.temp.toFixed(1)}</b>°C</> : null}</>}</KV>
        <KV k="패치"><span className="mono">{r.channel_id}</span> · 배터리 {r.battery ?? '—'}%{life?.batLeft != null ? ` (약 ${fmtDays(life.batLeft)})` : ''}</KV>
        {life && <KV k="착용 · 교체"><span className={life.level ? `lk-${life.level}` : ''}>{fmtDays(life.worn)}째 · {life.left <= 0 ? '지금 교체' : `${fmtDays(life.left)} 뒤 교체`} ({life.reason})</span></KV>}
        <KV k="게이트웨이"><GwLink id={r.gateway_id} /> · RSSI {r.rssi ?? '—'} dBm</KV>
        <KV k="상태">{r.connected ? (r.stale ? '수신 지연' : '수신 중') : '해제'} · 마지막 {fmtAgo(r.last_ts_ms)}</KV>
      </dl>
    </DetailPanel>
  )
}
