// Waveform sample store with timestamp-based playout (jitter buffer). Ported from the 2026-08 viewer and
// generalised: one ring per (patch, wave key). Every sample carries its source time t (ms); all rings share
// a playout clock that trails the newest source time by DISPLAY_DELAY_MS, so channels stay phase-aligned and
// source-rate drift never distorts the trace.
const store = new Map() // `${patch}:${key}` → ring

const RETAIN_MS = 8000
const DISPLAY_DELAY_MS = 1000
const COMFORT_MS = 2500

let newestSrc = null
let anchorLocal = null
let anchorSrc = null

function makeRing(sampleRate) {
  const cap = Math.ceil((RETAIN_MS / 1000) * sampleRate)
  return {
    sampleRate, lastT: null, trimmed: 0, cap, head: 0, len: 0,
    tBuf: new Float64Array(cap), vBuf: new Float32Array(cap),
    tAt(i) { return this.tBuf[(this.head + i) % this.cap] },
    vAt(i) { return this.vBuf[(this.head + i) % this.cap] },
    push(t, v) {
      if (this.len === this.cap) {
        this.tBuf[this.head] = t; this.vBuf[this.head] = v
        this.head = (this.head + 1) % this.cap; this.trimmed++
      } else {
        const i = (this.head + this.len) % this.cap
        this.tBuf[i] = t; this.vBuf[i] = v; this.len++
      }
    },
  }
}

// ts_ms is the time of the packet's last sample; first sample = ts_ms - (n-1)*step.
export function appendSamples(id, samples, sampleRate, tsMs) {
  if (!samples || samples.length === 0 || !sampleRate) return
  let ch = store.get(id)
  if (!ch || ch.sampleRate !== sampleRate) { ch = makeRing(sampleRate); store.set(id, ch) }
  const step = 1000 / sampleRate
  const n = samples.length
  let t0 = (tsMs ?? 0) - (n - 1) * step
  if (ch.lastT != null) {
    const expected = ch.lastT + step
    if (t0 < expected + step * n * 1.5) t0 = expected // snap send-time jitter; keep real gaps
  }
  for (let i = 0; i < n; i++) ch.push(t0 + i * step, samples[i])
  ch.lastT = t0 + (n - 1) * step
  if (newestSrc == null || ch.lastT > newestSrc) newestSrc = ch.lastT
}

export function playoutNow(localNow) {
  if (newestSrc == null) return null
  const target = newestSrc - DISPLAY_DELAY_MS
  if (anchorLocal == null) { anchorLocal = localNow; anchorSrc = target }
  let t = anchorSrc + (localNow - anchorLocal)
  if (target - t > COMFORT_MS) { anchorLocal = localNow; anchorSrc = target; t = target }
  return t
}

export const getStream = (id) => store.get(id)
export function dropPatch(patchId) {
  for (const k of [...store.keys()]) if (k.startsWith(patchId + ':')) store.delete(k)
}
export function clearAll() { store.clear(); newestSrc = null; anchorLocal = null; anchorSrc = null }
export { DISPLAY_DELAY_MS }
