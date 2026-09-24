import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { alarmIndex, gatewayAlarmIndex, GW_STATUS, SEV_LABEL, wardText, wardRoom, patchLife, fmtDays, gwLabel } from '../model.js'
import { openLive } from '../App.jsx'
import { useMe } from '../auth.js'
import Dropdown from '../Dropdown.jsx'
import FloorPlan, { LEGEND, LOD, bedBox, wallSegments, coveragePolygon, polyPoints, COV_OPEN_M } from './FloorPlan.jsx'

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

// 한글 자모 단위 비교 — 에뮬레이터 평면도 검색과 같다: 조합 중인 글자('안재ㅁ')도 '안재민'에 걸린다
const JAMO_L = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ', JAMO_V = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
const JAMO_T = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
const jamo = (str) => {
  let out = ''
  for (const ch of str) {
    const c = ch.charCodeAt(0) - 0xac00
    out += c >= 0 && c < 11172 ? JAMO_L[Math.floor(c / 588)] + JAMO_V[Math.floor((c % 588) / 28)] + JAMO_T[c % 28] : ch
  }
  return out
}

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
  // 표시 모드 — 에뮬레이터 평면도의 '표시' 메뉴와 같다
  //   patients: 환자 + 게이트웨이 + 설비 / gw: 게이트웨이 상태(연결 부하 파이·번호) / coverage: 게이트웨이 음영지역 / plan: 도면만
  const [mode, setMode] = useState(() => {
    try { return localStorage.getItem('map.mode') || (localStorage.getItem('map.cov') === '1' ? 'coverage' : 'patients') } catch { return 'patients' }
  })
  const covMode = mode === 'coverage'
  const [hoverGw, setHoverGw] = useState(null) // 마우스를 올린 게이트웨이 번호 → 반투명 커버리지
  const me = useMe()
  const [tip, setTip] = useState(null) // 호버 팁: { kind: 'pat'|'gw', id, x, y } (화면 좌표)
  // 검색·하이라이트 (에뮬레이터 평면도와 같은 동작): 고르면 그 층으로 가서 빨간 링 + 확대, 검색어를 지우면 원래대로
  const [q, setQ] = useState('')
  const [qOpen, setQOpen] = useState(false)
  const [hl, setHl] = useState(null) // { type: 'patient', id } | { type: 'gw', no } | { type: 'room', id }
  const [focus, setFocus] = useState(undefined) // FloorPlan 확대 요청 { x, y, seq } / null = 원래 배율
  useEffect(() => { try { localStorage.setItem('map.mode', mode) } catch { /* ignore */ } }, [mode])
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
  // 도면의 모든 실 id — 환자의 현재 위치(게이트웨이의 방)가 도면에 있는 실이면 그곳에 그린다
  const roomIds = useMemo(() => new Set(floors.flatMap((f) => (f.rooms || []).map((r) => r.id))), [floors])
  const byRoom = useMemo(() => {
    const m = new Map()
    for (const r of rows || []) {
      if (!r.connected) continue
      // 지금 있는 곳 우선(검사·재활·투석 등으로 이동 중이면 그 실), 모르면 입원 병실
      const room = (r.space && roomIds.has(r.space) ? r.space : '') || r.patient?.room || r.space
      if (!room) continue
      if (!m.has(room)) m.set(room, [])
      m.get(room).push(r)
    }
    return m
  }, [rows, roomIds])
  // building dropdown: connected patients per building (rooms of its floors)
  const buildingOpts = useMemo(() => buildings.map((b) => {
    let n = 0
    for (const f of floors) if (f.building_idx === b.idx) for (const r of f.rooms || []) n += (byRoom.get(r.id) || []).length
    return { value: b.idx, label: b.name, count: n }
  }), [buildings, floors, byRoom])
  const floorGws = useMemo(() => (layout?.gateways || []).filter((g) => cur && g.mount !== 'mobile' && g.building_idx === cur.building_idx && g.floor === cur.floor), [layout, cur])
  // 검색 결과: 환자(이름 자모·MRN·패치 번호·환자 id), 게이트웨이(#번호·ID·방) 각 6개
  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return { pats: [], gws: [] }
    const tj = jamo(t), tn = t.replace(/^#/, '')
    const pats = t.startsWith('#') ? [] : (rows || []).filter((r) => {
      const n = (r.patient?.name || '').toLowerCase()
      return n.includes(t) || jamo(n).includes(tj) || (r.mrn || '').toLowerCase().includes(t) || String(r.channel_id) === t || String(r.patient_id) === t
    }).slice(0, 6)
    const gws = (layout?.gateways || []).filter((g) => g.mount !== 'mobile' && (String(g.gw_no) === tn || gwLabel(g.id).toLowerCase().includes(t) || (g.room || '').toLowerCase().includes(t))).slice(0, 6)
    return { pats, gws }
  }, [q, rows, layout])
  const bIdxByName = useMemo(() => new Map(buildings.map((b) => [b.name, b.idx])), [buildings])
  const pickResult = (it) => {
    setQOpen(false)
    if (it.kind === 'patient') {
      const r = it.row
      const b = bIdxByName.get(r.patient?.building), f = parseInt(r.patient?.floor, 10)
      if (b == null || !f || !floors.some((x) => x.building_idx === b && x.floor === f)) { setHl(null); window.alert('현재 도면에 없음 (원외·이동 중)'); return }
      setSel({ b, f }); setHl({ type: 'patient', id: String(r.channel_id) })
    } else {
      const g = it.g
      setSel({ b: g.building_idx, f: g.floor }); setHl({ type: 'gw', no: String(g.gw_no) })
    }
  }
  const clearSearch = (v) => { setQ(v); if (!v.trim() && hl) { setHl(null); setFocus(null) } }
  // 다른 목록에서 넘어온 링크: #/map?pat=<패치> | ?gw=<번호> | ?room=<병실 id> — 그 층으로 가서 강조 (주소가 바뀔 때마다 한 번)
  const [linked, setLinked] = useState('')
  useEffect(() => {
    const qs = new URLSearchParams((hash || '').split('?')[1] || '')
    const key = ['pat', 'gw', 'room'].map((k) => qs.get(k) || '').join('|')
    if (key === '||' || key === linked || !layout || !rows) return
    setLinked(key)
    const pat = qs.get('pat'), gwq = qs.get('gw'), room = qs.get('room')
    if (pat) { const r = rows.find((x) => x.channel_id === pat); if (r) pickResult({ kind: 'patient', row: r }) }
    else if (gwq) { const g = (layout.gateways || []).find((x) => String(x.gw_no) === gwq && x.mount !== 'mobile'); if (g) { pickResult({ kind: 'gw', g }); setPick({ gw: gwq }) } }
    else if (room) {
      const f = floors.find((x) => (x.rooms || []).some((r) => r.id === room))
      if (f) { setSel({ b: f.building_idx, f: f.floor }); setPick({ room }); setHl({ type: 'room', id: room }) }
    }
  }, [hash, layout, rows]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const hlPoint = useMemo(() => {
    if (!hl || !cur) return null
    if (hl.type === 'patient') { const L = nameLayout.get(hl.id); return L ? { x: L.px + L.dx, y: L.py } : null }
    if (hl.type === 'room') {
      const r = (cur.rooms || []).find((x) => x.id === hl.id)
      if (!r?.poly?.length) return null
      const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1])
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
    }
    const g = floorGws.find((x) => String(x.gw_no) === hl.no)
    return g ? { x: g.x, y: g.y } : null
  }, [hl, cur, nameLayout, floorGws])
  const hlKey = hl && hlPoint ? `${hl.type}:${hl.id || hl.no}:${cur?.building_idx}:${cur?.floor}` : null
  useEffect(() => { if (hlKey) setFocus({ x: hlPoint.x, y: hlPoint.y, seq: hlKey + Date.now() }) }, [hlKey]) // eslint-disable-line react-hooks/exhaustive-deps
  // 빨간 링은 5초만 — 확대와 검색어는 그대로 두고 링만 사라진다
  const [ringOn, setRingOn] = useState(false)
  useEffect(() => {
    if (!hlKey) { setRingOn(false); return }
    setRingOn(true)
    const t = setTimeout(() => setRingOn(false), 5000)
    return () => clearTimeout(t)
  }, [hlKey])

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
        <span className="map-search">
          <input value={q} placeholder="환자·게이트웨이 검색" title="환자: 이름(자모 일부도 됨)·MRN·패치 번호 / 게이트웨이: #번호·ID·방" onChange={(e) => { clearSearch(e.target.value); setQOpen(true) }}
            onFocus={() => setQOpen(true)} onBlur={() => setTimeout(() => setQOpen(false), 150)} onKeyDown={(e) => { if (e.key === 'Escape') { clearSearch(''); e.currentTarget.blur() } }} />
          {q && <button type="button" className="ms-clear" title="검색어 지우기 (하이라이트·확대도 원래대로)" aria-label="검색어 지우기" onMouseDown={(e) => e.preventDefault()} onClick={() => { clearSearch(''); setQOpen(false) }}>×</button>}
          {qOpen && q.trim() && (
            <div className="ms-list">
              {results.pats.map((r) => (
                <div key={'p' + r.channel_id} className="ms-item" onMouseDown={() => pickResult({ kind: 'patient', row: r })}>
                  🧑‍⚕️ <b>{r.patient?.name || r.mrn}</b> <small>{r.patient?.bed || r.patient?.room || ''} · {r.patient?.ward || ''} · {r.patient?.building || ''} {r.patient?.floor ? r.patient.floor + 'F' : ''}</small>
                </div>
              ))}
              {results.gws.map((g) => (
                <div key={'g' + g.gw_no} className="ms-item" onMouseDown={() => pickResult({ kind: 'gw', g })}>
                  📡 <b>{gwLabel(g.id)}</b> #{g.gw_no} <small>{buildings.find((b) => b.idx === g.building_idx)?.name || ''} {g.floor}F {g.room || ''}</small>
                </div>
              ))}
              {!results.pats.length && !results.gws.length && <div className="ms-empty">결과 없음</div>}
            </div>
          )}
        </span>
        <span className="map-mode"><small>표시</small>
          <Dropdown value={mode} onChange={setMode} searchable={false} width={220} options={[
            { value: 'patients', label: '환자 + 게이트웨이 + 설비' },
            { value: 'gw', label: '게이트웨이 상태' },
            { value: 'coverage', label: '게이트웨이 음영지역' },
            { value: 'plan', label: '도면만' },
          ]} />
        </span>
        <span className="legend">
          {mode === 'patients' && <>환자 신호 <i className="dot q-good" />양호 <i className="dot q-fair" />보통 <i className="dot q-weak" />약함 <i className="dot q-poor" />매우 약함 <i className="dot q-lost" />끊김 <i className="dot gw" /> 게이트웨이</>}
          {(mode === 'gw' || mode === 'coverage') && <><i className="dot gw" />정상 <i className="dot gwwarn" />저하 <i className="dot gwbad" />장애 <i className="dot gwoff" />미접속 · 바깥 호 = 연결 패치/최대{mode === 'coverage' ? ' · 빗금 = 음영지역' : ''} · 마우스를 올리면 커버리지</>}
          {mode === 'plan' && <>방·벽·문·침대만 표시</>}
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
          showFixtures={mode !== 'plan'}
          focus={focus}
          patientsByRoom={byRoom}
          picked={pick?.room}
          onPickRoom={(id) => setPick({ room: id })}
          overlay={{
            // 방 색을 가장 위중한 알람으로 물들인다 (환자 점과 별개로 멀리서도 보이게)
            roomSeverity: (r, ps) => mode !== 'patients' ? null : ps.reduce((w, p) => {
              const a = aidx.get(p.channel_id)
              return a && (!w || SEV_RANK[a.severity] > SEV_RANK[w]) ? a.severity : w
            }, null),
            // EMR 이 준 침대 id(p.patient.bed)가 그 방의 침대면 그 자리, 아니면 남은 빈 침대 순서대로
            bedOccupied: (r, b) => mode === 'patients' && !!placeInRoom(r).beds.get(b.id),
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
                {hlPoint && ringOn && (
                  <g className="hl" pointerEvents="none">
                    <circle cx={hlPoint.x} cy={hlPoint.y} r="1.6" className="hl-ring">
                      <animate attributeName="r" values="1.2;2.16;1.2" dur="1.4s" repeatCount="indefinite" />
                      <animate attributeName="stroke-opacity" values="1;0.35;1" dur="1.4s" repeatCount="indefinite" />
                    </circle>
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
                {/* 위험·높음 환자의 깜박이는 원판은 모든 환자 표식 아래 층에 — 이웃 환자 아이콘·이름을 가리지 않게 */}
                {mode === 'patients' && cur.rooms.map((r) => (byRoom.get(r.id) || []).map((p) => {
                  const L = nameLayout.get(p.channel_id), a = aidx.get(p.channel_id)
                  if (!L || !a || (a.severity !== 'critical' && a.severity !== 'high')) return null
                  return <g key={'b' + p.channel_id} className={`pat urgent sev-${a.severity}` + (a.acked ? ' acked' : '')} pointerEvents="none" transform={L.dx ? `translate(${L.dx.toFixed(2)} 0)` : undefined}><circle cx={L.px} cy={L.py} r="1.5" className="pat-beacon" /></g>
                }))}
                {mode === 'patients' && cur.rooms.map((r) => (byRoom.get(r.id) || []).map((p, i) => {
                  const L = nameLayout.get(p.channel_id)
                  if (!L) return null
                  const { px, py, tx, toLeft, dx, fs, name } = L
                  const a = aidx.get(p.channel_id)
                  const lost = !p.connected || p.stale
                  const q = lost ? 'lost' : p.rssi >= -60 ? 'good' : p.rssi >= -72 ? 'fair' : p.rssi >= -82 ? 'weak' : 'poor'
                  const leadOff = (p.flags & 0x01) !== 0
                  const urgent = a && (a.severity === 'critical' || a.severity === 'high')
                  return (
                    <g key={p.channel_id} className={'pat q-' + q + (a ? ` sev-${a.severity}` : '') + (urgent ? ' urgent' : '') + (a?.acked ? ' acked' : '')} transform={dx ? `translate(${dx.toFixed(2)} 0)` : undefined} onClick={(e) => { e.stopPropagation(); setTip(null); openLive(p.channel_id) }}
                      onMouseEnter={(e) => setTip({ kind: 'pat', id: p.channel_id, x: e.clientX, y: e.clientY })} onMouseMove={(e) => setTip({ kind: 'pat', id: p.channel_id, x: e.clientX, y: e.clientY })} onMouseLeave={() => setTip(null)}>
                      {/* 위험·높음: 알람색 아이콘 + 알람색 이름표 (깜박이는 원판은 아래 층) */}
                      {a && !urgent && <circle cx={px} cy={py} r="0.72" className="pat-halo" />}
                      <circle cx={px} cy={py} r="0.45" className="pat-body" />
                      <circle cx={px} cy={py - 0.1} r="0.15" className="pat-head" />
                      <path d={`M${px - 0.26},${py + 0.32} a0.26,0.26 0 0 1 0.52,0`} className="pat-head" />
                      {leadOff && !urgent && <circle cx={px + 0.36} cy={py - 0.36} r="0.14" className="pat-lead" />}
                      {urgent && (() => { const w = textWidth(name, fs) + 0.3; return <rect x={toLeft ? tx - w + 0.15 : tx - 0.15} y={py + 0.2 - fs} width={w} height={fs * 1.3} rx={fs * 0.3} className="plbl-bg" /> })()}
                      <text x={tx} y={py + 0.2} className={'plbl' + (toLeft ? ' left' : '')} style={fs !== 0.52 ? { fontSize: `${fs}px` } : undefined}>{name}</text>
                    </g>
                  )
                }))}
                {mode !== 'plan' && floorGws.map((g) => {
                  const live = gwById.get(String(g.gw_no))
                  const al = gidx.get(String(g.gw_no))
                  const cls = al ? 'gwbad' : !live || !live.connected ? 'gwoff' : live.silent || live.status?.status === 2 ? 'gwbad' : live.status?.status === 1 ? 'gwwarn' : 'gw'
                  // 아이콘은 배율과 상관없이 항상. 멀리서(환자 표시 모드)는 번호 글자만 숨겨 환자 이름과 겹치지 않게
                  const showNo = !(k < LOD.gateway && mode === 'patients' && cls === 'gw' && pick?.gw !== String(g.gw_no))
                  const detail = mode === 'gw' || mode === 'coverage' // 상태 모드: 연결 부하 파이 + 번호
                  const load = detail && live && g.capacity ? Math.min(0.9999, (live.patches || 0) / g.capacity) : 0
                  // 게이트웨이는 에뮬레이터가 준 천장 설치 좌표 그대로 그린다 — 물리적 위치이므로 어떤 표기 때문에도 옮기지 않는다.
                  // (방 이름표·환자 이름이 게이트웨이를 피해 간다)
                  const gx = g.x, gy = g.y
                  return (
                    <g key={g.gw_no} className={'gwm ' + cls + (pick?.gw === String(g.gw_no) ? ' picked' : '')} onClick={(e) => { e.stopPropagation(); setPick({ gw: String(g.gw_no) }) }}
                      onMouseEnter={(e) => { setHoverGw(String(g.gw_no)); setTip({ kind: 'gw', id: String(g.gw_no), x: e.clientX, y: e.clientY }) }}
                      onMouseMove={(e) => setTip({ kind: 'gw', id: String(g.gw_no), x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => { setHoverGw(null); setTip(null) }}>
                      {/* 게이트웨이 아이콘은 모든 모드에서 같은 것(파란 원 + 와이파이). 상태 모드에서는 바깥 호로 연결 부하, 아래에 번호 */}
                      {detail && <circle cx={gx} cy={gy} r="0.58" className="gw-load-track" />}
                      {detail && load > 0 && (() => { const R = 0.58, a = load * 2 * Math.PI, ex = gx + R * Math.sin(a), ey = gy - R * Math.cos(a)
                        return <path d={`M${gx},${(gy - R).toFixed(3)} A${R},${R} 0 ${a > Math.PI ? 1 : 0} 1 ${ex.toFixed(3)},${ey.toFixed(3)}`} className="gw-load" /> })()}
                      {/* 에뮬레이터와 같은 아이콘(ROUTER_FLOORPLAN.md §6): 채운 원 r0.36 + 흰 테두리, 흰 와이파이 점과 위로 퍼지는 호 두 개 */}
                      <circle cx={gx} cy={gy} r="0.36" className="gw-body" />
                      <circle cx={gx} cy={gy + 0.13} r="0.045" className="gw-dot" />
                      {[0.13, 0.24].map((r) => { const cy = gy + 0.13, k = Math.SQRT1_2
                        return <path key={r} d={`M${(gx - r * k).toFixed(3)},${(cy - r * k).toFixed(3)} A${r},${r} 0 0 1 ${(gx + r * k).toFixed(3)},${(cy - r * k).toFixed(3)}`} className="gw-wave" /> })}
                      {/* 게이트웨이 번호는 고유번호 — 숫자만 아이콘 아래에 작게 */}
                      {showNo && <text x={gx} y={gy + (detail ? 0.95 : 0.78)} className="gw-no">{g.gw_no}</text>}
                    </g>
                  )
                })}
              </g>
            ),
          }}
        />
        {tip && <MapTip tip={tip} row={tip.kind === 'pat' ? (rows || []).find((r) => r.channel_id === tip.id) : null}
          gw={tip.kind === 'gw' ? floorGws.find((x) => String(x.gw_no) === tip.id) : null} live={tip.kind === 'gw' ? gwById.get(tip.id) : null}
          alarm={tip.kind === 'pat' ? aidx.get(tip.id) : gidx.get(tip.id)} platform={!me?.user?.tenant_id} />}
        <aside className="map-side">
          {pickRoom && <><h4>{pickRoom.id} <small>{pickRoom.kind} · {pickRoom.ward}</small></h4><small className="muted">게이트웨이 {pickRoom.gateway ? '있음' : '없음'} · 침대 {pickRoom.beds?.length || 0}</small></>}
          {pickGw && <><h4>{gwLabel(pickGw.id)} <small>{pickGw.type}</small></h4><GwInfo g={gwById.get(String(pickGw.gw_no))} />
            {pickPatients.length > 0
              ? <p><a href={`#/viewer?tpl=central&gw=${pickGw.gw_no}`} target="_blank" rel="noopener"><button className="primary">중앙 모니터 열기 (새 탭)</button></a></p>
              : <p className="muted">이 게이트웨이에 연결된 환자가 없습니다.</p>}</>}
          {pickRoom && pickPatients.length > 0 && <p><a href={`#/viewer?tpl=central&room=${encodeURIComponent(pickRoom.id)}`} target="_blank" rel="noopener"><button className="primary">이 병실 중앙 모니터 (새 탭)</button></a></p>}
          {pickRoom && !pickPatients.length && <p className="muted">이 병실에 연결된 환자가 없습니다.</p>}
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

const SEX = { M: '남', F: '여' }
const ageOf = (birth) => { const y = +(String(birth || '').slice(0, 4)); return y > 1900 ? new Date().getFullYear() - y : null }
const fmtUp = (s) => (s == null ? '—' : s >= 86400 ? `${Math.floor(s / 86400)}일 ${Math.floor((s % 86400) / 3600)}시간` : s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor((s % 3600) / 60)}분` : `${Math.floor(s / 60)}분`)

/**
 * 지도 호버 팁: 환자·게이트웨이 기본 정보 (마우스 옆, 화면 가장자리에서는 반대쪽으로). 한 항목 = 한 줄(넘치면 말줄임).
 * 순서: 병원 계정 = 위치·진료·담당·바이탈 먼저, 패치·게이트웨이는 아래 / 플랫폼 계정 = 패치·신호·게이트웨이 먼저.
 */
function MapTip({ tip, row, gw, live, alarm, platform }) {
  const W = 375, H = 280
  const left = tip.x + 16 + W > window.innerWidth ? tip.x - 16 - W : tip.x + 16
  const top = Math.max(8, Math.min(tip.y + 12, window.innerHeight - H - 8))
  const R = (k, v, cls) => (v == null || v === '' ? null : <React.Fragment key={k}><dt>{k}</dt><dd className={cls} title={typeof v === 'string' ? v : undefined}>{v}</dd></React.Fragment>)
  let body = null
  if (row) {
    const p = row.patient || {}
    const v = row.vitals || {}
    const life = patchLife(row, row.battery)
    const age = ageOf(p.birth)
    const place = wardRoom(p.room || row.space)
    const lost = !row.connected || row.stale
    const clinical = [
      R('위치', [wardText(p.ward), place?.room || p.room, p.bed ? `${p.bed.slice(-1)} 침대` : null].filter(Boolean).join(' · ') || row.space),
      R('진료', [p.department, p.diagnosis].filter(Boolean).join(' · ')),
      R('담당', [p.doctor && `의사 ${p.doctor}`, p.nurse && `간호사 ${p.nurse}`].filter(Boolean).join(' · ')),
      R('바이탈', lost ? <span className="muted">수신 없음</span> : <>HR <b>{v.hr ?? '—'}</b> · SpO₂ <b>{v.spo2 ?? '—'}</b> · RR <b>{v.resp ?? '—'}</b>{v.temp != null ? <> · <b>{v.temp.toFixed(1)}</b>°C</> : null}</>),
      R('MRN', row.mrn, 'mono'),
    ]
    const device = [
      R('패치', `${row.channel_id} · 배터리 ${row.battery ?? '—'}%${life?.batLeft != null ? ` (약 ${fmtDays(life.batLeft)})` : ''}`, 'mono'),
      life && R('착용', `${fmtDays(life.worn)}째 · 교체 ${life.left <= 0 ? '지금' : `${fmtDays(life.left)} 뒤`} (${life.reason})`, life.level ? `mt-${life.level}` : ''),
      R('신호', `RSSI ${row.rssi ?? '—'} dBm · ${row.connected ? (row.stale ? '수신 지연' : '수신 중') : '해제'}`),
      R('게이트웨이', row.gateway_id, 'mono'),
    ]
    body = (
      <>
        <div className="mt-head"><b>{p.name || row.mrn || row.channel_id}</b><span>{[SEX[p.sex] || p.sex, age != null ? `${age}세` : null].filter(Boolean).join(' · ')}</span></div>
        {alarm && <div className={`mt-alarm sev-${alarm.severity}`}>{SEV_LABEL[alarm.severity]} · {alarm.message}</div>}
        <dl>{platform ? [...device, ...clinical] : [...clinical, ...device]}</dl>
        <div className="mt-foot">누르면 실시간 파형</div>
      </>
    )
  } else if (gw) {
    const st = live?.status || {}
    const place = [R('설치 위치', gw.room), R('상태', `${!live ? '미접속' : !live.connected ? '끊김' : live.silent ? '무응답' : '연결'}${live && st.status != null ? ` · ${GW_STATUS[st.status] || ''}` : ''}`), R('연결 패치', `${live?.patches ?? 0} / ${gw.capacity || '—'}`)]
    const tech = live ? [
      R('CPU · MEM · NET', `${st.cpu ?? '—'}% · ${st.mem ?? '—'}% · ${st.net ?? '—'}%`),
      R('WAN · 온도', `${st.wan_rssi ?? '—'} dBm · ${st.temp ?? '—'}°C`),
      R('가동', fmtUp(st.uptime ?? st.uptime_s)),
      R('수신', `프레임 ${live.frames?.toLocaleString?.() ?? '—'} · NACK ${live.nack_tx ?? 0} · 복구 ${live.recovered ?? 0}`),
    ] : []
    body = (
      <>
        <div className="mt-head"><b>{gwLabel(gw.id)}</b><span>#{gw.gw_no} · {gw.type}</span></div>
        {alarm && <div className={`mt-alarm sev-${alarm.severity}`}>{SEV_LABEL[alarm.severity]} · {alarm.message}</div>}
        <dl>{platform ? [place[1], place[2], ...tech, place[0]] : [...place, ...tech]}</dl>
        <div className="mt-foot">누르면 상세 · 올려 두면 커버리지</div>
      </>
    )
  }
  if (!body) return null
  return <div className="map-tip" style={{ left, top, width: W }}>{body}</div>
}
