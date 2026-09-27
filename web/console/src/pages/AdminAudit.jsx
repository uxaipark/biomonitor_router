import React, { useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { Pager, SummaryChips } from '../ListKit.jsx'

/** 동작 코드 → 표시 이름 · 묶음(칩) · 강조 */
const ACTION = {
  login: ['로그인', 'auth'], login_fail: ['로그인 실패', 'auth', 'warn'], logout: ['로그아웃', 'auth'],
  password_change: ['비밀번호 변경', 'account'], password_reset: ['비밀번호 초기화', 'account', 'warn'],
  user_create: ['계정 생성', 'account'], user_update: ['계정 수정', 'account'], test_pin: ['시험용 PIN 변경', 'account', 'warn'],
  tenant_create: ['병원 추가', 'account'], tenant_update: ['병원 수정', 'account'],
  permissions_save: ['권한 저장', 'account', 'warn'], dev_mode: ['개발 모드', 'ops', 'warn'],
  control_stop: ['서비스 멈춤', 'ops', 'warn'], control_start: ['서비스 다시 켬', 'ops'], full_reset: ['가동 초기화', 'ops', 'err'],
  wave_reset: ['파형 저장소 전체 삭제', 'ops', 'err'], backup_abort: ['백업 중단', 'ops', 'warn'], backup_purge: ['백업 파일 전체 삭제', 'ops', 'err'], backup_policy: ['저장·백업 정책 변경', 'ops'],
  emr_connection_create: ['EMR 연결 추가', 'ops'], emr_connection_update: ['EMR 연결 변경', 'ops'], emr_connection_delete: ['EMR 연결 삭제', 'ops', 'warn'],
  security_block: ['IP 차단', 'security', 'err'], security_unblock: ['IP 차단 해제', 'security'], security_settings: ['보안 설정 변경', 'security'], security_clear: ['보안 기록 삭제', 'security'],
}
const GROUP = { all: '전체', auth: '로그인', account: '계정·권한', ops: '운영', security: '보안', other: '기타' }
const label = (a) => ACTION[a]?.[0] || a
const group = (a) => ACTION[a]?.[1] || 'other'
const sev = (a) => ACTION[a]?.[2] || ''
const fmtAbs = (ms) => new Date(ms).toLocaleString('ko-KR', { hour12: false })
const ago = (ms) => { const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); if (s < 60) return `${s}초 전`; const m = Math.floor(s / 60); if (m < 60) return `${m}분 전`; const h = Math.floor(m / 60); if (h < 48) return `${h}시간 전`; return `${Math.floor(h / 24)}일 전` }
const PAGE = 50

/** 운영관리 › 감사 기록 — 로그인·계정·권한·운영·보안 기록 (병원 역할은 자기 병원 기록만). 최근 500건, 10초마다 갱신 */
export default function AdminAudit() {
  const [rows, err] = usePoll(() => api.admin.audit(500), 10000)
  const [grp, setGrp] = useState('')
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')
  const [who, setWho] = useState('')
  const [page, setPage] = useState(0)
  const all = rows || []
  const groups = useMemo(() => { const c = {}; for (const r of all) c[group(r.action)] = (c[group(r.action)] || 0) + 1; return c }, [all])
  const kinds = useMemo(() => { const c = new Map(); for (const r of all) if (!grp || group(r.action) === grp) c.set(r.action, (c.get(r.action) || 0) + 1); return [...c.entries()].sort((a, b) => b[1] - a[1]) }, [all, grp])
  const users = useMemo(() => [...new Set(all.map((r) => r.username))].sort(), [all])
  const list = useMemo(() => {
    const n = q.trim().toLowerCase()
    return all.filter((r) => (!grp || group(r.action) === grp) && (!kind || r.action === kind) && (!who || r.username === who)
      && (!n || [r.username, r.tenant, label(r.action), r.detail].some((x) => (x || '').toLowerCase().includes(n))))
  }, [all, grp, kind, who, q])
  const pages = Math.max(1, Math.ceil(list.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const shown = list.slice(cur * PAGE, cur * PAGE + PAGE)
  const reset = () => { setGrp(''); setKind(''); setWho(''); setQ(''); setPage(0) }
  const active = !!(grp || kind || who || q)
  // 날짜가 바뀌는 곳에 구분 줄
  let lastDay = ''
  return (
    <div className="page adm audit">
      <div className="adm-head">
        <h2 className="h">감사 기록</h2>
        <span className="muted small">최근 {all.length.toLocaleString()}건 · 10초마다 갱신 · 병원 역할은 자기 병원 기록만</span>
        <span className="spacer" />
        <span className="muted small">{list.length.toLocaleString()}건{active ? ' (조건 적용)' : ''}</span>
        <Pager page={cur} pages={pages} onPage={setPage} />
      </div>
      {err && <p className="err">{err.message}</p>}
      <SummaryChips items={[{ key: 'all', label: '전체', count: all.length }, ...Object.keys(GROUP).filter((g) => g !== 'all' && groups[g]).map((g) => ({ key: g, label: GROUP[g], count: groups[g], cls: g === 'security' ? 'err' : g === 'auth' && all.some((r) => r.action === 'login_fail') ? 'warn' : '' }))]}
        value={grp || 'all'} onChange={(v) => { setGrp(v === 'all' ? '' : v); setKind(''); setPage(0) }} unit="건" />
      <div className="audit-filter">
        <input className="audit-q" placeholder="검색: 계정 · 병원 · 동작 · 내용" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
        <select value={kind} onChange={(e) => { setKind(e.target.value); setPage(0) }}><option value="">모든 동작</option>{kinds.map(([k, n]) => <option key={k} value={k}>{label(k)} ({n})</option>)}</select>
        <select value={who} onChange={(e) => { setWho(e.target.value); setPage(0) }}><option value="">모든 계정</option>{users.map((u) => <option key={u} value={u}>{u}</option>)}</select>
        {active && <button className="ghost" onClick={reset}>조건 지우기 ✕</button>}
      </div>
      <table className="tbl audit-tbl">
        <thead><tr><th style={{ width: 150 }}>시각</th><th style={{ width: 150 }}>계정</th><th style={{ width: 90 }}>병원</th><th style={{ width: 170 }}>동작</th><th>내용</th></tr></thead>
        <tbody>
          {shown.map((r, i) => {
            const day = new Date(r.ts_ms).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })
            const sep = day !== lastDay; lastDay = day
            const sv = sev(r.action)
            return (
              <React.Fragment key={r.ts_ms + '-' + i}>
                {sep && <tr className="audit-day"><td colSpan="5">{day}</td></tr>}
                <tr className={sv ? 'is-' + sv : ''}>
                  <td className="muted" title={fmtAbs(r.ts_ms)}><span className="mono">{new Date(r.ts_ms).toLocaleTimeString('ko-KR', { hour12: false })}</span><small className="audit-ago">{ago(r.ts_ms)}</small></td>
                  <td className="mono"><a className="lk-link" onClick={() => { setWho(r.username); setPage(0) }} title="이 계정 기록만">{r.username}</a></td>
                  <td className="mono">{r.tenant || <span className="muted">플랫폼</span>}</td>
                  <td><span className={'audit-act ' + group(r.action) + (sv ? ' ' + sv : '')} onClick={() => { setKind(r.action); setPage(0) }} title="이 동작만">{label(r.action)}</span></td>
                  <td className="audit-detail" title={r.detail}>{r.detail || <span className="muted">—</span>}</td>
                </tr>
              </React.Fragment>)
          })}
          {!shown.length && <tr><td colSpan="5"><div className="sec-empty"><b>{active ? '조건에 맞는 기록이 없습니다.' : '기록이 없습니다.'}</b>{active && <span>조건을 지우면 전체 기록이 보입니다.</span>}</div></td></tr>}
        </tbody>
      </table>
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 8 }}><Pager page={cur} pages={pages} onPage={setPage} /></div>
    </div>
  )
}
