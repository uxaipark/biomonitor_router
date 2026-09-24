import React, { useState } from 'react'
import { api, usePoll } from '../api.js'

const ACTION = {
  login: '로그인', login_fail: '로그인 실패', logout: '로그아웃', password_change: '비밀번호 변경', password_reset: '비밀번호 초기화',
  user_create: '계정 생성', user_update: '계정 수정', tenant_create: '병원 추가', tenant_update: '병원 수정',
  permissions_save: '권한 저장', dev_mode: '개발 모드',
  emr_connection_create: 'EMR 연결 추가', emr_connection_update: 'EMR 연결 변경', emr_connection_delete: 'EMR 연결 삭제',
}

/** 관리 › 감사 기록 — 로그인·계정·권한 변경 기록 (병원 역할은 자기 병원 기록만) */
export default function AdminAudit() {
  const [rows, err] = usePoll(() => api.admin.audit(500), 10000)
  const [kind, setKind] = useState('')
  const list = (rows || []).filter((r) => !kind || r.action === kind)
  const kinds = [...new Set((rows || []).map((r) => r.action))]
  return (
    <div className="page adm">
      <div className="adm-head">
        <h2 className="h">감사 기록</h2>
        <span className="seg wrap"><button className={!kind ? 'active' : ''} onClick={() => setKind('')}>전체</button>{kinds.map((k) => <button key={k} className={kind === k ? 'active' : ''} onClick={() => setKind(k)}>{ACTION[k] || k}</button>)}</span>
      </div>
      {err && <p className="err">{err.message}</p>}
      <table className="tbl adm-tbl">
        <thead><tr><th>시각</th><th>계정</th><th>병원</th><th>동작</th><th>내용</th></tr></thead>
        <tbody>
          {list.map((r, i) => (
            <tr key={i} className={r.action === 'login_fail' ? 'sev-high' : ''}>
              <td className="muted">{new Date(r.ts_ms).toLocaleString('ko-KR', { hour12: false })}</td>
              <td className="mono">{r.username}</td>
              <td className="mono">{r.tenant || <span className="muted">플랫폼</span>}</td>
              <td>{ACTION[r.action] || r.action}</td>
              <td>{r.detail}</td>
            </tr>
          ))}
          {!list.length && <tr><td colSpan="5" className="muted">기록이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
