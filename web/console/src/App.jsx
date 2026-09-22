import React, { useEffect, useRef, useState } from 'react'
import { api, usePoll } from './api.js'
import { ensureOpen, onWs, subscribeGroup, wsStatus } from './ws.js'
import Dashboard from './pages/Dashboard.jsx'
import Patients from './pages/Patients.jsx'
import Live from './pages/Live.jsx'
import MapPage from './pages/MapPage.jsx'
import Gateways from './pages/Gateways.jsx'
import Alarms from './pages/Alarms.jsx'
import Events from './pages/Events.jsx'
import Viewers from './pages/Viewers.jsx'
import Viewer from './pages/Viewer.jsx'
import MultiViewerTest from './pages/MultiViewerTest.jsx'
import ViewerSettings from './pages/ViewerSettings.jsx'
import BiosignalAdmin from './pages/BiosignalAdmin.jsx'
import DataAdmin from './pages/DataAdmin.jsx'
import OpsStats from './pages/OpsStats.jsx'
import { LiveModal } from './pages/LiveModal.jsx'

const PAGES = [
  ['#/', '대시보드', Dashboard],
  ['#/alarms', '알람', Alarms],
  ['#/events', '이벤트', Events],
  ['#/patients', '환자', Patients],
  ['#/gateways', '게이트웨이', Gateways],
  ['#/map', '병원 지도', MapPage],
  ['#/viewers', '뷰어', Viewers],
  // entries with a 4th element hang under that top-menu group (rendered as a custom nav menu)
  ['#/live', '실시간', Live, '테스트'],
  ['#/test/multiviewer', '멀티 뷰어 테스트', MultiViewerTest, '테스트'],
  ['#/test/ops', '운영 통계', OpsStats, '테스트'],
  ['#/test/data', '데이터 관리', DataAdmin, '테스트'],
  ['#/settings/viewer', '뷰어 설정', ViewerSettings, '설정'],
  ['#/settings/biosignal', '생체신호 관리', BiosignalAdmin, '설정'],
]
const MENUS = [...new Set(PAGES.map((p) => p[3]).filter(Boolean))]

/** Top-nav group with a click-to-open submenu (no native controls); closes on outside click / Esc / pick. */
function NavMenu({ label, items, base, hints }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc); document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [open])
  const active = items.some(([h]) => h === base)
  return (
    <span ref={ref} className={'nav-menu' + (open ? ' open' : '')}>
      <a href="#" className={active ? 'active' : ''} onClick={(e) => { e.preventDefault(); setOpen(!open) }} aria-haspopup="menu" aria-expanded={open}>{label} <i className="dd-caret" /></a>
      {open && <div className="nav-sub" role="menu">{items.map(([h, l]) => <a key={h} href={h} role="menuitem" className={base === h ? 'active' : ''} onClick={() => setOpen(false)}>{l}{hints?.[h] != null && <span className="hint">{hints[h]}</span>}</a>)}</div>}
    </span>
  )
}

function useHash() {
  const [h, setH] = useState(location.hash || '#/')
  useEffect(() => {
    const f = () => setH(location.hash || '#/')
    window.addEventListener('hashchange', f)
    return () => window.removeEventListener('hashchange', f)
  }, [])
  return h
}

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') } catch { return 'dark' }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try { localStorage.setItem('theme', theme) } catch { /* ignore */ }
  }, [theme])
  return [theme, setTheme]
}

// Alarm feed shared by every page: REST snapshot every 3 s + WS raise/clear in between.
export function useAlarms() {
  const [snap] = usePoll(api.alarms, 3000)
  const [live, setLive] = useState({ alarms: [], summary: {} })
  useEffect(() => { if (snap) setLive(snap) }, [snap])
  useEffect(() => {
    const un = subscribeGroup('alarms')
    // Alarm events arrive ~3/s across a busy hospital and each used to re-render the whole page (every bed tile
    // and waveform card), which froze the draw loop for a moment. Batch them into one update per 500 ms.
    let pending = []
    let timer = 0
    const flush = () => {
      timer = 0
      const batch = pending
      pending = []
      if (!batch.length) return
      setLive((cur) => {
        const byId = new Map(cur.alarms.map((a) => [a.id, a]))
        for (const m of batch) {
          if (m.event === 'raise') byId.set(m.alarm.id, m.alarm)
          else byId.delete(m.alarm.id)
        }
        return { ...cur, alarms: [...byId.values()] }
      })
    }
    const off = onWs('alarm', (m) => {
      pending.push(m)
      if (!timer) timer = setTimeout(flush, 500)
    })
    return () => { un(); off(); if (timer) clearTimeout(timer) }
  }, [])
  return live
}

export default function App() {
  const hash = useHash()
  const [theme, setTheme] = useTheme()
  const [health] = usePoll(api.health, 5000)
  const [emu] = usePoll(api.emu.status, 5000)
  // ward count for the 멀티 뷰어 테스트 menu caption (= number of browser tabs it opens)
  const [chRows] = usePoll(api.channels, 30000)
  const wardCount = new Set((chRows || []).filter((r) => r.connected).map((r) => r.patient?.ward).filter(Boolean)).size
  const navHints = { '#/test/multiviewer': `${wardCount}탭` }
  const [ws, setWs] = useState(wsStatus())
  const [modal, setModal] = useState(null) // { channel_id } for the patient live modal
  const alarms = useAlarms()
  useEffect(() => { ensureOpen(); return onWs('status', setWs) }, [])
  useEffect(() => {
    const f = (e) => setModal(e.detail)
    window.addEventListener('open-live', f)
    return () => window.removeEventListener('open-live', f)
  }, [])

  const base = hash.split('?')[0]
  // old bookmark '#/settings' → 뷰어 설정
  const page = PAGES.find(([h]) => h === (base === '#/settings' ? '#/settings/viewer' : base)) || PAGES[0]
  const Page = page[2]
  const s = alarms.summary || {}
  // Viewer templates run full-screen without the console chrome (opened in their own tab).
  if (base === '#/viewer') {
    return <>
      <Viewer alarms={alarms} hash={hash} />
      {modal && <LiveModal channelId={modal.channel_id} alarms={alarms} onClose={() => setModal(null)} />}
    </>
  }
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">🫀 Biomonitor Router</a>
        <nav>
          {PAGES.filter((p) => !p[3] && !p[4]).map(([h, label]) => (
            <a key={h} href={h} className={base === h ? 'active' : ''}>{label}{h === '#/alarms' && s.unacked > 0 && <span className="badge">{s.unacked}</span>}</a>
          ))}
          {MENUS.map((m) => <NavMenu key={m} label={m} base={base} items={PAGES.filter((p) => p[3] === m)} hints={navHints} />)}
          {PAGES.filter((p) => p[4] === 'last').map(([h, label]) => <a key={h} href={h} className={base === h ? 'active' : ''}>{label}</a>)}
        </nav>
        <span className="spacer" />
        <span className={'pill ' + (health?.ok ? 'ok' : 'err')} title="라우터 API">라우터 {health?.ok ? '정상' : '응답 없음'}</span>
        <span className={'pill ' + (ws === 'open' ? 'ok' : 'warn')} title="출력 WebSocket">WS {ws === 'open' ? '연결' : ws}</span>
        <span className={'pill ' + (emu?.running ? 'ok' : emu ? 'warn' : 'err')} title="에뮬레이터 (RP5#1)">에뮬레이터 {emu ? (emu.running ? '전송 중' : '정지') : '연결 안 됨'}</span>
        <span className={'pill ' + (s.critical ? 'crit' : s.high ? 'err' : s.active ? 'warn' : '')} title="활성 알람 (위험/높음/중간/낮음)">
          알람 {s.active ?? 0}{s.active ? ` · ${s.critical || 0}/${s.high || 0}/${s.medium || 0}/${s.low || 0}` : ''}
        </span>
        <button className="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title="테마">{theme === 'dark' ? '🌙' : '☀️'}</button>
      </header>
      <main>
        <Page alarms={alarms} hash={hash} />
      </main>
      {modal && <LiveModal channelId={modal.channel_id} alarms={alarms} onClose={() => setModal(null)} />}
    </div>
  )
}

/** Any page can open the live modal for a patch. */
export const openLive = (channel_id) => window.dispatchEvent(new CustomEvent('open-live', { detail: { channel_id: String(channel_id) } }))
