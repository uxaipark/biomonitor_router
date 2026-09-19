// Pixel-column tracer ("품질형" rendering). Bedside monitors draw a waveform as one vertical span per pixel
// column: the span covers every sample that fell into that column and is joined to the previous column's last
// row. Drawn with fillRect in whole device pixels, so there is no anti-aliasing, no overlapping strokes between
// animation frames (which thicken the joints), and no decimation that drops R peaks. Redrawing a span is
// idempotent, so incremental frames can extend a column freely. One fill() per frame: rects are accumulated
// into the current path by `emit` and filled by the caller.
export class ColumnTracer {
  constructor() { this.reset() }
  reset() { this.col = -1; this.top = 0; this.bot = 0; this.row = 0 }
  /** xd/yd: device-pixel coordinates (floats). `gap` = discontinuity before this sample. emit(col, top, bot). */
  point(xd, yd, gap, emit) {
    const c = Math.floor(xd), r = Math.round(yd)
    if (gap || this.col < 0 || c < this.col) { this.col = c; this.top = this.bot = this.row = r; emit(c, r, r); return }
    if (c === this.col) {
      if (r < this.top || r > this.bot) { this.top = Math.min(this.top, r); this.bot = Math.max(this.bot, r); emit(c, this.top, this.bot) }
      this.row = r
      return
    }
    // advance one or more columns: interpolate a row for each column crossed so the trace stays connected
    let prev = this.row
    const span = c - this.col
    for (let k = this.col + 1; k <= c; k++) {
      const rk = k === c ? r : Math.round(prev + (r - prev) * (k - this.col) / span)
      emit(k, Math.min(prev, rk), Math.max(prev, rk))
      prev = rk
    }
    this.col = c; this.top = Math.min(this.row, r); this.bot = Math.max(this.row, r); this.row = r
  }
}

/** Build an `emit` that appends the column span as a rect (lw device px thick) to the current path. */
export function rectEmitter(ctx, lw) {
  const off = Math.floor((lw - 1) / 2)
  return (c, top, bot) => ctx.rect(c - off, top - off, lw, bot - top + lw)
}
