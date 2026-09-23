import React, { useEffect, useRef } from 'react'
import { getStream, playoutNow } from './waveStore.js'
import { registerDraw } from './renderLoop.js'

/** Accelerometer X / Y / Z colours (shared with the history strips). */
export const ACCEL_COLORS = ['#ff7b72', '#e3b341', '#58a6ff']
const WINDOW_MS = 6000

/**
 * The three accelerometer axes overlaid in one small scrolling plot (newest at the right), auto-scaled to what
 * the window holds with a floor of ±0.25 g around the centre. Redrawn whole every other frame — a few hundred
 * samples per axis, far cheaper than three sweep canvases.
 */
export function AccelPlot({ id, height = 96 }) {
  const ref = useRef(null)
  useEffect(() => {
    const canvas = ref.current
    const css = getComputedStyle(document.documentElement)
    const bg = css.getPropertyValue('--wave-bg').trim() || '#0b1220'
    const grid = css.getPropertyValue('--wave-grid').trim() || '#182338'
    const muted = css.getPropertyValue('--muted').trim() || '#8b9bb0'
    let W = 0, H = 0, dpr = 1, ctx = null
    let lo = -1.2, hi = 1.2
    const size = () => {
      const r = canvas.getBoundingClientRect()
      const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height)), d = Math.min(window.devicePixelRatio || 1, 2)
      if (w === W && h === H && d === dpr && ctx) return
      W = w; H = h; dpr = d
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr)
      ctx = canvas.getContext('2d')
    }
    const draw = (now, frame) => {
      if (frame % 2) return
      size()
      const T = playoutNow(now)
      const rings = [0, 1, 2].map((a) => getStream(`${id}:accel${a}`))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H)
      if (T == null) return
      const t0 = T - WINDOW_MS
      // range of what is on screen, eased so the traces do not jump
      let vmin = Infinity, vmax = -Infinity
      for (const st of rings) {
        if (!st) continue
        for (let i = st.len - 1; i >= 0; i--) { const t = st.tAt(i); if (t < t0) break; if (t > T) continue; const v = st.vAt(i); if (v < vmin) vmin = v; if (v > vmax) vmax = v }
      }
      if (vmin <= vmax) {
        const c = (vmin + vmax) / 2, half = Math.max(0.25, (vmax - vmin) / 2 * 1.2)
        lo += (c - half - lo) * 0.15; hi += (c + half - hi) * 0.15
      }
      const yOf = (v) => 4 + (1 - (v - lo) / (hi - lo)) * (H - 8)
      const xOf = (t) => ((t - t0) / WINDOW_MS) * W
      // grid: one vertical line a second, horizontal lines on whole / half g
      ctx.strokeStyle = grid; ctx.lineWidth = 1
      for (let s = Math.ceil(t0 / 1000) * 1000; s <= T; s += 1000) { const x = Math.round(xOf(s)) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke() }
      const stepG = hi - lo > 2.5 ? 1 : 0.5
      ctx.fillStyle = muted; ctx.font = '10px system-ui, sans-serif'; ctx.textBaseline = 'middle'
      for (let g = Math.ceil(lo / stepG) * stepG; g <= hi; g += stepG) {
        const y = Math.round(yOf(g)) + 0.5
        ctx.setLineDash(g === 0 ? [] : [3, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
        if (y > 8 && y < H - 8) ctx.fillText(`${+g.toFixed(1)}g`, 4, y - 6)
      }
      ctx.setLineDash([])
      ctx.lineWidth = 1.4; ctx.lineJoin = 'round'
      rings.forEach((st, a) => {
        if (!st || !st.len) return
        const step = 1000 / st.sampleRate
        ctx.strokeStyle = ACCEL_COLORS[a]
        ctx.beginPath()
        let pT = null
        let i = st.len - 1
        while (i > 0 && st.tAt(i - 1) >= t0) i--
        for (; i < st.len; i++) {
          const t = st.tAt(i)
          if (t > T) break
          const x = xOf(t), y = yOf(st.vAt(i))
          if (pT == null || t - pT > step * 1.5) ctx.moveTo(x, y); else ctx.lineTo(x, y)
          pT = t
        }
        ctx.stroke()
      })
    }
    return registerDraw(draw)
  }, [id])
  return <canvas ref={ref} className="accel-plot" style={{ height }} />
}

/** Latest value of each axis (g), for the legend. */
export function accelNow(id) {
  return [0, 1, 2].map((a) => {
    const st = getStream(`${id}:accel${a}`)
    return st && st.len ? st.vAt(st.len - 1) : null
  })
}
