import React, { useEffect, useState } from 'react'
import { api } from '../api.js'

/**
 * 로그인. 개발 모드에서는 시험용 계정(역할별)과 임시 비밀번호가 목록으로 나와, 고르면 바로 들어간다.
 * 개발 모드를 끄면 목록은 사라지고 아이디·비밀번호만 남는다.
 */
export default function Login({ onLogin }) {
  const [info, setInfo] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { api.auth.testAccounts().then(setInfo).catch(() => setInfo({ accounts: [] })) }, [])

  const submit = async (u = username, pw = password) => {
    if (!u || !pw) { setErr('아이디와 비밀번호를 입력하세요'); return }
    setBusy(true); setErr('')
    try { const me = await api.auth.login(u, pw); onLogin(me) } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const accounts = info?.accounts || []
  const platform = accounts.filter((a) => !a.tenant_id)
  const byTenant = new Map()
  for (const a of accounts.filter((x) => x.tenant_id)) {
    const k = `${a.tenant_id} · ${a.tenant_name || ''}`
    if (!byTenant.has(k)) byTenant.set(k, [])
    byTenant.get(k).push(a)
  }
  const Acc = ({ a }) => (
    <button className={'login-acc' + (username === a.username ? ' on' : '')} onClick={() => { setUsername(a.username); setPassword(a.password); setErr('') }} onDoubleClick={() => submit(a.username, a.password)} title="두 번 누르면 바로 로그인">
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
          <div><b>Biomonitor Router</b><small>병원 생체신호 모니터링 콘솔</small></div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); submit() }} className="login-form">
          <label>아이디<input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus /></label>
          <label>비밀번호<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></label>
          {err && <p className="err">{err}</p>}
          <button className="primary" disabled={busy}>{busy ? '확인 중…' : '로그인'}</button>
        </form>
        {info?.dev_mode && accounts.length > 0 && (
          <div className="login-test">
            <h4>시험용 계정 <small>개발 모드 · 임시 비밀번호 — 누르면 입력, 두 번 누르면 로그인</small></h4>
            <div className="la-group"><span className="la-gt">플랫폼</span><div className="la-list">{platform.map((a) => <Acc key={a.username} a={a} />)}</div></div>
            {[...byTenant].map(([k, list]) => (
              <div key={k} className="la-group"><span className="la-gt">{k}</span><div className="la-list">{list.map((a) => <Acc key={a.username} a={a} />)}</div></div>
            ))}
          </div>
        )}
        {info && !info.dev_mode && <p className="muted login-note">운영 모드입니다. 계정은 병원 IT 매니저나 관리자에게 요청하세요.</p>}
      </div>
    </div>
  )
}
