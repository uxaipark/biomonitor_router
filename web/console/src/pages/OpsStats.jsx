import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtBytes, fmtNum } from '../api.js'

/**
 * 테스트 › 운영 통계 — long-term (24/7/365) operating statistics.
 * The router samples itself every 2 s and writes one row per minute into SQLite (minute rows for 14 days,
 * hourly rows kept for years). This page reads the aggregated series and shows load, capacity, throughput,
 * availability and incidents over a day, week, month, quarter or year.
 */
const RANGES = [['hour', '1시간'], ['day', '1일'], ['week', '1주'], ['month', '1개월'], ['quarter', '분기'], ['year', '1년']]
const MB = 1024 * 1024

const fmtT = (t, range) => {
  const d = new Date(t * 1000)
  const p = (n) => String(n).padStart(2, '0')
  if (range === 'hour' || range === 'day') return `${p(d.getHours())}:${p(d.getMinutes())}`
  if (range === 'week') return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}시`
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}`
}
const fmtDur = (s) => {
  if (!s || s < 0) return '—'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분`
}

/** Small multi-series SVG chart: no dependencies, fixed viewBox, lines scaled to a shared max. */
function Chart({ points, series, range, height = 130, unit = '', stack = false }) {
  const W = 1000, H = height, pad = { l: 46, r: 8, t: 8, b: 16 }
  const vals = (s) => points.map((p) => (s.get ? s.get(p) : p[s.key]) ?? 0)
  const all = series.flatMap(vals)
  const max = Math.max(1e-9, ...all)
  const nice = (v) => { const e = Math.pow(10, Math.floor(Math.log10(v))); const m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e }
  const top = nice(max * 1.1)
  const x = (i) => pad.l + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => H - pad.b - (Math.max(0, v) / top) * (H - pad.t - pad.b)
  const path = (s) => vals(s).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = (s) => `${path(s)} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
  const ticks = [0, 0.5, 1].map((f) => top * f)
  const label = (v) => (unit === 'B' ? fmtBytes(v) : unit === '%' ? `${v.toFixed(0)}%` : v >= 1000 ? fmtNum(Math.round(v)) : v.toFixed(v < 10 ? 1 : 0))
  return (
    <div className="ops-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        {ticks.map((t, i) => <g key={i}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="ops-grid" /><text x={pad.l - 6} y={y(t) + 3} className="ops-ytick">{label(t)}</text></g>)}
        {series.map((s) => <g key={s.key || s.label}>
          {(stack || s.area) && <path d={area(s)} fill={s.color} opacity="0.16" />}
          <path d={path(s)} fill="none" stroke={s.color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        </g>)}
      </svg>
      <div className="ops-legend">
        {series.map((s) => { const v = vals(s); const last = v[v.length - 1] ?? 0; const mx = Math.max(0, ...v)
          return <span key={s.key || s.label}><i style={{ background: s.color }} />{s.label} <b>{label(last)}</b> <small>최대 {label(mx)}</small></span> })}
        <span className="spacer" />
        <small className="ds-dim">{points.length ? `${fmtT(points[0].t, range)} ~ ${fmtT(points[points.length - 1].t, range)}` : ''}</small>
      </div>
    </div>
  )
}

const Tile = ({ label, value, sub, warn }) => (
  <div className={'ops-tile' + (warn ? ' warn' : '')}><small>{label}</small><b>{value}</b>{sub && <span>{sub}</span>}</div>
)

const KIND = { restart: '재시작', store_stall: '저장 스톨', queue_drop: '저장 드롭', ws_lag: 'WS 지연', disk_low: '디스크 부족', reset: '통계 초기화' }

export default function OpsStats() {
  const [range, setRange] = useState(() => { try { return localStorage.getItem('ops.range') || 'day' } catch { return 'day' } })
  const [data, , refresh] = usePoll(() => api.metrics(range), 30000, [range])
  const [info, , refreshInfo] = usePoll(api.metricsInfo, 60000)
  const [stats] = usePoll(api.stats, 5000)
  const [msg, setMsg] = useState('')
  const setR = (r) => { setRange(r); try { localStorage.setItem('ops.range', r) } catch { /* ignore */ } }
  const points = data?.points || []
  const tot = data?.totals || {}
  const cov = data?.coverage || {}
  const inc = data?.incident_counts || {}
  const bucketH = (data?.bucket_s || 3600) / 3600
  // per-bucket counter deltas → rates
  const pts = useMemo(() => points.map((p) => ({
    ...p,
    rx_mb_h: (p.rx || 0) / MB / bucketH,
    tx_mb_h: (p.tx || 0) / MB / bucketH,
    rec_s: (p.records || 0) / (bucketH * 3600),
    mem_mb: (p.mem || 0) / MB,
    sys_mem_pct: p.mem_total ? ((p.mem_used || 0) / p.mem_total) * 100 : 0,
    store_gb: (p.store || 0) / 1024 / MB,
    disk_pct: p.disk_total ? ((p.disk_used || 0) / p.disk_total) * 100 : 0,
  })), [points, bucketH])
  const growth = pts.length > 1 ? (pts[pts.length - 1].store_gb - pts[0].store_gb) : 0
  const spanH = pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / 3600 : 0
  const reset = async () => {
    if (!window.confirm('수집된 운영 통계(분·시간 기록과 사건 목록)를 모두 삭제합니다. 되돌릴 수 없습니다. 계속할까요?')) return
    if (!window.confirm('정말로 초기화할까요?')) return
    try { await api.metricsReset(); setMsg('초기화했습니다. 다음 분부터 새로 수집합니다.'); refresh?.(); refreshInfo?.() } catch (e) { setMsg('실패: ' + e.message) }
  }
  return (
    <div className="page">
      <div className="toolbar">
        <h2 className="h" style={{ margin: 0 }}>운영 통계</h2>
        <span className="seg">{RANGES.map(([k, l]) => <button key={k} className={range === k ? 'active' : ''} onClick={() => setR(k)}>{l}</button>)}</span>
        <span className="muted">
          {info?.first_ts ? `수집 시작 ${new Date(info.first_ts * 1000).toLocaleString('ko-KR')}` : '수집 시작 —'}
          {info ? ` · 분 기록 ${fmtNum(info.minute_rows)}(${info.keep_days}일 보관) · 시간 기록 ${fmtNum(info.hour_rows)} · DB ${fmtBytes(info.db_bytes)}` : ''}
        </span>
        <span className="spacer" />
        <button className="danger" onClick={reset}>통계 초기화</button>
      </div>
      {msg && <p className="muted">{msg}</p>}
      <div className="ops-tiles">
        <Tile label="현재 가동 시간" value={fmtDur(stats?.uptime_s)} sub={`재시작 ${inc.restart || 0}회 (이 구간)`} />
        <Tile label="수집 커버리지" value={`${(cov.percent || 0).toFixed(1)}%`} sub={`${fmtNum(cov.sampled_minutes || 0)} / ${fmtNum(cov.expected_minutes || 0)}분`} warn={(cov.percent || 0) < 99 && range !== 'hour'} />
        <Tile label="라우터 CPU" value={`${(tot.cpu_avg || 0).toFixed(1)}%`} sub={`최대 ${(tot.cpu_max || 0).toFixed(0)}% · 1코어=100`} warn={(tot.cpu_max || 0) > 150} />
        <Tile label="라우터 메모리" value={fmtBytes(tot.mem_avg || 0)} sub={`최대 ${fmtBytes(tot.mem_max || 0)}`} />
        <Tile label="환자 (패치)" value={fmtNum(Math.round(tot.patients_avg || 0))} sub={`최소 ${fmtNum(tot.patients_min || 0)} · 최대 ${fmtNum(tot.patients_max || 0)}`} />
        <Tile label="수신 / 송신" value={`${fmtBytes(tot.rx || 0)} / ${fmtBytes(tot.tx || 0)}`} sub={`레코드 ${fmtNum(tot.records || 0)}`} />
        <Tile label="저장 증가" value={`${growth >= 0 ? '+' : ''}${growth.toFixed(1)} GB`} sub={spanH > 1 ? `${(growth / spanH * 24).toFixed(1)} GB/일` : ''} />
        <Tile label="유실 / 드롭" value={`${fmtNum(tot.lost || 0)} / ${fmtNum(tot.drops || 0)}`} sub={`WS 지연 ${fmtNum(tot.lag || 0)}`} warn={(tot.drops || 0) > 0} />
      </div>
      <div className="ops-grid2">
        <section><h4>CPU (%, 1코어 = 100)</h4><Chart points={pts} range={range} unit="" series={[
          { key: 'cpu', label: '라우터 평균', color: '#3ddc84', area: true },
          { key: 'cpu_max', label: '라우터 최대', color: '#ff9f6b' },
          { key: 'cpu_sys', label: '시스템 전체', color: '#7cc4ff' },
        ]} /></section>
        <section><h4>메모리</h4><Chart points={pts} range={range} series={[
          { key: 'mem_mb', label: '라우터 RSS (MB)', color: '#3ddc84', area: true },
          { key: 'sys_mem_pct', label: '시스템 사용 (%)', color: '#f5d442' },
        ]} /></section>
        <section><h4>저장소</h4><Chart points={pts} range={range} series={[
          { key: 'store_gb', label: '파형 저장 (GB)', color: '#7cc4ff', area: true },
          { key: 'disk_pct', label: '디스크 사용 (%)', color: '#ff6b6b' },
        ]} /></section>
        <section><h4>환자 · 구독</h4><Chart points={pts} range={range} series={[
          { key: 'connected', label: '수신 중 패치', color: '#3ddc84', area: true },
          { key: 'subs', label: '구독 채널', color: '#7cc4ff' },
          { key: 'ws', label: 'WS 세션', color: '#f5d442' },
        ]} /></section>
        <section><h4>전송량</h4><Chart points={pts} range={range} series={[
          { key: 'rx_mb_h', label: '수신 MB/h', color: '#3ddc84', area: true },
          { key: 'tx_mb_h', label: '송신 MB/h', color: '#ff9f6b' },
        ]} /></section>
        <section><h4>지연 · 장애</h4><Chart points={pts} range={range} series={[
          { key: 'lag', label: 'WS 지연 건너뜀', color: '#ff6b6b', area: true },
          { key: 'store_q', label: '저장 큐 최대', color: '#f5d442' },
          { key: 'lost', label: 'seq 유실', color: '#ff9f6b' },
          { key: 'drops', label: '저장 드롭', color: '#ff2d55' },
        ]} /></section>
      </div>
      <h3 className="h">사건 기록</h3>
      <div className="toolbar">
        {Object.entries(KIND).map(([k, l]) => <span key={k} className={'pill' + (inc[k] ? (k === 'queue_drop' || k === 'disk_low' ? ' err' : ' warn') : '')}>{l} {inc[k] || 0}</span>)}
      </div>
      <table className="tbl dense vw-table">
        <thead><tr><th>시각</th><th>종류</th><th>내용</th><th className="num">값</th></tr></thead>
        <tbody>
          {(data?.incidents || []).slice(0, 100).map((e, i) => (
            <tr key={i}><td className="mono">{new Date(e.ts * 1000).toLocaleString('ko-KR')}</td><td>{KIND[e.kind] || e.kind}</td><td className="muted">{e.detail}</td><td className="num">{fmtNum(e.value)}</td></tr>
          ))}
          {!(data?.incidents || []).length && <tr><td colSpan={4} className="muted">이 구간에 기록된 사건이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
