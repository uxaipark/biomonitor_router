import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { claimLive, releaseLive, onWs } from '../ws.js'
import { WaveCard } from '../WaveCard.jsx'
import { alarmIndex } from '../model.js'
import { openLive } from '../App.jsx'

const MAX = 48

/** Live waveform grid: pick a ward / gateway / search, up to 48 patients at once. */
export default function Live({ alarms }) {
  const [rows] = usePoll(api.channels, 5000)
  const [ward, setWard] = useState(() => { try { return localStorage.getItem('live.ward') || '' } catch { return '' } })
  const [gw, setGw] = useState('')
  const [q, setQ] = useState('')
  const [density, setDensity] = useState('compact')
  const [onlyAlarm, setOnlyAlarm] = useState(false)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  useEffect(() => { try { localStorage.setItem('live.ward', ward) } catch { /* ignore */ } }, [ward])

  const wards = useMemo(() => [...new Set((rows || []).map((r) => r.patient?.ward).filter(Boolean))].sort(), [rows])
  const gws = useMemo(() => [...new Set((rows || []).filter((r) => !ward || r.patient?.ward === ward).map((r) => r.gateway_id).filter(Boolean))].sort((a, b) => a - b), [rows, ward])
  const selected = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = (rows || []).filter((r) => r.connected)
    if (ward) v = v.filter((r) => r.patient?.ward === ward)
    if (gw) v = v.filter((r) => r.gateway_id === gw)
    if (needle) v = v.filter((r) => [r.channel_id, r.patient?.name, r.mrn, r.patient?.room].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (onlyAlarm) v = v.filter((r) => aidx.has(r.channel_id))
    v.sort((a, b) => (a.patient?.room || '').localeCompare(b.patient?.room || '', 'ko') || Number(a.channel_id) - Number(b.channel_id))
    return v.slice(0, MAX)
  }, [rows, ward, gw, q, onlyAlarm, aidx])

  const ids = selected.map((r) => r.channel_id).join(',')
  useEffect(() => { claimLive('live', ids ? ids.split(',') : []); return () => releaseLive('live') }, [ids])
  // re-render vitals 4×/s from the WS `latest` map without re-rendering per packet
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t) }, [])
  useEffect(() => onWs('stream', () => {}), [])

  return (
    <div className="page">
      <div className="toolbar">
        <select value={ward} onChange={(e) => { setWard(e.target.value); setGw('') }}><option value="">병동 선택 (전체)</option>{wards.map((w) => <option key={w}>{w}</option>)}</select>
        <select value={gw} onChange={(e) => setGw(e.target.value)}><option value="">모든 게이트웨이</option>{gws.map((g) => <option key={g}>{g}</option>)}</select>
        <input placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={onlyAlarm} onChange={(e) => setOnlyAlarm(e.target.checked)} /> 알람만</label>
        <span className="seg">{['normal', 'compact', 'dense'].map((d) => <button key={d} className={density === d ? 'active' : ''} onClick={() => setDensity(d)}>{{ normal: '크게', compact: '보통', dense: '촘촘' }[d]}</button>)}</span>
        <span className="muted">{selected.length}명 표시 (최대 {MAX})</span>
      </div>
      {!ward && !gw && !q && <p className="muted">병동이나 게이트웨이를 고르면 해당 환자의 파형이 실시간으로 표시됩니다. 카드를 누르면 상세 창이 열립니다.</p>}
      <div className={'grid ' + density}>
        {selected.map((r) => <WaveCard key={r.channel_id} row={r} density={density} alarm={aidx.get(r.channel_id)} onClick={() => openLive(r.channel_id)} />)}
      </div>
    </div>
  )
}
