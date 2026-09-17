import React, { useEffect, useState } from 'react'
import { api, usePoll } from './api.js'
import { ensureOpen, onWs, subscribeGroup, wsStatus } from './ws.js'
import Dashboard from './pages/Dashboard.jsx'
import Patients from './pages/Patients.jsx'
import Live from './pages/Live.jsx'
import MapPage from './pages/MapPage.jsx'
import Gateways from './pages/Gateways.jsx'
import Alarms from './pages/Alarms.jsx'
import Events from './pages/Events.jsx'
import { LiveModal } from './pages/LiveModal.jsx'

const PAGES = [
  ['#/', '대시보드', Dashboard],
  ['#/patients', '환자', Patients],
  ['#/live', '실시간', Live],
  ['#/map', '병원 지도', MapPage],
  ['#/gateways', '게이트웨이', Gateways],
  ['#/alarms', '알람', Alarms],
  ['#/events', '이벤트', Events],
]

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
    const off = onWs('alarm', (m) => {
      setLive((cur) => {
        const rest = cur.alarms.filter((a) => a.id !== m.alarm.id)
        const alarms = m.event === 'raise' ? [m.alarm, ...rest] : rest
        return { ...cur, alarms }
      })
    })
    return () => { un(); off() }
  }, [])
  return live
}

export default function App() {
  const hash = useHash()
  const [theme, setTheme] = useTheme()
  const [health] = usePoll(api.health, 5000)
  const [emu] = usePoll(api.emu.status, 5000)
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
  const page = PAGES.find(([h]) => h === base) || PAGES[0]
  const Page = page[2]
  const s = alarms.summary || {}
  return (
    <div className="app">
      <header className="top">
        <a className="brand" href="#/">🫀 Biomonitor Router</a>
        <nav>
          {PAGES.map(([h, label]) => (
            <a key={h} href={h} className={base === h ? 'active' : ''}>{label}{h === '#/alarms' && s.unacked > 0 && <span className="badge">{s.unacked}</span>}</a>
          ))}
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
