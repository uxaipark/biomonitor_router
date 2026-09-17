import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import { alarmIndex, flagNames, sortBy, SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'

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
  const wards = useMemo(() => [...new Set(flat.map((r) => r.ward).filter(Boolean))].sort(), [flat])
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
        <select value={ward} onChange={(e) => { setWard(e.target.value); setPage(0) }}><option value="">모든 병동</option>{wards.map((w) => <option key={w}>{w}</option>)}</select>
        <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }}>
          <option value="all">전체</option><option value="alarm">알람 있음</option><option value="leadoff">전극 탈락</option><option value="stale">수신 없음/해제</option><option value="lowbat">배터리 부족</option>
        </select>
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
