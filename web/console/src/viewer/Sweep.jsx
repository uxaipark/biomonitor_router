import React, { useEffect, useRef } from 'react'
import { getStream, playoutNow } from '../waveStore.js'
import { registerDraw } from '../renderLoop.js'
import { latest } from '../ws.js'
import { getRenderMode, onRenderMode } from '../settings.js'
import { ColumnTracer, ColumnStroker } from '../traceRender.js'

// Monitor-style sweep trace that fills its box (the emulator's Central Station / bed viewer look): black or
// paper ground with an ECG-paper major grid (bold line every 0.2 s), fixed physical range, colour per channel,
// pace-pulse markers. Reads the console's shared rings + playout clock, so it stays phase-locked with WaveCard.
//
// Two renderers (설정 → 메인 뷰어 그래픽):
//  - quality: pixel-column tracer in whole device pixels (uniform thickness, no lost peaks, no AA seams)
//  - speed:   anti-aliased polyline, decimated on full redraws (the original renderer)
const WINDOW_S = 6
const GAP_FRAC = 0.035

export default function Sweep({ id, wave = 'ecg', range = [-1.5, 2.0], color = '#3ddc84', theme, lineWidth = 1.6, pace = true }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    const box = canvas.parentElement
    const ctx = canvas.getContext('2d')
    const th = { bg: '#000', grid: 'rgba(243,242,242,.10)', stale: '#5a6a80', paceLine: ['#ffe34d', '#ffffff', '#ff9783'], ...(theme || {}) }
    let W = 0, H = 0, dpr = 1, lwDev = 2
    let grid = null
    const windowMs = WINDOW_S * 1000
    const [lo, hi] = range
    let lastT = null, lastAbsIdx = null, penX = null, penY = null, penT = null, needFull = true
    let visible = true
    let mode = getRenderMode()
    const tracer = new ColumnTracer()
    let stroker = null
    const offMode = onRenderMode((m) => { mode = m; needFull = true })

    const size = () => {
      const r = box.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (w === W && h === H && canvas.width === Math.round(w * dpr)) return false
      W = w; H = h
      lwDev = Math.max(1, Math.round(lineWidth * dpr))
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      stroker = new ColumnStroker(ctx, dpr)
      grid = document.createElement('canvas')
      grid.width = canvas.width; grid.height = canvas.height
      const g = grid.getContext('2d')
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = th.bg; g.fillRect(0, 0, W, H)
      // ECG paper: 25 mm/s → 1 mm = 0.04 s; bold line every 5 mm (0.2 s); square boxes through the centre line
      const minor = W / WINDOW_S / 25
      g.strokeStyle = th.grid; g.lineWidth = 1
      for (let k = 0; k * minor <= W; k += 5) { const x = Math.round(k * minor) + 0.5; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke() }
      const yc = H / 2
      for (let j = -Math.ceil(yc / (minor * 5)); j * minor * 5 <= yc; j++) { const y = Math.round(yc + j * minor * 5) + 0.5; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke() }
      needFull = true
      return true
    }
    size()
    const ro = new ResizeObserver(() => { if (size()) needFull = true })
    ro.observe(box)
    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting }, { rootMargin: '100px' })
    io.observe(canvas)

    // vertical margin: 12 % of the strip top and bottom (min 8 px) so full-range waves do not touch the edges
    const vm = () => Math.max(8, H * 0.12)
    const yOf = (v) => H - vm() - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 2 * vm())
    const xOf = (t) => ((((t % windowMs) + windowMs) % windowMs) / windowMs) * W
    const gapPx = () => Math.max(10, W * GAP_FRAC)
    const strokeNow = () => { const l = latest.get(id); return l && (l.disconnected || Date.now() - l.rx > 5000) ? th.stale : color }
    // grid restore in whole device pixels (fractional source rects would resample the grid into a blur)
    const blit = (x, w) => {
      if (!(w > 0) || !grid) return
      const sx = Math.floor(x * dpr), sw = Math.min(canvas.width - sx, Math.ceil(w * dpr) + 1)
      if (sw <= 0) return
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(grid, sx, 0, sw, canvas.height, sx, 0, sw, canvas.height)
      ctx.restore()
    }
    // clear from `a` (CSS px) forward to the sweep front `b` plus the gap, wrapping at the right edge
    const eraseAdvance = (a, b) => {
      // the erase start may sit a column or two AHEAD of the sweep front (pen column + line width); treating that
      // as a wrap would wipe the whole trace, so clamp it to the front
      if ((b - a + W * 2) % W > W / 2) a = b
      let len = (b - a + W * 2) % W + gapPx()
      if (len > W) len = W
      const w1 = Math.min(len, W - a)
      blit(a, w1)
      if (len > w1) blit(0, len - w1)
    }
    // Pace marks: queue them as they arrive (each record once) and draw a mark only once the playout clock
    // has passed it, so the tick appears together with the spike in the trace instead of ~1 s ahead of the pen.
    let paceDrawn = null // paceSeq of the last queued pace record (the latest map is replaced per packet)
    const pending = [] // [{ t, ch }]
    const drawTick = (t, ch) => {
      // bedside-monitor style: a short tick at the top edge (chamber colour), not a full-height line
      const x = Math.round(xOf(t)) + 0.5
      const c = th.paceLine[ch] || th.paceLine[1]
      ctx.save(); ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.moveTo(x, 1); ctx.lineTo(x, 9); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(x - 3, 9); ctx.lineTo(x + 3, 9); ctx.lineTo(x, 13); ctx.closePath(); ctx.fill()
      ctx.restore()
    }
    const paceMarks = (l, T, tFirst, step, n) => {
      if (!pace || wave !== 'ecg') return
      // a tick is 7 px wide; draw it only once the pen (and so next frame's erase start) is clear of it,
      // otherwise the erase sweeping ahead of the pen wipes the half that lies past the pen
      const tDraw = (penT ?? T) - (8 / W) * windowMs
      // pace: bits 0-13 = sample offset within this bundle's ECG block, bits 14-15 = chamber (0 A, 1 V, 2 LV)
      if (l?.pace?.length && l.paceSeq != null && l.paceSeq !== paceDrawn) {
        const t0 = (l.paceTs ?? l.ts_ms) - (n - 1) * step
        for (const m of l.pace) pending.push({ t: t0 + (m & 0x3fff) * step, ch: (m >> 14) & 3 })
        paceDrawn = l.paceSeq
      }
      for (let i = pending.length - 1; i >= 0; i--) {
        const m = pending[i]
        if (m.t < tFirst) { pending.splice(i, 1); continue }
        if (m.t <= tDraw) { drawTick(m.t, m.ch); pending.splice(i, 1) }
      }
    }

    // ---- quality renderer: samples → device-pixel columns, one fill per frame
    const traceQuality = (st, from, T, step, restart) => {
      if (restart) { tracer.reset(); stroker.reset() }
      stroker.begin(strokeNow(), lineWidth)
      let i = from, pT = penT, pX = penX
      for (; i < st.len && st.tAt(i) <= T; i++) {
        const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
        const gap = pT != null && (t - pT > step * 1.5 || x < pX) // discontinuity or wrap at the right edge
        tracer.point(x * dpr, y * dpr, gap, stroker.emit)
        pX = x; pT = t; penX = x; penY = y; penT = t; lastAbsIdx = st.trimmed + i
      }
      stroker.end()
      return i
    }
    // ---- speed renderer: anti-aliased polyline (original)
    const traceSpeed = (st, from, T, step, stride) => {
      ctx.strokeStyle = strokeNow(); ctx.lineWidth = lineWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      ctx.beginPath()
      let i = from, started = penX != null, pT = penT ?? 0, pX = penX ?? -1
      if (started) ctx.moveTo(penX, penY)
      for (; i < st.len && st.tAt(i) <= T; i += stride) {
        const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
        const gap = t - pT > step * stride * 1.5
        if (!started || gap || x < pX) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        started = true; pT = t; pX = x; penX = x; penY = y; penT = t; lastAbsIdx = st.trimmed + i
      }
      ctx.stroke()
      return i
    }

    const renderFull = (T, st, step) => {
      ctx.drawImage(grid, 0, 0, W, H)
      const tOld = T - windowMs + (gapPx() / W) * windowMs
      let hi_ = st.len - 1
      while (hi_ >= 0 && st.tAt(hi_) > T) hi_--
      if (hi_ < 0) return null
      let lo_ = hi_
      while (lo_ > 0 && st.tAt(lo_ - 1) >= tOld) lo_--
      penX = null; penY = null; penT = null
      if (mode === 'speed') {
        const stride = Math.max(1, Math.ceil((hi_ - lo_ + 1) / (W * 2)))
        traceSpeed(st, lo_, T, step, stride)
      } else {
        traceQuality(st, lo_, T, step, true)
      }
      blit(Math.min(xOf(T), W - 1), Math.min(gapPx(), W - xOf(T)))
      return hi_
    }
    const draw = (now) => {
      if (!visible || !W) { needFull = true; return }
      const T = playoutNow(now)
      const st = getStream(`${id}:${wave}`)
      if (T == null || !st || st.len === 0) { if (needFull && grid) { ctx.drawImage(grid, 0, 0, W, H); needFull = false; lastT = null } return }
      const step = 1000 / st.sampleRate
      if (needFull || lastT == null || T - lastT > windowMs) {
        const hi_ = renderFull(T, st, step)
        lastT = T
        if (hi_ == null) { needFull = true; return }
        needFull = false; lastAbsIdx = st.trimmed + hi_
        return
      }
      if (lastAbsIdx == null) { needFull = true; return }
      // erase ahead of the pen only: starting at the pen's own x would clip the last stroke's edge every frame
      // quality: the pen's column is not drawn yet; the previous column's stroke (round cap) reaches lineWidth/2 past its centre
      const eraseFrom = penX == null ? xOf(lastT) : mode === 'speed' ? xOf(lastT) : Math.min(W - 1, (tracer.col - 0.5) / dpr + lineWidth / 2 + 1 / dpr)
      eraseAdvance(eraseFrom, xOf(T))
      let i = lastAbsIdx - st.trimmed + 1
      if (i < 0) { needFull = true; lastT = T; return }
      if (i < st.len && st.tAt(i) <= T) {
        if (mode === 'speed') traceSpeed(st, i, T, step, 1)
        else traceQuality(st, i, T, step, false)
      }
      // marks that fell out of the window (one sweep behind the front) are dropped; the rest wait for the pen
      paceMarks(latest.get(id), T, T - windowMs + (gapPx() / W) * windowMs, step, st.sampleRate * 0.2)
      lastT = T
    }
    const un = registerDraw(draw)
    return () => { un(); ro.disconnect(); io.disconnect(); offMode() }
  }, [id, wave, range[0], range[1], color, lineWidth, pace, theme])
  return <canvas ref={ref} />
}
