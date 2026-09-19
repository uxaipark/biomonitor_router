// Console-wide display settings kept in localStorage and shared across tabs (viewer windows included).
const KEY = 'render.mode' // 'quality' (pixel-column tracer, default) | 'speed' (anti-aliased polyline)
const listeners = new Set()
let mode = null
const read = () => { try { return localStorage.getItem(KEY) } catch { return null } }
export const RENDER_MODES = [['quality', '품질형'], ['speed', '속도형']]
export function getRenderMode() {
  if (mode == null) mode = read() === 'speed' ? 'speed' : 'quality'
  return mode
}
export function setRenderMode(m) {
  mode = m === 'speed' ? 'speed' : 'quality'
  try { localStorage.setItem(KEY, mode) } catch { /* ignore */ }
  for (const fn of listeners) fn(mode)
}
export function onRenderMode(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
// another tab (a viewer window) changed the setting
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) { mode = null; for (const fn of listeners) fn(getRenderMode()) } })

/** React hook: current render mode, re-rendering the caller when it changes. */
import { useEffect, useState } from 'react'
export function useRenderMode() {
  const [m, setM] = useState(getRenderMode)
  useEffect(() => onRenderMode(setM), [])
  return m
}
