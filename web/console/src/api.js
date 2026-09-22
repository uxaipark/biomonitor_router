// Router API client. The console is served by the router itself, so everything is same-origin;
// VITE_ROUTER overrides for a dev server pointed at another machine.
const BASE = import.meta.env.VITE_ROUTER || ''
export const WS_URL = (BASE ? BASE.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`) + '/ws'

export async function get(path) {
  const r = await fetch(BASE + path)
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`)
  return r.json()
}

export async function send(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    let msg = `${path}: HTTP ${r.status}`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const t = await r.text()
  return t ? JSON.parse(t) : null
}

export const api = {
  stats: () => get('/api/stats'),
  health: () => get('/api/health'),
  channels: () => get('/api/channels'),
  // scoped list: the router filters, so a viewer tab parses ~20 KB instead of the 1.2 MB full registry
  channelsScoped: (qs) => get('/api/channels' + (qs ? '?' + qs : '')),
  gateways: () => get('/api/gateways'),
  gatewaySummary: () => get('/api/gateways/summary'),
  events: () => get('/api/events'),
  alarms: () => get('/api/alarms'),
  alarmHistory: (limit = 200) => get(`/api/alarms/history?limit=${limit}`),
  alarmRules: () => get('/api/alarms/rules'),
  setAlarmRules: (r) => send('PUT', '/api/alarms/rules', r),
  ackAlarm: (id) => send('POST', `/api/alarms/${id}/ack`),
  patch: (id) => get(`/api/patches/${id}`),
  groups: () => get('/api/groups'),
  createGroup: (g) => send('POST', '/api/groups', g),
  updateGroup: (id, g) => send('PUT', `/api/groups/${id}`, g),
  deleteGroup: (id) => send('DELETE', `/api/groups/${id}`),
  staff: () => get('/api/emr/staff'),
  waveReset: () => send('POST', '/api/wave/reset'),
  metrics: (range) => get(`/api/metrics?range=${range}`),
  metricsInfo: () => get('/api/metrics/info'),
  metricsReset: () => send('POST', '/api/metrics/reset'),
  verifyPatch: (id) => get(`/api/patches/${id}/verify`),
  backup: {
    status: () => get('/api/backup'),
    setPolicy: (p) => send('PUT', '/api/backup/policy', p),
    create: (t) => send('POST', '/api/backup/targets', t),
    update: (id, t) => send('PUT', `/api/backup/targets/${id}`, t),
    remove: (id) => send('DELETE', `/api/backup/targets/${id}`),
    order: (ids) => send('PUT', '/api/backup/order', { ids }),
    test: (t) => send('POST', '/api/backup/test', t),
    scan: () => send('POST', '/api/backup/scan'),
  },
  emu: {
    status: () => get('/api/emu/status'),
    layout: () => get('/api/emr/layout'),
    hospital: () => get('/api/emr/hospital'),
    wards: () => get('/api/emr/wards'),
    admissions: () => get('/api/emr/admissions'),
    patient: (pid) => get(`/api/emr/patients/${pid}`),
    trips: () => get('/api/emr/trips'),
  },
}

// Small polling hook: calls fn every `ms`, keeps the latest value, pauses when the tab is hidden.
import { useEffect, useState, useRef } from 'react'
export function usePoll(fn, ms, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [bump, setBump] = useState(0) // refresh(): re-run the poll now
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    let timer = 0
    const tick = async () => {
      if (document.visibilityState !== 'hidden') {
        try {
          const v = await fn()
          if (alive.current) { setData(v); setError(null) }
        } catch (e) {
          if (alive.current) setError(e)
        }
      }
      if (alive.current) timer = setTimeout(tick, ms)
    }
    tick()
    return () => { alive.current = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, bump])
  return [data, error, () => setBump((b) => b + 1)]
}

export const fmtBytes = (b) => {
  if (b == null) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return `${b.toFixed(i >= 2 ? 1 : 0)} ${u[i]}`
}
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
export const fmtTime = (ms) => (ms ? new Date(ms).toLocaleTimeString('ko-KR', { hour12: false }) : '—')
export const fmtAgo = (ms) => {
  if (!ms) return '—'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
export const fmtDur = (s) => {
  if (s == null) return '—'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`
}
