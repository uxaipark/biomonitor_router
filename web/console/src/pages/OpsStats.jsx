import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtBytes, fmtNum } from '../api.js'

/**
 * 대시보드 (운영 통계) — long-term (24/7/365) operating statistics.
 * The router samples itself every 2 s and writes one row per minute into SQLite (minute rows for 14 days,
 * hourly rows kept for years). This page reads the aggregated series and shows load, capacity, throughput,
 * availability and incidents over a day, week, month, quarter or year.
 */
const RANGES = [['5min', '5분'], ['hour', '1시간'], ['day', '1일'], ['week', '1주'], ['month', '1개월'], ['quarter', '분기'], ['year', '1년']]
const MB = 1024 * 1024

const fmtT = (t, range) => {
  const d = new Date(t * 1000)
  const p = (n) => String(n).padStart(2, '0')
  if (range === '5min') return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
function Chart({ points, series, range, height = 130, unit = '', stack = false, fixedMax }) {
  const W = 1000, H = height, pad = { l: 46, r: 8, t: 8, b: 16 }
  const vals = (s) => points.map((p) => (s.get ? s.get(p) : p[s.key]) ?? 0)
  const all = series.flatMap(vals)
  const max = Math.max(1e-9, ...all)
  const nice = (v) => { const e = Math.pow(10, Math.floor(Math.log10(v))); const m = v / e; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e }
  const top = fixedMax || nice(max * 1.1)
  const x = (i) => pad.l + (points.length < 2 ? 0 : (i / (points.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => H - pad.b - (Math.max(0, v) / top) * (H - pad.t - pad.b)
  const path = (s) => vals(s).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const area = (s) => !points.length ? '' : `${path(s)} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`
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

const Tile = ({ label, value, sub, warn, title }) => (
  <div className={'ops-tile' + (warn ? ' warn' : '')} title={title}><small>{label}</small><b>{value}</b>{sub && <span>{sub}</span>}</div>
)

const KIND = { restart: '재시작', full_reset: '가동 초기화', store_stall: '저장 스톨', queue_drop: '저장 드롭', ws_lag: 'WS 지연', disk_low: '디스크 부족', reset: '통계 초기화' }

export default function OpsStats() {
  // 구간 선택: '자동' 이면 수집된 데이터 양으로 정한다 — 1시간 미만 5분, 1시간 이상 1시간, 1일 이상 1일, 1주 이상 1주, 1개월 이상이면 1개월에서 멈춤 (사용자 결정)
  const [sel, setSel] = useState(() => { try { return localStorage.getItem('ops.range') || 'auto' } catch { return 'auto' } })
  // 5분 구간은 2 s 샘플이라 5 s 마다, 나머지는 30 s 마다 새로 읽는다
  const [info, , refreshInfo] = usePoll(api.metricsInfo, 60000)
  const autoRange = useMemo(() => {
    const span = info?.first_ts ? Date.now() / 1000 - info.first_ts : 0
    return span >= 30 * 86400 ? 'month' : span >= 7 * 86400 ? 'week' : span >= 86400 ? 'day' : span >= 3600 ? 'hour' : '5min'
  }, [info])
  const range = sel === 'auto' ? autoRange : sel
  // 5분 구간은 2초 샘플이라 2초마다 다시 그린다 (사용자 요청); 나머지는 30초
  const [data, , refresh] = usePoll(() => api.metrics(range), range === '5min' ? 2000 : 30000, [range])
  const [stats] = usePoll(api.stats, 5000)
  const [msg, setMsg] = useState('')
  const setR = (r) => { setSel(r); try { localStorage.setItem('ops.range', r) } catch { /* ignore */ } }
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
        <h2 className="h" style={{ margin: 0 }}>대시보드 <small className="muted" style={{ marginLeft: 12, fontWeight: 400 }}>운영 통계</small></h2>
      </div>
      {msg && <p className="muted">{msg}</p>}
      {/* 수치 카드 두 줄: 1줄 = 라우터 서버, 2줄 = 게이트웨이·패치·데이터 (사용자 요청) */}
      <div className="ops-row-label">라우터 서버</div>
      <div className="ops-tiles ops-row">
        <Tile label="현재 가동 시간" value={fmtDur(stats?.uptime_s)} sub={`선택 구간 안 라우터 재시작 ${inc.restart || 0}회`} title="라우터 프로세스가 다시 시작된 횟수(선택한 구간 기준). 배포·설정 반영을 위한 재시작도 포함되며, 수집 공백이 90초를 넘으면 '수집 공백'으로 표시됩니다. 아래 사건 표에서 시각을 볼 수 있습니다." />
        <Tile label="수집 커버리지" value={`${(cov.percent || 0).toFixed(1)}%`} sub={range === '5min' ? `${fmtNum(cov.sampled_samples || 0)} / ${fmtNum(cov.expected_samples || 0)} 샘플 (2초)` : `${fmtNum(cov.sampled_minutes || 0)} / ${fmtNum(cov.expected_minutes || 0)}분`} warn={(cov.percent || 0) < 99 && range !== 'hour' && range !== '5min'} />
        <Tile label="라우터 CPU" value={`${(tot.cpu_avg || 0).toFixed(1)}%`} sub={`최대 ${(tot.cpu_max || 0).toFixed(0)}% · 1코어=100`} warn={(tot.cpu_max || 0) > 150} />
        <Tile label="라우터 메모리" value={fmtBytes(tot.mem_avg || 0)} sub={`최대 ${fmtBytes(tot.mem_max || 0)}`} />
        <Tile label="전송 지연 (에뮬레이터→라우터)" value={stats?.latency?.n ? `${stats.latency.p50} ms` : '—'} sub={stats?.latency?.n ? `p95 ${stats.latency.p95} ms${stats.latency.offset_ms ? ` · 시계 보정 +${stats.latency.offset_ms} ms` : ''}` : '프레임 없음'} warn={(stats?.latency?.p95 || 0) > 2000} />
      </div>
      <div className="ops-row-label">게이트웨이 · 패치 · 데이터</div>
      <div className="ops-tiles ops-row">
        <Tile label="게이트웨이 연결" value={stats?.gateways ? `${fmtNum(stats.gateways.connected)} / ${fmtNum(stats.gateways.gateways)}` : '—'} sub={stats?.gateways ? `다운 ${stats.gateways.down || 0} · 무응답 ${stats.gateways.silent || 0} · 저하 ${stats.gateways.degraded || 0}` : ''} warn={!!(stats?.gateways?.down || stats?.gateways?.silent)} />
        <Tile label="환자 (패치)" value={fmtNum(Math.round(tot.patients_avg || 0))} sub={`최소 ${fmtNum(tot.patients_min || 0)} · 최대 ${fmtNum(tot.patients_max || 0)}`} />
        <Tile label="송신 (WS·분석)" value={fmtBytes(tot.tx || 0)} sub={spanH > 0 ? `${fmtBytes((tot.tx || 0) / (spanH * 3600))}/s` : ''} />
        <Tile label="수신" value={fmtBytes(tot.rx || 0)} sub={`레코드 ${fmtNum(tot.records || 0)}${spanH > 0 ? ` · ${fmtBytes((tot.rx || 0) / (spanH * 3600))}/s` : ''}`} />
        <Tile label="저장 증가" value={`${growth >= 0 ? '+' : ''}${growth.toFixed(1)} GB`} sub={spanH > 1 ? `${(growth / spanH * 24).toFixed(1)} GB/일` : ''} />
        <Tile label="유실 / 드롭" value={`${fmtNum(tot.lost || 0)} / ${fmtNum(tot.drops || 0)}`} sub={`WS 지연 ${fmtNum(tot.lag || 0)}`} warn={(tot.drops || 0) > 0} />
      </div>
      {/* 구간 선택·수집 정보·초기화: 수치 카드와 그래프 사이 (사용자 요청) */}
      <div className="toolbar ops-range">
        <span className="seg">
          <button className={sel === 'auto' ? 'active' : ''} onClick={() => setR('auto')} title="수집된 데이터 양에 맞춰 구간을 고릅니다 (1시간 미만 5분 → 1시간 → 1일 → 1주 → 1개월에서 멈춤)">자동{sel === 'auto' ? ` · ${(RANGES.find(([k]) => k === range) || [])[1] || range}` : ''}</button>
          {RANGES.map(([k, l]) => <button key={k} className={sel === k ? 'active' : ''} onClick={() => setR(k)}>{l}</button>)}
        </span>
        <span className="muted">
          {info?.first_ts ? `수집 시작 ${new Date(info.first_ts * 1000).toLocaleString('ko-KR')}` : '수집 시작 —'}
          {info ? ` · 분 기록 ${fmtNum(info.minute_rows)}(${info.keep_days}일 보관) · 시간 기록 ${fmtNum(info.hour_rows)} · DB ${fmtBytes(info.db_bytes)}` : ''}
        </span>
        <span className="spacer" />
        <button className="danger" onClick={reset}>통계 초기화</button>
      </div>
      <div className="ops-grid2">
        <section><h4>CPU (%, 1코어 = 100 · 4코어 최대 400)</h4><Chart points={pts} range={range} unit="" fixedMax={400} series={[
          { key: 'cpu', label: '라우터 평균', color: '#3ddc84', area: true },
          { key: 'cpu_max', label: '라우터 최대', color: '#ff9f6b' },
          { key: 'cpu_sys', label: '시스템 전체', color: '#7cc4ff' },
          { key: 'cpu_norm', label: `라우터 ${((stats?.cpu_ref_mhz || 2000) / 1000)} GHz 환산`, color: '#c8a2ff' },
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
