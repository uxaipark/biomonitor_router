import React, { useEffect, useRef, useState } from 'react'
import { api, usePoll } from './api.js'
import { onWs, setWsAllowed, subscribeGroup, wsStatus } from './ws.js'
import { MeContext, can, canBio, canPhi } from './auth.js'
import Login from './pages/Login.jsx'
import AdminUsers from './pages/AdminUsers.jsx'
import AdminPermissions from './pages/AdminPermissions.jsx'
import AdminTenants from './pages/AdminTenants.jsx'
import AdminAudit from './pages/AdminAudit.jsx'
import Integration from './pages/Integration.jsx'
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
import NetworkSettings from './pages/NetworkSettings.jsx'
import DataAdmin from './pages/DataAdmin.jsx'
import OpsStats from './pages/OpsStats.jsx'
import { LiveModal } from './pages/LiveModal.jsx'

// [hash, 메뉴 이름, 페이지, 묶음 메뉴(선택), 권한 자원]
const PAGES = [
  ['#/', '대시보드', Dashboard, null, 'page.dashboard'],
  ['#/alarms', '알람', Alarms, null, 'page.alarms'],
  ['#/events', '이벤트', Events, null, 'page.events'],
  ['#/patients', '환자', Patients, null, 'page.patients'],
  ['#/gateways', '게이트웨이', Gateways, null, 'page.gateways'],
  ['#/map', '병원 지도', MapPage, null, 'page.map'],
  ['#/viewers', '뷰어', Viewers, null, 'page.viewers'],
  // entries with a 4th element hang under that top-menu group (rendered as a custom nav menu)
  ['#/live', '실시간', Live, '테스트', 'page.test'],
  ['#/test/multiviewer', '멀티 뷰어 테스트', MultiViewerTest, '테스트', 'page.test'],
  ['#/test/ops', '운영 통계', OpsStats, '테스트', 'page.ops'],
  ['#/test/data', '데이터 관리', DataAdmin, '테스트', 'page.data_admin'],
  ['#/settings/viewer', '뷰어 설정', ViewerSettings, '설정', 'page.settings_viewer'],
  ['#/settings/biosignal', '생체 데이터 관리', BiosignalAdmin, '설정', 'page.settings_biosignal'],
  ['#/settings/network', '네트워크 설정', NetworkSettings, '설정', 'page.settings_network'],
  ['#/settings/integration', 'EMR 연동', Integration, '설정', 'page.integration'],
  ['#/admin/users', '계정', AdminUsers, '관리', 'page.admin_users'],
  ['#/admin/permissions', '권한 설정', AdminPermissions, '관리', 'page.admin_permissions'],
  ['#/admin/tenants', '병원 (테넌트)', AdminTenants, '관리', 'page.admin_tenants'],
  ['#/admin/audit', '감사 기록', AdminAudit, '관리', 'page.admin_audit'],
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
export function useAlarms(enabled = true, live = true) {
  const [snap] = usePoll(() => (enabled ? api.alarms() : Promise.resolve(null)), 3000, [enabled])
  const [liveState, setLive] = useState({ alarms: [], summary: {} })
  useEffect(() => { if (snap) setLive(snap) }, [snap])
  useEffect(() => {
    if (!live) return
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
  }, [live])
  return liveState
}

/** 로그인 확인 → 로그인 화면 또는 콘솔. 어느 API 든 401 이면(세션 만료) 로그인 화면으로 돌아간다. */
export const appTitle = (u) => (u?.tenant_id ? 'Patient Monitor' : 'Biomonitor Router')

export default function App() {
  const [me, setMe] = useState(undefined) // undefined = 확인 중, null = 로그인 필요
  useEffect(() => {
    api.auth.me().then(setMe).catch(() => setMe(null))
    const lost = () => setMe(null)
    window.addEventListener('auth-lost', lost)
    return () => window.removeEventListener('auth-lost', lost)
  }, [])
  useEffect(() => { setWsAllowed(!!me && canBio(me) && canPhi(me)) }, [me])
  useTheme()
  // 병원 계정(소속 병원이 있는 계정)으로 들어오면 제품 이름을 Patient Monitor 로, 플랫폼 계정은 Biomonitor Router 그대로
  useEffect(() => { if (me) document.title = appTitle(me.user) }, [me]) // 로그인 전 제목은 Login 이 정한다
  if (me === undefined) return <div className="boot muted">확인 중…</div>
  if (!me) return <Login onLogin={setMe} />
  return <MeContext.Provider value={me}><Console me={me} setMe={setMe} /></MeContext.Provider>
}

/** 다른 병원 계정이 이 라우터의 데이터 화면에 들어왔을 때 */
function SiteBlocked({ me }) {
  return (
    <div className="page"><div className="panel no-access">
      <h3>이 병원의 데이터에 접근할 수 없습니다</h3>
      <p>이 라우터는 <b>{me.site.tenant_id} · {me.site.name}</b> 소속입니다. 이 계정은 <b>{me.user.tenant_name || '다른 병원'}</b> 소속이라 환자·파형·알람을 볼 수 없습니다 — 병원마다 데이터가 완전히 분리됩니다.</p>
      <p className="muted">소속 병원의 라우터(또는 클라우드 콘솔)로 접속하세요. 계정·권한 관리 메뉴는 그대로 쓸 수 있습니다.</p>
    </div></div>
  )
}

/** 권한이 없는 페이지 */
function NoAccess({ label }) {
  return <div className="page"><div className="panel no-access"><h3>{label}</h3><p>이 계정에는 이 화면을 볼 권한이 없습니다. 필요하면 관리자(권한 설정)에게 요청하세요.</p></div></div>
}

function Console({ me, setMe }) {
  const hash = useHash()
  const [theme, setTheme] = useTheme()
  const [health] = usePoll(api.health, 5000)
  const [emu] = usePoll(api.emu.status, 5000)
  // ward count for the 멀티 뷰어 테스트 menu caption (= number of browser tabs it opens)
  const [chRows] = usePoll(() => (can(me, 'page.test') ? api.channels() : Promise.resolve(null)), 30000)
  const wardCount = new Set((chRows || []).filter((r) => r.connected).map((r) => r.patient?.ward).filter(Boolean)).size
  const navHints = { '#/test/multiviewer': `${wardCount}탭` }
  const [ws, setWs] = useState(wsStatus())
  const [modal, setModal] = useState(null) // { channel_id } for the patient live modal
  const alarmsVisible = ['page.alarms', 'page.dashboard', 'page.map', 'page.patients', 'page.viewers', 'page.test'].some((r) => can(me, r))
  const alarms = useAlarms(alarmsVisible, canBio(me) && canPhi(me))
  useEffect(() => onWs('status', setWs), [])
  useEffect(() => {
    const f = (e) => setModal(e.detail)
    window.addEventListener('open-live', f)
    return () => window.removeEventListener('open-live', f)
  }, [])

  const base = hash.split('?')[0]
  // old bookmark '#/settings' → 뷰어 설정
  // 다른 병원 계정은 이 라우터에서 관리 메뉴만 (데이터 메뉴는 숨김)
  const allowed = PAGES.filter((p) => can(me, p[4]) && (me.site.accessible || p[0].startsWith('#/admin/')))
  const page = PAGES.find(([h]) => h === (base === '#/settings' ? '#/settings/viewer' : base)) || allowed[0] || PAGES[0]
  // 이 라우터의 병원에 속하지 않은 계정: 관리 화면 외에는 데이터가 없다(서버가 403) — 빈 화면 대신 안내
  const blocked = !me.site.accessible && !page[0].startsWith('#/admin/')
  const Page = blocked ? () => <SiteBlocked me={me} /> : can(me, page[4]) ? page[2] : () => <NoAccess label={page[1]} />
  const menus = MENUS.filter((m) => allowed.some((p) => p[3] === m))
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
        <a className="brand" href="#/"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent)" /><path d="M4 13h4l2-5 3 9 2-6 1.5 2H20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>{appTitle(me.user)}</a>
        <nav>
          {allowed.filter((p) => !p[3]).map(([h, label]) => (
            <a key={h} href={h} className={base === h ? 'active' : ''}>{label}{h === '#/alarms' && s.unacked > 0 && <span className="badge">{s.unacked}</span>}</a>
          ))}
          {menus.map((m) => <NavMenu key={m} label={m} base={base} items={allowed.filter((p) => p[3] === m)} hints={navHints} />)}
        </nav>
        <span className="spacer" />
        <span className={'pill ' + (health?.ok ? 'ok' : 'err')} title={`라우터 API ${health?.ok ? '정상' : '응답 없음'}`}>라우터</span>
        {!me.site.accessible ? null : canBio(me) && canPhi(me) ? <span className={'pill ' + (ws === 'open' ? 'ok' : 'warn')} title={`출력 WebSocket: ${ws}`}>WS</span> : <span className="pill warn" title="개인정보·생체신호 권한이 없어 이름 등은 가려지고 파형은 나오지 않습니다">마스킹</span>}
        {me.site.accessible && <span className={'pill ' + (emu?.running ? 'ok' : emu ? 'warn' : 'err')} title={`에뮬레이터 (RP5#1): ${emu ? (emu.running ? '전송 중' : '정지') : '연결 안 됨'}`}>에뮬레이터</span>}
        {alarmsVisible && me.site.accessible && <span className={'pill ' + (s.critical ? 'crit' : s.high ? 'err' : s.active ? 'warn' : '')} title={`활성 알람 — 위험 ${s.critical || 0} · 높음 ${s.high || 0} · 중간 ${s.medium || 0} · 낮음 ${s.low || 0}`}>
          알람 {s.active ?? 0}{s.critical ? ` · 위험 ${s.critical}` : ''}
        </span>}
        <UserMenu me={me} setMe={setMe} />
        <button className="icon" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} title={theme === 'dark' ? '밝은 테마로' : '어두운 테마로'}>{theme === 'dark'
          ? <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" fill="currentColor" /></svg>
          : <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="4.5" fill="currentColor" /><g stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></g></svg>}</button>
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

/** 임시 비밀번호 안내 창은 계정마다(이 브라우저에서) 처음 한 번만 자동으로 띄운다. */
const pwPromptKey = (u) => `bm_pw_prompted:${u.tenant_id || ''}:${u.username}`
function pwPromptOnce(u) {
  if (!u.must_change || u.service) return false
  try {
    if (localStorage.getItem(pwPromptKey(u))) return false
    localStorage.setItem(pwPromptKey(u), String(Date.now()))
  } catch { /* 저장소를 못 쓰면 매번 띄우는 쪽보다 안 띄우는 쪽 */ return false }
  return true
}

/** 머리글 오른쪽 계정 메뉴: 이름·역할·병원, 비밀번호 변경, 로그아웃. 임시 비밀번호면 처음 한 번 바꾸기 창을 띄운다. */
function UserMenu({ me, setMe }) {
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState(() => pwPromptOnce(me.user))
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const f = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [open])
  const logout = async () => { try { await api.auth.logout() } catch { /* ignore */ } setMe(null) }
  const u = me.user
  return (
    <span className="user-menu" ref={ref}>
      <button className="user-btn" onClick={() => setOpen(!open)} title={`${u.name} · ${u.role_label}`}>
        <span className={'role-dot r-' + u.role} />
        <span className="um-name">{u.name}</span>
        {(u.tenant_id || me.context?.tenant_id) && <span className="um-tenant mono">{u.tenant_id || me.context.tenant_id}</span>}
        <small>{u.role_label}</small>
      </button>
      {open && (
        <div className="um-pop">
          <div className="um-who"><b>{u.name}</b><span className="mono">{u.username}</span></div>
          <div className="um-row"><small>역할</small>{u.role_label}</div>
          <div className="um-row"><small>소속</small>{u.tenant_name ? `${u.tenant_id} · ${u.tenant_name}` : '플랫폼'}</div>
          {!u.tenant_id && <div className="um-row"><small>로그인 병원</small>{me.context?.tenant_id ? `${me.context.tenant_id} · ${me.context.name || ''} (이 병원만)` : '플랫폼 (담당 전체)'}</div>}
          <div className="um-row"><small>이 라우터</small>{me.site.tenant_id} · {me.site.name}</div>
          <div className="um-row"><small>개인정보 · 생체신호</small>{canPhi(me) ? '원문' : '마스킹'} · {canBio(me) ? '보기' : '없음'}</div>
          {me.dev_mode && <div className="um-row dev"><small>개발 모드</small>켜짐</div>}
          <div className="um-acts"><button onClick={() => { setPw(true); setOpen(false) }}>비밀번호 변경</button><button onClick={logout}>로그아웃</button></div>
        </div>
      )}
      {pw && <PasswordModal must={u.must_change} onClose={() => setPw(false)} onDone={() => { setPw(false); api.auth.me().then(setMe).catch(() => {}) }} />}
    </span>
  )
}

function PasswordModal({ must, onClose, onDone }) {
  const [f, setF] = useState({ old: '', nw: '', nw2: '' })
  const [err, setErr] = useState('')
  const save = async () => {
    setErr('')
    if (f.nw !== f.nw2) { setErr('새 비밀번호가 서로 다릅니다'); return }
    try { await api.auth.password(f.old, f.nw); onDone() } catch (e) { setErr(e.message) }
  }
  return (
    <div className="modal-bg" onClick={must ? undefined : onClose}>
      <div className="modal adm-form" onClick={(e) => e.stopPropagation()}>
        <h3>비밀번호 변경</h3>
        {must && <p className="adm-notice">임시 비밀번호로 로그인했습니다. 계속 쓰려면 비밀번호를 바꾸세요. (시험 중에는 "나중에"로 넘어갈 수 있습니다)</p>}
        <label>현재 비밀번호<input type="password" value={f.old} onChange={(e) => setF({ ...f, old: e.target.value })} autoFocus /></label>
        <label>새 비밀번호<input type="password" value={f.nw} onChange={(e) => setF({ ...f, nw: e.target.value })} placeholder="8자 이상, 대·소문자·숫자·기호 중 3가지" /></label>
        <label>새 비밀번호 확인<input type="password" value={f.nw2} onChange={(e) => setF({ ...f, nw2: e.target.value })} /></label>
        {err && <p className="err">{err}</p>}
        <div className="toolbar"><span className="spacer" /><button onClick={onClose}>{must ? '나중에' : '취소'}</button><button className="primary" onClick={save}>변경</button></div>
      </div>
    </div>
  )
}
