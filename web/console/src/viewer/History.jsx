import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, fmtTime } from '../api.js'
import { ColumnTracer, ColumnStroker } from '../traceRender.js'
import { getStream, playoutNow } from '../waveStore.js'
import { latest } from '../ws.js'
import { ACCEL_COLORS } from '../AccelPlot.jsx'

/**
 * Stored-waveform history for one patch. The router keeps every record in hourly files; this panel shows the
 * hour buttons and lists that hour as consecutive windows (10–120 s each, newest first): ECG on top with the
 * accel / Pleth / resp traces as thin strips glued underneath, pace marks included. Windows draw when scrolled
 * into view; data is fetched on demand in 5-minute chunks (binary, ~230 KB each for ECG+accel) and cached.
 */
const CHUNK_MS = 5 * 60 * 1000
const DEFAULT_KEYS = new Set(['ecg', 'accel'])
const SPANS = [10, 30, 60, 120]
// accelerometer X / Y / Z are drawn overlaid in one strip
const AccelLegend = () => <span className="hx-lbl hx-lbl-acc">Accel {['X', 'Y', 'Z'].map((n, i) => <b key={n} style={{ color: ACCEL_COLORS[i] }}>{n}</b>)}</span>

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

/** Runs from the live strip's accumulated samples (already physical values), clipped to [t0, t1). */
function runsFromSamples(rec, t0, t1) {
  if (!rec || !rec.t.length) return []
  const step = 1000 / (rec.fs || 250)
  const runs = []
  let s0 = null
  for (let k = 0; k < rec.t.length; k++) {
    const inside = rec.t[k] >= t0 && rec.t[k] < t1
    const brk = k > 0 && rec.t[k] - rec.t[k - 1] > step * 1.5
    if (!inside || brk) {
      if (s0 != null && k > s0) runs.push({ t0: rec.t[s0], step, scale: 1, axes: 1, axis: 0, data: rec.v, i0: s0, i1: k })
      s0 = inside ? k : null
      continue
    }
    if (s0 == null) s0 = k
  }
  if (s0 != null) runs.push({ t0: rec.t[s0], step, scale: 1, axes: 1, axis: 0, data: rec.v, i0: s0, i1: rec.t.length })
  return runs
}
const samplesIn = (runs) => runs.reduce((n, r) => n + (r.i1 - r.i0), 0)

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
function drawStrip(canvas, { runs, pace, t0, spanMs, range, color, theme, lineWidth = 1.6, grid = true, live = null, layers = [] }) {
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
  // overlaid layers first (accel Y/Z), the main trace on top
  for (const L of [...layers, { runs, color }]) {
    const tracer = new ColumnTracer(), stroker = new ColumnStroker(ctx, dpr)
    stroker.begin(L.color, lineWidth)
    let pT = null
    for (const run of L.runs) {
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
  }
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
function Window({ t0, spanMs, loaded, pace, theme, onVisible, keys, fresh }) {
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
    if (keys.has('accel')) thin.push({ key: 'accel', axis: 0, over: [1, 2], range: [-1.6, 1.6], color: ACCEL_COLORS[0], h: 'hx-thin', lw: 1.1 })
    if (keys.has('resp_wave')) thin.push({ key: 'resp_wave', range: [-1.5, 1.5], color: '#f5d442', h: 'hx-thin', lw: 1.1 })
    return [ecg, ...thin]
  }, [keys])
  const canvases = useRef([])
  useEffect(() => {
    if (!visible) return
    rows.forEach((row, i) => {
      const c = canvases.current[i]
      if (!c) return
      // stored copy vs the live strip's handoff: take whichever covers more of this window (the store lags by
      // seconds right after a rollover; the handoff has gaps if the viewer stalled while it was live)
      const pick = (axis) => {
        const stored = slice(loaded, row.key, axis, t0, t1)
        const live = runsFromSamples(fresh?.find((x) => x.key === row.key && (x.axis || 0) === axis), t0, t1)
        return samplesIn(live) > samplesIn(stored) ? live : stored
      }
      const layers = (row.over || []).map((ax) => ({ runs: pick(ax), color: ACCEL_COLORS[ax] }))
      drawStrip(c, { runs: pick(row.axis || 0), layers, pace: row.key === 'ecg' ? pace : [], t0, spanMs, range: row.range, color: row.color, theme, lineWidth: row.lw, grid: !!row.grid })
    })
  }, [visible, loaded, pace, rows, t0, t1, spanMs, theme, fresh])
  const has = loaded.length > 0
  return (
    <div ref={ref} className="hx-win">
      <div className="hx-win-t"><b>{fmtTime(t0)}</b><span className="ds-dim"> ~ {fmtTime(t1)}</span>{!has && <span className="ds-dim"> · 불러오는 중…</span>}</div>
      {rows.map((row, i) => <div key={row.key} className={'hx-box ' + row.h}><canvas ref={(el) => { canvases.current[i] = el }} />{row.key === 'accel' ? <AccelLegend /> : <span className="hx-lbl" style={{ color: row.color }}>{row.key === 'ecg' ? 'ECG' : row.key === 'ppg' ? 'Pleth' : 'Resp'}</span>}</div>)}
    </div>
  )
}

/** The newest window, drawn live and incrementally: the grid is painted once per window, each new ring sample
 *  extends the trace through a persistent column tracer (no full redraws), the sweep bar is erased by restoring a
 *  grid slice, all on requestAnimationFrame. When the playout clock crosses the next span boundary the window rolls
 *  over and the completed one becomes the first stored strip (the parent refreshes the index and that chunk). */
function LiveWindow({ id, spanMs, theme, keys, onRollover, loaded, onWindow }) {
  const canvases = useRef([])
  const [t0, setT0] = useState(null)
  const rows = useMemo(() => {
    const r = [{ key: 'ecg', ring: 'ecg', range: [-1.5, 2.0], color: '#3ddc84', h: 'hx-ecg', lw: 1.6, grid: true, label: 'ECG' }]
    if (keys.has('ppg')) r.push({ key: 'ppg', ring: 'ppg', range: [-1.2, 1.5], color: '#7cc4ff', h: 'hx-thin', lw: 1.1, label: 'Pleth' })
    if (keys.has('accel')) {
      // Y and Z trace onto X's canvas (overlay rows: no box of their own, no background of their own)
      const base = r.length
      r.push({ key: 'accel', ring: 'accel0', axis: 0, range: [-1.6, 1.6], color: ACCEL_COLORS[0], h: 'hx-thin', lw: 1.1, label: 'Accel' })
      for (const ax of [1, 2]) r.push({ key: 'accel', ring: `accel${ax}`, axis: ax, base, range: [-1.6, 1.6], color: ACCEL_COLORS[ax], lw: 1.1 })
    }
    if (keys.has('resp_wave')) r.push({ key: 'resp_wave', ring: 'resp_wave', range: [-1.5, 1.5], color: '#f5d442', h: 'hx-thin', lw: 1.1, label: 'Resp' })
    return r
  }, [keys])
  const loadedRef = useRef(loaded); loadedRef.current = loaded
  useEffect(() => {
    // per row: canvas prep + persistent tracer state
    const S = rows.map(() => ({ gen: 0, ctx: null, W: 0, H: 0, dpr: 1, grid: null, tracer: new ColumnTracer(), stroker: null, drawn: 0, pT: null, barX: null, seeded: false, t: [], v: [], lastAbs: null, fs: 250 }))
    let cur = null, curAt = 0, paceSeen = null
    const pace = [], paceDrawn = new Set()
    const prep = (i) => {
      const st = S[i]
      if (rows[i].base != null) { // overlay row: borrow the base row's canvas; "resized" when the base was
        const b = S[rows[i].base]
        if (!b.ctx || st.gen === b.gen) return false
        st.gen = b.gen; st.ctx = b.ctx; st.W = b.W; st.H = b.H; st.dpr = b.dpr; st.stroker = new ColumnStroker(b.ctx, b.dpr)
        return true
      }
      const canvas = canvases.current[i]
      if (!canvas) return false
      const r = canvas.parentElement.getBoundingClientRect()
      const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height)), dpr = Math.min(window.devicePixelRatio || 1, 2)
      const resized = W !== st.W || H !== st.H
      if (resized) {
        st.W = W; st.H = H; st.dpr = dpr; st.gen++
        canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
        st.ctx = canvas.getContext('2d'); st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        st.grid = document.createElement('canvas'); st.grid.width = canvas.width; st.grid.height = canvas.height
        const g = st.grid.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.fillStyle = theme.bg; g.fillRect(0, 0, W, H)
        if (rows[i].grid) {
          const px = W / (spanMs / 1000)
          g.strokeStyle = theme.grid; g.lineWidth = 1
          for (let t = 0; t * px * 0.2 <= W; t++) { const x = Math.round(t * px * 0.2) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke() }
          const minor = px * 0.2, yc = H / 2
          for (let j = -Math.ceil(yc / minor); j * minor <= yc; j++) { const y = Math.round(yc + j * minor) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke() }
        }
        st.stroker = new ColumnStroker(st.ctx, dpr)
      }
      return resized
    }
    const restart = (i) => { const st = S[i]; if (!st.ctx) return; if (rows[i].base == null) st.ctx.drawImage(st.grid, 0, 0, st.W, st.H); st.tracer.reset(); st.stroker.reset(); st.drawn = 0; st.pT = null; st.barX = null; st.seeded = false }
    const yOf = (st, range, v) => { const vm = Math.max(3, st.H * 0.1), [lo, hi] = range; return st.H - vm - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (st.H - 2 * vm) }
    const xOf = (st, t) => ((t - cur) / spanMs) * st.W
    const traceRuns = (i, runs) => {
      const st = S[i], row = rows[i]
      st.stroker.begin(row.color, row.lw)
      for (const run of runs) {
        for (let k = run.i0; k < run.i1; k++) {
          const t = run.t0 + (k - run.i0) * run.step, v = run.data[k * run.axes + run.axis] * run.scale
          const gap = st.pT != null && t - st.pT > run.step * 1.5
          st.tracer.point(xOf(st, t) * st.dpr, yOf(st, row.range, v) * st.dpr, gap, st.stroker.emit)
          st.pT = t
        }
      }
      st.stroker.end()
    }
    // append ring samples in [from, upTo] to each row's buffer (the rings are per wave key)
    const pull = (upTo, from) => {
      rows.forEach((row, i) => {
        const st = S[i]
        const rg = getStream(`${id}:${row.ring}`)
        if (!rg || !rg.len) return
        st.fs = rg.sampleRate
        let k = st.lastAbs == null ? 0 : st.lastAbs - rg.trimmed + 1
        if (k < 0) k = 0
        for (; k < rg.len; k++) { const t = rg.tAt(k); if (t > upTo) break; if (t >= from) { st.t.push(t); st.v.push(rg.vAt(k)) } st.lastAbs = rg.trimmed + k }
      })
    }
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const T = playoutNow(performance.now())
      if (T == null) return
      const w0 = Math.floor(T / spanMs) * spanMs
      if (cur !== w0) {
        const prev = cur
        // Top the finished window up to its last sample before handing it over: the per-frame pull stops at the
        // playout clock, so everything between the previous frame and the boundary (a whole second or more when
        // the browser stalls) would otherwise be dropped — that is the cut-off tail on the strip below.
        if (prev != null) pull(w0 - 1, cur)
        // hand the finished window's own samples over: the store needs up to ~15 s to hold that last minute,
        // and until then a strip drawn from it is missing its tail
        const snap = prev == null ? null : rows.map((row, i) => ({ key: row.key, axis: row.axis || 0, fs: S[i].fs, t: S[i].t.slice(), v: S[i].v.slice() }))
        cur = w0; curAt = performance.now(); pace.length = 0; paceDrawn.clear()
        for (let i = 0; i < S.length; i++) { S[i].t = []; S[i].v = []; S[i].lastAbs = null; prep(i); restart(i) }
        setT0(w0); onWindow?.(w0); if (prev != null) onRollover?.(prev, snap)
      }
      // pace marks of this window from the latest map (each record once)
      const l = latest.get(id)
      if (l?.pace?.length && l.paceSeq != null && l.paceSeq !== paceSeen) {
        const ecg = getStream(`${id}:ecg`), fs = ecg?.sampleRate || 250, step = 1000 / fs, n = Math.round(fs * 0.2)
        const p0 = (l.paceTs ?? l.ts_ms) - (n - 1) * step
        for (const m of l.pace) pace.push([p0 + (m & 0x3fff) * step, (m >> 14) & 3])
        paceSeen = l.paceSeq
      }
      pull(T, cur)
      rows.forEach((row, i) => {
        const st = S[i]
        if (prep(i)) { // resized: repaint everything drawn so far
          restart(i)
          if (st.t.length) { st.seeded = true; traceRuns(i, splitRuns(st)); st.drawn = st.t.length }
        }
        if (!st.ctx) return
        // seed: the part of the window before the oldest ring sample comes from the stored chunk — wait up to
        // 2.5 s for it (the chunk is being re-read), then give up and draw from the rings only
        if (!st.seeded) {
          const ringStart = st.t.length ? st.t[0] : T
          const needSeed = ringStart > cur + 400
          const stored = needSeed ? slice(loadedRef.current, row.key, row.axis || 0, cur, ringStart) : []
          if (!needSeed || stored.length || performance.now() - curAt > 2500) {
            if (stored.length) traceRuns(i, stored)
            st.seeded = true
          } else return
        }
        // extend the trace with the samples not drawn yet (no sweep bar: erasing it would wipe the newest column)
        if (st.drawn < st.t.length) { traceRuns(i, splitRuns(st, st.drawn)); st.drawn = st.t.length }
        if (row.key === 'ecg') {
          for (let j = 0; j < pace.length; j++) {
            const [t, ch] = pace[j]
            if (paceDrawn.has(j) || t > (st.pT ?? -Infinity) || t < cur) continue
            const x = Math.round(xOf(st, t)) + 0.5, c = theme.paceLine[ch] || theme.paceLine[1]
            st.ctx.strokeStyle = c; st.ctx.fillStyle = c; st.ctx.lineWidth = 1.5
            st.ctx.beginPath(); st.ctx.moveTo(x, 1); st.ctx.lineTo(x, 9); st.ctx.stroke()
            st.ctx.beginPath(); st.ctx.moveTo(x - 3, 9); st.ctx.lineTo(x + 3, 9); st.ctx.lineTo(x, 13); st.ctx.closePath(); st.ctx.fill()
            paceDrawn.add(j)
          }
        }
      })
    }
    // accumulated ring samples → uniformly spaced runs (split at gaps), from index `from`
    const splitRuns = (st, from = 0) => {
      const runs = [], step = 1000 / st.fs
      let s0 = from
      for (let k = from + 1; k <= st.t.length; k++) {
        if (k === st.t.length || st.t[k] - st.t[k - 1] > step * 1.5) { runs.push({ t0: st.t[s0], step, scale: 1, axes: 1, axis: 0, data: st.v, i0: s0, i1: k }); s0 = k }
      }
      return runs
    }
    let raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [id, spanMs, theme, rows, onRollover, onWindow])
  return (
    <div className="hx-win hx-live">
      <div className="hx-win-t"><b>{t0 != null ? fmtTime(t0) : '--:--:--'}</b><span className="ds-dim"> ~ {t0 != null ? fmtTime(t0 + spanMs) : ''}</span><span className="hx-live-tag">LIVE</span></div>
      {rows.map((row, i) => row.base == null && <div key={row.key} className={'hx-box ' + row.h}><canvas ref={(el) => { canvases.current[i] = el }} />{row.key === 'accel' ? <AccelLegend /> : <span className="hx-lbl" style={{ color: row.color }}>{row.label}</span>}</div>)}
    </div>
  )
}

export default function HistoryPanel({ id, theme, onClose, compact }) {
  // stable object: a fresh theme object per render restarted the live strip's effect on every render, which
  // re-issued the chunk fetch each time (the flickering '불러오는 중…')
  const th = useMemo(() => ({ bg: '#000', grid: 'rgba(243,242,242,.10)', paceLine: ['#ffe34d', '#ffffff', '#ff9783'], ...(theme || {}) }), [theme])
  const [info, setInfo] = useState(null) // { index, files }
  const [chunks, setChunks] = useState(new Map()) // chunk index → decoded header (with segments); null = in flight
  const [loading, setLoading] = useState(0)
  const [err, setErr] = useState('')
  const [anchor, setAnchor] = useState(null) // list start (ms); null = follow the live window
  const [span, setSpan] = useState(() => { try { return Number(localStorage.getItem('hx.span')) || 60 } catch { return 60 } })
  useEffect(() => { try { localStorage.setItem('hx.span', String(span)) } catch { /* ignore */ } }, [span])
  const [height, setHeight] = useState(() => { try { return Number(localStorage.getItem('hx.height')) || 60 } catch { return 60 } }) // ECG strip px (default = slider minimum); thin strips scale with it
  useEffect(() => { try { localStorage.setItem('hx.height', String(height)) } catch { /* ignore */ } }, [height])
  const spanMs = span * 1000
  useEffect(() => {
    let alive = true
    api.patch(id).then((d) => { if (!alive) return; setInfo(d) }).catch((e) => setErr(e.message))
    return () => { alive = false }
  }, [id])
  // a live window completed: 6 s later (writer flush) re-read the index and drop the cached chunk so the new
  // stored strip fills in under the live one
  // chunk requests are de-duplicated through a ref (not inside a state updater: React may re-run updaters, which
  // re-issued fetches and made the loading text flicker)
  const requested = useRef(new Set())
  // at most 2 chunk requests in flight: a fast scroll through an hour queued a dozen at once, each making the
  // router load a whole hour file
  const inflight = useRef(0)
  const queue = useRef([])
  const pump = () => {
    while (inflight.current < 2 && queue.current.length) {
      const c = queue.current.shift()
      inflight.current++
      fetchChunk(id, c * CHUNK_MS, (c + 1) * CHUNK_MS).then((h) => setChunks((m) => new Map(m).set(c, h))).catch((e) => { setErr(e.message); requested.current.delete(c) }).finally(() => { inflight.current--; setLoading((n) => n - 1); pump() })
    }
  }
  const load = (c) => { setLoading((n) => n + 1); queue.current.push(c); pump() }
  const ensureChunk = (c) => { if (requested.current.has(c)) return; requested.current.add(c); load(c) }
  // a window scrolled into view: make sure the chunks covering it are loaded
  const onVisible = useMemo(() => (t0) => { for (let c = Math.floor(t0 / CHUNK_MS); c <= Math.floor((t0 + spanMs - 1) / CHUNK_MS); c++) ensureChunk(c) }, [spanMs, id]) // eslint-disable-line react-hooks/exhaustive-deps
  const loaded = useMemo(() => [...chunks.values()].filter(Boolean), [chunks])
  const pace = useMemo(() => loaded.flatMap((h) => h.pace).map(([t, m]) => [t, (m >> 14) & 3]), [loaded])
  const keysKey = [...new Set(loaded.flatMap((h) => h.segments.map((s) => s.key)))].sort().join(',')
  const keys = useMemo(() => new Set(keysKey ? keysKey.split(',') : []), [keysKey]) // identity changes only when the channel set does
  const hours = info?.files || []
  const ix = info?.index
  // hour file keys are UTC (router hour_key); show them in local time
  const hourStart = (key) => Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8), +key.slice(9, 11))
  const localHour = (key) => { const d = new Date(hourStart(key)); return { day: d.toLocaleDateString('ko-KR'), hh: String(d.getHours()).padStart(2, '0') } }
  // windows of the selected hour, newest first, clipped to the stored range
  const [liveW0, setLiveW0] = useState(null) // start of the window the live strip is filling
  const [fresh, setFresh] = useState(new Map()) // window start → samples handed over by the live strip (last 4)
  // the live window (re)started: (re)read the chunk that holds it, so a cached copy fetched minutes ago does not
  // leave the part before the rings' oldest sample empty
  const refetchChunk = (c) => { requested.current.add(c); load(c) }
  const onRollover = useMemo(() => (w0, snap) => {
    if (snap) {
      setFresh((m) => {
        const n = new Map(m).set(w0, snap)
        for (const k of [...n.keys()].sort((a, b) => b - a).slice(4)) n.delete(k)
        return n
      })
    }
    // Re-read (never drop) the chunks holding the window that just finished: the cached copy was fetched while
    // that minute was still being recorded, so it ends early — a strip drawn from it shows grid only. Fetch at
    // once (the store has the finished minute within ~2 s) and again after its next flush for the tail.
    const cs = new Set([Math.floor(w0 / CHUNK_MS), Math.floor((w0 + spanMs) / CHUNK_MS)])
    for (const c of cs) refetchChunk(c)
    setTimeout(() => {
      // refresh the index; if the latest hour was selected, follow a newly started hour file
      api.patch(id).then(setInfo).catch(() => {})
      for (const c of cs) refetchChunk(c)
    }, 6000)
  }, [id, spanMs])
  const onWindow = useMemo(() => (w0) => { setLiveW0(w0); for (let c = Math.floor(w0 / CHUNK_MS); c <= Math.floor((w0 + spanMs - 1) / CHUNK_MS); c++) refetchChunk(c) }, [spanMs, id]) // eslint-disable-line react-hooks/exhaustive-deps
  // The list runs continuously back in time from `anchor` (null = follow the live window), across hour-file
  // boundaries — grouping by hour file made every strip vanish at the top of the hour. Hour buttons jump the
  // anchor; scrolling to the bottom extends the list further back.
  const [count, setCount] = useState(40)
  useEffect(() => { setCount(40) }, [anchor, spanMs])
  const top = anchor != null ? anchor : liveW0 != null ? liveW0 : ix ? ix.last_ts_ms : null
  const windows = useMemo(() => {
    if (!ix || top == null) return []
    const first = Math.floor(ix.first_ts_ms / spanMs) * spanMs
    const v = []
    for (let t = Math.floor(top / spanMs) * spanMs - spanMs; t >= first && v.length < count; t -= spanMs) v.push(t)
    return v
  }, [ix, top, spanMs, count])
  const more = () => setCount((c) => Math.min(c + 30, 600))
  const onListScroll = (e) => { const el = e.currentTarget; if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) more() }
  if (err) return <div className="hx"><div className="hx-bar"><span className="ds-dim">이력을 불러오지 못했습니다: {err}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  if (!ix) return <div className="hx"><div className="hx-bar"><span className="ds-dim">{info && !ix ? '저장된 파형이 없습니다.' : '저장 색인 읽는 중…'}</span><span className="spacer" /><button className="btn btn-secondary" onClick={onClose}>실시간으로</button></div></div>
  return (
    <div className={'hx' + (compact ? ' compact' : '')}>
      <div className="hx-bar">
        <span className="hx-when"><b>{top != null ? `${new Date(top).toLocaleDateString('ko-KR')} ${fmtTime(windows.length ? windows[windows.length - 1] : top)} ~ ${fmtTime(top)}` : ''}</b><span className="ds-dim"> · {windows.length}개 구간{anchor == null ? ' · 실시간 따라감' : ''}</span></span>
        <span className="hx-seg">{SPANS.map((s) => <button key={s} className={span === s ? 'on' : ''} onClick={() => setSpan(s)}>{s}s</button>)}</span>
        {anchor != null && <button className="btn btn-secondary" onClick={() => setAnchor(null)}>지금으로</button>}
        <label className="hx-h"><span className="ds-dim">높이</span><input type="range" min="60" max="320" step="10" value={height} onChange={(e) => setHeight(Number(e.target.value))} title={`ECG ${height}px`} /><span className="ds-dim">{height}px</span></label>
        <span className="ds-dim">{loading ? '불러오는 중…' : `${(ix.records || 0).toLocaleString()} 레코드 · ${hours.length}개 시간 파일`}</span>
        <span className="spacer" />
        {!compact && <button className="btn btn-secondary" onClick={onClose}>실시간으로</button>}
      </div>
      <div className="hx-hours">{hours.map((f, i) => {
        const start = hourStart(f.hour), end = start + 3600000
        const cur = top != null && top > start && top <= end
        const newest = i === hours.length - 1
        return <button key={f.hour} className={cur ? 'on' : ''} title={`${localHour(f.hour).day} ${localHour(f.hour).hh}시 · ${(f.bytes / 2 ** 20).toFixed(1)} MB`} onClick={() => setAnchor(newest ? null : end)}>{localHour(f.hour).hh}시</button>
      })}</div>
      <div className="hx-list" onScroll={onListScroll} style={{ '--hx-ecg': `${height}px`, '--hx-thin': `${Math.max(20, Math.round(height * 0.28))}px` }}>
        {anchor == null && <LiveWindow id={id} spanMs={spanMs} theme={th} keys={keys.size ? keys : DEFAULT_KEYS} onRollover={onRollover} loaded={loaded} onWindow={onWindow} />}
        {windows.map((t0) => <Window key={t0} t0={t0} spanMs={spanMs} loaded={loaded} pace={pace} theme={th} onVisible={onVisible} keys={keys} fresh={fresh.get(t0)} />)}
        {!windows.length && <div className="ds-dim">저장된 구간이 없습니다.</div>}
        {windows.length >= count && <button className="btn btn-secondary" onClick={more}>더 보기</button>}
      </div>
    </div>
  )
}
