// Column tracer ("품질형" rendering). Samples are bucketed per device-pixel column; a column contributes its
// entry, min, max and exit rows (so R peaks survive when several samples share a column). Completed columns are
// handed to the renderer once, in time order, and drawn as ONE anti-aliased polyline segment per frame — never
// re-stroking geometry drawn in an earlier frame (which thickened the joints) and never decimating samples.
// The column the pen is in is held back until the next column starts (≤ 1 sample of latency).
export class ColumnTracer {
  constructor() { this.reset() }
  reset() { this.col = -1; this.entry = this.min = this.max = this.exit = 0; this.brk = true }
  /** xd/yd: device-pixel coordinates (floats). `gap` = discontinuity before this sample.
   *  emit(points, startNew): points = [[xd, yd], ...] of one completed column; startNew = do not join to the previous one. */
  point(xd, yd, gap, emit) {
    const c = Math.floor(xd)
    if (gap || this.col < 0 || c < this.col) {
      if (this.col >= 0) this.flush(emit)
      this.col = c; this.entry = this.min = this.max = this.exit = yd; this.brk = true
      return
    }
    if (c === this.col) { if (yd < this.min) this.min = yd; if (yd > this.max) this.max = yd; this.exit = yd; return }
    this.flush(emit)
    // columns skipped in one step (very wide canvases): one interpolated point each keeps the line continuous
    const span = c - this.col, from = this.exit
    for (let k = this.col + 1; k < c; k++) emit([[k + 0.5, from + (yd - from) * (k - this.col) / span]], false)
    this.col = c; this.entry = this.min = this.max = this.exit = yd
  }
  flush(emit) {
    const x = this.col + 0.5, pts = [[x, this.entry]]
    if (this.max - this.min > 0.5) {
      if (Math.abs(this.entry - this.min) <= Math.abs(this.entry - this.max)) pts.push([x, this.min], [x, this.max]); else pts.push([x, this.max], [x, this.min])
    }
    if (Math.abs(this.exit - pts[pts.length - 1][1]) > 0.01) pts.push([x, this.exit])
    emit(pts, this.brk)
    this.brk = false
  }
}

/** Renderer state for a canvas in CSS space (ctx transform = dpr): strokes each completed column once. */
export class ColumnStroker {
  constructor(ctx, dpr) { this.ctx = ctx; this.dpr = dpr; this.pen = null; this.open = false }
  reset() { this.pen = null; this.open = false }
  begin(color, lineWidth) {
    const c = this.ctx
    c.strokeStyle = color; c.lineWidth = lineWidth; c.lineJoin = 'round'; c.lineCap = 'round'
    c.beginPath(); this.open = false
  }
  emit = (pts, startNew) => {
    const c = this.ctx, d = this.dpr
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0] / d, y = pts[i][1] / d
      if (i === 0 && (startNew || !this.pen)) c.moveTo(x, y)
      else { if (i === 0 && !this.open) c.moveTo(this.pen.x, this.pen.y); c.lineTo(x, y) }
      this.open = true; this.pen = { x, y }
    }
  }
  end() { if (this.open) this.ctx.stroke() }
}
