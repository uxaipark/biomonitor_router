import React, { useState } from 'react'
import { api, usePoll } from '../api.js'

/**
 * 관리 › 병원(테넌트). 병원마다 데이터가 완전히 분리된다: 한 라우터는 한 병원(★)의 데이터만 받고,
 * 다른 병원 계정은 이 라우터의 환자·파형·알람을 한 건도 볼 수 없다(서버가 모든 요청에서 확인).
 * 리셀러는 담당 병원만 보고 만들 수 있고, CRM 영업은 담당 병원 정보만 읽는다.
 */
export default function AdminTenants() {
  const [data, err, refresh] = usePoll(api.admin.tenants, 15000)
  const [edit, setEdit] = useState(null)
  const list = data?.tenants || []
  return (
    <div className="page adm">
      <div className="adm-head">
        <h2 className="h">병원 (테넌트)</h2>
        <span className="muted">{list.length}곳 · ★ = 이 라우터가 데이터를 받는 병원</span>
        <span className="spacer" />
        {data?.can_create && <button className="primary" onClick={() => setEdit({ active: true, kind: 'hospital' })}>+ 병원 추가</button>}
      </div>
      {err && <p className="err">{err.message}</p>}
      <p className="muted adm-desc">
        계정은 소속 병원이 정해져 있고(플랫폼 역할 제외), 요청마다 서버가 병원을 확인합니다. 클라우드로 여러 병원을 모을 때도 병원 ID 가 데이터·계정·권한의 경계가 됩니다.
      </p>
      <table className="tbl adm-tbl">
        <thead><tr><th>ID</th><th>병원 이름</th><th>지역</th><th>연락처</th><th>담당 리셀러</th><th className="num">계정</th><th>상태</th><th /></tr></thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id} className={t.active ? '' : 'stale'}>
              <td className="mono"><b>{t.id}</b>{t.is_site && <span className="tag small ok" title="이 라우터의 병원">★ 이 라우터</span>}</td>
              <td><b>{t.name}</b></td>
              <td>{t.region || <span className="muted">—</span>}</td>
              <td>{t.contact || <span className="muted">—</span>}</td>
              <td className="mono">{t.reseller || <span className="muted">—</span>}</td>
              <td className="num">{t.users}</td>
              <td>{t.active ? <span className="tag ok small">운영</span> : <span className="tag err small">중지</span>}</td>
              <td className="acts">{data?.can_edit && <button onClick={() => setEdit(t)}>수정</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && <TenantForm t={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.() }} />}
    </div>
  )
}

function TenantForm({ t, onClose, onSaved }) {
  const isNew = !t.id || !t.created_ms
  const [f, setF] = useState({ id: t.id || '', name: t.name || '', kind: t.kind || 'hospital', region: t.region || '', contact: t.contact || '', reseller: t.reseller || '', active: t.active ?? true })
  const [err, setErr] = useState('')
  const save = async () => {
    setErr('')
    try { if (isNew) await api.admin.createTenant(f); else await api.admin.updateTenant(t.id, f); onSaved() } catch (e) { setErr(e.message) }
  }
  const field = (k, label, ph) => <label>{label}<input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} disabled={k === 'id' && !isNew} /></label>
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal adm-form" onClick={(e) => e.stopPropagation()}>
        <h3>{isNew ? '병원 추가' : `병원 수정 · ${t.id}`}</h3>
        {field('id', '병원 ID', '예: H003 (영문·숫자, 바꿀 수 없음)')}
        {field('name', '병원 이름', '예: 서울 중앙병원')}
        {field('region', '지역', '예: 서울')}
        {field('contact', '연락처', '담당 부서·전화')}
        {field('reseller', '담당 리셀러 계정', '예: reseller1')}
        <label className="chk"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> 운영 중</label>
        {err && <p className="err">{err}</p>}
        <div className="toolbar"><span className="spacer" /><button onClick={onClose}>취소</button><button className="primary" onClick={save}>{isNew ? '추가' : '저장'}</button></div>
      </div>
    </div>
  )
}
