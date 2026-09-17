import React, { useEffect, useState } from 'react'
import { DB_API } from './endpoints.js'

// 타임 로그 페이지 (중앙관제 > 타임 로그).
// SQLite 시계열(metrics, 10초 샘플 → 서버측 버킷 집계)을 일/주/월 단위로 그린다.
//  - 시계열: ECG 패킷(pkt/s), 게이트웨이 장애 비중(%), 패치 채널 수
//  - 마커: 패치 교체/폐기, 다운타임 시작/종료, 게이트웨이 장애
//  - 다운타임(분석 링크 단절) 구간은 차트에 붉은 음영으로 표기

const RANGES = [
  ['hour', '시간 단위 (1시간)'],
  ['day', '일 단위 (24시간)'],
  ['week', '주 단위 (7일)'],
  ['month', '월 단위 (30일)'],
]

const EVENT_STYLE = {
  downtime_start: { color: '#ef4444', label: '다운타임 시작' },
  downtime_end: { color: '#10b981', label: '다운타임 종료' },
  gateway_down: { color: '#f59e0b', label: '게이트웨이 장애' },
  patch_deployed: { color: '#6366f1', label: '패치 교체/투입' },
  patch_retired: { color: '#94a3b8', label: '패치 폐기' },
}

const fmtXOf = (range) => (t) => {
  const d = new Date(t)
  if (range === 'hour' || range === 'day') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}시`
}

// 시계열 차트 (SVG): 라인 + 영역 + 다운타임 음영 + 이벤트 마커 + 호버 툴팁
function TimeChart({ title, unit, color, data, t0, t1, downRegions, events, fmtX, decimals = 0 }) {
  const W = 1000, H = 160, PL = 50, PR = 12, PT = 10, PB = 24
  const span = Math.max(t1 - t0, 1)
  const xs = (t) => PL + ((t - t0) / span) * (W - PL - PR)
  const vmax = Math.max(1e-6, ...data.map((d) => d.v)) * 1.12
  const ys = (v) => PT + (1 - v / vmax) * (H - PT - PB)
  const [hover, setHover] = useState(null)

  const line = data.map((d) => `${xs(d.t).toFixed(1)},${ys(d.v).toFixed(1)}`).join(' ')
  const area = data.length
    ? `M ${xs(data[0].t)} ${ys(0)} L ${line.split(' ').join(' L ')} L ${xs(data[data.length - 1].t)} ${ys(0)} Z`
    : ''

  const onMove = (e) => {
    if (!data.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const t = t0 + ((e.clientX - rect.left) / rect.width) * span
    let best = data[0]
    for (const d of data) if (Math.abs(d.t - t) < Math.abs(best.t - t)) best = d
    setHover(best)
  }

  const ticks = [0, 1 / 3, 2 / 3, 1].map((r) => t0 + r * span)

  return (
    <div className="tl-chart">
      <div className="tl-chart-head">
        <b>{title}</b>
        <span className="tl-unit">{unit}</span>
        <span className="tl-hover">
          {hover ? `${fmtX(hover.t)} · ${hover.v.toFixed(decimals)}${unit}` : ' '}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="tl-svg" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {/* 다운타임 음영 */}
        {downRegions.map((r, i) => (
          <rect key={i} x={xs(r.start)} y={PT} width={Math.max(2, xs(r.end) - xs(r.start))}
            height={H - PT - PB} fill="rgba(239,68,68,0.10)" />
        ))}
        {/* 그리드 + Y 라벨 */}
        {[0, 0.5, 1].map((r) => {
          const v = vmax * r
          return (
            <g key={r}>
              <line x1={PL} y1={ys(v)} x2={W - PR} y2={ys(v)} stroke="var(--line-soft)" strokeWidth="1" />
              <text x={PL - 6} y={ys(v) + 4} textAnchor="end" className="tl-axis">
                {v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 0 : 1)}
              </text>
            </g>
          )
        })}
        {/* 영역 + 라인 */}
        {area && <path d={area} fill={color} opacity="0.10" />}
        <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {/* 이벤트 마커 */}
        {events.map((e, i) => (
          <line key={i} x1={xs(e.ts)} y1={PT} x2={xs(e.ts)} y2={H - PB}
            stroke={EVENT_STYLE[e.kind].color} strokeWidth="1.4" opacity="0.65">
            <title>{fmtX(e.ts)} {EVENT_STYLE[e.kind].label} {e.detail || ''}</title>
          </line>
        ))}
        {/* 호버 표시 */}
        {hover && (
          <g>
            <line x1={xs(hover.t)} y1={PT} x2={xs(hover.t)} y2={H - PB}
              stroke="var(--ink-3)" strokeWidth="1" strokeDasharray="3 3" />
            <circle cx={xs(hover.t)} cy={ys(hover.v)} r="4" fill={color} stroke="var(--surface)" strokeWidth="2" />
          </g>
        )}
        {/* X 라벨 */}
        {ticks.map((t, i) => (
          <text key={i} x={xs(t)} y={H - 7}
            textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}
            className="tl-axis">
            {fmtX(t)}
          </text>
        ))}
      </svg>
    </div>
  )
}

// 이벤트 타임라인 스트립
function EventStrip({ events, t0, t1, fmtX }) {
  const W = 1000, H = 44
  const span = Math.max(t1 - t0, 1)
  const xs = (t) => 50 + ((t - t0) / span) * (W - 62)
  return (
    <div className="tl-chart">
      <div className="tl-chart-head">
        <b>이벤트 타임라인</b>
        <span className="tl-legend">
          {Object.entries(EVENT_STYLE).map(([k, s]) => (
            <span key={k}><i style={{ background: s.color }} /> {s.label}</span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="tl-svg strip">
        <line x1="50" y1={H / 2} x2={W - 12} y2={H / 2} stroke="var(--line)" strokeWidth="1.5" />
        {events.map((e, i) => (
          <line key={i} x1={xs(e.ts)} y1="8" x2={xs(e.ts)} y2={H - 8}
            stroke={EVENT_STYLE[e.kind].color} strokeWidth="2.2">
            <title>{fmtX(e.ts)} · {EVENT_STYLE[e.kind].label} {e.detail || ''}</title>
          </line>
        ))}
      </svg>
    </div>
  )
}

export default function TimeLogPage() {
  const [range, setRange] = useState('day')
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  const load = (r) =>
    fetch(`${DB_API}/timeseries?range=${r}`)
      .then((res) => res.json())
      .then((j) => { setData(j); setError('') })
      .catch(() => setError('DB API(:7600)에 연결할 수 없습니다 — 시계열은 db-api 가 수집합니다'))

  useEffect(() => {
    load(range)
    const t = setInterval(() => load(range), 30000)
    return () => clearInterval(t)
  }, [range])

  const fmtX = fmtXOf(range)
  const now = Date.now()
  const t0 = data?.since ?? now - 86400e3
  const metrics = data?.metrics ?? []
  const events = (data?.events ?? []).filter((e) => EVENT_STYLE[e.kind])

  // 다운타임 음영 구간 (버킷의 analysis_up=0 연속 구간)
  const downRegions = []
  let cur = null
  for (const m of metrics) {
    if (m.analysis_up === 0) {
      if (!cur) cur = { start: m.t, end: m.t + (data?.bucket_s ?? 300) * 1000 }
      else cur.end = m.t + (data?.bucket_s ?? 300) * 1000
    } else if (cur) {
      downRegions.push(cur)
      cur = null
    }
  }
  if (cur) downRegions.push(cur)

  const series = (key) => metrics.map((m) => ({ t: m.t, v: m[key] || 0 }))
  const totalDownMs = downRegions.reduce((s, r) => s + (r.end - r.start), 0)

  return (
    <div>
      {error && <div className="error">{error}</div>}

      <section>
        <div className="section-head">
          <div className="bld-tabs">
            {RANGES.map(([k, label]) => (
              <button key={k} className={range === k ? 'primary' : ''} onClick={() => setRange(k)}>
                {label}
              </button>
            ))}
          </div>
          <h2 className="map-title" />
          <span className="map-count">
            다운타임 {Math.round(totalDownMs / 60000)}분 · 이벤트 {events.length}건 · 30초 자동 갱신
          </span>
        </div>

        <EventStrip events={events} t0={t0} t1={now} fmtX={fmtX} />

        <TimeChart
          title="ECG 패킷" unit=" pkt/s" color="var(--accent)"
          data={series('pkt')} t0={t0} t1={now}
          downRegions={downRegions}
          events={events.filter((e) => e.kind.startsWith('downtime'))}
          fmtX={fmtX}
        />
        <TimeChart
          title="게이트웨이 장애 비중" unit=" %" color="#f59e0b" decimals={1}
          data={series('gw_fault')} t0={t0} t1={now}
          downRegions={[]}
          events={events.filter((e) => e.kind === 'gateway_down')}
          fmtX={fmtX}
        />
        <TimeChart
          title="패치 채널 수" unit=" 채널" color="#6366f1"
          data={series('channels')} t0={t0} t1={now}
          downRegions={downRegions}
          events={events.filter((e) => e.kind.startsWith('patch'))}
          fmtX={fmtX}
        />
        <p className="hint">
          10초 샘플을 서버에서 버킷 집계(일 5분 / 주 30분 / 월 2시간)해 표시합니다.
          붉은 음영 = 분석 링크 다운타임 구간, 세로 마커 = 이벤트 (마우스 오버로 상세).
        </p>
      </section>
    </div>
  )
}
