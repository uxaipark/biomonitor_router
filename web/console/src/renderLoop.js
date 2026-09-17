// One shared requestAnimationFrame loop calling every registered draw callback (per-card rAF scales badly).
const draws = new Set()
let raf = 0
let frame = 0

function loop(now) {
  frame++
  const skip = draws.size > 400 ? 2 : 1
  let i = 0
  for (const fn of draws) {
    if ((frame + i) % skip === 0) fn(now, frame)
    i++
  }
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
