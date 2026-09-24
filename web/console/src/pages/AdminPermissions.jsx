import React, { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { useMe, LEVEL_LABEL } from '../auth.js'
import Dropdown from '../Dropdown.jsx'

/**
 * 관리 › 권한 설정 — 역할 × 메뉴·동작·데이터 매트릭스.
 *  - 권한 설정이 '편집'이면 자기보다 아래 역할만 고친다(자기·상위 역할 열은 보이지도 않거나 보기만).
 *  - 전역 표: 플랫폼 역할(수퍼 어드민 → 시스템 관리자 → 리셀러 → 영업)이 아래 역할을 정한다.
 *  - 병원별 표: 병원 역할(IT 매니저·의사·간호사·스태프)을 병원마다 덮어쓴다 — IT 매니저는 의사·간호사·스태프, 의사는 간호사·스태프.
 *  - 자기 권한보다 높게는 줄 수 없다(이미 그 값인 칸은 유지 가능).
 *  - 초기값 불러오기 = 코드의 기본 표, 이전 설정 불러오기 = 저장할 때마다 남는 판. 불러온 뒤 저장해야 적용된다.
 */
const LV_CLS = ['lv0', 'lv1', 'lv2']
/** 권한 표 구조: [섹션, [[메뉴 자원, [그 화면 안의 동작·데이터 자원…]], …]] — 톱 메뉴 순서와 같다 */
const TREE = [
  ['주요 메뉴', [
    ['page.ops', []],
    ['page.dashboard', ['data.system']],
    ['page.alarms', ['action.alarm_ack', 'action.alarm_rules']],
    ['page.events', []],
    ['page.patients', []],
    ['page.gateways', []],
    ['page.map', []],
    ['page.viewers', ['action.groups_edit']],
  ]],
  ['테스트', [['page.test', []], ['page.data_admin', ['action.wave_reset']]]],
  ['설정', [['page.settings_viewer', []], ['page.settings_biosignal', ['action.backup_purge']], ['page.settings_network', []], ['page.integration', []]]],
  ['관리', [['page.admin_users', []], ['page.admin_permissions', []], ['page.admin_tenants', []], ['page.admin_audit', []]]],
  ['데이터 (모든 화면 공통)', [['data.phi', []], ['data.biosignal', []]]],
]

export default function AdminPermissions() {
  const me = useMe()
  const [tenant, setTenant] = useState(me?.user?.tenant_id || me?.site?.tenant_id || '')
  const [view, setView] = useState(null)
  const [scope, setScope] = useState(null) // 'global' | 'tenant'
  const [draft, setDraft] = useState(null)
  const [versions, setVersions] = useState([])
  const [note, setNote] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = async (t = tenant) => {
    try {
      const v = await api.admin.perms(t)
      setView(v); setErr('')
      const sc = scope || (v.editable.global.length ? 'global' : 'tenant')
      setScope(sc)
      setDraft(baseOf(v, sc))
    } catch (e) { setErr(e.message) }
  }
  useEffect(() => { load() }, [tenant]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (view && scope) { setDraft(baseOf(view, scope)); api.admin.permVersions(scope, view.tenant).then(setVersions).catch(() => setVersions([])) } }, [scope, view])

  const editRoles = useMemo(() => (view && scope ? view.editable[scope] || [] : []), [view, scope])
  if (err) return <div className="page"><h2 className="h">권한 설정</h2><p className="err">{err}</p></div>
  if (!view || !draft) return <div className="page"><p className="muted">불러오는 중…</p></div>

  const base = baseOf(view, scope)
  const changed = diffCount(base, draft, editRoles)
  const groups = [...new Set(view.resources.map((r) => r.group))]
  const set = (role, res, lv) => setDraft((d) => ({ ...d, [role]: { ...d[role], [res]: lv } }))
  const cap = (res) => (me.user.role === 'super_admin' ? 2 : me.perms[res] ?? 0)
  const loadDefaults = () => {
    setDraft((d) => { const n = { ...d }; for (const r of editRoles) n[r] = { ...view.defaults[r] }; return n })
    setMsg('초기값을 불러왔습니다 — 저장해야 적용됩니다')
  }
  const loadVersion = (id) => {
    const v = versions.find((x) => String(x.id) === String(id))
    if (!v) return
    setDraft((d) => {
      const n = { ...d }
      // 판에는 그때 저장된 칸만 있다: 없는 칸은 전역/기본값
      const g = scope === 'tenant' ? view.global : view.defaults
      for (const r of editRoles) n[r] = { ...g[r], ...(v.matrix?.[r] || {}) }
      return n
    })
    setMsg(`${new Date(v.saved_ms).toLocaleString('ko-KR', { hour12: false })} (${v.saved_by}) 설정을 불러왔습니다 — 저장해야 적용됩니다`)
  }
  const save = async () => {
    setBusy(true); setMsg('')
    try {
      const matrix = Object.fromEntries(editRoles.map((r) => [r, draft[r]]))
      await api.admin.savePerms({ scope, tenant: view.tenant, matrix, note })
      setNote(''); setMsg('저장했습니다 — 해당 역할 사용자에게 바로 적용됩니다')
      await load()
    } catch (e) { setMsg('저장 실패: ' + e.message) } finally { setBusy(false) }
  }
  const tenantOpts = (view.tenants || []).map((t) => ({ value: t.id, label: `${t.id} · ${t.name}${t.is_site ? ' (이 라우터)' : ''}` }))

  // 메뉴 구조대로: 섹션 → 메뉴 → (하위) 그 화면의 동작·데이터 권한. 표에 없는 새 자원은 '기타'로.
  const known = new Map(view.resources.map((r) => [r.code, r]))
  const used = new Set()
  const tree = TREE.map(([title, items]) => [title, items.flatMap(([code, kids]) => [[code, 0], ...kids.map((c) => [c, 1])]).filter(([c]) => known.has(c) && !used.has(c) && used.add(c))])
    .concat([['기타', view.resources.filter((r) => !used.has(r.code)).map((r) => [r.code, 0])]])
    .filter(([, items]) => items.length)
  const resRow = (code, depth) => {
    const res = known.get(code)
    const label = depth ? res.label : res.label.replace(/^(테스트|설정|관리) › /, '')
    return (
      <tr key={code} className={depth ? 'perm-sub' : 'perm-top'}>
        <td className="perm-res">{depth ? <span className="perm-branch">└</span> : null}<b>{label}</b><small className="mono">{res.code}</small></td>
        {view.roles.map((role) => {
          const editable = editRoles.includes(role.code)
          const locked = role.code === 'super_admin'
          const lv = locked ? view.effective.super_admin[res.code] : editable ? draft[role.code]?.[res.code] ?? 0 : scope === 'tenant' ? view.effective[role.code][res.code] : draft[role.code]?.[res.code] ?? 0
          const was = base[role.code]?.[res.code] ?? 0
          const dirty = editable && lv !== was
          return (
            <td key={role.code} className={'perm-cell' + (dirty ? ' dirty' : '') + (editable ? ' ed' : '')}>
              {editable ? (
                <span className="lvseg">{[0, 1, 2].map((n) => (
                  <button key={n} className={(lv === n ? 'on ' : '') + LV_CLS[n]} disabled={n > cap(res.code)} onClick={() => set(role.code, res.code, n)} title={n > cap(res.code) ? '자기 권한보다 높게 줄 수 없습니다' : LEVEL_LABEL[n]}>{LEVEL_LABEL[n]}</button>
                ))}</span>
              ) : (
                <span className={'lvtag ' + LV_CLS[lv]} title={locked ? '개발 모드 동안 모든 권한' : '이 화면에서는 바꿀 수 없음'}>{LEVEL_LABEL[lv]}</span>
              )}
            </td>
          )
        })}
      </tr>
    )
  }
  return (
    <div className="page adm">
      <div className="adm-head">
        <h2 className="h">권한 설정</h2>
        <span className="seg">
          {view.editable.global.length > 0 && <button className={scope === 'global' ? 'active' : ''} onClick={() => setScope('global')}>전역 권한 (역할 기본)</button>}
          <button className={scope === 'tenant' ? 'active' : ''} onClick={() => setScope('tenant')}>병원별 권한</button>
        </span>
        {scope === 'tenant' && tenantOpts.length > 1 && <Dropdown value={view.tenant} options={tenantOpts} onChange={setTenant} searchable={false} width={300} />}
        <span className="spacer" />
        <DevMode me={me} view={view} onChange={load} />
      </div>
      <p className="muted adm-desc">
        {scope === 'global'
          ? '모든 병원에 공통으로 적용되는 역할별 권한입니다. 수퍼 어드민 열은 개발 모드 동안 모든 권한이 고정됩니다. 병원 역할(IT 매니저·의사·간호사·스태프)은 병원마다 따로 정할 수 있고, 그 값이 이 표보다 우선합니다.'
          : `이 병원(${view.tenant})의 병원 역할 권한입니다. 편집 권한이 있으면 자기보다 아래 역할(${editRoles.map((c) => view.roles.find((r) => r.code === c)?.label || c).join('·') || '없음'})만 고칠 수 있고, 자기 권한보다 높게 줄 수는 없습니다. 나머지 열은 보기만 합니다.`}
        {' '}<b>없음</b> = 메뉴·기능 숨김, <b>보기</b> = 읽기, <b>편집</b> = 바꾸기까지. 데이터 항목이 <b>없음</b>이면 개인정보는 가려지고(마스킹) 생체신호는 나오지 않습니다.
      </p>
      <div className="adm-bar">
        <button onClick={loadDefaults} disabled={!editRoles.length}>초기값 불러오기</button>
        <Dropdown value="" options={[{ value: '', label: versions.length ? `이전 설정 불러오기 (${versions.length}판)` : '이전 저장본 없음' }, ...versions.map((v) => ({ value: String(v.id), label: `${new Date(v.saved_ms).toLocaleString('ko-KR', { hour12: false })} · ${v.saved_by}${v.note ? ' · ' + v.note : ''}` }))]} onChange={loadVersion} searchable={false} width={360} />
        <button onClick={() => { setDraft(base); setMsg('') }} disabled={!changed}>되돌리기</button>
        <input className="adm-note" placeholder="변경 메모 (선택)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="primary" onClick={save} disabled={!changed || busy || !editRoles.length}>저장{changed ? ` (${changed}칸)` : ''}</button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <div className="perm-wrap">
        <table className="perm">
          <thead>
            <tr>
              <th className="perm-res">메뉴 · 기능</th>
              {view.roles.map((r) => (
                <th key={r.code} className={(editRoles.includes(r.code) ? 'ed ' : '') + (r.platform ? 'pf' : 'hs')}>
                  <span>{r.label}</span><small>{r.platform ? '플랫폼' : '병원'}{editRoles.includes(r.code) ? ' · 편집' : ''}</small>
                </th>
              ))}
            </tr>
          </thead>
          {tree.map(([title, items]) => (
            <tbody key={title}>
              <tr className="perm-group"><td colSpan={view.roles.length + 1}>{title}</td></tr>
              {items.map(([code, depth]) => resRow(code, depth))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  )
}

function DevMode({ me, view, onChange }) {
  const [busy, setBusy] = useState(false)
  const sa = me.user.role === 'super_admin'
  const toggle = async () => {
    const on = !view.dev_mode
    if (!on && !window.confirm('개발 모드를 끄면 수퍼 어드민도 개인정보·생체신호가 가려지고, 로그인 화면의 시험용 계정·임시 비밀번호 표시가 사라집니다. 계속할까요?')) return
    setBusy(true)
    try { await api.admin.devMode(on); window.location.reload() } catch (e) { alert(e.message) } finally { setBusy(false); onChange() }
  }
  return (
    <span className={'dev-pill' + (view.dev_mode ? ' on' : '')}>
      개발 모드 {view.dev_mode ? '켜짐 — 수퍼 어드민 전체 권한' : '꺼짐'}
      {sa && <button onClick={toggle} disabled={busy}>{view.dev_mode ? '끄기' : '켜기'}</button>}
    </span>
  )
}

function baseOf(view, scope) {
  // global: 저장된 전역(기본 위에) · tenant: 전역 위에 병원 덮어쓰기
  const g = view.global
  if (scope !== 'tenant') return clone(g)
  const out = clone(g)
  for (const [role, row] of Object.entries(view.tenant_overrides || {})) out[role] = { ...out[role], ...row }
  return out
}
function clone(m) { return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { ...v }])) }
function diffCount(a, b, roles) {
  let n = 0
  for (const r of roles) for (const [res, lv] of Object.entries(b[r] || {})) if ((a[r]?.[res] ?? 0) !== lv) n++
  return n
}
