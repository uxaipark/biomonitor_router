import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll } from '../api.js'
import { claimLive, releaseLive, onWs, wsCounters } from '../ws.js'
import { renderStats } from '../renderLoop.js'
import { WaveCard } from '../WaveCard.jsx'
import { alarmIndex } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'

// card counts offered per density — the large ones exist to load-test streaming (2,000 = every patch)
const COUNTS = { normal: [48, 72], compact: [120, 240], dense: [500, 1000, 2000] }
const DENSITY_LABEL = { normal: '크게', compact: '보통', dense: '촘촘' }
const loadPref = () => { try { return JSON.parse(localStorage.getItem('live.density') || 'null') } catch { return null } }

/** Live waveform grid: pick a ward / gateway / search; density × count selects how many cards to stream. */
export default function Live({ alarms }) {
  const [rows] = usePoll(api.channels, 5000)
  const [ward, setWard] = useState(() => { try { return localStorage.getItem('live.ward') || '' } catch { return '' } })
  const [gw, setGw] = useState('')
  const [q, setQ] = useState('')
  const [density, setDensityRaw] = useState(() => loadPref()?.density || 'compact')
  const [count, setCount] = useState(() => loadPref()?.count || COUNTS[loadPref()?.density || 'compact'][0])
  const setDensity = (d) => { setDensityRaw(d); if (!COUNTS[d].includes(count)) setCount(COUNTS[d][0]) }
  useEffect(() => { try { localStorage.setItem('live.density', JSON.stringify({ density, count })) } catch { /* ignore */ } }, [density, count])
  // streaming performance line: diff the cumulative WS counters once a second
  const perfRef = useRef({ t: 0, frames: 0, bytes: 0, items: 0, decodeMs: 0 })
  const [perf, setPerf] = useState(null)
  const [onlyAlarm, setOnlyAlarm] = useState(false)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  useEffect(() => { try { localStorage.setItem('live.ward', ward) } catch { /* ignore */ } }, [ward])

  // dropdown lists carry the connected-patient count of each ward / gateway
  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const wards = useMemo(() => {
    const c = new Map()
    for (const r of live) if (r.patient?.ward) c.set(r.patient.ward, (c.get(r.patient.ward) || 0) + 1)
    return [{ value: '', label: '병동 선택 (전체)', count: live.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([w, n]) => ({ value: w, label: w, count: n }))]
  }, [live])
  const gws = useMemo(() => {
    const c = new Map()
    for (const r of live) if (r.gateway_id && (!ward || r.patient?.ward === ward)) c.set(r.gateway_id, (c.get(r.gateway_id) || 0) + 1)
    const all = [...c.values()].reduce((a, b) => a + b, 0)
    return [{ value: '', label: '모든 게이트웨이', count: all }, ...[...c].sort((a, b) => a[0] - b[0]).map(([g, n]) => ({ value: g, label: `GW ${g}`, count: n }))]
  }, [live, ward])
  const selected = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = (rows || []).filter((r) => r.connected)
    if (ward) v = v.filter((r) => r.patient?.ward === ward)
    if (gw) v = v.filter((r) => r.gateway_id === gw)
    if (needle) v = v.filter((r) => [r.channel_id, r.patient?.name, r.mrn, r.patient?.room].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (onlyAlarm) v = v.filter((r) => aidx.has(r.channel_id))
    v.sort((a, b) => (a.patient?.room || '').localeCompare(b.patient?.room || '', 'ko') || Number(a.channel_id) - Number(b.channel_id))
    return v.slice(0, count)
  }, [rows, ward, gw, q, onlyAlarm, aidx, count])

  const ids = selected.map((r) => r.channel_id).join(',')
  useEffect(() => { claimLive('live', ids ? ids.split(',') : []); return () => releaseLive('live') }, [ids])
  // re-render vitals from the WS `latest` map without re-rendering per packet: 4×/s, 1×/s above 240 cards
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), count > 240 ? 1000 : 250); return () => clearInterval(t) }, [count])
  useEffect(() => {
    const t = setInterval(() => {
      const p = perfRef.current, now = performance.now(), dt = (now - p.t) / 1000
      if (p.t) setPerf({ fps: wsCounters.frames - p.frames, kbps: (wsCounters.bytes - p.bytes) / 1024 / dt, ips: (wsCounters.items - p.items) / dt, decode: (wsCounters.decodeMs - p.decodeMs) / dt, draw: renderStats.drawMs, rfps: renderStats.fps, canvases: renderStats.canvases, heap: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null })
      perfRef.current = { t: now, frames: wsCounters.frames, bytes: wsCounters.bytes, items: wsCounters.items, decodeMs: wsCounters.decodeMs }
    }, 1000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => onWs('stream', () => {}), [])

  return (
    <div className="page">
      <div className="toolbar">
        <Dropdown value={ward} options={wards} onChange={(v) => { setWard(v); setGw('') }} placeholder="병동 선택 (전체)" width={220} />
        <Dropdown value={gw} options={gws} onChange={setGw} placeholder="모든 게이트웨이" width={220} />
        <input placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="chk"><input type="checkbox" checked={onlyAlarm} onChange={(e) => setOnlyAlarm(e.target.checked)} /> 알람만</label>
        <span className="seg gap-l">{Object.keys(COUNTS).map((d) => <button key={d} className={density === d ? 'active' : ''} onClick={() => setDensity(d)}>{DENSITY_LABEL[d]}</button>)}</span>
        <span className="seg">{COUNTS[density].map((n) => <button key={n} className={count === n ? 'active' : ''} onClick={() => setCount(n)}>{n.toLocaleString()}</button>)}</span>
        <span className="muted">{selected.length.toLocaleString()}명 표시</span>
        {perf && <span className="muted perf">WS {perf.fps}/s · {perf.kbps.toFixed(0)} KB/s · {Math.round(perf.ips)} rec/s · 디코드 {perf.decode.toFixed(1)} ms/s · 그리기 {perf.draw.toFixed(1)} ms/프레임 · {perf.rfps.toFixed(0)} fps · 캔버스 {perf.canvases}{perf.heap != null && ` · 힙 ${perf.heap.toFixed(0)} MB`}</span>}
      </div>
      {!ward && !gw && !q && <p className="muted">병동이나 게이트웨이를 고르면 해당 환자의 파형이 실시간으로 표시됩니다. 카드를 누르면 상세 창이 열립니다.</p>}
      <div className={'grid ' + density}>
        {selected.map((r) => <WaveCard key={r.channel_id} row={r} density={density} alarm={aidx.get(r.channel_id)} onClick={() => openLive(r.channel_id)} />)}
      </div>
    </div>
  )
}
