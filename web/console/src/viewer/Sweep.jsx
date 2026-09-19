import React, { useEffect, useRef } from 'react'
import { getStream, playoutNow } from '../waveStore.js'
import { registerDraw } from '../renderLoop.js'
import { latest } from '../ws.js'

// Monitor-style sweep trace that fills its box (the emulator's Central Station / bed viewer look): black or
// paper ground with an ECG-paper major grid (bold line every 0.2 s), fixed physical range, colour per channel,
// pace-pulse markers. Reads the console's shared rings + playout clock, so it stays phase-locked with WaveCard.
const WINDOW_S = 6
const GAP_FRAC = 0.035

export default function Sweep({ id, wave = 'ecg', range = [-1.5, 2.0], color = '#3ddc84', theme, lineWidth = 1.6, pace = true }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    const box = canvas.parentElement
    const ctx = canvas.getContext('2d')
    const th = { bg: '#000', grid: 'rgba(243,242,242,.10)', stale: '#5a6a80', paceLine: ['#ffe34d', '#ffffff', '#ff9783'], ...(theme || {}) }
    let W = 0, H = 0, dpr = 1
    let grid = null
    const windowMs = WINDOW_S * 1000
    const [lo, hi] = range
    let lastT = null, lastAbsIdx = null, penX = null, penY = null, penT = null, needFull = true
    let visible = true

    const size = () => {
      const r = box.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height))
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      if (w === W && h === H && canvas.width === Math.round(w * dpr)) return false
      W = w; H = h
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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

    const yOf = (v) => H - 4 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (H - 8)
    const xOf = (t) => ((((t % windowMs) + windowMs) % windowMs) / windowMs) * W
    const gapPx = () => Math.max(10, W * GAP_FRAC)
    const strokeNow = () => { const l = latest.get(id); return l && (l.disconnected || Date.now() - l.rx > 5000) ? th.stale : color }
    const blit = (x, w) => { if (w > 0 && grid) ctx.drawImage(grid, x * dpr, 0, w * dpr, H * dpr, x, 0, w, H) }
    const eraseAdvance = (a, b) => {
      let len = (b - a + W * 2) % W + gapPx()
      if (len > W) len = W
      const w1 = Math.min(len, W - a)
      blit(a, w1)
      if (len > w1) blit(0, len - w1)
    }
    let paceDrawn = null // paceSeq of the last drawn pace record (the latest map is replaced per packet)
    const paceMarks = (l, tFirst, step, n) => {
      // pace: bits 0-13 = sample offset within this bundle's ECG block, bits 14-15 = chamber (0 A, 1 V, 2 LV)
      if (!pace || wave !== 'ecg' || !l?.pace?.length || l.paceSeq == null || l.paceSeq === paceDrawn) return
      const t0 = (l.paceTs ?? l.ts_ms) - (n - 1) * step
      for (const m of l.pace) {
        const off = m & 0x3fff, ch = (m >> 14) & 3
        const t = t0 + off * step
        if (t < tFirst) continue
        const x = Math.round(xOf(t)) + 0.5
        ctx.save(); ctx.strokeStyle = th.paceLine[ch] || th.paceLine[1]; ctx.lineWidth = 1.5; ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, H - 2); ctx.stroke(); ctx.restore()
        ctx.fillStyle = th.paceLine[ch] || th.paceLine[1]; ctx.fillRect(x - 1, 2, 3, 8)
      }
      paceDrawn = l.paceSeq
    }
    const renderFull = (T, st, step) => {
      ctx.drawImage(grid, 0, 0, W, H)
      const tOld = T - windowMs + (gapPx() / W) * windowMs
      let hi_ = st.len - 1
      while (hi_ >= 0 && st.tAt(hi_) > T) hi_--
      if (hi_ < 0) return null
      let lo_ = hi_
      while (lo_ > 0 && st.tAt(lo_ - 1) >= tOld) lo_--
      const stride = Math.max(1, Math.ceil((hi_ - lo_ + 1) / (W * 2)))
      ctx.strokeStyle = strokeNow(); ctx.lineWidth = lineWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      ctx.beginPath()
      let started = false, pT = 0, pX = -1
      for (let i = lo_; i <= hi_; i += stride) {
        const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
        const gap = t - pT > step * stride * 1.5
        if (!started || gap || x < pX) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        started = true; pT = t; pX = x
      }
      ctx.stroke()
      blit(Math.min(xOf(T), W - 1), Math.min(gapPx(), W - xOf(T)))
      penX = xOf(st.tAt(hi_)); penY = yOf(st.vAt(hi_)); penT = st.tAt(hi_)
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
      eraseAdvance(xOf(lastT), xOf(T))
      let i = lastAbsIdx - st.trimmed + 1
      if (i < 0) { needFull = true; lastT = T; return }
      if (i < st.len && st.tAt(i) <= T) {
        const tFirst = st.tAt(i)
        ctx.strokeStyle = strokeNow(); ctx.lineWidth = lineWidth; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.beginPath()
        for (; i < st.len && st.tAt(i) <= T; i++) {
          const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
          const gap = penT != null && t - penT > step * 1.5
          if (penX == null || gap || x < penX) ctx.moveTo(x, y); else { ctx.moveTo(penX, penY); ctx.lineTo(x, y) }
          penX = x; penY = y; penT = t; lastAbsIdx = st.trimmed + i
        }
        ctx.stroke()
        const l = latest.get(id)
        if (l) paceMarks(l, tFirst, step, st.sampleRate * 0.2)
      }
      lastT = T
    }
    const un = registerDraw(draw)
    return () => { un(); ro.disconnect(); io.disconnect() }
  }, [id, wave, range[0], range[1], color, lineWidth, pace, theme])
  return <canvas ref={ref} />
}
