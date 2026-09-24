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

/** 문: 에뮬레이터의 `door_seg`(복도측 벽 위 문 구간 두 끝점)를 그대로 쓴다. 벽을 끊고, 문짝은 방 안쪽으로 연다.
 *  `door_seg` 가 없는 옛 데이터는 `door`(N/S/E/W) 벽 가운데 1.2 m 로 만든다. */
function doorSegment(r) {
  if (r.door_seg?.length === 2) return r.door_seg
  const b = bbox(r.poly), c = 0.6
  switch (r.door) {
    case 'N': return [[b.x + b.w / 2 - c, b.y], [b.x + b.w / 2 + c, b.y]]
    case 'S': return [[b.x + b.w / 2 - c, b.y + b.h], [b.x + b.w / 2 + c, b.y + b.h]]
    case 'W': return [[b.x, b.y + b.h / 2 - c], [b.x, b.y + b.h / 2 + c]]
    case 'E': return [[b.x + b.w, b.y + b.h / 2 - c], [b.x + b.w, b.y + b.h / 2 + c]]
    default: return null
  }
}
function Door({ r }) {
  const seg = doorSegment(r)
  if (!seg) return null
  const [[x1, y1], [x2, y2]] = seg
  const w = Math.hypot(x2 - x1, y2 - y1)
  // 문 구간에 수직인 두 방향 중 방 가운데를 향하는 쪽이 "안쪽"
  let nx = -(y2 - y1) / w, ny = (x2 - x1) / w
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  if ((r.cx - mx) * nx + (r.cy - my) * ny < 0) { nx = -nx; ny = -ny }
  const hinge = [x1, y1], other = [x2, y2]
  const leaf = [hinge[0] + nx * w, hinge[1] + ny * w]
  // 호의 방향: other → leaf 가 hinge 를 중심으로 도는 방향 (외적 부호)
  const cross = (other[0] - hinge[0]) * (leaf[1] - hinge[1]) - (other[1] - hinge[1]) * (leaf[0] - hinge[0])
  return (
    <g className="door">
      <line x1={x1} y1={y1} x2={x2} y2={y2} className="door-gap" />
      <path d={`M ${other[0]} ${other[1]} A ${w} ${w} 0 0 ${cross > 0 ? 1 : 0} ${leaf[0]} ${leaf[1]}`} className="door-swing" />
      <line x1={hinge[0]} y1={hinge[1]} x2={leaf[0]} y2={leaf[1]} className="door-leaf" />
    </g>
  )
}

/** 침대 크기 (에뮬레이터 emulator/hospital/layout.py 의 BED_HL·BED_HW: 2.4 x 1.08 m). */
export const BED_L = 2.4, BED_W = 1.08
/** 침대 `angle` 은 **머리가 향하는 방위**다: 0 = 북(위), 90 = 동, 180 = 남, 270 = 서 (에뮬레이터가 머리를 벽에 붙여 놓는다).
 *  그리기는 긴 축을 로컬 x, 베개를 -x 끝에 두고 (angle + 90)° 돌린다 → 로컬 -x 가 머리 방위를 가리킨다. */
const bedRot = (b) => (b.angle || 0) + 90
/** 침대 로컬 좌표(긴 축 = x, 머리는 -x) → 도면 좌표. 환자 점은 베개, 이름은 이불 위에 놓는다. */
export function bedPoint(b, lx, ly = 0) {
  const a = (bedRot(b) * Math.PI) / 180
  return [b.x + lx * Math.cos(a) - ly * Math.sin(a), b.y + lx * Math.sin(a) + ly * Math.cos(a)]
}
export const BED_HEAD = -(BED_L / 2 - 0.4) // 베개 중심
export const BED_BODY = 0.35 // 이불 중심

/** 침대·설비가 차지하는 사각형(축 정렬 근사). 각도가 대부분 0/90/180/270° 라 근사로 충분하다. */
const quarter = (a) => Math.abs(Math.round((a || 0) / 90)) % 2 === 1
export function bedBox(b) {
  const [w, h] = quarter(b.angle) ? [BED_L, BED_W] : [BED_W, BED_L] // 머리가 동·서면 가로로 눕는다
  return { x: b.x - w / 2, y: b.y - h / 2, w, h }
}
export function fixtureBox(f) {
  const [lw, lh] = f.type === 'display' ? [1.1, 0.9] : [f.type === 'nurse_desk' ? 2.6 : 2.0, 0.9]
  const [w, h] = quarter(f.angle) ? [lh, lw] : [lw, lh]
  return { x: f.x - w / 2, y: f.y - h / 2, w, h }
}
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** 게이트웨이 RF 커버리지 — 에뮬레이터(emulator/web/static/app.js `coveragePolygon`)와 같은 규칙.
 *  시야가 트이면 ~10 m 까지 닿고, 벽을 하나 지날 때마다 남은 거리가 절반이 된다(벽 1개 뒤 ~5 m, 2개 ~2.5 m).
 *  벽 = 그려진 모든 방의 윤곽선, 복도는 트인 공간, 층 외곽에서는 멈춘다. 광선 240개. */
export const COV_OPEN_M = 10.0, COV_WALL_ATT = 0.5, COV_RAYS = 240
export function wallSegments(rooms) {
  const segs = []
  for (const r of rooms || []) {
    if (r.ensuite || !r.poly) continue
    const q = r.poly
    for (let i = 0; i < q.length; i++) {
      const a = q[i], b = q[(i + 1) % q.length]
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) segs.push([a[0], a[1], b[0], b[1]])
    }
  }
  return segs
}
export function coveragePolygon(ox, oy, segs, W, D) {
  const pts = []
  for (let k = 0; k < COV_RAYS; k++) {
    const a = (k / COV_RAYS) * 2 * Math.PI, dx = Math.cos(a), dy = Math.sin(a)
    // 층 외곽까지 거리 (여기서 무조건 멈춘다)
    let tb = Infinity
    if (dx > 1e-9) tb = Math.min(tb, (W - ox) / dx); else if (dx < -1e-9) tb = Math.min(tb, -ox / dx)
    if (dy > 1e-9) tb = Math.min(tb, (D - oy) / dy); else if (dy < -1e-9) tb = Math.min(tb, -oy / dy)
    // 광선이 지나는 벽 (맞붙은 두 방의 같은 벽은 0.12 m 안이면 하나로 친다)
    const hits = []
    for (const [x1, y1, x2, y2] of segs) {
      const ex = x2 - x1, ey = y2 - y1, den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-9) continue
      const fx = x1 - ox, fy = y1 - oy, t = (fx * ey - fy * ex) / den, u = (fx * dy - fy * dx) / den
      if (t > 0.05 && t < COV_OPEN_M && u >= 0 && u <= 1) hits.push(t)
    }
    hits.sort((p, q) => p - q)
    let budget = COV_OPEN_M, last = -1
    for (const t of hits) { if (t - last < 0.12) continue; last = t; if (t >= budget) break; budget = t + (budget - t) * COV_WALL_ATT }
    const rr = Math.min(budget, tb)
    pts.push([ox + dx * rr, oy + dy * rr])
  }
  return pts
}
export const polyPoints = (pts) => pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ')

/** 확대 배율(px/m)에 따라 보이는 정보를 늘린다 — 멀리서는 방 번호만, 가까이서 부가 정보. */
export const LOD = { sub: 14, gateway: 22, names: 34 }

/** 침대 픽토그램: 매트리스 + 베개(머리 쪽) + 이불선. */
function Bed({ b, occupied }) {
  const L = BED_L, W = BED_W
  return (
    <g transform={`rotate(${bedRot(b)} ${b.x} ${b.y})`} className={'bed' + (occupied ? ' occ' : '')}>
      <rect x={b.x - L / 2} y={b.y - W / 2} width={L} height={W} rx={0.14} className="bed-frame" />
      <rect x={b.x - L / 2 + 0.1} y={b.y - W / 2 + 0.1} width={0.6} height={W - 0.2} rx={0.1} className="bed-pillow" />
      <line x1={b.x - 0.05} y1={b.y - W / 2 + 0.07} x2={b.x - 0.05} y2={b.y + W / 2 - 0.07} className="bed-fold" />
      <title>{b.id}</title>
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

/** 글자 크기는 고정한 채 폭을 넘으면 공백에서 두 줄로 나눈다 (병실 구역 줄을 층 전체 같은 크기로) */
function wrapFixed(text, width, size) {
  if (text.length * size <= width * 0.9 || !text.includes(' ')) return { lines: [text], size }
  const at = text.indexOf(' ')
  return { lines: [text.slice(0, at), text.slice(at + 1)], size }
}

/** 글자 폭(m) 근사 — 에뮬레이터 textWidth 와 같은 표: 한글 0.98, 대문자·숫자 0.66, 공백 0.32, 그 밖 0.56 (× 크기) */
const textW = (str, fs) => {
  let w = 0
  for (const ch of str) w += (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF\u4E00-\u9FFF]/.test(ch) ? 0.98 : /[A-Z0-9#]/.test(ch) ? 0.66 : ch === ' ' ? 0.32 : 0.56) * fs
  return w
}

/** 병실 이름표 문구: id "103A01" → ["301호", "3A병동" (+ " 격리(음압)")] */
export function wardLabelText(r) {
  const wid = /^\d(\d\d)([A-Z])(\d\d)$/.exec(r.id)
  if (!wid || !(r.kind === 'room' || r.kind === 'isolation')) return null
  const fl = parseInt(wid[1], 10)
  const extra = /^\d+[A-Za-z]?\s+(.+)$/.exec(r.name || '')
  return { head: `${fl}${wid[3]}호`, tail: `${fl}${wid[2]}병동` + (extra ? ` ${extra[1]}` : '') }
}

/** 문 여닫이 범위: 문 구간 × 방 안쪽으로 문폭+0.15 */
function doorSwingBox(r) {
  const seg = doorSegment(r)
  if (!seg) return null
  const [[x1, y1], [x2, y2]] = seg, w = Math.hypot(x2 - x1, y2 - y1)
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2
  let nx = -(y2 - y1) / w, ny = (x2 - x1) / w
  if ((r.cx - mx) * nx + (r.cy - my) * ny < 0) { nx = -nx; ny = -ny }
  const xs = [x1, x2, x1 + nx * (w + 0.15), x2 + nx * (w + 0.15)], ys = [y1, y2, y1 + ny * (w + 0.15), y2 + ny * (w + 0.15)]
  return { box: { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }, door: { x: mx, y: my } }
}

/** 한 병실에서 주어진 글자 크기로 호실 표기를 놓을 자리: 문 여닫이·침대·설비·게이트웨이와 겹치지 않는 곳 중 문에 가장 가까운 곳.
 *  0.2 m 격자로 훑는다. 없으면 null. */
function placeWardLabel(r, text, size, obstacles, maxDist = Infinity) {
  const b = bbox(r.poly)
  const sub = size * 0.58
  let subLines = [text.tail]
  if (text.tail.includes(' ') && textW(text.tail, sub) > b.w - 0.4) { const i = text.tail.indexOf(' '); subLines = [text.tail.slice(0, i), text.tail.slice(i + 1)] }
  const w = Math.max(textW(text.head, size), ...subLines.map((l) => textW(l, sub))) + 0.1
  const h = size * 1.02 + subLines.length * sub * 1.12 + 0.1
  if (w > b.w - 0.3 || h > b.h - 0.3) return null
  const sw = doorSwingBox(r)
  const obs = sw ? [...obstacles, sw.box] : obstacles
  const target = sw ? sw.door : { x: r.cx, y: r.cy }
  let best = null
  for (let cy = b.y + 0.15 + h / 2; cy <= b.y + b.h - 0.15 - h / 2 + 1e-6; cy += 0.2) {
    for (let cx = b.x + 0.15 + w / 2; cx <= b.x + b.w - 0.15 - w / 2 + 1e-6; cx += 0.2) {
      const box = { x: cx - w / 2, y: cy - h / 2, w, h }
      if (obs.some((o) => overlap(box, o) > 1e-4)) continue
      const d = Math.hypot(cx - target.x, cy - target.y)
      if (d > maxDist) continue
      if (!best || d < best.d) best = { d, cx, cy }
    }
  }
  return best && { cx: best.cx, top: best.cy - h / 2, size, sub, subLines, head: text.head }
}

/** 방 이름표 — 겹침을 줄이려고 정보량을 배율과 방 성격에 맞추고, 침대·설비를 피해 가장 빈 자리에 놓는다.
 *  병실: 번호만 크게 (격리·음압 같은 부가 설명이 있을 때만 아랫줄). 침대가 있으면 인원은 침대 위 점이 대신한다.
 *  그 밖의 방: 이름(길면 두 줄) + (확대 시) 용도. 침대 없는 방에 환자가 있으면 인원 배지를 아래쪽에. */
function RoomLabel({ r, count, k, obstacles, wardSize, ward }) {
  if (ward) {
    // 병실: 층 공통 크기, 문 가까운 빈자리 (placeWardLabel)
    return (
      <g className="rlabel" pointerEvents="none">
        <text x={ward.cx} y={ward.top + ward.size * 0.9} className="rl-name" style={{ fontSize: `${ward.size}px` }}>{ward.head}</text>
        {ward.subLines.map((l, i) => (
          <text key={i} x={ward.cx} y={ward.top + ward.size * 1.02 + ward.sub * (0.95 + i * 1.12)} className="rl-kind" style={{ fontSize: `${ward.sub}px` }}>{l}</text>
        ))}
      </g>
    )
  }
  const b = bbox(r.poly)
  if (b.w < 1.9 || b.h < 1.4) return null // 너무 좁은 방은 툴팁으로만
  const isWard = r.kind === 'room' || r.kind === 'isolation'
  const raw = r.name || r.id
  // "02 격리(음압)" 처럼 번호로 시작할 때만 번호/설명으로 나눈다 ("간호사실 A" 는 한 덩어리)
  const m = /^(\d+[A-Za-z]?)\s+(.+)$/.exec(raw)
  let head = m ? m[1] : raw
  let tail = m ? m[2] : isWard ? null : (CATEGORY[r.kind] || [null, r.kind])[1]
  // 병실은 층마다 A·B 두 병동에 같은 호실 번호가 있으므로 층·호실·구역을 모두 쓴다:
  // id "103A01" = 건물 1 · 03층 · A병동 · 01호 → "301호" + "3A병동" (격리실은 "3A병동 격리(음압)")
  const wid = isWard && /^\d(\d\d)([A-Z])(\d\d)$/.exec(r.id)
  if (wid) {
    const fl = parseInt(wid[1], 10)
    head = `${fl}${wid[3]}호`
    tail = `${fl}${wid[2]}병동` + (m ? ` ${m[2]}` : '')
  }
  const hasBeds = (r.beds?.length || 0) > 0
  const badge = count > 0 && !hasBeds && b.h >= 2.2
  const top = b.y + 0.3, bottom = b.y + b.h - 0.3 - (badge ? 0.95 : 0)

  // 후보 자리: (가운데 폭 전체 | 좌·우 절반 폭) × 세로 5단 × 글자 크기 3단계.
  // 점수: 겹침이 가장 나쁘고, 다음이 이름 잘림, 그다음 작은 글자, 마지막으로 가운데에서 먼 자리.
  const cols = [[r.cx, b.w], [b.x + b.w * 0.27, b.w * 0.5], [b.x + b.w * 0.73, b.w * 0.5]]
  const rows = [0.5, 0.3, 0.7, 0.18, 0.82, 0.9, 0.1]
  // 병실은 호실 표기를 출입문 가까이 둔다 (에뮬레이터 평면도와 같음) — 문짝이 열리는 자리는 비워 두고 그 옆 빈 곳으로
  const seg = wid ? doorSegment(r) : null
  const door = seg && { x: (seg[0][0] + seg[1][0]) / 2, y: (seg[0][1] + seg[1][1]) / 2 }
  const swing = seg && (() => {
    const [[x1, y1], [x2, y2]] = seg, w = Math.hypot(x2 - x1, y2 - y1)
    let nx = -(y2 - y1) / w, ny = (x2 - x1) / w
    if ((r.cx - door.x) * nx + (r.cy - door.y) * ny < 0) { nx = -nx; ny = -ny }
    const xs = [x1, x2, x1 + nx * (w + 0.15), x2 + nx * (w + 0.15)], ys = [y1, y2, y1 + ny * (w + 0.15), y2 + ny * (w + 0.15)]
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  })()
  const obst = swing ? [...(obstacles || []), swing] : obstacles || []
  const maxSize = isWard ? 1.4 : 1.2
  let best = null
  // 병실 호실은 층 전체가 같은 글자 크기(wardSize) — 크기 단계를 바꾸지 않고, 그 크기가 안 들어가는 칸은 후보에서 뺀다
  const uniform = wid && wardSize
  cols.forEach(([cx, width], ci) => {
    if (uniform && head.length * wardSize * 0.95 > width * 0.92) return
    ;(uniform ? [1] : [1, 0.8, 0.64]).forEach((shrink, si) => {
      const t = uniform ? { lines: [head], size: wardSize } : layoutText(head, width, maxSize * shrink, !isWard)
      const showSub = tail && (wid ? b.h >= 2.0 : b.h >= 2.6 && (k >= LOD.sub || !isWard))
      const st = !showSub ? null : uniform ? wrapFixed(tail, width, wardSize * 0.58) : layoutText(tail, width, Math.min(0.78, t.size * 0.68), false)
      const blockH = t.lines.length * t.size * 1.08 + (st ? st.lines.length * st.size * 1.1 + 0.2 : 0)
      const textW = Math.min(width * 0.86, Math.max(...t.lines.map((l) => l.length * t.size * 0.95), ...(st ? st.lines.map((l) => l.length * st.size) : [0])))
      const cutName = t.lines.some((l) => l.endsWith('…'))
      rows.forEach((fy, ri) => {
        const cy = Math.min(Math.max(b.y + b.h * fy, top + blockH / 2), bottom - blockH / 2)
        const box = { x: cx - textW / 2, y: cy - blockH / 2, w: textW, h: blockH }
        const hit = obst.reduce((a, o) => a + overlap(box, o), 0)
        const near = door ? Math.hypot(cx - door.x, cy - door.y) * 0.9 : ci * 0.4 + ri * 0.15 // 문에서 멀수록 감점
        const score = hit * 100 + (cutName ? 25 : 0) - t.size * 3 + si * 0.3 + near
        if (!best || score < best.score) best = { score, cx, cy, t, st, blockH }
      })
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
      {st && st.lines.map((line, i) => (
        <text key={'s' + i} x={cx} y={y0 + (t.lines.length - 1) * t.size * 1.08 + st.size + 0.2 + i * st.size * 1.1} className="rl-kind" style={{ fontSize: `${st.size}px` }}>{line}</text>
      ))}
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

export default function FloorPlan({ floor, corridors, rooms, fixtures, markers, patientsByRoom, overlay, onPickRoom, picked, focus, onZoomChange, showFixtures = true }) {
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

  // 기본 배율(층 전체가 들어오는 값)과 확대 배율 — 에뮬레이터 평면도처럼 2.5배 한 단계
  const ZOOM = 2.5
  const fitK = Math.min((box.w - 56) / W, (box.h - 56) / D)
  const fit = useCallback(() => {
    const k = Math.min((box.w - 56) / W, (box.h - 56) / D)
    setView({ k, x: (box.w - W * k) / 2, y: (box.h - D * k) / 2 })
  }, [box, W, D])
  useEffect(() => { fit() }, [fit, floor.building_idx, floor.floor])

  const v = view || { k: 1, x: 0, y: 0 }
  const zoomed = v.k > fitK * 1.05
  useEffect(() => { onZoomChange?.(zoomed) }, [zoomed]) // eslint-disable-line react-hooks/exhaustive-deps
  /** 도면 좌표 (mx, my) 를 화면 가운데에 두고 2.5배로 — 층 밖이 보이지 않게 가장자리는 붙인다 */
  const zoomTo = useCallback((mx, my) => {
    const k = fitK * ZOOM
    const cx = Math.min(Math.max(mx, box.w / 2 / k), W - box.w / 2 / k)
    const cy = Math.min(Math.max(my, box.h / 2 / k), D - box.h / 2 / k)
    setView({ k, x: box.w / 2 - (W * k > box.w ? cx : W / 2) * k, y: box.h / 2 - (D * k > box.h ? cy : D / 2) * k })
  }, [fitK, box, W, D])
  // 바깥(검색 등)에서 특정 지점으로 확대 요청: focus = { x, y, seq } — seq 가 바뀔 때마다 한 번
  useEffect(() => { if (focus) zoomTo(focus.x, focus.y) }, [focus?.seq]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (focus === null) fit() }, [focus]) // eslint-disable-line react-hooks/exhaustive-deps
  /** 빈 곳(방·환자·게이트웨이·버튼이 아닌 곳) 클릭: 확대 ↔ 원래 배율. 건물(층 슬래브) 바깥을 눌러서는 확대하지 않는다 */
  const onPlanClick = (e) => {
    if (e.target.closest('.rm, .pat, .gwm, .plan-zoom')) return
    if (zoomed) { fit(); return }
    const rect = wrap.current.getBoundingClientRect()
    const mx = (e.clientX - rect.left - v.x) / v.k, my = (e.clientY - rect.top - v.y) / v.k
    if (mx < 0 || my < 0 || mx > W || my > D) return
    zoomTo(mx, my)
  }
  // 끌어서 이동. 누르는 순간 포인터를 가로채면 방·환자·게이트웨이의 click 이 wrapper 로 가 버리므로,
  // 4 px 넘게 움직여 "끌기"가 확정된 뒤에만 가로채고, 끌기 직후 따라오는 click 은 한 번 버린다.
  const drag = useRef(null)
  const suppressClick = useRef(false)
  const onDown = (e) => {
    if (e.button !== 0 || !zoomed) return // 원래 배율에서는 끌어도 움직이지 않는다
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
      // 천장 게이트웨이 같은 표식도 이름표가 피한다 (크게 확대해야 보이는 것도 자리는 미리 비워 둔다)
      const marks = (markers || []).filter(inside).map((q) => ({ x: q.x - 0.55, y: q.y - 0.55, w: 1.1, h: 1.1 }))
      m.set(r.id, [...(r.beds || []).map(bedBox), ...(fixtures || []).filter(inside).map(fixtureBox), ...marks])
    }
    return m
  }, [rooms, fixtures, markers])

  // 병실 호실 표기: 층 전체가 같은 글자 크기. 모든 병실에서 겹치지 않는 문 근처 자리가 나오는 가장 큰 크기를 고른다.
  const wardLabels = useMemo(() => {
    const wards = rooms.map((r) => [r, wardLabelText(r)]).filter(([, t]) => t)
    if (!wards.length) return new Map()
    // 문 가까이가 우선: 표기 중심이 문 중점에서 2.4 m 안에 드는 자리만 인정하고, 모든 병실이 그런 자리를 찾는 가장 큰 크기를
    // 고른다. 그 거리로 안 되면 거리를 조금씩 넓힌다.
    for (const maxDist of [2.4, 3.0, 3.8, Infinity]) {
      for (let size = 1.1; size >= 0.55; size = +(size - 0.05).toFixed(2)) {
        const m = new Map()
        let okAll = true
        for (const [r, t] of wards) {
          const pl = placeWardLabel(r, t, size, obstaclesByRoom.get(r.id) || [], maxDist)
          if (!pl) { okAll = false; break }
          m.set(r.id, pl)
        }
        if (okAll) return m
      }
    }
    // 가장 작은 크기로도 안 되는 방은 크기 0.45 로 겹침을 감수하고 문 옆에
    const m = new Map()
    for (const [r, t] of wards) m.set(r.id, placeWardLabel(r, t, 0.45, []) )
    return m
  }, [rooms, obstaclesByRoom])

  const grid = useMemo(() => {
    const step = W > 80 ? 10 : 5
    const gx = [], gy = []
    for (let x = step; x < W; x += step) gx.push(x)
    for (let y = step; y < D; y += step) gy.push(y)
    return { gx, gy }
  }, [W, D])

  return (
    <div className={'plan-wrap' + (zoomed ? ' zoomed' : '')} ref={wrap} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onClickCapture={onClickCapture} onClick={onPlanClick}>
      <svg className="plan" width={box.w} height={box.h}>
        <defs>
          <pattern id="hatch" width="1.1" height="1.1" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="1.1" className="hatch-line" />
          </pattern>
          <filter id="slab-shadow" x="-6%" y="-6%" width="112%" height="112%">
            <feDropShadow dx="0" dy="1.1" stdDeviation="1.4" floodOpacity="0.20" />
          </filter>
          <filter id="covblur" x="-15%" y="-15%" width="130%" height="130%" filterUnits="objectBoundingBox"><feGaussianBlur stdDeviation="0.45" /></filter>
          <pattern id="covhatch" width="0.5" height="0.5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <path d="M0,0.25 H0.5 M0.25,0 V0.5" className="cov-hatch" />
          </pattern>
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
            {rooms.map((r) => r.beds?.map((b) => (
              <Bed key={b.id} b={b} occupied={!!overlay?.bedOccupied?.(r, b)} />
            )))}
            {showFixtures && fixtures?.map((f, i) => <Fixture key={'f' + i} f={f} />)}
          </g>

          <g className="labels">
            {rooms.map((r) => <RoomLabel key={r.id} r={r} k={v.k} ward={wardLabels.get(r.id)} obstacles={obstaclesByRoom.get(r.id)} count={(patientsByRoom?.get(r.id) || []).length} />)}
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
        <button onClick={() => (zoomed ? fit() : zoomTo(W / 2, D / 2))} title={zoomed ? '원래 배율' : '확대 (빈 곳을 눌러도 됩니다)'}>{zoomed ? '−' : '+'}</button>
      </div>
    </div>
  )
}
