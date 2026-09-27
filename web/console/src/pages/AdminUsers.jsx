import React, { useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { useMe } from '../auth.js'
import Dropdown from '../Dropdown.jsx'

/**
 * 운영관리 › 계정. 보이는 계정·줄 수 있는 역할은 요청자에 따라 서버가 정한다:
 * 수퍼 어드민 = 전부, 시스템 관리자 = 수퍼 어드민 외 전부, 리셀러 = 담당 병원의 병원 역할,
 * 병원 IT 매니저 = 자기 병원의 병원 역할, 의사 = 자기 병원의 간호사·스태프.
 */
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : '—')

export default function AdminUsers() {
  const me = useMe()
  const [data, err, refresh] = usePoll(api.admin.users, 15000)
  const [edit, setEdit] = useState(null) // user object or {} for new
  const [q, setQ] = useState('')
  const [tenantF, setTenantF] = useState('')
  const [notice, setNotice] = useState(null) // { username, pw }
  const users = data?.users || []
  const tenants = data?.tenants || []
  const tname = (id) => tenants.find((t) => t.id === id)?.name || id
  const roleLabel = (code) => ({ super_admin: '수퍼 어드민', system_admin: '시스템 관리자', reseller: '리셀러', sales_crm: 'CRM 영업', hospital_it: '병원 IT 매니저', doctor: '의사', nurse: '간호사', staff: '스태프' })[code] || code
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase()
    return users.filter((u) => (!tenantF || (tenantF === '-' ? !u.tenant_id : u.tenant_id === tenantF)) && (!n || [u.username, u.name, roleLabel(u.role)].some((x) => x.toLowerCase().includes(n))))
  }, [users, q, tenantF])
  const canAssign = (role) => (data?.assignable || []).some((r) => r.code === role)
  const reset = async (u) => {
    if (!window.confirm(`${u.username} 의 비밀번호를 임시 비밀번호로 바꾸고 로그인 세션을 끊습니다. 계속할까요?`)) return
    try { const r = await api.admin.resetPassword(u.id); setNotice({ username: u.username, pw: r.temp_password }); refresh?.() } catch (e) { alert(e.message) }
  }
  const tOpts = [{ value: '', label: '전체 병원', count: users.length }, { value: '-', label: '플랫폼 계정', count: users.filter((u) => !u.tenant_id).length }, ...tenants.map((t) => ({ value: t.id, label: `${t.id} · ${t.name}`, count: users.filter((u) => u.tenant_id === t.id).length }))]
  return (
    <div className="page adm">
      <div className="adm-head">
        <h2 className="h">계정</h2>
        <input placeholder="검색: 아이디 · 이름 · 역할" value={q} onChange={(e) => setQ(e.target.value)} />
        <Dropdown value={tenantF} options={tOpts} onChange={setTenantF} searchable={false} countUnit="명" width={280} />
        <span className="spacer" />
        {data?.can_edit && (data.assignable || []).length > 0 && <button className="primary" onClick={() => setEdit({})}>+ 계정 만들기</button>}
      </div>
      {err && <p className="err">{err.message}</p>}
      {notice && (
        <div className="adm-notice">
          <b>{notice.username}</b> 임시 비밀번호: <code className="pw">{notice.pw}</code> — 본인에게 전달하세요. 처음 로그인하면 비밀번호를 바꾸게 됩니다.
          <button onClick={() => { navigator.clipboard?.writeText(notice.pw) }}>복사</button><button onClick={() => setNotice(null)}>닫기</button>
        </div>
      )}
      {me?.user?.role === 'super_admin' && <TestPins tname={tname} />}
      <table className="tbl adm-tbl">
        <thead><tr><th>아이디</th><th>이름</th><th>역할</th><th>소속 병원</th><th>담당 병원</th><th>상태</th><th>마지막 로그인</th><th /></tr></thead>
        <tbody>
          {shown.map((u) => {
            const mine = u.id === me.user.id
            const editable = data?.can_edit && canAssign(u.role)
            return (
              <tr key={u.id} className={u.active ? '' : 'stale'}>
                <td className="mono"><b>{u.username}</b>{mine && <span className="tag small ok">나</span>}</td>
                <td>{u.name}</td>
                <td><span className={'role-tag r-' + u.role}>{roleLabel(u.role)}</span></td>
                <td>{u.tenant_id ? <>{tname(u.tenant_id)} <small className="muted mono">{u.tenant_id}</small></> : <span className="muted">플랫폼</span>}</td>
                <td>{u.tenants?.length ? u.tenants.map((t) => <span key={t} className="tag small">{t}</span>) : <span className="muted">—</span>}</td>
                <td>{!u.active ? <span className="tag err small">사용 중지</span> : u.must_change ? <span className="tag warn small">임시 비밀번호</span> : <span className="tag ok small">사용</span>}</td>
                <td className="muted">{fmt(u.last_login_ms)}</td>
                <td className="acts">{editable && <><button onClick={() => setEdit(u)}>수정</button><button onClick={() => reset(u)}>비밀번호 초기화</button></>}</td>
              </tr>
            )
          })}
          {!shown.length && <tr><td colSpan="8" className="muted">계정이 없습니다.</td></tr>}
        </tbody>
      </table>
      {edit && <UserForm user={edit} data={data} onClose={() => setEdit(null)} onSaved={(r) => { setEdit(null); refresh?.(); if (r?.temp_password) setNotice({ username: r.username, pw: r.temp_password }) }} />}
    </div>
  )
}

function UserForm({ user, data, onClose, onSaved }) {
  const isNew = !user.id
  const roles = data.assignable || []
  const [f, setF] = useState({ username: user.username || '', name: user.name || '', role: user.role || roles[roles.length - 1]?.code || '', tenant_id: user.tenant_id || data.tenants?.[0]?.id || '', tenants: user.tenants || [], active: user.active ?? true })
  const [err, setErr] = useState('')
  const platform = roles.find((r) => r.code === f.role)?.platform
  const scoped = f.role === 'reseller' || f.role === 'sales_crm'
  const save = async () => {
    setErr('')
    try {
      const body = { ...f, tenant_id: platform ? null : f.tenant_id, tenants: scoped ? f.tenants : [] }
      const r = isNew ? await api.admin.createUser(body) : await api.admin.updateUser(user.id, body)
      onSaved({ ...r, username: f.username })
    } catch (e) { setErr(e.message) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal adm-form" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? '계정 만들기' : `계정 수정 · ${user.username}`}</h3>
        <label>아이디<input value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="영문·숫자·.-_" /></label>
        <label>이름<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="표시 이름 (예: 홍길동 · 3A병동)" /></label>
        <label>역할
          <Dropdown value={f.role} options={roles.map((r) => ({ value: r.code, label: `${r.label}${r.platform ? ' · 플랫폼' : ''}` }))} onChange={(v) => setF({ ...f, role: v })} searchable={false} width={260} />
        </label>
        {!platform && (
          <label>소속 병원
            <Dropdown value={f.tenant_id} options={(data.tenants || []).map((t) => ({ value: t.id, label: `${t.id} · ${t.name}` }))} onChange={(v) => setF({ ...f, tenant_id: v })} searchable={false} width={320} />
          </label>
        )}
        {scoped && (
          <div className="adm-chk"><span>담당 병원</span>
            {(data.tenants || []).map((t) => (
              <label key={t.id} className="chk"><input type="checkbox" checked={f.tenants.includes(t.id)} onChange={(e) => setF({ ...f, tenants: e.target.checked ? [...f.tenants, t.id] : f.tenants.filter((x) => x !== t.id) })} /> {t.id} · {t.name}</label>
            ))}
          </div>
        )}
        {!isNew && <label className="chk"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 사용 (끄면 즉시 로그아웃되고 로그인할 수 없습니다)</label>}
        {isNew && <p className="muted">임시 비밀번호가 만들어지고, 처음 로그인하면 바꾸게 됩니다.</p>}
        {err && <p className="err">{err}</p>}
        <div className="toolbar"><span className="spacer" /><button onClick={onClose}>취소</button><button className="primary" onClick={save}>{isNew ? '만들기' : '저장'}</button></div>
      </div>
    </div>
  )
}

/**
 * 시험용 계정 PIN (수퍼 어드민만). 로그인 화면의 PIN 8자리 — 계정마다 하나씩, 비우면 기본 PIN.
 * 수퍼 어드민 본인의 PIN 도 여기서 바꾼다. 저장하면 다음 로그인부터 적용된다.
 */
function TestPins({ tname }) {
  const [open, setOpen] = useState(true) // 수퍼 어드민이 계정 화면을 열면 바로 보이게
  const [data, , refresh] = usePoll(() => (open ? api.admin.testPins() : Promise.resolve(null)), 30000, [open])
  const [def, setDef] = useState('')
  const [pins, setPins] = useState({}) // id → 입력값 ('' = 기본)
  const [msg, setMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const len = data?.pin_len || 8
  React.useEffect(() => { if (data && !dirty) { setDef(data.default || ''); const m = {}; for (const a of data.accounts || []) m[a.id] = a.custom ? a.pin : ''; setPins(m) } }, [data, dirty])
  const digits = (v) => v.replace(/\D/g, '').slice(0, len)
  const save = async () => {
    if (def.length !== len) { setMsg(`기본 PIN 은 숫자 ${len}자리여야 합니다`); return }
    for (const [id, v] of Object.entries(pins)) if (v && v.length !== len) { setMsg(`계정 PIN 은 숫자 ${len}자리이거나 비워야 합니다`); return }
    try { await api.admin.saveTestPins({ default: def, pins }); setDirty(false); setMsg('저장했습니다. 다음 로그인부터 적용됩니다.'); refresh?.() } catch (e) { setMsg('저장 실패: ' + e.message) }
  }
  if (!open) return <div className="adm-notice" style={{ justifyContent: 'space-between' }}><span>로그인 화면의 <b>시험용 계정 PIN</b>(8자리)을 계정마다 정할 수 있습니다. 수퍼 어드민 본인 PIN 도 여기서 바꿉니다.</span><button onClick={() => setOpen(true)}>PIN 설정 열기</button></div>
  return (
    <section className="adm-pins">
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>시험용 계정 PIN <small className="muted">로그인 화면 PIN 8자리 · 계정마다 하나 · 수퍼 어드민 본인 포함</small></h3>
        <label className="muted small">기본 PIN <input className="mono" style={{ width: 120 }} inputMode="numeric" maxLength={len} value={def} onChange={(e) => { setDef(digits(e.target.value)); setDirty(true) }} /></label>
        <span className="muted small">계정 칸을 비우면 기본 PIN 을 씁니다. 출고값 {data?.env_default}.</span>
        <span className="spacer" />
        <button className="primary" disabled={!dirty} onClick={save}>PIN 저장</button>
        {dirty && <button onClick={() => { setDirty(false); refresh?.() }}>되돌리기</button>}
        <button onClick={() => setOpen(false)}>닫기</button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
      <table className="tbl adm-tbl">
        <thead><tr><th>아이디</th><th>이름</th><th>역할</th><th>병원</th><th>PIN (비우면 기본)</th><th>적용 중</th></tr></thead>
        <tbody>
          {(data?.accounts || []).map((a) => (
            <tr key={a.id}>
              <td className="mono"><b>{a.username}</b>{a.me && <span className="tag small ok">나</span>}</td>
              <td>{a.name}</td>
              <td><span className={'role-tag r-' + a.role}>{a.role_label}</span></td>
              <td>{a.tenant_id ? `${a.tenant_id} · ${a.tenant_name || tname(a.tenant_id)}` : <span className="muted">플랫폼</span>}</td>
              <td><input className="mono" style={{ width: 130 }} inputMode="numeric" maxLength={len} placeholder={`기본 (${def || data?.default})`} value={pins[a.id] ?? ''} onChange={(e) => { setPins({ ...pins, [a.id]: digits(e.target.value) }); setDirty(true) }} /></td>
              <td className="mono">{pins[a.id] || def || data?.default}{!(pins[a.id]) && <span className="muted small"> (기본)</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
