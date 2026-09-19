import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { alarmIndex, flagNames, sortBy, SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'

const COLS = [
  ['channel_id', '패치'], ['name', '환자'], ['mrn', 'MRN'], ['ward', '병동'], ['room', '병실'], ['gateway_id', 'GW'],
  ['hr', 'HR'], ['spo2', 'SpO₂'], ['resp', 'RR'], ['temp', '체온'], ['battery', '배터리'], ['rssi', 'RSSI'], ['flags', '상태'], ['alarm', '알람'], ['last', '수신'],
]
const PAGE = 100

export default function Patients({ alarms }) {
  const [rows] = usePoll(api.channels, 3000)
  const [q, setQ] = useState('')
  const [ward, setWard] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState(['alarm', 'desc'])
  const [page, setPage] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])

  const flat = useMemo(() => (rows || []).map((r) => {
    const p = r.patient || {}
    const al = aidx.get(r.channel_id)
    return {
      ...r, name: p.name || '', ward: p.ward || '', room: p.room || r.space || '', doctor: p.doctor, nurse: p.nurse,
      hr: r.vitals?.hr ?? null, spo2: r.vitals?.spo2 ?? null, resp: r.vitals?.resp ?? null, temp: r.vitals?.temp ?? null,
      alarm: al ? ({ critical: 3, high: 2, medium: 1, low: 0 })[al.severity] + 1 : 0, alarmObj: al, last: r.last_ts_ms,
    }
  }), [rows, aidx])
  const wards = useMemo(() => {
    const c = new Map()
    for (const r of flat) if (r.ward) c.set(r.ward, (c.get(r.ward) || 0) + 1)
    return [{ value: '', label: '모든 병동', count: flat.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([w, n]) => ({ value: w, label: w, count: n }))]
  }, [flat])
  const filters = useMemo(() => {
    const inWard = flat.filter((r) => !ward || r.ward === ward)
    return [
      { value: 'all', label: '전체', count: inWard.length },
      { value: 'alarm', label: '알람 있음', count: inWard.filter((r) => r.alarm).length },
      { value: 'leadoff', label: '전극 탈락', count: inWard.filter((r) => r.flags & 0x01).length },
      { value: 'stale', label: '수신 없음/해제', count: inWard.filter((r) => r.stale || !r.connected).length },
      { value: 'lowbat', label: '배터리 부족', count: inWard.filter((r) => r.flags & 0x04 || r.battery <= 15).length },
    ]
  }, [flat, ward])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = flat.filter((r) => (!ward || r.ward === ward) && (!needle || [r.channel_id, r.name, r.mrn, r.room, r.gateway_id, String(r.patient_id)].some((x) => String(x || '').toLowerCase().includes(needle))))
    if (filter === 'alarm') v = v.filter((r) => r.alarm)
    else if (filter === 'leadoff') v = v.filter((r) => r.flags & 0x01)
    else if (filter === 'stale') v = v.filter((r) => r.stale || !r.connected)
    else if (filter === 'lowbat') v = v.filter((r) => r.flags & 0x04 || r.battery <= 15)
    const key = sort[0] === 'channel_id' ? (r) => Number(r.channel_id) : sort[0]
    return sortBy(v, key, sort[1])
  }, [flat, q, ward, filter, sort])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const th = (k, label) => (
    <th key={k} onClick={() => setSort([k, sort[0] === k && sort[1] === 'asc' ? 'desc' : 'asc'])} className="sortable">{label}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  )
  return (
    <div className="page">
      <div className="toolbar">
        <input placeholder="검색: 이름 · MRN · 패치 · 병실 · GW" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
        <Dropdown value={ward} options={wards} onChange={(v) => { setWard(v); setPage(0) }} placeholder="모든 병동" width={200} />
        <Dropdown value={filter} options={filters} onChange={(v) => { setFilter(v); setPage(0) }} searchable={false} width={200} />
        <span className="muted">{shown.length.toLocaleString()} / {flat.length.toLocaleString()}명</span>
        <span className="spacer" />
        <button disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹</button><span className="muted">{cur + 1} / {pages}</span><button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>›</button>
      </div>
      <table className="tbl dense">
        <thead><tr>{COLS.map(([k, l]) => th(k, l))}</tr></thead>
        <tbody>
          {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((r) => (
            <tr key={r.channel_id} className={'clickable ' + (r.alarmObj ? `sev-${r.alarmObj.severity}` : '') + (r.stale || !r.connected ? ' stale' : '')} onClick={() => openLive(r.channel_id)}>
              <td className="mono">{r.channel_id}</td><td><b>{r.name || r.mrn}</b></td><td className="mono muted">{r.mrn}</td><td>{r.ward}</td><td>{r.room}</td><td className="mono">{r.gateway_id}</td>
              <td className="num">{r.hr ?? '—'}</td><td className="num">{r.spo2 ?? '—'}</td><td className="num">{r.resp ?? '—'}</td><td className="num">{r.temp != null ? r.temp.toFixed(1) : '—'}</td>
              <td className="num">{r.battery}%</td><td className="num">{r.rssi}</td>
              <td>{flagNames(r.flags).map((n) => <span key={n} className="tag small">{n}</span>)}{!r.connected && <span className="tag err small">해제</span>}{r.stale && r.connected && <span className="tag warn small">수신 없음</span>}</td>
              <td>{r.alarmObj && <span className={`tag small sev-${r.alarmObj.severity}`}>{SEV_LABEL[r.alarmObj.severity]} · {r.alarmObj.message}</span>}</td>
              <td className="muted">{fmtAgo(r.last)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
