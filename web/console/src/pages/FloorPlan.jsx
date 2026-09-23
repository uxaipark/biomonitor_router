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

/** 침대 로컬 좌표(긴 축 = x, 베개는 -x 끝) → 도면 좌표. 환자 점은 베개, 이름은 이불 위에 놓는다. */
export function bedPoint(b, lx, ly = 0) {
  const a = ((b.angle || 0) * Math.PI) / 180
  return [b.x + lx * Math.cos(a) - ly * Math.sin(a), b.y + lx * Math.sin(a) + ly * Math.cos(a)]
}
export const BED_HEAD = -0.66 // 베개 중심
export const BED_BODY = 0.32 // 이불 중심

/** 침대·설비가 차지하는 사각형(축 정렬 근사). 대부분 0/90/180/270° 라 근사로 충분하다. */
const quarter = (a) => Math.abs(Math.round((a || 0) / 90)) % 2 === 1
export function bedBox(b) {
  const [w, h] = quarter(b.angle) ? [0.95, 2.0] : [2.0, 0.95]
  return { x: b.x - w / 2, y: b.y - h / 2, w, h }
}
export function fixtureBox(f) {
  const [lw, lh] = f.type === 'display' ? [1.1, 0.9] : [f.type === 'nurse_desk' ? 2.6 : 2.0, 0.9]
  const [w, h] = quarter(f.angle) ? [lh, lw] : [lw, lh]
  return { x: f.x - w / 2, y: f.y - h / 2, w, h }
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** 확대 배율(px/m)에 따라 보이는 정보를 늘린다 — 멀리서는 방 번호만, 가까이서 부가 정보. */
export const LOD = { sub: 14, gateway: 22, names: 34 }

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

/** 글자 배치: 폭에 맞춰 크기를 정하고, 너무 작아지면 '/'·공백·'·' 근처에서 두 줄로 나눈다. 그래도 넘치면 자른다. */
function layoutText(text, width, max, allowWrap) {
  const one = Math.min(max, (width * 0.86) / Math.max(text.length, 2))
  const cut = (t, size) => {
    // +1e-6: 폭에 딱 맞는 글자 수가 부동소수점으로 6.9999… 가 되어 한 글자를 잘라내던 것을 막는다
    const n = Math.max(2, Math.floor((width * 0.86) / size + 1e-6))
    return t.length > n ? t.slice(0, n - 1) + '…' : t
  }
  if (!allowWrap || one >= 0.72 || text.length < 4) {
    const size = Math.max(0.55, one)
    return { lines: [cut(text, size)], size }
  }
  // 가운데에서 가장 가까운 구분자를 찾아 두 줄로
  const mid = text.length / 2
  let at = -1
  for (let i = 1; i < text.length - 1; i++) if ('/ ·'.includes(text[i]) && (at < 0 || Math.abs(i - mid) < Math.abs(at - mid))) at = i
  if (at < 0) at = Math.round(mid)
  const l1 = text.slice(0, text[at] === '/' ? at + 1 : at).trim(), l2 = text.slice(at).replace(/^[\s·/]+/, '').trim()
  const two = Math.min(max, (width * 0.86) / Math.max(l1.length, l2.length, 2))
  if (two < one * 1.2) return { lines: [cut(text, Math.max(0.55, one))], size: Math.max(0.55, one) }
  const size = Math.max(0.55, two)
  return { lines: [cut(l1, size), cut(l2, size)], size }
}

/** 방 이름표 — 겹침을 줄이려고 정보량을 배율과 방 성격에 맞추고, 침대·설비를 피해 가장 빈 자리에 놓는다.
 *  병실: 번호만 크게 (격리·음압 같은 부가 설명이 있을 때만 아랫줄). 침대가 있으면 인원은 침대 위 점이 대신한다.
 *  그 밖의 방: 이름(길면 두 줄) + (확대 시) 용도. 침대 없는 방에 환자가 있으면 인원 배지를 아래쪽에. */
function RoomLabel({ r, count, k, obstacles }) {
  const b = bbox(r.poly)
  if (b.w < 1.9 || b.h < 1.4) return null // 너무 좁은 방은 툴팁으로만
  const isWard = r.kind === 'room' || r.kind === 'isolation'
  const raw = r.name || r.id
  // "02 격리(음압)" 처럼 번호로 시작할 때만 번호/설명으로 나눈다 ("간호사실 A" 는 한 덩어리)
  const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(raw)
  const head = m ? m[1] : raw
  const tail = m ? m[2] : isWard ? null : (CATEGORY[r.kind] || [null, r.kind])[1]
  const hasBeds = (r.beds?.length || 0) > 0
  const badge = count > 0 && !hasBeds && b.h >= 2.2
  const top = b.y + 0.3, bottom = b.y + b.h - 0.3 - (badge ? 0.95 : 0)

  // 후보 자리: 가운데 폭 전체, 또는 좌·우 절반 폭 × 세로 5단. 겹침이 가장 적고(같으면) 글자가 큰 곳.
  const cols = [[r.cx, b.w], [b.x + b.w * 0.27, b.w * 0.5], [b.x + b.w * 0.73, b.w * 0.5]]
  const rows = [0.5, 0.3, 0.7, 0.2, 0.8]
  let best = null
  cols.forEach(([cx, width], ci) => {
    const t = layoutText(head, width, isWard ? 1.4 : 1.2, !isWard)
    const showSub = tail && b.h >= 2.6 && (k >= LOD.sub || !isWard)
    const st = showSub ? layoutText(tail, width, Math.min(0.78, t.size * 0.68), false) : null
    const blockH = t.lines.length * t.size * 1.08 + (st ? st.size + 0.2 : 0)
    const textW = Math.min(width * 0.86, Math.max(...t.lines.map((l) => l.length * t.size * 0.95), st ? st.lines[0].length * st.size : 0))
    rows.forEach((fy, ri) => {
      const cy = Math.min(Math.max(b.y + b.h * fy, top + blockH / 2), bottom - blockH / 2)
      const box = { x: cx - textW / 2, y: cy - blockH / 2, w: textW, h: blockH }
      const hit = (obstacles || []).reduce((a, o) => a + overlap(box, o), 0)
      // 겹침이 최우선, 다음은 글자 크기(클수록 좋음), 마지막으로 가운데에 가까울수록 좋음
      const score = hit * 100 - t.size * 3 + ci * 0.4 + ri * 0.15
      if (!best || score < best.score) best = { score, cx, cy, t, st, blockH }
    })
  })
  const { cx, cy, t, st, blockH } = best
  const y0 = cy - blockH / 2 + t.size * 0.88
  const badgeY = b.y + b.h - 0.7
  return (
    <g className="rlabel" pointerEvents="none">
      {t.lines.map((line, i) => (
        <text key={i} x={cx} y={y0 + i * t.size * 1.08} className="rl-name" style={{ fontSize: `${t.size}px` }}>{line}</text>
      ))}
      {st && <text x={cx} y={y0 + (t.lines.length - 1) * t.size * 1.08 + st.size + 0.2} className="rl-kind" style={{ fontSize: `${st.size}px` }}>{st.lines[0]}</text>}
      {badge && (
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
  // 끌어서 이동. 누르는 순간 포인터를 가로채면 방·환자·게이트웨이의 click 이 wrapper 로 가 버리므로,
  // 4 px 넘게 움직여 "끌기"가 확정된 뒤에만 가로채고, 끌기 직후 따라오는 click 은 한 번 버린다.
  const drag = useRef(null)
  const suppressClick = useRef(false)
  const onDown = (e) => {
    if (e.button !== 0) return
    drag.current = { x: e.clientX, y: e.clientY, vx: v.x, vy: v.y, moved: false, id: e.pointerId }
  }
  const onMove = (e) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.moved) {
      if (Math.hypot(dx, dy) < 4) return
      d.moved = true
      try { wrap.current.setPointerCapture(d.id) } catch { /* ignore */ }
    }
    setView({ k: v.k, x: d.vx + dx, y: d.vy + dy })
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.moved) {
      suppressClick.current = true
      try { wrap.current.releasePointerCapture(d.id) } catch { /* ignore */ }
    }
  }
  const onClickCapture = (e) => {
    if (suppressClick.current) { suppressClick.current = false; e.stopPropagation(); e.preventDefault() }
  }

  const obstaclesByRoom = useMemo(() => {
    const m = new Map()
    for (const r of rooms) {
      const b = bbox(r.poly)
      const inside = (f) => f.room === r.id || (f.x > b.x && f.x < b.x + b.w && f.y > b.y && f.y < b.y + b.h)
      m.set(r.id, [...(r.beds || []).map(bedBox), ...(fixtures || []).filter(inside).map(fixtureBox)])
    }
    return m
  }, [rooms, fixtures])

  const grid = useMemo(() => {
    const step = W > 80 ? 10 : 5
    const gx = [], gy = []
    for (let x = step; x < W; x += step) gx.push(x)
    for (let y = step; y < D; y += step) gy.push(y)
    return { gx, gy }
  }, [W, D])

  return (
    <div className="plan-wrap" ref={wrap} onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClickCapture={onClickCapture}>
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
            {rooms.map((r) => <RoomLabel key={r.id} r={r} k={v.k} obstacles={obstaclesByRoom.get(r.id)} count={(patientsByRoom?.get(r.id) || []).length} />)}
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
