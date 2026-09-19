import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { alarmIndex, gatewayAlarmIndex, GW_STATUS } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'

const ROOM_FILL = {
  room: 'var(--room)', corridor: 'var(--corridor)', nurse_station: 'var(--station)', exam: 'var(--exam)',
  lobby: 'var(--lobby)', elevator: 'var(--elev)', stairs: 'var(--elev)', toilet: 'var(--util)', shower: 'var(--util)', utility: 'var(--util)',
}
const poly = (pts) => pts.map((p) => p.join(',')).join(' ')

/** Floor plan from the emulator's layout JSON (proxied by the router), overlaid with live gateway state,
 *  patients (registry rows) and alarms. Rooms are keyed by id; a patient's room comes from the EMR sync. */
export default function MapPage({ alarms, hash }) {
  const [layout, setLayout] = useState(null)
  const [err, setErr] = useState(null)
  const [rows] = usePoll(api.channels, 4000)
  const [gws] = usePoll(api.gateways, 4000)
  const [sel, setSel] = useState(() => {
    try { return JSON.parse(localStorage.getItem('map.sel') || 'null') } catch { return null }
  })
  const [pick, setPick] = useState(null) // { room } | { gw }
  useEffect(() => { api.emu.layout().then(setLayout).catch((e) => setErr(String(e))) }, [])
  useEffect(() => { if (sel) try { localStorage.setItem('map.sel', JSON.stringify(sel)) } catch { /* ignore */ } }, [sel])

  const floors = layout?.floors || []
  const cur = useMemo(() => {
    if (!floors.length) return null
    const f = sel && floors.find((x) => x.building_idx === sel.b && x.floor === sel.f)
    return f || floors.find((x) => x.wards?.length) || floors[0]
  }, [floors, sel])
  const buildings = layout?.buildings || []
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const gidx = useMemo(() => gatewayAlarmIndex(alarms?.alarms), [alarms])
  const gwById = useMemo(() => new Map((gws || []).map((g) => [String(g.gw_id), g])), [gws])
  // patients on this floor: by room id (EMR) — fall back to the gateway's room for moving patients
  const byRoom = useMemo(() => {
    const m = new Map()
    for (const r of rows || []) {
      if (!r.connected) continue
      const room = r.patient?.room || r.space
      if (!room) continue
      if (!m.has(room)) m.set(room, [])
      m.get(room).push(r)
    }
    return m
  }, [rows])
  // building dropdown: connected patients per building (rooms of its floors)
  const buildingOpts = useMemo(() => buildings.map((b) => {
    let n = 0
    for (const f of floors) if (f.building_idx === b.idx) for (const r of f.rooms || []) n += (byRoom.get(r.id) || []).length
    return { value: b.idx, label: b.name, count: n }
  }), [buildings, floors, byRoom])
  const floorGws = useMemo(() => (layout?.gateways || []).filter((g) => cur && g.building_idx === cur.building_idx && g.floor === cur.floor), [layout, cur])

  if (err) return <div className="page"><p className="err">도면을 불러오지 못했습니다: {err} (에뮬레이터 연결 확인)</p></div>
  if (!layout || !cur) return <div className="page"><p className="muted">도면 불러오는 중…</p></div>

  const W = cur.width, D = cur.depth
  const floorList = floors.filter((f) => f.building_idx === cur.building_idx)
  const stats = { patients: 0, alarm: 0 }
  for (const r of cur.rooms) for (const p of byRoom.get(r.id) || []) { stats.patients++; if (aidx.has(p.channel_id)) stats.alarm++ }
  const pickRoom = pick?.room && cur.rooms.find((r) => r.id === pick.room)
  const pickGw = pick?.gw && floorGws.find((g) => String(g.gw_no) === pick.gw)
  const pickPatients = pickRoom ? byRoom.get(pickRoom.id) || [] : pickGw ? (rows || []).filter((r) => r.connected && r.gateway_id === String(pickGw.gw_no)) : []

  return (
    <div className="page map-page">
      <div className="toolbar">
        <Dropdown value={cur.building_idx} options={buildingOpts} onChange={(v) => setSel({ b: Number(v), f: floors.find((x) => x.building_idx === Number(v) && x.wards?.length)?.floor || 1 })} searchable={false} width={220} />
        <span className="seg wrap">
          {floorList.map((f) => <button key={f.floor} className={f.floor === cur.floor ? 'active' : ''} onClick={() => setSel({ b: cur.building_idx, f: f.floor })} title={f.name}>{f.floor}F</button>)}
        </span>
        <span className="muted">{cur.name} · {cur.kind} · 환자 {stats.patients}명 · 알람 {stats.alarm}</span>
        <span className="spacer" />
        <span className="legend"><i className="dot ok" /> 정상 <i className="dot alarm" /> 알람 <i className="dot gw" /> 게이트웨이 <i className="dot gwbad" /> GW 이상</span>
      </div>
      <div className="map-cols">
        <svg className="plan" viewBox={`-1 -1 ${W + 2} ${D + 2}`} preserveAspectRatio="xMidYMid meet">
          <rect x="0" y="0" width={W} height={D} className="floor-bg" />
          {cur.corridors?.map((c, i) => <polygon key={'c' + i} points={poly(c.poly)} className="corridor" />)}
          {cur.rooms.map((r) => {
            const ps = byRoom.get(r.id) || []
            const worst = ps.reduce((w, p) => { const a = aidx.get(p.channel_id); return a && (!w || a.severity === 'critical') ? a : w }, null)
            return (
              <g key={r.id} className={'room ' + (pick?.room === r.id ? 'picked' : '')} onClick={() => setPick({ room: r.id })}>
                <polygon points={poly(r.poly)} style={{ fill: ROOM_FILL[r.kind] || 'var(--room)' }} className={worst ? `sev-${worst.severity}` : ''} />
                <text x={r.cx} y={r.cy - 0.4} className="room-label">{r.name || r.id}</text>
                {ps.length > 0 && <text x={r.cx} y={r.cy + 1.4} className="room-count">{ps.length}명</text>}
                {r.beds?.map((b) => {
                  const occ = ps.find((p) => p.patient?.bed === b.id) // bed ids are not on rows yet; dots are placed by index below
                  return <rect key={b.id} x={b.x - 0.9} y={b.y - 0.45} width="1.8" height="0.9" transform={`rotate(${b.angle || 0} ${b.x} ${b.y})`} className={'bed ' + (occ ? 'occ' : '')} />
                })}
                {ps.map((p, i) => {
                  const bed = r.beds?.[i]
                  const x = bed ? bed.x : r.cx + ((i % 4) - 1.5) * 1.2
                  const y = bed ? bed.y : r.cy + 2.2 + Math.floor(i / 4) * 1.2
                  const a = aidx.get(p.channel_id)
                  return <circle key={p.channel_id} cx={x} cy={y} r="0.55" className={'pt ' + (a ? `sev-${a.severity}` : p.stale ? 'stale' : 'ok')} onClick={(e) => { e.stopPropagation(); openLive(p.channel_id) }}><title>{p.patient?.name || p.mrn} · {p.channel_id}{a ? ` · ${a.message}` : ''}</title></circle>
                })}
              </g>
            )
          })}
          {cur.fixtures?.map((f, i) => <g key={'f' + i} className="fixture"><rect x={f.x - 0.6} y={f.y - 0.3} width="1.2" height="0.6" transform={`rotate(${f.angle || 0} ${f.x} ${f.y})`} /><title>{f.label || f.type}</title></g>)}
          {floorGws.map((g) => {
            const live = gwById.get(String(g.gw_no))
            const al = gidx.get(String(g.gw_no))
            const cls = al ? 'gwbad' : !live ? 'gwoff' : !live.connected ? 'gwoff' : live.silent || live.status?.status === 2 ? 'gwbad' : live.status?.status === 1 ? 'gwwarn' : 'gw'
            return (
              <g key={g.gw_no} className={'gwm ' + cls + (pick?.gw === String(g.gw_no) ? ' picked' : '')} onClick={(e) => { e.stopPropagation(); setPick({ gw: String(g.gw_no) }) }}>
                <rect x={g.x - 0.7} y={g.y - 0.7} width="1.4" height="1.4" rx="0.3" />
                <title>{g.id} · {g.type} · {g.room}{live ? ` · ${live.connected ? '연결' : '끊김'} · 패치 ${live.patches} · ${GW_STATUS[live.status?.status] || ''}` : ' · 미접속'}{al ? ` · ${al.message}` : ''}</title>
              </g>
            )
          })}
        </svg>
        <aside className="map-side">
          {pickRoom && <><h4>{pickRoom.id} <small>{pickRoom.kind} · {pickRoom.ward}</small></h4><small className="muted">게이트웨이 {pickRoom.gateway ? '있음' : '없음'} · 침대 {pickRoom.beds?.length || 0}</small></>}
          {pickGw && <><h4>{pickGw.id} <small>{pickGw.type}</small></h4><GwInfo g={gwById.get(String(pickGw.gw_no))} />
            <p><a href={`#/viewer?tpl=central&gw=${pickGw.gw_no}`} target="_blank" rel="noopener"><button className="primary">중앙 모니터 열기 (새 탭)</button></a></p></>}
          {pickRoom && <p><a href={`#/viewer?tpl=central&room=${encodeURIComponent(pickRoom.id)}`} target="_blank" rel="noopener"><button>이 병실 중앙 모니터 (새 탭)</button></a></p>}
          {!pick && <p className="muted">병실이나 게이트웨이를 누르면 환자 목록이 나옵니다. 환자 점을 누르면 실시간 창이 열립니다.</p>}
          {pickPatients.map((p) => {
            const a = aidx.get(p.channel_id)
            return (
              <div key={p.channel_id} className={'prow clickable ' + (a ? `sev-${a.severity}` : '')} onClick={() => openLive(p.channel_id)}>
                <b>{p.patient?.name || p.mrn}</b> <span className="mono muted">{p.channel_id}</span>
                <span className="vit">HR {p.vitals?.hr ?? '—'} · SpO₂ {p.vitals?.spo2 ?? '—'} · RR {p.vitals?.resp ?? '—'}</span>
                {a && <span className={`tag small sev-${a.severity}`}>{a.message}</span>}
              </div>
            )
          })}
        </aside>
      </div>
    </div>
  )
}

function GwInfo({ g }) {
  if (!g) return <p className="muted">라우터에 접속한 적 없음</p>
  const st = g.status || {}
  return (
    <div className="kv one">
      <div><small>연결</small>{g.connected ? (g.silent ? '무응답' : '정상') : '끊김'} · {GW_STATUS[st.status] || '—'}</div>
      <div><small>패치</small>{g.patches} · 프레임 {g.frames?.toLocaleString?.()}</div>
      <div><small>NACK/복구/실패</small>{g.nack_tx} / {g.recovered} / {g.resend_lost}</div>
      <div><small>CPU/MEM/NET</small>{st.cpu ?? '—'}% / {st.mem ?? '—'}% / {st.net ?? '—'}%</div>
      <div><small>WAN RSSI / 온도</small>{st.wan_rssi ?? '—'} dBm / {st.temp ?? '—'}°C</div>
      <div><small>seq 갭/역전/재시작</small>{g.seq_gap} / {g.seq_reorder} / {g.seq_restart}</div>
    </div>
  )
}
