import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtNum, fmtAgo } from '../api.js'
import { gatewayAlarmIndex, GW_STATUS, sortBy } from '../model.js'
import Dropdown from '../Dropdown.jsx'

const COLS = [
  ['gw_id', 'GW'], ['name', '이름'], ['type', '유형'], ['loc', '위치'], ['state', '상태'], ['patches', '패치'], ['frames', '프레임'],
  ['nack_tx', 'NACK'], ['recovered', '복구'], ['resend_lost', '재전송 실패'], ['seq_gap', 'seq 갭'], ['seq_reorder', '역전'], ['bad_crc', 'CRC'],
  ['cpu', 'CPU'], ['mem', 'MEM'], ['net', 'NET'], ['wan_rssi', 'RSSI'], ['temp', '온도'], ['since_last_s', '마지막 프레임'],
]
const PAGE = 100

export default function Gateways({ alarms }) {
  const [rows] = usePoll(api.gateways, 3000)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState(['state', 'desc'])
  const [page, setPage] = useState(0)
  const gidx = useMemo(() => gatewayAlarmIndex(alarms?.alarms), [alarms])
  const flat = useMemo(() => (rows || []).map((g) => {
    const st = g.status || {}
    const state = !g.connected ? 3 : g.silent ? 2 : st.status === 2 ? 2 : st.status === 1 ? 1 : 0
    return { ...g, loc: [g.location?.building, g.location?.floor && `${g.location.floor}F`, g.location?.room].filter(Boolean).join(' '), state, cpu: st.cpu, mem: st.mem, net: st.net, wan_rssi: st.wan_rssi, temp: st.temp, stLabel: GW_STATUS[st.status], alarm: gidx.get(String(g.gw_id)) }
  }), [rows, gidx])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = flat.filter((g) => !needle || [g.gw_id, g.name, g.loc, g.type].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (filter === 'problem') v = v.filter((g) => g.state > 0 || g.alarm || g.resend_lost || g.bad_crc)
    else if (filter === 'down') v = v.filter((g) => !g.connected || g.silent)
    else if (filter === 'patched') v = v.filter((g) => g.patches > 0)
    return sortBy(v, sort[0], sort[1])
  }, [flat, q, filter, sort])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const counts = { conn: flat.filter((g) => g.connected).length, down: flat.filter((g) => !g.connected).length, silent: flat.filter((g) => g.silent).length }
  const filters = [
    { value: 'all', label: '전체', count: flat.length },
    { value: 'problem', label: '문제 있음', count: flat.filter((g) => g.state > 0 || g.alarm || g.resend_lost || g.bad_crc).length },
    { value: 'down', label: '끊김/무응답', count: flat.filter((g) => !g.connected || g.silent).length },
    { value: 'patched', label: '패치 있는 GW', count: flat.filter((g) => g.patches > 0).length },
  ]
  return (
    <div className="page">
      <div className="toolbar">
        <input placeholder="검색: GW 번호 · 이름 · 위치" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
        <Dropdown value={filter} options={filters} onChange={(v) => { setFilter(v); setPage(0) }} searchable={false} countUnit="대" width={200} />
        <span className="muted">연결 {counts.conn} · 끊김 {counts.down} · 무응답 {counts.silent} · 표시 {shown.length}</span>
        <span className="spacer" />
        <button disabled={cur === 0} onClick={() => setPage(cur - 1)}>‹</button><span className="muted">{cur + 1} / {pages}</span><button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>›</button>
      </div>
      <table className="tbl dense">
        <thead><tr>{COLS.map(([k, l]) => <th key={k} className="sortable" onClick={() => setSort([k, sort[0] === k && sort[1] === 'asc' ? 'desc' : 'asc'])}>{l}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
        <tbody>
          {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((g) => (
            <tr key={g.gw_id} className={g.alarm ? `sev-${g.alarm.severity}` : g.state === 3 ? 'stale' : ''}>
              <td className="mono">{g.gw_id}</td><td>{g.name}</td><td>{g.type}</td><td>{g.loc}</td>
              <td>{!g.connected ? <span className="tag err small">끊김</span> : g.silent ? <span className="tag err small">무응답</span> : g.state === 2 ? <span className="tag err small">DOWN</span> : g.state === 1 ? <span className="tag warn small">저하</span> : <span className="tag ok small">정상</span>}</td>
              <td className="num">{g.patches}</td><td className="num">{fmtNum(g.frames)}</td>
              <td className="num">{g.nack_tx}</td><td className="num">{g.recovered}</td><td className="num">{g.resend_lost}</td><td className="num">{g.seq_gap}</td><td className="num">{g.seq_reorder}</td><td className="num">{g.bad_crc}</td>
              <td className="num">{g.cpu ?? '—'}</td><td className="num">{g.mem ?? '—'}</td><td className="num">{g.net ?? '—'}</td><td className="num">{g.wan_rssi ?? '—'}</td><td className="num">{g.temp ?? '—'}</td>
              <td className="muted">{g.since_last_s != null ? `${g.since_last_s.toFixed(1)}s` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
