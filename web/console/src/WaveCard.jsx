import React, { useEffect, useRef } from 'react'
import { getStream, playoutNow } from './waveStore.js'
import { registerDraw } from './renderLoop.js'
import { latest } from './ws.js'
import { flagNames } from './model.js'
import { getRenderMode, onRenderMode } from './settings.js'
import { ColumnTracer, rectEmitter } from './traceRender.js'

const WINDOW_S = 6
const GAP_PX = 16
const GRID_PX = 40
const WAVE_H = { normal: 140, compact: 50, dense: 68 }
const WAVE_W = { normal: 460, compact: 300, dense: 300 }

// Sweep-style ECG canvas (incremental drawing, shared rAF loop, auto-scaling envelope) — ported from the
// 2026-08 viewer's ChannelCard. `id` is the patch id; the trace reads the `${id}:${wave}` ring.
export function WaveCanvas({ id, wave = 'ecg', density = 'normal', color, height }) {
  const canvasRef = useRef(null)
  const H = height || WAVE_H[density] || WAVE_H.normal
  useEffect(() => {
    const canvas = canvasRef.current
    const W = WAVE_W[density] || 460
    const dpr = Math.min(window.devicePixelRatio || 1, density === 'normal' ? 2 : 1.25)
    const css = getComputedStyle(document.documentElement)
    const bg = css.getPropertyValue('--wave-bg').trim() || '#0b1220'
    const gridCol = css.getPropertyValue('--wave-grid').trim() || '#182338'
    const traceCol = color || css.getPropertyValue('--wave-trace').trim() || '#3ddc84'
    const staleCol = css.getPropertyValue('--wave-stale').trim() || '#5a6a80'
    // backing stores are allocated on the first visible frame, so 2,000 off-screen cards cost no bitmap memory
    let ctx = null, gridCanvas = null
    const init = () => {
      canvas.width = W * dpr
      canvas.height = H * dpr
      ctx = canvas.getContext('2d')
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      gridCanvas = document.createElement('canvas')
      gridCanvas.width = W * dpr; gridCanvas.height = H * dpr
      const g = gridCanvas.getContext('2d')
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = bg; g.fillRect(0, 0, W, H)
      g.strokeStyle = gridCol; g.lineWidth = 1
      for (let gx = GRID_PX; gx < W; gx += GRID_PX) { g.beginPath(); g.moveTo(gx + 0.5, 0); g.lineTo(gx + 0.5, H); g.stroke() }
    }

    let envMin = -0.4, envMax = 1.2, tgtMin = null, tgtMax = null, clipFrames = 0, smallFrames = 0
    const yOf = (v) => H * (0.9 - 0.8 * ((v - envMin) / Math.max(envMax - envMin, 0.2)))
    const windowMs = WINDOW_S * 1000
    const xOf = (t) => ((((t % windowMs) + windowMs) % windowMs) / windowMs) * W
    const gapMs = (GAP_PX / W) * windowMs

    let visible = true
    const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting }, { rootMargin: '200px' })
    io.observe(canvas)

    let lastT = null, lastAbsIdx = null, penX = null, penY = null, penT = null, needFull = true, envTick = 0
    const strokeNow = () => {
      const l = latest.get(id)
      return l && (l.disconnected || Date.now() - l.rx > 5000) ? staleCol : traceCol
    }
    let mode = getRenderMode()
    const tracer = new ColumnTracer()
    const lwDev = () => Math.max(1, Math.round((density === 'dense' ? 1.1 : 1.4) * dpr))
    const offMode = onRenderMode((m) => { mode = m; needFull = true })
    // grid restore in whole device pixels (fractional source rects would resample the grid into a blur)
    const blit = (x, w) => {
      if (!(w > 0) || !gridCanvas) return
      const sx = Math.floor(x * dpr), sw = Math.min(canvas.width - sx, Math.ceil(w * dpr) + 1)
      if (sw <= 0) return
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(gridCanvas, sx, 0, sw, canvas.height, sx, 0, sw, canvas.height); ctx.restore()
    }
    // quality renderer: samples → device-pixel columns, one fill per frame (see traceRender.js)
    const traceQuality = (st, from, T, step, restart) => {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = strokeNow(); ctx.beginPath()
      const emit = rectEmitter(ctx, lwDev())
      if (restart) tracer.reset()
      let i = from, pT = penT, pX = penX
      for (; i < st.len && st.tAt(i) <= T; i++) {
        const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
        const gap = pT != null && (t - pT > step * 1.5 || x < pX)
        tracer.point(x * dpr, y * dpr, gap, emit)
        pX = x; pT = t; penX = x; penY = y; penT = t; lastAbsIdx = st.trimmed + i
      }
      ctx.fill(); ctx.restore()
    }
    const eraseAdvance = (a, b) => {
      if ((b - a + W * 2) % W > W / 2) a = b // erase start ahead of the front (pen column + width): clamp, not wrap
      let len = (b - a + W * 2) % W + GAP_PX
      if (len > W) len = W
      const w1 = Math.min(len, W - a)
      blit(a, w1)
      if (len > w1) blit(0, len - w1)
    }
    const envUpdate = (st, lo, hi) => {
      let vmin = Infinity, vmax = -Infinity
      for (let i = lo; i <= hi; i++) { const v = st.vAt(i); if (v < vmin) vmin = v; if (v > vmax) vmax = v }
      if (vmin >= vmax) return
      const span = Math.max(envMax - envMin, 0.2)
      clipFrames = (vmax > envMax || vmin < envMin) ? clipFrames + 1 : 0
      smallFrames = (vmax - vmin) < span * 0.45 ? smallFrames + 1 : 0
      if (tgtMin == null && (clipFrames > 2 || smallFrames > 12)) {
        const m = (vmax - vmin) * 0.15 + 0.05
        tgtMin = vmin - m; tgtMax = vmax + m
      }
    }
    const renderFull = (T, st, step) => {
      ctx.drawImage(gridCanvas, 0, 0, W, H)
      const tOld = T - windowMs + gapMs
      let hi = st.len - 1
      while (hi >= 0 && st.tAt(hi) > T) hi--
      if (hi < 0) return null
      let lo = hi
      while (lo > 0 && st.tAt(lo - 1) >= tOld) lo--
      if (mode !== 'speed') {
        penX = null; penY = null; penT = null
        traceQuality(st, lo, T, step, true)
        blit(Math.min(xOf(T), W - 1), Math.min(GAP_PX, W - xOf(T)))
        const hiAbs = lastAbsIdx; lastAbsIdx = null
        return hiAbs == null ? null : hiAbs - st.trimmed
      }
      const stride = Math.max(1, Math.ceil((hi - lo + 1) / (W * 2)))
      let i0 = lo
      if (stride > 1) { const rem = Math.round(st.tAt(lo) / step) % stride; if (rem) i0 = lo + (stride - rem); if (i0 > hi) i0 = lo }
      ctx.strokeStyle = strokeNow(); ctx.lineWidth = density === 'dense' ? 1.1 : 1.4; ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false, pT = 0, pX = -1
      for (let i = i0; i <= hi; i += stride) {
        const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
        const gap = t - pT > step * stride * 1.5
        if (!started || gap || x < pX) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        started = true; pT = t; pX = x
      }
      ctx.stroke()
      blit(Math.min(xOf(T), W - 1), Math.min(GAP_PX, W - xOf(T)))
      penX = xOf(st.tAt(hi)); penY = yOf(st.vAt(hi)); penT = st.tAt(hi)
      lastAbsIdx = null
      return hi
    }
    let invisFrames = 0
    const draw = (now) => {
      if (!visible) {
        needFull = true
        if (++invisFrames >= 60) {
          invisFrames = 0
          const r = canvas.getBoundingClientRect()
          visible = r.width > 0 && r.bottom > -200 && r.top < window.innerHeight + 200
        }
        if (!visible) return
      }
      invisFrames = 0
      if (!ctx) init()
      const T = playoutNow(now)
      const st = getStream(`${id}:${wave}`)
      if (T == null || !st || st.len === 0) return
      const step = 1000 / st.sampleRate
      if (++envTick >= 15 || tgtMin != null) {
        envTick = 0
        let hi = st.len - 1
        while (hi >= 0 && st.tAt(hi) > T) hi--
        if (hi >= 0) { let lo = hi; const tOld = T - windowMs + gapMs; while (lo > 0 && st.tAt(lo - 1) >= tOld) lo--; envUpdate(st, lo, hi) }
        if (tgtMin != null) {
          envMin += (tgtMin - envMin) * 0.03; envMax += (tgtMax - envMax) * 0.03
          const tspan = Math.max(tgtMax - tgtMin, 0.2)
          if (Math.abs(envMin - tgtMin) < tspan * 0.02 && Math.abs(envMax - tgtMax) < tspan * 0.02) { tgtMin = null; tgtMax = null; clipFrames = 0; smallFrames = 0 }
          needFull = true
        }
      }
      if (needFull || lastT == null || T - lastT > windowMs) {
        const hi = renderFull(T, st, step)
        lastT = T
        if (hi == null) { needFull = true; return }
        needFull = false; lastAbsIdx = st.trimmed + hi
        return
      }
      if (lastAbsIdx == null) { needFull = true; return }
      // erase ahead of the pen only: starting at the pen's own x would clip the last stroke's edge every frame
      eraseAdvance(mode === 'speed' || penX == null ? xOf(lastT) : Math.min(W - 1, (tracer.col + lwDev()) / dpr), xOf(T))
      let i = lastAbsIdx - st.trimmed + 1
      if (i < 0) { needFull = true; lastT = T; return }
      if (i < st.len && st.tAt(i) <= T && mode !== 'speed') traceQuality(st, i, T, step, false)
      else if (i < st.len && st.tAt(i) <= T) {
        ctx.strokeStyle = strokeNow(); ctx.lineWidth = density === 'dense' ? 1.1 : 1.4; ctx.lineJoin = 'round'
        ctx.beginPath()
        for (; i < st.len && st.tAt(i) <= T; i++) {
          const t = st.tAt(i), x = xOf(t), y = yOf(st.vAt(i))
          const gap = penT != null && t - penT > step * 1.5
          if (penX == null || gap || x < penX) ctx.moveTo(x, y); else { ctx.moveTo(penX, penY); ctx.lineTo(x, y) }
          penX = x; penY = y; penT = t; lastAbsIdx = st.trimmed + i
        }
        ctx.stroke()
      }
      lastT = T
    }
    const unregister = registerDraw(draw)
    return () => { unregister(); io.disconnect(); offMode() }
  }, [id, wave, H, density, color])
  return <canvas ref={canvasRef} width={WAVE_W[density] || 460} height={H} className="wave" />
}

const V = ({ label, value, unit, cls }) => (
  <span className={'vital ' + (cls || '')}><small>{label}</small><b>{value ?? '—'}</b><small>{unit}</small></span>
)

/** One patient card: header (name/location), vitals, ECG sweep. `row` is a /api/channels row (may be stale);
 *  live values come from the WS `latest` map and are re-read on each render tick of the parent. */
export function WaveCard({ row, density = 'normal', alarm, onClick, waves }) {
  const id = String(row.channel_id)
  const live = latest.get(id)
  const v = live?.vitals || row.vitals || {}
  const flags = live?.flags ?? row.flags ?? 0
  const p = row.patient || live?.patient || {}
  const stale = live ? Date.now() - live.rx > 5000 : row.stale
  const names = flagNames(flags)
  const sevCls = alarm ? `sev-${alarm.severity}` : ''
  const cls = ['card', density, stale ? 'stale' : '', sevCls, row.connected === false ? 'disconnected' : ''].join(' ')
  if (density === 'dense') {
    // stacked layout: patient/location line → ECG strip → key numbers, so ~120 cards fit on one screen
    const loc = [p.ward, p.room || row.space].filter(Boolean).join(' ')
    const bat = live?.battery ?? row.battery
    return (
      <div className={cls} onClick={onClick} title={[id, p.name, p.building, p.floor && `${p.floor}F`, p.ward, p.room, p.doctor, p.nurse].filter(Boolean).join(' · ')}>
        <div className="card-head">
          <b className="pname">{p.name || row.mrn || id}</b>
          <span className="ploc">{loc}</span>
          <span className="pid">{id}</span>
          <span className="spacer" />
          {alarm && <span className={`tag sev-${alarm.severity}`}>{alarm.message}</span>}
          {names.map((n) => <span key={n} className={'tag ' + (n === 'LEAD_OFF' || n === 'LOW_BATTERY' ? 'warn' : '')}>{n}</span>)}
          {stale && <span className="tag err">수신 없음</span>}
        </div>
        <WaveCanvas id={id} wave="ecg" density="dense" />
        <div className="card-foot">
          <V label="HR" value={v.hr} cls="hr" />
          <V label="SpO₂" value={v.spo2} cls="spo2" />
          <V label="RR" value={v.resp} cls="rr" />
          <V label="T" value={v.temp != null ? v.temp.toFixed(1) : null} cls="temp" />
          <span className={'vital small' + (bat != null && bat <= 15 ? ' low' : '')}><small>BAT</small><b>{bat ?? '—'}</b></span>
        </div>
      </div>
    )
  }
  return (
    <div className={cls} onClick={onClick}>
      <div className="card-head">
        <span className="pid">{id}</span>
        <b className="pname">{p.name || row.mrn || '—'}</b>
        <span className="ploc">{[p.building, p.floor && `${p.floor}F`, p.ward, p.room || row.space].filter(Boolean).join(' · ')}</span>
        {density === 'normal' && <span className="pstaff">{[p.doctor, p.nurse].filter(Boolean).join(' · ')}</span>}
        <span className="spacer" />
        {alarm && <span className={`tag sev-${alarm.severity}`}>{alarm.message}</span>}
        {names.map((n) => <span key={n} className={'tag ' + (n === 'LEAD_OFF' || n === 'LOW_BATTERY' ? 'warn' : '')}>{n}</span>)}
        {stale && <span className="tag err">수신 없음</span>}
      </div>
      <div className="card-body">
        <div className="wave-col">
          <WaveCanvas id={id} wave="ecg" density={density} />
          {waves?.includes('resp_wave') && <WaveCanvas id={id} wave="resp_wave" density="dense" color="#7cc4ff" />}
          {waves?.includes('ppg') && <WaveCanvas id={id} wave="ppg" density="dense" color="#ff9f6b" />}
        </div>
        <div className="vitals">
          <V label="HR" value={v.hr} unit="bpm" cls="hr" />
          <V label="SpO₂" value={v.spo2} unit="%" cls="spo2" />
          <V label="RR" value={v.resp} unit="/min" cls="rr" />
          <V label="Temp" value={v.temp != null ? v.temp.toFixed(1) : null} unit="°C" cls="temp" />
          {v.glucose != null && <V label="Glu" value={Math.round(v.glucose)} unit="mg/dL" cls="glu" />}
          <span className="vital small"><small>BAT</small><b>{live?.battery ?? row.battery ?? '—'}</b><small>%</small></span>
          <span className="vital small"><small>RSSI</small><b>{live?.rssi ?? row.rssi ?? '—'}</b><small>dBm</small></span>
        </div>
      </div>
    </div>
  )
}
