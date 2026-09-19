// One shared requestAnimationFrame loop calling every registered draw callback (per-card rAF scales badly).
const draws = new Set()
let raf = 0
let frame = 0
// draw-loop stats for the live page's performance line: EMA of ms spent in draw callbacks per frame, and fps
export const renderStats = { drawMs: 0, fps: 0, canvases: 0 }
let lastNow = 0

function loop(now) {
  frame++
  const skip = draws.size > 400 ? 2 : 1
  let i = 0
  const t0 = performance.now()
  for (const fn of draws) {
    if ((frame + i) % skip === 0) fn(now, frame)
    i++
  }
  const spent = performance.now() - t0
  renderStats.drawMs += (spent - renderStats.drawMs) * 0.1
  if (lastNow) renderStats.fps += (1000 / Math.max(now - lastNow, 1) - renderStats.fps) * 0.1
  lastNow = now
  renderStats.canvases = draws.size
  raf = draws.size ? requestAnimationFrame(loop) : 0
}

export function registerDraw(fn) {
  draws.add(fn)
  if (!raf) raf = requestAnimationFrame(loop)
  return () => {
    draws.delete(fn)
    if (!draws.size && raf) { cancelAnimationFrame(raf); raf = 0 }
  }
}
