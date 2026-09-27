import React, { useState } from 'react'
import { api, usePoll, fmtNum } from '../api.js'
import { can, useMe } from '../auth.js'

/**
 * 운영관리 › 보안 운영 — 무단 스캐닝 IP 차단, 로그인 실패 IP 차단.
 * - 스캐닝: 콘솔·API·WS 가 아닌 경로, 공격 서명(경로 조작·인젝션·웹 취약점 탐색), 9100 포트의 엉뚱한 바이트를 IP 마다
 *   분류(서브그룹)별로 모아 보여 준다. 공격·침투 목적 분류는 즉시, 미상 경로는 창 안 횟수가 한도에 닿으면 자동 차단.
 * - 로그인 실패: 같은 IP 에서 기간(기본 30일) 안 한도(기본 10번)면 차단. PIN·비밀번호·계정 불일치 모두 1건, 성공 1번이면 목록 삭제.
 * - 차단 IP 는 HTTP 403, 게이트웨이 포트는 접속 즉시 끊김. 루프백·신뢰 IP 는 차단하지 않는다.
 */
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
const left = (u, now) => { if (!u) return '수동 해제까지'; const s = Math.max(0, Math.round((u - now) / 1000)); const h = Math.floor(s / 3600); return h >= 48 ? `${Math.floor(h / 24)}일 뒤` : h >= 1 ? `${h}시간 ${Math.floor((s % 3600) / 60)}분 뒤` : `${Math.floor(s / 60)}분 뒤` }
const KIND = { login: '로그인 실패', scan: '스캐닝', manual: '수동' }
const FAIL_KIND = { pin: 'PIN', credential: '비밀번호·계정', locked: '잠금 중 시도' }
const HOURS = [[24, '24시간'], [72, '3일'], [168, '7일'], [720, '30일'], [0, '수동 해제까지']]

export default function AdminSecurity() {
  const me = useMe()
  const edit = can(me, 'page.security', 2)
  const [d, err, refresh] = usePoll(api.security.get, 5000)
  const [msg, setMsg] = useState('')
  const run = async (fn, ok) => { try { await fn(); setMsg(ok || ''); refresh?.() } catch (e) { setMsg(e.message) } }
  if (err) return <div className="page"><h2 className="h">보안 운영</h2><p className="err">{err.message}</p></div>
  if (!d) return <div className="page"><p className="muted">불러오는 중…</p></div>
  const s = d.settings || {}
  const now = d.now_ms || Date.now()
  return (
    <div className="page sec">
      <div className="toolbar">
        <h2 className="h" style={{ margin: 0 }}>보안 운영</h2>
        <span className={'pill ' + (d.blocked.length ? 'warn' : 'ok')}>차단 {d.blocked.length}</span>
        <span className="muted small">무단 스캐닝 IP 와 로그인 실패 IP 를 자동으로 차단합니다. 차단된 IP 는 콘솔·API(403)와 게이트웨이 포트(즉시 끊김) 모두 막힙니다. 루프백·신뢰 IP 는 차단하지 않습니다.</span>
        {msg && <span className="muted small">· {msg}</span>}
      </div>
      <div className="tiles">
        <div className={'tile' + (d.blocked.length ? ' warn' : '')}><div className="tile-label">차단 중인 IP</div><div className="tile-value">{d.blocked.length}</div><div className="tile-sub">로그인 실패 {d.blocked.filter((b) => b.kind === 'login').length} · 스캐닝 {d.blocked.filter((b) => b.kind === 'scan').length} · 수동 {d.blocked.filter((b) => b.kind === 'manual').length}</div></div>
        <div className="tile"><div className="tile-label">로그인 실패 추적</div><div className="tile-value">{d.login_fails.length}<small> IP</small></div><div className="tile-sub">{s.login_window_days}일 안 {s.login_fail_limit}번이면 차단 · {s.auto_block_login ? '자동 차단 켬' : '자동 차단 끔'}</div></div>
        <div className={'tile' + (d.scans.some((x) => x.attack && !x.blocked && !x.trusted) ? ' err' : '')}><div className="tile-label">무단 스캐닝 (7일)</div><div className="tile-value">{d.scans.length}<small> IP</small></div><div className="tile-sub">공격 서명 {d.scans.filter((x) => x.attack).length} IP · 시도 {fmtNum(d.scans.reduce((a, x) => a + x.count, 0))}건 · {s.auto_block_scan ? '자동 차단 켬' : '자동 차단 끔'}</div></div>
        <div className="tile"><div className="tile-label">신뢰 IP</div><div className="tile-value">{(s.trusted || []).length}</div><div className="tile-sub">{(s.trusted || []).slice(0, 3).join(', ') || '없음 (루프백은 항상 신뢰)'}</div></div>
      </div>

      <Blocked d={d} now={now} edit={edit} run={run} />
      <LoginFails d={d} edit={edit} run={run} />
      <Scans d={d} edit={edit} run={run} />
      <SettingsCard s={s} edit={edit} run={run} />
    </div>
  )
}

function Blocked({ d, now, edit, run }) {
  const [ip, setIp] = useState('')
  const [reason, setReason] = useState('')
  const [hours, setHours] = useState(720)
  const block = () => { if (!ip.trim()) return; run(() => api.security.block({ ip: ip.trim(), reason, hours }), `${ip.trim()} 차단`).then(() => { setIp(''); setReason('') }) }
  return (
    <section className="sec-card">
      <div className="toolbar"><h3 style={{ margin: 0 }}>차단 목록 <small className="muted">{d.blocked.length}개</small></h3>
        <span className="spacer" />
        {edit && <div className="ctl-form">
          <input className="mono" style={{ width: 150 }} placeholder="IP 직접 차단" value={ip} onChange={(e) => setIp(e.target.value)} />
          <input style={{ width: 200 }} placeholder="사유" value={reason} onChange={(e) => setReason(e.target.value)} />
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>{HOURS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <button className="danger" onClick={block} disabled={!ip.trim()}>차단</button>
        </div>}
      </div>
      {!d.blocked.length ? <p className="muted small">차단된 IP 가 없습니다.</p> : (
        <table className="tbl">
          <thead><tr><th>IP</th><th>종류</th><th>사유</th><th>내용</th><th>차단 시각</th><th>해제</th><th>누가</th><th /></tr></thead>
          <tbody>{d.blocked.map((b) => (
            <tr key={b.ip}>
              <td className="mono"><b>{b.ip}</b></td>
              <td><span className={'tag small ' + (b.kind === 'scan' ? 'err' : b.kind === 'login' ? 'warn' : '')}>{KIND[b.kind] || b.kind}</span></td>
              <td>{b.reason}</td><td className="mono small" title={b.detail}>{(b.detail || '').slice(0, 60)}</td>
              <td className="small">{fmt(b.created_ms)}</td><td className="small">{left(b.until_ms, now)}{b.until_ms ? <span className="muted"> ({fmt(b.until_ms)})</span> : ''}</td><td className="small">{b.by}</td>
              <td>{edit && <button onClick={() => window.confirm(`${b.ip} 차단을 해제할까요?`) && run(() => api.security.unblock(b.ip), `${b.ip} 해제`)}>해제</button>}</td>
            </tr>))}
          </tbody>
        </table>)}
    </section>
  )
}

function LoginFails({ d, edit, run }) {
  const s = d.settings
  return (
    <section className="sec-card">
      <div className="toolbar"><h3 style={{ margin: 0 }}>로그인 실패 IP <small className="muted">{s.login_window_days}일 안 {s.login_fail_limit}번이면 차단 · PIN·비밀번호·계정 불일치 모두 1건 · 성공 1번이면 그 IP 목록 삭제</small></h3>
        <span className="spacer" />
        {edit && d.login_fails.length > 0 && <button onClick={() => window.confirm('로그인 실패 목록을 모두 지울까요? (차단은 유지)') && run(() => api.security.clear({ what: 'login' }), '로그인 실패 목록 삭제')}>전체 지우기</button>}
      </div>
      {!d.login_fails.length ? <p className="muted small">추적 중인 IP 가 없습니다.</p> : (
        <table className="tbl">
          <thead><tr><th>IP</th><th>실패</th><th>종류</th><th>시도한 계정</th><th>처음</th><th>마지막</th><th>상태</th><th /></tr></thead>
          <tbody>{d.login_fails.map((f) => (
            <tr key={f.ip} className={f.count >= f.limit ? 'warn-row' : ''}>
              <td className="mono"><b>{f.ip}</b></td>
              <td className="num"><b>{f.count}</b><span className="muted"> / {f.limit}</span></td>
              <td className="small">{Object.entries(f.kinds || {}).map(([k, n]) => `${FAIL_KIND[k] || k} ${n}`).join(' · ')}</td>
              <td className="small mono">{(f.accounts || []).slice(0, 6).map((a) => `${a.account}×${a.count}`).join(', ')}{(f.accounts || []).length > 6 ? ` 외 ${f.accounts.length - 6}` : ''}</td>
              <td className="small">{fmt(f.first_ms)}</td><td className="small">{fmt(f.last_ms)}</td>
              <td>{f.blocked ? <span className="tag small warn">차단됨</span> : f.trusted ? <span className="tag small">신뢰 IP</span> : <span className="tag small">감시</span>}</td>
              <td className="ctl-form">{edit && !f.blocked && !f.trusted && <button className="danger" onClick={() => run(() => api.security.block({ ip: f.ip, reason: `로그인 실패 ${f.count}회 (수동)`, hours: s.login_block_hours }), `${f.ip} 차단`)}>지금 차단</button>}{edit && <button onClick={() => run(() => api.security.clear({ ip: f.ip, what: 'login' }), `${f.ip} 목록 삭제`)}>지우기</button>}</td>
            </tr>))}
          </tbody>
        </table>)}
    </section>
  )
}

function Scans({ d, edit, run }) {
  const [open, setOpen] = useState(null)
  const s = d.settings
  return (
    <section className="sec-card">
      <div className="toolbar"><h3 style={{ margin: 0 }}>무단 스캐닝 IP <small className="muted">공격·침투 목적 분류({(d.categories?.attack || []).join(' · ')})는 즉시 차단 · 미상 경로 등은 {s.scan_unknown_window_min}분 안 {s.scan_unknown_limit}회면 차단 · 7일 보관</small></h3>
        <span className="spacer" />
        {edit && d.scans.length > 0 && <button onClick={() => window.confirm('스캐닝 기록을 모두 지울까요? (차단은 유지)') && run(() => api.security.clear({ what: 'scan' }), '스캐닝 기록 삭제')}>전체 지우기</button>}
      </div>
      {!d.scans.length ? <p className="muted small">기록된 스캐닝이 없습니다.</p> : (
        <table className="tbl">
          <thead><tr><th /><th>IP</th><th>횟수</th><th>분류 (서브그룹)</th><th>처음</th><th>마지막</th><th>상태</th><th /></tr></thead>
          <tbody>{d.scans.map((x) => (
            <React.Fragment key={x.ip}>
              <tr className={x.attack && !x.blocked ? 'warn-row' : ''}>
                <td><button className="icon" onClick={() => setOpen(open === x.ip ? null : x.ip)} title="자세히">{open === x.ip ? '▾' : '▸'}</button></td>
                <td className="mono"><b>{x.ip}</b></td>
                <td className="num"><b>{fmtNum(x.count)}</b>{x.recent ? <span className="muted small"> · 최근 창 {x.recent}</span> : ''}</td>
                <td className="small">{x.groups.map((g) => <span key={g.category} className={'tag small ' + (g.attack ? 'err' : '')} style={{ marginRight: 4 }}>{g.category} {g.count}</span>)}</td>
                <td className="small">{fmt(x.first_ms)}</td><td className="small">{fmt(x.last_ms)}</td>
                <td>{x.blocked ? <span className="tag small warn">차단됨</span> : x.trusted ? <span className="tag small">신뢰 IP</span> : x.attack ? <span className="tag small err">공격 서명</span> : <span className="tag small">감시</span>}</td>
                <td className="ctl-form">{edit && !x.blocked && !x.trusted && <button className="danger" onClick={() => run(() => api.security.block({ ip: x.ip, reason: '무단 스캐닝 (수동)', hours: s.scan_block_hours }), `${x.ip} 차단`)}>차단</button>}{edit && <button onClick={() => run(() => api.security.clear({ ip: x.ip, what: 'scan' }), `${x.ip} 기록 삭제`)}>지우기</button>}</td>
              </tr>
              {open === x.ip && <tr className="sec-sub"><td /><td colSpan={7}>
                <table className="tbl small">
                  <thead><tr><th>분류</th><th>횟수</th><th>마지막</th><th>예시 (최근 5개)</th></tr></thead>
                  <tbody>{x.groups.map((g) => <tr key={g.category}><td><span className={'tag small ' + (g.attack ? 'err' : '')}>{g.category}</span>{g.attack && <span className="muted"> 즉시 차단 대상</span>}</td><td className="num">{fmtNum(g.count)}</td><td>{fmt(g.last_ms)}</td><td className="mono">{g.samples.map((p, i) => <div key={i}>{p}</div>)}</td></tr>)}</tbody>
                </table>
              </td></tr>}
            </React.Fragment>))}
          </tbody>
        </table>)}
    </section>
  )
}

function SettingsCard({ s, edit, run }) {
  const [f, setF] = useState(null)
  const v = f || { ...s, trusted_text: (s.trusted || []).join('\n') }
  const set = (k, val) => setF({ ...v, [k]: val })
  const num = (k, w = 90) => <input type="number" style={{ width: w }} value={v[k] ?? 0} onChange={(e) => set(k, Math.max(0, parseInt(e.target.value || '0', 10)))} disabled={!edit} />
  const save = () => run(() => api.security.saveSettings({ ...v, trusted: v.trusted_text.split(/\n|,/).map((x) => x.trim()).filter(Boolean) }), '설정 저장').then(() => setF(null))
  return (
    <section className="sec-card">
      <h3 style={{ marginTop: 0 }}>설정</h3>
      <div className="bk-form">
        <label>로그인 실패 차단</label>
        <div><label className="chk"><input type="checkbox" checked={!!v.auto_block_login} onChange={(e) => set('auto_block_login', e.target.checked)} disabled={!edit} /> 자동 차단</label>
          {num('login_window_days', 70)} 일 안에 {num('login_fail_limit', 70)} 번 실패하면 {num('login_block_hours')} 시간 차단 <span className="muted">(0 = 수동 해제까지)</span></div>
        <label>스캐닝 차단</label>
        <div><label className="chk"><input type="checkbox" checked={!!v.auto_block_scan} onChange={(e) => set('auto_block_scan', e.target.checked)} disabled={!edit} /> 자동 차단</label>
          공격 서명은 즉시, 미상 경로·API 탐색·포트 탐색은 {num('scan_unknown_window_min', 70)} 분 안 {num('scan_unknown_limit', 70)} 회면 · 차단 {num('scan_block_hours')} 시간 <span className="muted">(0 = 수동 해제까지)</span></div>
        <label>신뢰 IP</label>
        <div><textarea rows={3} style={{ width: '100%', maxWidth: 520 }} className="mono" value={v.trusted_text} onChange={(e) => set('trusted_text', e.target.value)} disabled={!edit} placeholder={'한 줄에 하나 — 192.168.0.10 또는 10.0.0.0/8'} />
          <div className="muted small">절대 차단하지 않는 IP·대역. 관리자 PC 와 에뮬레이터를 넣어 두면 실수로 잠기지 않습니다. 루프백(127.0.0.1)은 항상 신뢰.</div></div>
      </div>
      {edit && <div className="toolbar" style={{ marginTop: 8 }}><button className="primary" disabled={!f} onClick={save}>설정 저장</button>{f && <button onClick={() => setF(null)}>되돌리기</button>}</div>}
    </section>
  )
}
