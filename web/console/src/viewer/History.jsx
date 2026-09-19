import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime } from '../api.js'
import { ColumnTracer, ColumnStroker } from '../traceRender.js'

/**
 * Stored-waveform history for one patch. The router keeps every record in hourly files; this panel shows the
 * coverage timeline, lets the user pick a moment (hour buttons + slider), and renders a window (10–120 s) of the
 * stored ECG / PPG / respiration / accel traces with pace marks, with step buttons and 1×/4×/16× playback.
 * Data is fetched in 5-minute chunks (binary, ~150 KB each for ECG+accel) and cached per chunk.
 */
const CHUNK_MS = 5 * 60 * 1000
const SPANS = [10, 30, 60, 120]
const TRACES = [
  { key: 'ecg', label: 'ECG', range: [-1.5, 2.0], color: '#3ddc84' },
  { key: 'ppg', label: 'Pleth', range: [-1.2, 1.5], color: '#7cc4ff', alt: { key: 'accel', axis: 0, label: 'Accel X', range: [-1.6, 1.6], color: '#ff9783' } },
  { key: 'resp_wave', label: 'Resp', range: [-1.5, 1.5], color: '#f5d442' },
]

/** Decode the `/api/wave/{id}/waves` frame: [0xB3][u32 hlen][JSON][i16 blob]. */
async function fetchChunk(id, from, to) {
  const r = await fetch(`/api/wave/${id}/waves?from_ms=${from}&to_ms=${to}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const buf = await r.arrayBuffer()
  const dv = new DataView(buf)
  if (dv.getUint8(0) !== 0xb3) throw new Error('bad frame')
  const hlen = dv.getUint32(1, true)
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 5, hlen)))
  const blob = new Int16Array(buf.slice(5 + hlen))
  for (const s of h.segments) s.data = blob.subarray(s.off, s.off + s.n * s.axes)
  return h
}

/** Samples of one wave key inside [t0, t1): list of { t, v } runs (per segment, per axis). */
function slice(chunks, key, axis, t0, t1) {
  const runs = []
  for (const h of chunks) {
    for (const s of h.segments) {
      if (s.key !== key) continue
      const step = 1000 / s.fs
      const end = s.t0_ms + s.n * step
      if (end < t0 || s.t0_ms > t1) continue
      const i0 = Math.max(0, Math.floor((t0 - s.t0_ms) / step)), i1 = Math.min(s.n, Math.ceil((t1 - s.t0_ms) / step))
      if (i1 <= i0) continue
      runs.push({ t0: s.t0_ms + i0 * step, step, scale: s.scale, axes: s.axes, axis, data: s.data, i0, i1 })
    }
  }
  runs.sort((a, b) => a.t0 - b.t0)
  return runs
}

/** Static strip: draws the runs for [t0, t0+span) with the pixel-column tracer; pace ticks along the top. */
function Strip({ runs, pace, t0, spanMs, range, color, label, sub, theme }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const box = canvas.parentElement
    const r = box.getBoundingClientRect()
    const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H)
    // ECG paper grid: 25 mm/s, bold line each 0.2 s
    const px = W / (spanMs / 1000) // px per second
    ctx.strokeStyle = theme.grid; ctx.lineWidth = 1
    for (let t = 0; t * px * 0.2 <= W; t++) { const x = Math.round(t * px * 0.2) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
    const minor = px * 0.2, yc = H / 2
    for (let j = -Math.ceil(yc / minor); j * minor <= yc; j++) { const y = Math.round(yc + j * minor) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
    const vm = Math.max(8, H * 0.12), [lo, hi] = range
    const yOf = (v) => H - vm - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 2 * vm)
    const xOf = (t) => ((t - t0) / spanMs) * W
    const tracer = new ColumnTracer(), stroker = new ColumnStroker(ctx, dpr)
    stroker.begin(color, 1.6)
    let pT = null
    for (const run of runs) {
      for (let i = run.i0; i < run.i1; i++) {
        const t = run.t0 + (i - run.i0) * run.step
        const v = run.data[i * run.axes + run.axis] * run.scale
        const gap = pT != null && t - pT > run.step * 1.5
        tracer.point(xOf(t) * dpr, yOf(v) * dpr, gap, stroker.emit)
        pT = t
      }
    }
    if (tracer.col >= 0) tracer.flush(stroker.emit) // the last column too (nothing follows it)
    stroker.end()
    for (const [t, ch] of pace) {
      if (t < t0 || t >= t0 + spanMs) continue
      const x = Math.round(xOf(t)) + 0.5, c = theme.paceLine[ch] || theme.paceLine[1]
      ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, 9); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - 3, 9); ctx.lineTo(x + 3, 9); ctx.lineTo(x, 13); ctx.closePath(); ctx.fill()
    }
  }, [runs, pace, t0, spanMs, range, color, theme])
  return (
    <div className="hx-row">
      <div className="hx-ttl"><b>{label}</b><span className="ds-dim">{sub}</span></div>
      <div className="hx-box"><canvas ref={ref} /></div>
    </div>
  )
}

export default function HistoryPanel({ id, theme, onClose, compact }) {
  const th = { bg: '#000', grid: 'rgba(243,242,242,.10)', paceLine: ['#ffe34d', '#ffffff', '#ff9783'], ...(theme || {}) }
  const [info, setInfo] = useState(null) // { index, files }
  const [chunks, setChunks] = useState(new Map()) // chunk index → decoded header (with segments)
  const [loading, setLoading] = useState(0)
  const [err, setErr] = useState('')
  const [cursor, setCursor] = useState(null) // window start (ms)
  const [span, setSpan] = useState(30)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const spanMs = span * 1000
  useEffect(() => {
    let alive = true
    api.patch(id).then((d) => { if (!alive) return; setInfo(d); if (d?.index?.last_ts_ms) setCursor(Math.max(d.index.first_ts_ms, d.index.last_ts_ms - spanMs)) }).catch((e) => setErr(e.message))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])
  // fetch the chunks that cover the window (plus the next one while playing)
  useEffect(() => {
    if (cursor == null) return
    const first = Math.floor(cursor / CHUNK_MS), last = Math.floor((cursor + spanMs + (playing ? CHUNK_MS / 2 : 0)) / CHUNK_MS)
    for (let c = first; c <= last; c++) {
      if (chunks.has(c)) continue
      setChunks((m) => new Map(m).set(c, null)) // in flight
      setLoading((n) => n + 1)
      fetchChunk(id, c * CHUNK_MS, (c + 1) * CHUNK_MS).then((h) => setChunks((m) => new Map(m).set(c, h))).catch((e) => { setErr(e.message); setChunks((m) => { const n = new Map(m); n.delete(c); return n }) }).finally(() => setLoading((n) => n - 1))
    }
  }, [id, cursor, spanMs, playing, chunks])
  // playback: advance the cursor in real time × speed
  useEffect(() => {
    if (!playing) return
    let raf = 0, last = performance.now()
    const step = (now) => { const dt = (now - last) * speed; last = now; setCursor((c) => { const n = c + dt; if (info?.index?.last_ts_ms && n + spanMs > info.index.last_ts_ms) { setPlaying(false); return c } return n }); raf = requestAnimationFrame(step) }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, spanMs, info])
  useEffect(() => {
    const f = (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p) }
      else if (e.key === 'ArrowLeft') { setCursor((c) => c - spanMs) }
      else if (e.key === 'ArrowRight') { setCursor((c) => c + spanMs) }
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [spanMs])

  const loaded = useMemo(() => [...chunks.values()].filter(Boolean), [chunks])
  const t1 = cursor + spanMs
  const runsOf = (key, axis = 0) => slice(loaded, key, axis, cursor, t1)
  const pace = useMemo(() => loaded.flatMap((h) => h.pace).map(([t, m]) => [t, (m >> 14) & 3]), [loaded])
  const hours = info?.files || []
  const ix = info?.index
  const hourKeyOf = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}` }
  const hourStart = (key) => new Date(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(9, 11)).getTime()
  const curHour = cursor != null ? hourKeyOf(cursor) : ''
  const hourPos = cursor != null ? ((cursor - hourStart(curHour)) / 3600000) : 0
  const keys = new Set(loaded.flatMap((h) => h.segments.map((s) => s.key)))
  const hasData = (key) => keys.has(key)
  if (err) return <div className="hx"><div className="hx-bar"><span className="ds-dim">이력을 불러오지 못했습니다: {err}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  if (!ix || cursor == null) return <div className="hx"><div className="hx-bar"><span className="ds-dim">{info && !ix ? '저장된 파형이 없습니다.' : '저장 색인 읽는 중…'}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  return (
    <div className={'hx' + (compact ? ' compact' : '')}>
      <div className="hx-bar">
        <span className="hx-when"><b>{fmtTime(cursor)}</b><span className="ds-dim"> ~ {fmtTime(t1)} · {new Date(cursor).toLocaleDateString('ko-KR')}</span></span>
        <span className="hx-seg">{SPANS.map((s) => <button key={s} className={span === s ? 'on' : ''} onClick={() => setSpan(s)}>{s}s</button>)}</span>
        <span className="hx-seg">
          <button onClick={() => setCursor((c) => Math.max(ix.first_ts_ms, c - spanMs))} title="이전 (←)">◀</button>
          <button className={playing ? 'on' : ''} onClick={() => setPlaying(!playing)} title="재생/정지 (space)">{playing ? '❚❚' : '▶'}</button>
          <button onClick={() => setCursor((c) => Math.min(ix.last_ts_ms - spanMs, c + spanMs))} title="다음 (→)">▶▶</button>
        </span>
        <span className="hx-seg">{[1, 4, 16].map((s) => <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}</span>
        <button className="btn btn-secondary" onClick={() => setCursor(Math.max(ix.first_ts_ms, ix.last_ts_ms - spanMs))}>최근</button>
        <span className="ds-dim">{loading ? '불러오는 중…' : `${(ix.records || 0).toLocaleString()} 레코드 · ${hours.length}개 시간 파일`}</span>
        <span className="spacer" />
        <button className="btn btn-secondary" onClick={onClose}>실시간으로</button>
      </div>
      <div className="hx-timeline">
        <div className="hx-hours">{hours.map((f) => <button key={f.hour} className={f.hour === curHour ? 'on' : ''} title={`${f.hour.slice(0, 8)} ${f.hour.slice(9)}시 · ${(f.bytes / 2 ** 20).toFixed(1)} MB`} onClick={() => setCursor(Math.max(hourStart(f.hour), ix.first_ts_ms))}>{f.hour.slice(9)}시</button>)}</div>
        <input type="range" min="0" max="1" step="0.0005" value={hourPos} onChange={(e) => setCursor(hourStart(curHour) + Number(e.target.value) * 3600000)} className="hx-slider" title="이 시간 안에서 이동" />
      </div>
      <div className="hx-waves">
        {TRACES.map((t) => {
          const use = hasData(t.key) ? t : (t.alt && hasData(t.alt.key) ? t.alt : null)
          if (!use) return <div key={t.key} className="hx-row"><div className="hx-ttl"><b>{t.label}</b><span className="ds-dim">저장된 채널 없음</span></div><div className="hx-box hx-none" /></div>
          return <Strip key={t.key} runs={runsOf(use.key, use.axis || 0)} pace={use.key === 'ecg' ? pace : []} t0={cursor} spanMs={spanMs} range={use.range} color={use.color} label={use.label} sub={`저장 파형 · ${span} s`} theme={th} />
        })}
      </div>
    </div>
  )
}
