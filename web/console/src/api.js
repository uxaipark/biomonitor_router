// Router API client. The console is served by the router itself, so everything is same-origin;
// VITE_ROUTER overrides for a dev server pointed at another machine.
const BASE = import.meta.env.VITE_ROUTER || ''
export const WS_URL = (BASE ? BASE.replace(/^http/, 'ws') : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`) + '/ws'

// 뷰어 전용 토큰: 뷰어(#/viewer…)가 로그인 상태에서 한 번 발급받아 이 브라우저에 간직한다. 로그인 쿠키와 별개라
// 사용자가 로그아웃해도 뷰어는 계속 동작한다(다시 실행할 때도 그대로). 401 이 나면(토큰 폐기) 버리고 쿠키로 되돌아간다.
const DT_KEY = 'viewer.token'
export const displayToken = () => { try { return localStorage.getItem(DT_KEY) || '' } catch { return '' } }
export const setDisplayToken = (t) => { try { if (t) localStorage.setItem(DT_KEY, t); else localStorage.removeItem(DT_KEY) } catch { /* ignore */ } }
const isViewer = () => location.hash.startsWith('#/viewer')
export const wsUrl = () => WS_URL + (isViewer() && displayToken() ? `?token=${encodeURIComponent(displayToken())}` : '')

// 401 = not logged in / session expired → the app shows the login screen (auth.js listens)
const authLost = (r) => { if (r.status === 401) { if (isViewer() && displayToken()) setDisplayToken(''); window.dispatchEvent(new CustomEvent('auth-lost')) } }

// 모니터링 뷰어(#/viewer…)에서 나가는 요청: 표식 헤더(세션 자동 로그아웃 제외) + 뷰어 전용 토큰이 있으면 그걸로 인증
const hdrs = (extra) => ({ ...(isViewer() ? { 'X-Viewer-Display': '1', ...(displayToken() ? { Authorization: `Bearer ${displayToken()}` } : {}) } : {}), ...(extra || {}) })

export async function get(path) {
  const r = await fetch(BASE + path, { credentials: 'same-origin', headers: hdrs() })
  if (!r.ok) {
    authLost(r)
    let msg = `${path}: HTTP ${r.status}`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e
  }
  return r.json()
}

export async function send(method, path, body) {
  const r = await fetch(BASE + path, {
    credentials: 'same-origin',
    method,
    headers: hdrs(body !== undefined ? { 'content-type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) {
    if (!path.startsWith('/api/auth/login')) authLost(r)
    let msg = `${path}: HTTP ${r.status}`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
    const e = new Error(msg); e.status = r.status; throw e
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
  waveRecent: (ids, secs = 10, points = 96) => get(`/api/wave/recent?ids=${encodeURIComponent(ids.join(','))}&secs=${secs}&points=${points}`), // 여러 환자 최근 N초 ECG 미니 파형
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
  net: {
    get: () => get('/api/settings/network'),
    set: (b) => send('PUT', '/api/settings/network', b),
    test: (kind, addr) => send('POST', '/api/settings/network/test', { kind, addr }),
    latencyReset: () => send('POST', '/api/settings/network/latency_reset'),
    time: () => get('/api/time'),
  },
  backup: {
    status: () => get('/api/backup'),
    setPolicy: (p) => send('PUT', '/api/backup/policy', p),
    create: (t) => send('POST', '/api/backup/targets', t),
    update: (id, t) => send('PUT', `/api/backup/targets/${id}`, t),
    remove: (id) => send('DELETE', `/api/backup/targets/${id}`),
    order: (ids) => send('PUT', '/api/backup/order', { ids }),
    test: (t) => send('POST', '/api/backup/test', t),
    scan: () => send('POST', '/api/backup/scan'),
    catalog: (id, hour, q = '') => get(`/api/backup/catalog/${encodeURIComponent(id)}${hour ? `?hour=${encodeURIComponent(hour)}&q=${encodeURIComponent(q)}` : ''}`),
    catalogSync: (id) => send('POST', `/api/backup/catalog/${encodeURIComponent(id)}/sync`),
    catalogPurge: (id, confirm) => send('POST', `/api/backup/catalog/${encodeURIComponent(id)}/purge`, { confirm }),
    abort: () => send('POST', '/api/backup/abort'),
    migration: () => get('/api/backup/migration'),
    setMigration: (v) => send('PUT', '/api/backup/migration', v),
    mirrorKick: () => send('POST', '/api/backup/mirror/kick'),
  },
  auth: {
    me: () => get('/api/auth/me'),
    login: (tenant, username, password, pin = '') => send('POST', '/api/auth/login', { tenant, username, password, pin }),
    logout: () => send('POST', '/api/auth/logout'),
    password: (old, nw) => send('POST', '/api/auth/password', { old, new: nw }),
    testAccounts: () => get('/api/auth/test-accounts'),
    displayToken: () => send('POST', '/api/auth/display-token'), // 뷰어 전용 토큰 발급
    prefs: () => get('/api/auth/prefs'), // 계정별 UI 선호 (라우터 DB)
    setPrefs: (patch) => send('PUT', '/api/auth/prefs', patch),
  },
  security: {
    get: () => get('/api/security'),
    saveSettings: (s) => send('PUT', '/api/security/settings', s),
    block: (b) => send('POST', '/api/security/block', b),
    unblock: (ip) => send('DELETE', `/api/security/block/${encodeURIComponent(ip)}`),
    clear: (b) => send('POST', '/api/security/clear', b),
  },
  control: {
    status: () => get('/api/control/status'),
    set: (svc, body) => send('POST', `/api/control/${svc}`, body),
    maintenance: (body) => send('POST', '/api/control/maintenance', body),
    reset: (body) => send('POST', '/api/control/reset', body),
  },
  admin: {
    users: () => get('/api/admin/users'),
    createUser: (u) => send('POST', '/api/admin/users', u),
    updateUser: (id, u) => send('PUT', `/api/admin/users/${id}`, u),
    resetPassword: (id) => send('POST', `/api/admin/users/${id}/reset_password`),
    testPins: () => get('/api/admin/users/test-pins'),
    saveTestPins: (b) => send('PUT', '/api/admin/users/test-pins', b),
    tenants: () => get('/api/admin/tenants'),
    createTenant: (t) => send('POST', '/api/admin/tenants', t),
    updateTenant: (id, t) => send('PUT', `/api/admin/tenants/${id}`, t),
    perms: (tenant) => get('/api/admin/permissions' + (tenant ? `?tenant=${encodeURIComponent(tenant)}` : '')),
    savePerms: (b) => send('PUT', '/api/admin/permissions', b),
    permVersions: (scope, tenant) => get(`/api/admin/permissions/versions?scope=${scope}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`),
    devMode: (on) => send('PUT', '/api/admin/dev_mode', { on }),
    audit: (limit = 300) => get(`/api/admin/audit?limit=${limit}`),
  },
  integ: {
    list: () => get('/api/integration'),
    catalog: () => get('/api/integration/catalog'),
    create: (b) => send('POST', '/api/integration', b),
    get: (id) => get(`/api/integration/${id}`),
    update: (id, b) => send('PUT', `/api/integration/${id}`, b),
    remove: (id) => send('DELETE', `/api/integration/${id}`),
    run: (id, what) => send('POST', `/api/integration/${id}/run`, { what }),
    received: (id) => get(`/api/integration/${id}/received`),
  },
  ecg: { // 내장 ECG 분석 엔진(live-ecg)
    engine: () => get('/api/ecg/engine'),
    reload: () => send('POST', '/api/ecg/engine/reload'),
    row: (id) => get(`/api/ecg/${id}`),
    config: () => get('/api/ecg/config'),
    setConfig: (preset, stages) => send('PUT', '/api/ecg/config', { preset, stages }),
    versions: () => get('/api/ecg/versions'),
    activate: (key) => send('POST', `/api/ecg/versions/${encodeURIComponent(key)}/activate`),
    removeVersion: (key) => send('DELETE', `/api/ecg/versions/${encodeURIComponent(key)}`),
    docUrl: (key, name) => `/api/ecg/versions/${encodeURIComponent(key)}/doc/${name}`,
    history: () => get('/api/ecg/history'),
    summary: () => get('/api/ecg/summary'),
    bench: (seconds = 20, channels = 8) => send('POST', '/api/ecg/bench', { seconds, channels }),
    evalLast: () => get('/api/ecg/eval'),
    evalRun: (hours = 1) => send('POST', '/api/ecg/eval', { hours }),
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
