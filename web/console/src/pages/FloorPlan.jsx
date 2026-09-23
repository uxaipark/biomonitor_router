import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * 층 평면도 렌더러 — 공공 건물 안내도(wayfinding) 스타일.
 *
 * 에뮬레이터 layout JSON 의 미터 좌표를 그대로 SVG 사용자 단위로 쓴다(1 단위 = 1 m).
 * 건축 도면의 관례를 따른다: 벽은 두꺼운 선(poche), 문은 벽을 끊고 열림 방향을 호로 표시, 침대·설비는
 * 방향이 있는 픽토그램, 수직 동선(계단·승강기)은 빗금. 용도별 색은 안내도처럼 파스텔 계열로 구분하고
 * 범례와 축척·방위표를 함께 둔다. 환자·알람·게이트웨이는 그 위에 얹는 별도 레이어(overlay)다.
 */

// 용도 분류 → CSS 클래스 + 범례 이름. layout 의 kind 19종을 8개 계열로 묶는다.
export const CATEGORY = {
  room: ['ward', '병실'],
  isolation: ['isolation', '격리실'],
  nurse_station: ['care', '간호 스테이션'],
  exam: ['clinic', '검사·처치'],
  prep: ['clinic', '검사·처치'],
  recovery: ['clinic', '검사·처치'],
  er: ['clinic', '검사·처치'],
  control: ['clinic', '검사·처치'],
  lobby: ['public', '로비·대기'],
  waiting: ['public', '로비·대기'],
  reception: ['public', '로비·대기'],
  lounge: ['amenity', '편의·휴게'],
  toilet: ['sanitary', '위생'],
  shower: ['sanitary', '위생'],
  staff: ['staff', '직원·사무'],
  office: ['staff', '직원·사무'],
  storage: ['service', '창고·설비'],
  equipment: ['service', '창고·설비'],
  utility: ['service', '창고·설비'],
  stairs: ['vertical', '계단·승강기'],
  elevator: ['vertical', '계단·승강기'],
}
export const LEGEND = [
  ['ward', '병실'], ['isolation', '격리실'], ['care', '간호 스테이션'], ['clinic', '검사·처치'],
  ['public', '로비·대기'], ['amenity', '편의·휴게'], ['sanitary', '위생'], ['staff', '직원·사무'],
  ['service', '창고·설비'], ['vertical', '계단·승강기'],
]
const cat = (kind) => (CATEGORY[kind] || ['other', kind])[0]

const bbox = (poly) => {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** 문: 벽을 지우는 두꺼운 선 + 열림 방향 호. `door` 는 방 기준 방위(N/S/E/W). */
function Door({ r }) {
  const b = bbox(r.poly)
  const w = Math.min(1.1, Math.max(0.8, Math.min(b.w, b.h) * 0.22)) // 문폭 0.8~1.1 m
  let p1, p2, sweep, hinge, dir
  switch (r.door) {
    case 'N': hinge = [b.x + b.w / 2 - w / 2, b.y]; p1 = hinge; p2 = [hinge[0] + w, b.y]; dir = [0, 1]; sweep = 1; break
    case 'S': hinge = [b.x + b.w / 2 + w / 2, b.y + b.h]; p1 = [hinge[0] - w, b.y + b.h]; p2 = hinge; dir = [0, -1]; sweep = 1; break
    case 'W': hinge = [b.x, b.y + b.h / 2 + w / 2]; p1 = [b.x, hinge[1] - w]; p2 = hinge; dir = [1, 0]; sweep = 1; break
    case 'E': hinge = [b.x + b.w, b.y + b.h / 2 - w / 2]; p1 = hinge; p2 = [b.x + b.w, hinge[1] + w]; dir = [-1, 0]; sweep = 1; break
    default: return null
  }
  const leafEnd = [hinge[0] + dir[0] * w, hinge[1] + dir[1] * w]
  const other = p1[0] === hinge[0] && p1[1] === hinge[1] ? p2 : p1
  return (
    <g className="door">
      <line x1={p1[0]} y1={p1[1]} x2={p2[0]} y2={p2[1]} className="door-gap" />
      <path d={`M ${other[0]} ${other[1]} A ${w} ${w} 0 0 ${sweep} ${leafEnd[0]} ${leafEnd[1]}`} className="door-swing" />
      <line x1={hinge[0]} y1={hinge[1]} x2={leafEnd[0]} y2={leafEnd[1]} className="door-leaf" />
    </g>
  )
}

/** 침대 픽토그램: 매트리스 + 베개 + 이불선. 긴 축이 x, `angle` 만큼 회전(데이터 관례). */
function Bed({ b, occupied }) {
  const L = 2.0, W = 0.95
  return (
    <g transform={`rotate(${b.angle || 0} ${b.x} ${b.y})`} className={'bed' + (occupied ? ' occ' : '')}>
      <rect x={b.x - L / 2} y={b.y - W / 2} width={L} height={W} rx={0.12} className="bed-frame" />
      <rect x={b.x - L / 2 + 0.08} y={b.y - W / 2 + 0.08} width={0.52} height={W - 0.16} rx={0.08} className="bed-pillow" />
      <line x1={b.x + 0.1} y1={b.y - W / 2 + 0.06} x2={b.x + 0.1} y2={b.y + W / 2 - 0.06} className="bed-fold" />
    </g>
  )
}

const FIXTURE_LABEL = { display: '모니터', nurse_desk: '간호 데스크', reception: '접수' }

/** 설비 픽토그램: 모니터(화면+받침), 데스크(카운터). */
function Fixture({ f }) {
  const t = `rotate(${f.angle || 0} ${f.x} ${f.y})`
  if (f.type === 'display') {
    return (
      <g className={'fx fx-display' + (f.subtype === 'central' ? ' central' : '')} transform={t}>
        <rect x={f.x - 0.55} y={f.y - 0.36} width={1.1} height={0.72} rx={0.1} className="fx-screen" />
        <line x1={f.x} y1={f.y + 0.36} x2={f.x} y2={f.y + 0.52} className="fx-stem" />
        <line x1={f.x - 0.28} y1={f.y + 0.52} x2={f.x + 0.28} y2={f.y + 0.52} className="fx-stem" />
        <title>{f.label || FIXTURE_LABEL[f.type]}</title>
      </g>
    )
  }
  const w = f.type === 'nurse_desk' ? 2.6 : 2.0
  return (
    <g className="fx fx-desk" transform={t}>
      <rect x={f.x - w / 2} y={f.y - 0.45} width={w} height={0.9} rx={0.15} className="fx-counter" />
      <line x1={f.x - w / 2 + 0.2} y1={f.y} x2={f.x + w / 2 - 0.2} y2={f.y} className="fx-fold" />
      <title>{f.label || FIXTURE_LABEL[f.type] || f.type}</title>
    </g>
  )
}

/** 수직 동선 기호: 계단은 디딤판, 승강기는 대각선 + 문. */
function Vertical({ r }) {
  const b = bbox(r.poly)
  if (r.kind === 'stairs') {
    const n = Math.max(4, Math.min(9, Math.round(b.h / 0.65)))
    return (
      <g className="vert">
        {Array.from({ length: n }, (_, i) => {
          const y = b.y + ((i + 1) * b.h) / (n + 1)
          return <line key={i} x1={b.x + 0.35} y1={y} x2={b.x + b.w - 0.35} y2={y} className="stair-tread" />
        })}
        <path d={`M ${b.x + b.w * 0.5} ${b.y + b.h - 0.5} L ${b.x + b.w * 0.5} ${b.y + 0.7}`} className="stair-arrow" markerEnd="url(#arrow)" />
      </g>
    )
  }
  return (
    <g className="vert">
      <rect x={b.x + 0.3} y={b.y + 0.3} width={b.w - 0.6} height={b.h - 0.6} className="elev-car" />
      <line x1={b.x + 0.3} y1={b.y + 0.3} x2={b.x + b.w - 0.3} y2={b.y + b.h - 0.3} className="elev-x" />
      <line x1={b.x + b.w - 0.3} y1={b.y + 0.3} x2={b.x + 0.3} y2={b.y + b.h - 0.3} className="elev-x" />
    </g>
  )
}

/** 방 이름표: 병실은 번호를 크게, 부가 설명은 아랫줄로. 방 폭에 맞춰 크기를 줄이고 넘치면 자른다. */
function RoomLabel({ r, count }) {
  const b = bbox(r.poly)
  const kindLabel = (CATEGORY[r.kind] || [null, r.kind])[1]
  if (b.w < 1.9 || b.h < 1.4) return null // 너무 좁은 방은 툴팁으로만
  // "02 격리(음압)" 처럼 번호 뒤에 설명이 붙는 이름은 번호만 크게 쓰고 나머지는 아랫줄로 내린다
  const raw = r.name || r.id
  const m = /^(\S+)\s+(.+)$/.exec(raw)
  const head = m ? m[1] : raw
  const tail = m ? m[2] : kindLabel
  const fit = (text, width, max) => {
    const size = Math.min(max, Math.max(0.55, (width * 0.88) / Math.max(text.length, 2)))
    const n = Math.max(2, Math.floor((width * 0.88) / size))
    return [text.length > n ? text.slice(0, n - 1) + '…' : text, size]
  }
  const [name, size] = fit(head, b.w, 1.3)
  const twoLines = b.h >= 2.6
  const [sub, subSize] = fit(tail, b.w, Math.min(0.8, size * 0.7))
  // 환자 수 배지는 방 아래쪽에 — 가운데는 게이트웨이 표식과 겹친다
  const badgeY = Math.min(r.cy + 1.5, b.y + b.h - 0.75)
  return (
    <g className="rlabel" pointerEvents="none">
      <text x={r.cx} y={r.cy + (twoLines ? -0.35 : size * 0.35)} className="rl-name" style={{ fontSize: `${size}px` }}>{name}</text>
      {twoLines && <text x={r.cx} y={r.cy + 0.6} className="rl-kind" style={{ fontSize: `${subSize}px` }}>{sub}</text>}
      {count > 0 && b.h >= 2.2 && (
        <g className="rl-badge">
          <rect x={r.cx - 0.92} y={badgeY - 0.42} width="1.84" height="0.84" rx="0.42" />
          <text x={r.cx} y={badgeY + 0.22} className="rl-count">{count}명</text>
        </g>
      )}
    </g>
  )
}

/** 화면 고정 축척 막대: 현재 배율에서 "깔끔한" 미터 값을 고른다. */
function ScaleBar({ k, height }) {
  const target = 120 / k // 화면 120 px 근처
  const nice = [1, 2, 5, 10, 20, 50, 100].reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
  return (
    <g className="scalebar" transform={`translate(16 ${height - 22})`}>
      <rect x={-6} y={-16} width={nice * k + 52} height={26} rx={5} className="chrome-bg" />
      <line x1={0} y1={0} x2={nice * k} y2={0} className="sb-line" />
      <line x1={0} y1={-4} x2={0} y2={4} className="sb-line" />
      <line x1={nice * k} y1={-4} x2={nice * k} y2={4} className="sb-line" />
      <text x={nice * k + 8} y={3.5} className="sb-text">{nice} m</text>
    </g>
  )
}

export default function FloorPlan({ floor, corridors, rooms, fixtures, patientsByRoom, overlay, onPickRoom, picked }) {
  const wrap = useRef(null)
  const [box, setBox] = useState({ w: 900, h: 560 })
  const [view, setView] = useState(null) // {k, x, y} — k: px per meter
  const W = floor.width, D = floor.depth

  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = useCallback(() => {
    const pad = 28
    const k = Math.min((box.w - pad * 2) / W, (box.h - pad * 2) / D)
    setView({ k, x: (box.w - W * k) / 2, y: (box.h - D * k) / 2 })
  }, [box, W, D])
  useEffect(() => { fit() }, [fit, floor.building_idx, floor.floor])

  const v = view || { k: 1, x: 0, y: 0 }
  const onWheel = (e) => {
    const rect = wrap.current.getBoundingClientRect()
    const mx = e.clientX - rect.left, my = e.clientY - rect.top
    const f = Math.exp(-e.deltaY * 0.0015)
    const k = Math.min(Math.max(v.k * f, 2), 120)
    setView({ k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k })
  }
  const drag = useRef(null)
  const onDown = (e) => { drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y }; wrap.current.setPointerCapture(e.pointerId) }
  const onMove = (e) => {
    if (!drag.current) return
    setView({ k: v.k, x: drag.current.vx + (e.clientX - drag.current.x), y: drag.current.vy + (e.clientY - drag.current.y) })
  }
  const onUp = (e) => { drag.current = null; try { wrap.current.releasePointerCapture(e.pointerId) } catch { /* ignore */ } }

  const grid = useMemo(() => {
    const step = W > 80 ? 10 : 5
    const gx = [], gy = []
    for (let x = step; x < W; x += step) gx.push(x)
    for (let y = step; y < D; y += step) gy.push(y)
    return { gx, gy }
  }, [W, D])

  return (
    <div className="plan-wrap" ref={wrap} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <svg className="plan" width={box.w} height={box.h}>
        <defs>
          <pattern id="hatch" width="1.1" height="1.1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="1.1" className="hatch-line" />
          </pattern>
          <filter id="slab-shadow" x="-6%" y="-6%" width="112%" height="112%">
            <feDropShadow dx="0" dy="1.1" stdDeviation="1.4" floodOpacity="0.20" />
          </filter>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" className="arrow-head" />
          </marker>
        </defs>

        <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
          {/* 바닥 슬래브 + 그림자 */}
          <rect x="0" y="0" width={W} height={D} rx="0.8" className="slab" filter="url(#slab-shadow)" />
          <g className="grid">
            {grid.gx.map((x) => <line key={'x' + x} x1={x} y1="0" x2={x} y2={D} />)}
            {grid.gy.map((y) => <line key={'y' + y} x1="0" y1={y} x2={W} y2={y} />)}
          </g>

          {/* 복도(순환 동선) */}
          {corridors?.map((c, i) => (
            <polygon key={'c' + i} points={c.poly.map((p) => p.join(',')).join(' ')} className="corridor">
              <title>{c.name}</title>
            </polygon>
          ))}

          {/* 방: 채움 → 벽 → 문 순서로 그려야 벽이 채움 위에 얹힌다 */}
          <g className="rooms">
            {rooms.map((r) => {
              const ps = patientsByRoom?.get(r.id) || []
              const sev = overlay?.roomSeverity?.(r, ps)
              return (
                <g key={r.id} className={`rm rm-${cat(r.kind)}${picked === r.id ? ' picked' : ''}${sev ? ` sev-${sev}` : ''}`} onClick={() => onPickRoom?.(r.id)}>
                  <polygon points={r.poly.map((p) => p.join(',')).join(' ')} className="rm-fill" />
                  {(r.kind === 'stairs' || r.kind === 'elevator') && <polygon points={r.poly.map((p) => p.join(',')).join(' ')} className="rm-hatch" />}
                  <title>{r.name || r.id} · {(CATEGORY[r.kind] || [null, r.kind])[1]}{r.ward ? ` · ${r.ward}` : ''}{ps.length ? ` · 환자 ${ps.length}명` : ''}</title>
                </g>
              )
            })}
          </g>

          <g className="walls">
            {rooms.map((r) => <polygon key={r.id} points={r.poly.map((p) => p.join(',')).join(' ')} />)}
            <rect x="0" y="0" width={W} height={D} rx="0.8" className="shell" />
          </g>
          <g className="doors">{rooms.map((r) => <Door key={r.id} r={r} />)}</g>

          {/* 가구·설비 */}
          <g className="furniture">
            {rooms.map((r) => (r.kind === 'stairs' || r.kind === 'elevator' ? <Vertical key={r.id} r={r} /> : null))}
            {rooms.map((r) => r.beds?.map((b, i) => (
              <Bed key={b.id} b={b} occupied={!!(patientsByRoom?.get(r.id) || [])[i]} />
            )))}
            {fixtures?.map((f, i) => <Fixture key={'f' + i} f={f} />)}
          </g>

          <g className="labels">
            {rooms.map((r) => <RoomLabel key={r.id} r={r} count={(patientsByRoom?.get(r.id) || []).length} />)}
          </g>

          {/* 실시간 레이어(환자·게이트웨이) */}
          {overlay?.render?.(v.k)}
        </g>

        {/* 화면 고정 요소 */}
        <ScaleBar k={v.k} height={box.h} />
        <g className="northarrow" transform={`translate(${box.w - 34} 34)`}>
          <circle r="17" className="chrome-bg" />
          <path d="M 0 -11 L 5 6 L 0 2 L -5 6 Z" className="na-needle" />
          <text y="-13.5" className="na-text">N</text>
        </g>
      </svg>
      <div className="plan-zoom">
        <button onClick={() => setView({ ...v, k: Math.min(v.k * 1.3, 120) })} title="확대">+</button>
        <button onClick={() => setView({ ...v, k: Math.max(v.k / 1.3, 2) })} title="축소">−</button>
        <button onClick={fit} title="전체 보기">⤢</button>
      </div>
    </div>
  )
}
