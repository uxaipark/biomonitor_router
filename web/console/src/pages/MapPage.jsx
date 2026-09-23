import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { alarmIndex, gatewayAlarmIndex, GW_STATUS } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'
import FloorPlan, { LEGEND, LOD, bedPoint, BED_HEAD, BED_BODY, fixtureBox } from './FloorPlan.jsx'

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

/** Floor plan from the emulator's layout JSON (proxied by the router), overlaid with live gateway state,
 *  patients (registry rows) and alarms. Rooms are keyed by id; a patient's room comes from the EMR sync. */
export default function MapPage({ alarms, hash }) {
  const [layout, setLayout] = useState(null)
  const [err, setErr] = useState(null)
  const [rows] = usePoll(api.channels, 4000)
  const [gws] = usePoll(api.gateways, 4000)
  // 층 선택: URL(#/map?b=0&f=3)이 있으면 그 층, 없으면 마지막으로 보던 층
  const [sel, setSel] = useState(() => {
    const q = new URLSearchParams((hash || '').split('?')[1] || '')
    if (q.has('b') || q.has('f')) return { b: Number(q.get('b') || 0), f: Number(q.get('f') || 1) }
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
  const floorGws = useMemo(() => (layout?.gateways || []).filter((g) => cur && g.mount !== 'mobile' && g.building_idx === cur.building_idx && g.floor === cur.floor), [layout, cur])
  // 방별 환자 ↔ 침대 배정: EMR 의 침대 id 가 그 방 침대면 그대로, 없으면 남은 빈 침대를 순서대로
  const placements = useMemo(() => {
    const m = new Map()
    for (const r of cur?.rooms || []) {
      const beds = new Map(), byPatient = new Map()
      const ps = byRoom.get(r.id) || []
      const ids = new Set((r.beds || []).map((b) => b.id))
      for (const p of ps) {
        const want = p.patient?.bed
        if (want && ids.has(want) && !beds.has(want)) { beds.set(want, p); byPatient.set(p.channel_id, r.beds.find((b) => b.id === want)) }
      }
      const free = (r.beds || []).filter((b) => !beds.has(b.id))
      for (const p of ps) if (!byPatient.has(p.channel_id) && free.length) { const b = free.shift(); beds.set(b.id, p); byPatient.set(p.channel_id, b) }
      m.set(r.id, { beds, byPatient })
    }
    return m
  }, [cur, byRoom])
  const placeInRoom = (r) => placements.get(r.id) || { beds: new Map(), byPatient: new Map() }

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
        <span className="legend">
          <i className="dot ok" /> 정상 <i className="dot alarm" /> 알람 <i className="dot gw" /> 게이트웨이
        </span>
      </div>
      <div className="plan-legend">
        {LEGEND.map(([c, label]) => <span key={c}><i className={'sw sw-' + c} />{label}</span>)}
      </div>
      <div className="map-cols">
        <FloorPlan
          floor={cur}
          rooms={cur.rooms}
          corridors={cur.corridors}
          fixtures={cur.fixtures}
          markers={floorGws}
          patientsByRoom={byRoom}
          picked={pick?.room}
          onPickRoom={(id) => setPick({ room: id })}
          overlay={{
            // 방 색을 가장 위중한 알람으로 물들인다 (환자 점과 별개로 멀리서도 보이게)
            roomSeverity: (r, ps) => ps.reduce((w, p) => {
              const a = aidx.get(p.channel_id)
              return a && (!w || SEV_RANK[a.severity] > SEV_RANK[w]) ? a.severity : w
            }, null),
            // EMR 이 준 침대 id(p.patient.bed)가 그 방의 침대면 그 자리, 아니면 남은 빈 침대 순서대로
            bedOccupied: (r, b) => !!placeInRoom(r).beds.get(b.id),
            render: (k) => (
              <g className="live">
                {cur.rooms.map((r) => (byRoom.get(r.id) || []).map((p, i) => {
                  const bed = placeInRoom(r).byPatient.get(p.channel_id)
                  // 침대가 있으면 점은 베개 위, 이름은 이불 위 — 서로 겹치지 않는다. 침대보다 환자가 많으면 방 아래쪽에 줄 세운다.
                  const [x, y] = bed ? bedPoint(bed, BED_HEAD) : [r.cx + ((i % 4) - 1.5) * 1.1, r.cy + 2.0 + Math.floor(i / 4) * 1.1]
                  const [nx, ny] = bed ? bedPoint(bed, BED_BODY) : [x, y + 0.95]
                  const a = aidx.get(p.channel_id)
                  const cls = a ? `sev-${a.severity}` : p.stale ? 'stale' : 'ok'
                  const nm = (p.patient?.name || p.mrn || '').slice(0, 4)
                  return (
                    <g key={p.channel_id} className={'pt ' + cls} onClick={(e) => { e.stopPropagation(); openLive(p.channel_id) }}>
                      {a && <circle cx={x} cy={y} r="0.8" className="pt-halo" />}
                      <circle cx={x} cy={y} r="0.3" className="pt-dot" />
                      {k >= LOD.names && nm && <text x={nx} y={ny + 0.13} className="pt-name">{nm}</text>}
                      <title>{p.patient?.name || p.mrn} · {p.channel_id}{a ? ` · ${a.message}` : ''}</title>
                    </g>
                  )
                }))}
                {floorGws.map((g) => {
                  const live = gwById.get(String(g.gw_no))
                  const al = gidx.get(String(g.gw_no))
                  const cls = al ? 'gwbad' : !live || !live.connected ? 'gwoff' : live.silent || live.status?.status === 2 ? 'gwbad' : live.status?.status === 1 ? 'gwwarn' : 'gw'
                  // 정상 게이트웨이는 확대했을 때만 — 멀리서는 이상 있는 것만 보인다
                  if (cls === 'gw' && k < LOD.gateway && pick?.gw !== String(g.gw_no)) return null
                  // 에뮬레이터가 준 천장 설치 좌표(환자 상체 무게중심) 그대로. 복도 게이트웨이가 복도 모니터와
                  // 정확히 겹칠 때만 모니터 옆으로 살짝 비켜 그린다 (좌표는 그대로, 그림만)
                  let gx = g.x, gy = g.y
                  if (!cur.rooms.some((r) => r.id === g.room)) {
                    for (const f of cur.fixtures || []) {
                      const fb = fixtureBox(f)
                      if (gx > fb.x - 0.45 && gx < fb.x + fb.w + 0.45 && gy > fb.y - 0.45 && gy < fb.y + fb.h + 0.45) { gx = fb.x + fb.w + 0.55; gy = f.y }
                    }
                  }
                  return (
                    <g key={g.gw_no} className={'gwm ' + cls + (pick?.gw === String(g.gw_no) ? ' picked' : '')} onClick={(e) => { e.stopPropagation(); setPick({ gw: String(g.gw_no) }) }}>
                      <circle cx={gx} cy={gy} r="0.4" className="gw-body" />
                      <path d={`M ${gx - 0.19} ${gy + 0.03} a 0.27 0.27 0 0 1 0.38 0`} className="gw-wave" />
                      <path d={`M ${gx - 0.095} ${gy + 0.13} a 0.135 0.135 0 0 1 0.19 0`} className="gw-wave" />
                      <circle cx={gx} cy={gy + 0.22} r="0.05" className="gw-dot" />
                      <title>{g.id} · {g.type} · {g.room}{live ? ` · ${live.connected ? '연결' : '끊김'} · 패치 ${live.patches} · ${GW_STATUS[live.status?.status] || ''}` : ' · 미접속'}{al ? ` · ${al.message}` : ''}</title>
                    </g>
                  )
                })}
              </g>
            ),
          }}
        />
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
