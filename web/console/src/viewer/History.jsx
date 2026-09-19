import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime } from '../api.js'
import { ColumnTracer, ColumnStroker } from '../traceRender.js'
import { getStream, playoutNow } from '../waveStore.js'
import { latest } from '../ws.js'

/**
 * Stored-waveform history for one patch. The router keeps every record in hourly files; this panel shows the
 * hour buttons and lists that hour as consecutive windows (10–120 s each, newest first): ECG on top with the
 * accel / Pleth / resp traces as thin strips glued underneath, pace marks included. Windows draw when scrolled
 * into view; data is fetched on demand in 5-minute chunks (binary, ~230 KB each for ECG+accel) and cached.
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

/** Draw one window [t0, t0+span) of runs into a canvas with the pixel-column tracer; pace ticks along the top. */
function drawStrip(canvas, { runs, pace, t0, spanMs, range, color, theme, lineWidth = 1.6, grid = true, live = null }) {
  const box = canvas.parentElement
  const r = box.getBoundingClientRect()
  const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height))
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr) }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, W, H)
  const px = W / (spanMs / 1000) // px per second
  if (grid) {
    // ECG paper grid: 25 mm/s, bold line each 0.2 s
    ctx.strokeStyle = theme.grid; ctx.lineWidth = 1
    for (let t = 0; t * px * 0.2 <= W; t++) { const x = Math.round(t * px * 0.2) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
    const minor = px * 0.2, yc = H / 2
    for (let j = -Math.ceil(yc / minor); j * minor <= yc; j++) { const y = Math.round(yc + j * minor) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke() }
  }
  const vm = Math.max(3, H * 0.1), [lo, hi] = range
  const yOf = (v) => H - vm - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 2 * vm)
  const xOf = (t) => ((t - t0) / spanMs) * W
  const tracer = new ColumnTracer(), stroker = new ColumnStroker(ctx, dpr)
  stroker.begin(color, lineWidth)
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
  if (live != null && live >= t0 && live < t0 + spanMs) { // sweep front of the live window
    const x = Math.round(xOf(live)) + 0.5
    ctx.strokeStyle = theme.paceLine[1] || '#fff'; ctx.lineWidth = 1; ctx.globalAlpha = 0.6
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.globalAlpha = 1
  }
  for (const [t, ch] of pace) {
    if (t < t0 || t >= t0 + spanMs) continue
    const x = Math.round(xOf(t)) + 0.5, c = theme.paceLine[ch] || theme.paceLine[1]
    ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, 9); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x - 3, 9); ctx.lineTo(x + 3, 9); ctx.lineTo(x, 13); ctx.closePath(); ctx.fill()
  }
}

/** One window in the list: ECG on top, accel / resp as thin strips glued underneath. Draws only while visible. */
function Window({ t0, spanMs, loaded, pace, theme, onVisible, keys }) {
  const ref = useRef(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    const io = new IntersectionObserver((es) => { const v = es[es.length - 1].isIntersecting; setVisible(v); if (v) onVisible(t0) }, { rootMargin: '300px' })
    io.observe(el)
    return () => io.disconnect()
  }, [t0, onVisible])
  const t1 = t0 + spanMs
  const rows = useMemo(() => {
    const ecg = { key: 'ecg', range: [-1.5, 2.0], color: '#3ddc84', h: 'hx-ecg', lw: 1.6, grid: true }
    const thin = []
    if (keys.has('ppg')) thin.push({ key: 'ppg', range: [-1.2, 1.5], color: '#7cc4ff', h: 'hx-thin', lw: 1.1 })
    if (keys.has('accel')) thin.push({ key: 'accel', axis: 0, range: [-1.6, 1.6], color: '#ff9783', h: 'hx-thin', lw: 1.1 })
    if (keys.has('resp_wave')) thin.push({ key: 'resp_wave', range: [-1.5, 1.5], color: '#f5d442', h: 'hx-thin', lw: 1.1 })
    return [ecg, ...thin]
  }, [keys])
  const canvases = useRef([])
  useEffect(() => {
    if (!visible) return
    rows.forEach((row, i) => {
      const c = canvases.current[i]
      if (!c) return
      drawStrip(c, { runs: slice(loaded, row.key, row.axis || 0, t0, t1), pace: row.key === 'ecg' ? pace : [], t0, spanMs, range: row.range, color: row.color, theme, lineWidth: row.lw, grid: !!row.grid })
    })
  }, [visible, loaded, pace, rows, t0, t1, spanMs, theme])
  const has = loaded.length > 0
  return (
    <div ref={ref} className="hx-win">
      <div className="hx-win-t"><b>{fmtTime(t0)}</b><span className="ds-dim"> ~ {fmtTime(t1)}</span>{!has && <span className="ds-dim"> · 불러오는 중…</span>}</div>
      {rows.map((row, i) => <div key={row.key} className={'hx-box ' + row.h}><canvas ref={(el) => { canvases.current[i] = el }} /><span className="hx-lbl" style={{ color: row.color }}>{row.key === 'ecg' ? 'ECG' : row.key === 'ppg' ? 'Pleth' : row.key === 'accel' ? 'Accel' : 'Resp'}</span></div>)}
    </div>
  )
}

/** The newest window, drawn live: samples accumulate from the WS rings as they play out, filling the strip
 *  left to right; when the playout clock crosses the next span boundary the window rolls over and the
 *  completed one becomes the first stored strip (the parent refreshes the index and re-reads that chunk). */
function LiveWindow({ id, spanMs, theme, keys, onRollover }) {
  const canvases = useRef([])
  const [t0, setT0] = useState(null)
  const rows = useMemo(() => {
    const r = [{ key: 'ecg', ring: 'ecg', range: [-1.5, 2.0], color: '#3ddc84', h: 'hx-ecg', lw: 1.6, grid: true, label: 'ECG' }]
    if (keys.has('ppg')) r.push({ key: 'ppg', ring: 'ppg', range: [-1.2, 1.5], color: '#7cc4ff', h: 'hx-thin', lw: 1.1, label: 'Pleth' })
    if (keys.has('accel')) r.push({ key: 'accel', ring: 'accel0', range: [-1.6, 1.6], color: '#ff9783', h: 'hx-thin', lw: 1.1, label: 'Accel' })
    if (keys.has('resp_wave')) r.push({ key: 'resp_wave', ring: 'resp_wave', range: [-1.5, 1.5], color: '#f5d442', h: 'hx-thin', lw: 1.1, label: 'Resp' })
    return r
  }, [keys])
  useEffect(() => {
    const bufs = new Map() // ring key → { t: [], v: [], lastAbs, fs }
    let cur = null, paceSeen = null
    const pace = []
    const tick = () => {
      const T = playoutNow(performance.now())
      if (T == null) return
      const w0 = Math.floor(T / spanMs) * spanMs
      if (cur !== w0) { const prev = cur; cur = w0; bufs.clear(); pace.length = 0; setT0(w0); if (prev != null) onRollover?.(prev) }
      for (const row of rows) {
        const st = getStream(`${id}:${row.ring}`)
        if (!st || !st.len) continue
        const b = bufs.get(row.ring) || { t: [], v: [], lastAbs: null, fs: st.sampleRate }
        let i = b.lastAbs == null ? 0 : b.lastAbs - st.trimmed + 1
        if (i < 0) i = 0
        for (; i < st.len; i++) { const t = st.tAt(i); if (t > T) break; if (t >= cur) { b.t.push(t); b.v.push(st.vAt(i)) } b.lastAbs = st.trimmed + i }
        bufs.set(row.ring, b)
      }
      const l = latest.get(id)
      if (l?.pace?.length && l.paceSeq != null && l.paceSeq !== paceSeen) {
        const st = getStream(`${id}:ecg`), fs = st?.sampleRate || 250, step = 1000 / fs, n = Math.round(fs * 0.2)
        const p0 = (l.paceTs ?? l.ts_ms) - (n - 1) * step
        for (const m of l.pace) pace.push([p0 + (m & 0x3fff) * step, (m >> 14) & 3])
        paceSeen = l.paceSeq
      }
      rows.forEach((row, i) => {
        const c = canvases.current[i]
        const b = bufs.get(row.ring)
        if (!c) return
        // split the accumulated samples into uniformly spaced runs at gaps
        const runs = []
        if (b && b.t.length) {
          const step = 1000 / b.fs
          let s0 = 0
          for (let k = 1; k <= b.t.length; k++) {
            if (k === b.t.length || b.t[k] - b.t[k - 1] > step * 1.5) { runs.push({ t0: b.t[s0], step, scale: 1, axes: 1, axis: 0, data: b.v, i0: s0, i1: k }); s0 = k }
          }
        }
        drawStrip(c, { runs, pace: row.key === 'ecg' ? pace : [], t0: cur, spanMs, range: row.range, color: row.color, theme, lineWidth: row.lw, grid: !!row.grid, live: T })
      })
    }
    const iv = setInterval(tick, 50) // 20 fps is plenty for a strip that only grows at the right edge
    return () => clearInterval(iv)
  }, [id, spanMs, theme, rows, onRollover])
  return (
    <div className="hx-win hx-live">
      <div className="hx-win-t"><b>{t0 != null ? fmtTime(t0) : '--:--:--'}</b><span className="ds-dim"> ~ {t0 != null ? fmtTime(t0 + spanMs) : ''}</span><span className="hx-live-tag">LIVE</span></div>
      {rows.map((row, i) => <div key={row.key} className={'hx-box ' + row.h}><canvas ref={(el) => { canvases.current[i] = el }} /><span className="hx-lbl" style={{ color: row.color }}>{row.label}</span></div>)}
    </div>
  )
}

export default function HistoryPanel({ id, theme, onClose, compact }) {
  const th = { bg: '#000', grid: 'rgba(243,242,242,.10)', paceLine: ['#ffe34d', '#ffffff', '#ff9783'], ...(theme || {}) }
  const [info, setInfo] = useState(null) // { index, files }
  const [chunks, setChunks] = useState(new Map()) // chunk index → decoded header (with segments); null = in flight
  const [loading, setLoading] = useState(0)
  const [err, setErr] = useState('')
  const [hour, setHour] = useState('') // selected hour key (YYYYMMDD-HH)
  const [span, setSpan] = useState(30)
  const [height, setHeight] = useState(() => { try { return Number(localStorage.getItem('hx.height')) || 120 } catch { return 120 } }) // ECG strip px; thin strips scale with it
  useEffect(() => { try { localStorage.setItem('hx.height', String(height)) } catch { /* ignore */ } }, [height])
  const spanMs = span * 1000
  useEffect(() => {
    let alive = true
    api.patch(id).then((d) => { if (!alive) return; setInfo(d); const files = d?.files || []; if (files.length) setHour(files[files.length - 1].hour) }).catch((e) => setErr(e.message))
    return () => { alive = false }
  }, [id])
  // a live window completed: 6 s later (writer flush) re-read the index and drop the cached chunk so the new
  // stored strip fills in under the live one
  const onRollover = useMemo(() => (w0) => {
    setTimeout(() => {
      api.patch(id).then((d) => setInfo(d)).catch(() => {})
      setChunks((m) => { const n = new Map(m); n.delete(Math.floor(w0 / CHUNK_MS)); n.delete(Math.floor((w0 + spanMs) / CHUNK_MS)); return n })
    }, 6000)
  }, [id, spanMs])
  const ensureChunk = (c) => {
    setChunks((m) => {
      if (m.has(c)) return m
      setLoading((n) => n + 1)
      fetchChunk(id, c * CHUNK_MS, (c + 1) * CHUNK_MS).then((h) => setChunks((mm) => new Map(mm).set(c, h))).catch((e) => { setErr(e.message); setChunks((mm) => { const n = new Map(mm); n.delete(c); return n }) }).finally(() => setLoading((n) => n - 1))
      return new Map(m).set(c, null)
    })
  }
  // a window scrolled into view: make sure the chunks covering it are loaded
  const onVisible = useMemo(() => (t0) => { for (let c = Math.floor(t0 / CHUNK_MS); c <= Math.floor((t0 + spanMs - 1) / CHUNK_MS); c++) ensureChunk(c) }, [spanMs, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = useMemo(() => [...chunks.values()].filter(Boolean), [chunks])
  const pace = useMemo(() => loaded.flatMap((h) => h.pace).map(([t, m]) => [t, (m >> 14) & 3]), [loaded])
  const keys = useMemo(() => new Set(loaded.flatMap((h) => h.segments.map((s) => s.key))), [loaded])
  const hours = info?.files || []
  const ix = info?.index
  // hour file keys are UTC (router hour_key); show them in local time
  const hourStart = (key) => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(9, 11))
  const localHour = (key) => { const d = new Date(hourStart(key)); return { day: d.toLocaleDateString('ko-KR'), hh: String(d.getHours()).padStart(2, '0') } }
  // windows of the selected hour, newest first, clipped to the stored range
  const windows = useMemo(() => {
    if (!hour || !ix) return []
    const h0 = hourStart(hour), h1 = h0 + 3600000
    const from = Math.max(h0, Math.floor(ix.first_ts_ms / spanMs) * spanMs), to = Math.min(h1, ix.last_ts_ms)
    const v = []
    for (let t = from; t < to; t += spanMs) v.push(t)
    return v.reverse()
  }, [hour, ix, spanMs])
  if (err) return <div className="hx"><div className="hx-bar"><span className="ds-dim">이력을 불러오지 못했습니다: {err}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  if (!ix) return <div className="hx"><div className="hx-bar"><span className="ds-dim">{info && !ix ? '저장된 파형이 없습니다.' : '저장 색인 읽는 중…'}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  return (
    <div className={'hx' + (compact ? ' compact' : '')}>
      <div className="hx-bar">
        <span className="hx-when"><b>{hour ? `${localHour(hour).day} ${localHour(hour).hh}시` : ''}</b><span className="ds-dim"> · {windows.length}개 구간</span></span>
        <span className="hx-seg">{SPANS.map((s) => <button key={s} className={span === s ? 'on' : ''} onClick={() => setSpan(s)}>{s}s</button>)}</span>
        <label className="hx-h"><span className="ds-dim">높이</span><input type="range" min="60" max="320" step="10" value={height} onChange={(e) => setHeight(Number(e.target.value))} title={`ECG ${height}px`} /><span className="ds-dim">{height}px</span></label>
        <span className="ds-dim">{loading ? '불러오는 중…' : `${(ix.records || 0).toLocaleString()} 레코드 · ${hours.length}개 시간 파일`}</span>
        <span className="spacer" />
        <button className="btn btn-secondary" onClick={onClose}>실시간으로</button>
      </div>
      <div className="hx-hours">{hours.map((f) => <button key={f.hour} className={f.hour === hour ? 'on' : ''} title={`${localHour(f.hour).day} ${localHour(f.hour).hh}시 · ${(f.bytes / 2 ** 20).toFixed(1)} MB`} onClick={() => setHour(f.hour)}>{localHour(f.hour).hh}시</button>)}</div>
      <div className="hx-list" style={{ '--hx-ecg': `${height}px`, '--hx-thin': `${Math.max(20, Math.round(height * 0.28))}px` }}>
        <LiveWindow id={id} spanMs={spanMs} theme={th} keys={keys.size ? keys : new Set(['ecg', 'accel'])} onRollover={onRollover} />
        {windows.map((t0) => <Window key={t0} t0={t0} spanMs={spanMs} loaded={loaded} pace={pace} theme={th} onVisible={onVisible} keys={keys} />)}
        {!windows.length && <div className="ds-dim">이 시간에 저장된 구간이 없습니다.</div>}
      </div>
    </div>
  )
}
