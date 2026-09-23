import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { alarmIndex, gatewayAlarmIndex, GW_STATUS } from '../model.js'
import { openLive } from '../App.jsx'
import Dropdown from '../Dropdown.jsx'
import FloorPlan, { LEGEND, LOD, fixtureBox, bedBox, wallSegments, coveragePolygon, polyPoints, COV_OPEN_M } from './FloorPlan.jsx'

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

// 글자 폭(m) — 에뮬레이터 app.js textWidth 와 같은 근사: 한글·한자·가나 0.98, 대문자·숫자 0.66, 공백 0.32, 그 밖 0.56 (× 글자 크기)
const textWidth = (str, fs) => {
  let w = 0
  for (const ch of str) w += (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u4E00-\u9FFF\u3040-\u30FF]/.test(ch) ? 0.98 : /[A-Z0-9#]/.test(ch) ? 0.66 : ch === ' ' ? 0.32 : 0.56) * fs
  return w
}


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
  const [covMode, setCovMode] = useState(() => { try { return localStorage.getItem('map.cov') === '1' } catch { return false } })
  const [hoverGw, setHoverGw] = useState(null) // 마우스를 올린 게이트웨이 번호 → 반투명 커버리지
  useEffect(() => { try { localStorage.setItem('map.cov', covMode ? '1' : '0') } catch { /* ignore */ } }, [covMode])
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
  // RF 커버리지: 벽 선분과 게이트웨이별 다각형은 층이 바뀔 때만 다시 계산한다 (광선 240개 × 벽 수 × 게이트웨이 수)
  const covPolys = useMemo(() => {
    if (!cur) return new Map()
    const segs = wallSegments(cur.rooms)
    return new Map(floorGws.map((g) => [String(g.gw_no), coveragePolygon(g.x, g.y, segs, cur.width, cur.depth)]))
  }, [cur, floorGws])
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
  // 환자 표식 배치 (에뮬레이터 표기): 침대에 누운 환자는 아이콘을 머리 쪽 끝에, 이름은 가운데 통로 쪽으로.
  // 이름은 자르지 않는다 — ① 마주 보는 두 이름은 통로를 길이에 비례해 나누고 ② 벽이나 다른 침대에 닿으면 표식을
  // 반대쪽으로 옮기고(벽은 넘지 않음) ③ 그래도 모자라면 그 이름만 글자를 줄인다.
  const nameLayout = useMemo(() => {
    const out = new Map()
    const FS = 0.52
    for (const r of cur?.rooms || []) {
      const ps = byRoom.get(r.id) || []
      if (!ps.length) continue
      const pl = placements.get(r.id)
      const xs = r.poly.map((q) => q[0])
      const xmin = Math.min(...xs) + 0.12, xmax = Math.max(...xs) - 0.12
      const items = ps.map((p, i) => {
        const bed = pl?.byPatient.get(p.channel_id)
        const toLeft = !!bed && ((Math.round(bed.angle || 0) % 360) + 360) % 360 === 90
        const px = bed ? (toLeft ? bed.x + 0.85 : bed.x - 0.85) : r.cx + ((i % 3) - 1) * 2.4 - 0.6
        const py = bed ? bed.y : r.cy + 1.6 + Math.floor(i / 3) * 1.1
        const name = p.patient?.name || p.mrn || ''
        return { p, bed, toLeft, px, py, tx: toLeft ? px - 0.58 : px + 0.58, name, w: textWidth(name, FS), fs: FS, dx: 0, cap: Infinity }
      })
      // 쓰는 방향의 막힘: 벽, 또는 같은 줄에서 짝이 아닌 다른 침대
      const occupied = new Set(items.map((it) => it.bed).filter(Boolean))
      for (const it of items) {
        let stop = it.toLeft ? xmin : xmax
        for (const ob of r.beds || []) {
          if (ob === it.bed || occupied.has(ob)) continue // 환자가 누운 침대는 짝으로 따로 처리
          const bb = bedBox(ob)
          if (bb.y >= it.py + 0.3 || bb.y + bb.h <= it.py - 0.3) continue
          if (!it.toLeft && bb.x > it.tx - 0.05) stop = Math.min(stop, bb.x - 0.1)
          if (it.toLeft && bb.x + bb.w < it.tx + 0.05) stop = Math.max(stop, bb.x + bb.w + 0.1)
        }
        it.cap = it.toLeft ? it.tx - stop : stop - it.tx
      }
      // ① 마주 보는 짝: 오른쪽으로 쓰는 A 와 그 오른편에서 왼쪽으로 쓰는 가장 가까운 B
      for (const a of items) {
        if (a.toLeft) continue
        const b = items.filter((o) => o.toLeft && Math.abs(o.py - a.py) < 0.6 && o.tx > a.tx).sort((u, v) => u.tx - v.tx)[0]
        if (!b) continue
        const avail = b.tx - a.tx - 0.2
        if (a.w + b.w <= avail) { a.cap = Math.min(a.cap, avail - b.w); b.cap = Math.min(b.cap, avail - a.w); continue }
        // 둘 다 못 들어가면 짧은 이름은 제 크기를 지키고(통로 절반까지) 긴 이름이 나머지를 쓴다
        const [short, long] = a.w <= b.w ? [a, b] : [b, a]
        const keep = Math.min(short.w, avail / 2)
        short.cap = Math.min(short.cap, keep); long.cap = Math.min(long.cap, avail - keep)
      }
      // ② 벽·침대에 닿으면 표식을 반대쪽으로 (아이콘이 방 밖으로 나가지 않는 만큼만) ③ 그래도 넘치면 글자 축소
      for (const it of items) {
        let over = it.w - it.cap
        if (over <= 0) continue
        const room = it.toLeft ? xmax - (it.px + 0.45) : it.px - 0.45 - xmin // 반대쪽으로 갈 수 있는 여유
        const mv = Math.max(0, Math.min(over, room))
        it.dx = it.toLeft ? mv : -mv
        over -= mv
        if (over > 0) it.fs = Math.max(0.34, FS * (it.cap + mv) / it.w)
      }
      for (const it of items) out.set(it.p.channel_id, it)
    }
    return out
  }, [cur, byRoom, placements])

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
        <button className={covMode ? 'primary' : ''} onClick={() => setCovMode(!covMode)} title="모든 게이트웨이의 커버리지를 합쳐 음영지역(빗금)을 표시합니다. 게이트웨이에 마우스를 올리면 그 게이트웨이의 커버리지가 보입니다.">커버리지</button>
        <span className="legend">
          환자 신호 <i className="dot q-good" />양호 <i className="dot q-fair" />보통 <i className="dot q-weak" />약함 <i className="dot q-poor" />매우 약함 <i className="dot q-lost" />끊김
          <i className="dot gw" /> 게이트웨이
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
                {/* 커버리지: 음영지역 모드는 층 전체를 회색 빗금으로 덮고 모든 게이트웨이 영역을 도려낸다 — 남은 곳이 음영지역 */}
                {covMode && (
                  <g pointerEvents="none">
                    <mask id="covmask" maskUnits="userSpaceOnUse" x="-1" y="-1" width={cur.width + 2} height={cur.depth + 2}>
                      <rect x="-1" y="-1" width={cur.width + 2} height={cur.depth + 2} fill="#fff" />
                      <g filter="url(#covblur)">{[...covPolys.values()].map((pts, i) => <polygon key={i} points={polyPoints(pts)} fill="#000" />)}</g>
                    </mask>
                    <g mask="url(#covmask)">
                      <rect x="0" y="0" width={cur.width} height={cur.depth} className="cov-dead" />
                      <rect x="0" y="0" width={cur.width} height={cur.depth} fill="url(#covhatch)" />
                    </g>
                  </g>
                )}
                {hoverGw && covPolys.get(hoverGw) && (() => {
                  const g = floorGws.find((x) => String(x.gw_no) === hoverGw)
                  return (
                    <g pointerEvents="none">
                      <polygon points={polyPoints(covPolys.get(hoverGw))} className="cov-area" filter="url(#covblur)" />
                      <circle cx={g.x} cy={g.y} r={COV_OPEN_M} className="cov-ring" />
                    </g>
                  )
                })()}
                {cur.rooms.map((r) => (byRoom.get(r.id) || []).map((p, i) => {
                  const L = nameLayout.get(p.channel_id)
                  if (!L) return null
                  const { px, py, tx, toLeft, dx, fs, name } = L
                  const a = aidx.get(p.channel_id)
                  const lost = !p.connected || p.stale
                  const q = lost ? 'lost' : p.rssi >= -60 ? 'good' : p.rssi >= -72 ? 'fair' : p.rssi >= -82 ? 'weak' : 'poor'
                  const leadOff = (p.flags & 0x01) !== 0
                  return (
                    <g key={p.channel_id} className={'pat q-' + q + (a ? ` sev-${a.severity}` : '')} transform={dx ? `translate(${dx.toFixed(2)} 0)` : undefined} onClick={(e) => { e.stopPropagation(); openLive(p.channel_id) }}>
                      {a && <circle cx={px} cy={py} r="0.72" className="pat-halo" />}
                      <circle cx={px} cy={py} r="0.45" className="pat-body" />
                      <circle cx={px} cy={py - 0.1} r="0.15" className="pat-head" />
                      <path d={`M${px - 0.26},${py + 0.32} a0.26,0.26 0 0 1 0.52,0`} className="pat-head" />
                      {leadOff && <circle cx={px + 0.36} cy={py - 0.36} r="0.14" className="pat-lead" />}
                      <text x={tx} y={py + 0.2} className={'plbl' + (toLeft ? ' left' : '')} style={fs !== 0.52 ? { fontSize: `${fs}px` } : undefined}>{name}</text>
                      <title>{name} · {p.channel_id} · RSSI {p.rssi ?? '—'} dBm{leadOff ? ' · 리드오프' : ''}{p.battery != null ? ` · 배터리 ${p.battery}%` : ''}{a ? ` · ${a.message}` : ''}</title>
                    </g>
                  )
                }))}
                {floorGws.map((g) => {
                  const live = gwById.get(String(g.gw_no))
                  const al = gidx.get(String(g.gw_no))
                  const cls = al ? 'gwbad' : !live || !live.connected ? 'gwoff' : live.silent || live.status?.status === 2 ? 'gwbad' : live.status?.status === 1 ? 'gwwarn' : 'gw'
                  // 정상 게이트웨이는 확대했을 때만 — 멀리서는 이상 있는 것만 보인다
                  if (cls === 'gw' && k < LOD.gateway && !covMode && pick?.gw !== String(g.gw_no)) return null
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
                    <g key={g.gw_no} className={'gwm ' + cls + (pick?.gw === String(g.gw_no) ? ' picked' : '')} onClick={(e) => { e.stopPropagation(); setPick({ gw: String(g.gw_no) }) }}
                      onMouseEnter={() => setHoverGw(String(g.gw_no))} onMouseLeave={() => setHoverGw(null)}>
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
