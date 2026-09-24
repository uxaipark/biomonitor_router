import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'

const LAST = 'login.tenant'
const PLATFORM = '' // 병원 ID 없음 = 플랫폼(본사) 계정

/**
 * 로그인: 병원 ID → 아이디 → 비밀번호. 아이디는 병원 안에서만 유일해서(병원마다 dr.kim 이 따로 있다) 병원을 먼저 고른다.
 * 플랫폼 계정(수퍼 어드민·시스템 관리자·리셀러·CRM 영업)은 "플랫폼"으로 들어오거나 담당 병원을 골라 그 병원 하나로 들어온다.
 * 개발 모드: 병원 목록과 그 병원의 시험용 계정·임시 비밀번호가 보인다. 운영 모드: 병원 ID 를 직접 입력한다.
 */
export default function Login({ onLogin }) {
  const [info, setInfo] = useState(null)
  const [tenant, setTenant] = useState(() => { try { return localStorage.getItem(LAST) ?? '' } catch { return '' } })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.auth.testAccounts().then(setInfo).catch(() => setInfo({ accounts: [], tenants: [] })) }, [])
  const dev = !!info?.dev_mode
  const tenants = info?.tenants || []
  // 처음 열면 이 라우터의 병원을 기본으로
  useEffect(() => {
    if (!info) return
    let saved = null
    try { saved = localStorage.getItem(LAST) } catch { /* ignore */ }
    if (saved == null && info.site) setTenant(info.site)
  }, [info])

  const submit = async (t = tenant, u = username, pw = password) => {
    if (!u || !pw) { setErr('아이디와 비밀번호를 입력하세요'); return }
    setBusy(true); setErr('')
    try {
      const me = await api.auth.login(t.trim().toUpperCase(), u, pw)
      try { localStorage.setItem(LAST, t.trim().toUpperCase()) } catch { /* ignore */ }
      onLogin(me)
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const T = tenant.trim().toUpperCase()
  // 고른 병원으로 들어올 수 있는 시험용 계정: 그 병원 계정 + 그 병원을 담당하는 플랫폼 계정
  const accounts = useMemo(() => (info?.accounts || []).filter((a) => (T === PLATFORM
    ? !a.tenant_id
    : a.tenant_id === T || (!a.tenant_id && (a.role === 'super_admin' || a.role === 'system_admin' || (a.tenants || []).includes(T))))), [info, T])
  const hosp = accounts.filter((a) => a.tenant_id)
  const plat = accounts.filter((a) => !a.tenant_id)
  const tname = tenants.find((t) => t.id === T)?.name
  // 제품 이름: 계정을 아직 안 골랐으면(직접 입력 중 포함) Biosignal Platform, 병원 계정이면 Patient Monitor, 플랫폼 계정이면 Biomonitor Router
  // (로그인 뒤 머리글·탭 제목도 같은 규칙)
  const brand = hosp.some((a) => a.username === username) ? 'Patient Monitor' : plat.some((a) => a.username === username) ? 'Biomonitor Router' : 'Biosignal Platform'
  useEffect(() => { document.title = brand }, [brand])
  const Acc = ({ a }) => (
    <button className={'login-acc' + (username === a.username ? ' on' : '')} onClick={() => { setUsername(a.username); setPassword(a.password); setErr('') }} onDoubleClick={() => submit(tenant, a.username, a.password)} title="두 번 누르면 바로 로그인">
      <span className="la-role">{a.role_label}</span>
      <b>{a.name}</b>
      <span className="la-id mono">{a.username}</span>
      <span className="la-pw mono">{a.password}</span>
    </button>
  )
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="login-brand">
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="1" y="1" width="22" height="22" rx="6" fill="var(--accent)" /><path d="M4 13h4l2-5 3 9 2-6 1.5 2H20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <div><b>{brand}</b><small>병원 생체신호 모니터링 콘솔</small></div>
        </div>

        <div className="login-tenant">
          <span className="lt-label">병원</span>
          {dev ? (
            <div className="lt-list">
              {tenants.map((t) => (
                <button key={t.id} className={'lt-item' + (T === t.id ? ' on' : '')} onClick={() => { setTenant(t.id); setUsername(''); setPassword(''); setErr('') }}>
                  <b className="mono">{t.id}</b><span>{t.name}</span>{t.is_site && <small>이 라우터</small>}
                </button>
              ))}
              <button className={'lt-item plat' + (T === PLATFORM ? ' on' : '')} onClick={() => { setTenant(PLATFORM); setUsername(''); setPassword(''); setErr('') }}>
                <b>플랫폼</b><span>본사 계정 (병원 ID 없음)</span>
              </button>
            </div>
          ) : (
            <div className="lt-manual">
              <input className="mono" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="병원 ID (예: H001)" />
              <label className="chk"><input type="checkbox" checked={T === PLATFORM} onChange={(e) => setTenant(e.target.checked ? PLATFORM : '')} /> 플랫폼(본사) 계정</label>
            </div>
          )}
        </div>

        <form onSubmit={(e) => { e.preventDefault(); submit() }} className="login-form">
          <label>아이디<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus /></label>
          <label>비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          <button className="primary" disabled={busy}>{busy ? '확인 중…' : T ? `${T} 로그인` : '플랫폼 로그인'}</button>
          {err && <p className="err">{err}</p>}
        </form>

        {dev && accounts.length > 0 && (
          <div className="login-test">
            <h4>{T ? `${T} · ${tname || ''}` : '플랫폼'} 시험용 계정 <small>개발 모드 · 임시 비밀번호 — 누르면 입력, 두 번 누르면 로그인</small></h4>
            {hosp.length > 0 && <div className="la-group"><span className="la-gt">병원 계정</span><div className="la-list">{hosp.map((a) => <Acc key={a.username} a={a} />)}</div></div>}
            {plat.length > 0 && <div className="la-group"><span className="la-gt">{T ? '선택한 병원 플랫폼 계정' : '플랫폼 계정'}{T && <small>선택한 병원으로 접속됩니다.</small>}</span><div className="la-list">{plat.map((a) => <Acc key={a.username} a={a} />)}</div></div>}
          </div>
        )}
        {info && !dev && <p className="muted login-note">운영 모드입니다. 병원 ID 와 계정은 병원 IT 매니저나 관리자에게 받으세요.</p>}
      </div>
    </div>
  )
}
