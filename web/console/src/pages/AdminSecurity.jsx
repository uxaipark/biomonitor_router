import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtNum } from '../api.js'
import { can, useMe } from '../auth.js'

/**
 * 운영관리 › 보안 운영 — 무단 스캐닝 IP 차단, 로그인 실패 IP 차단.
 * - 스캐닝: 콘솔·API·WS 가 아닌 경로, 공격 서명(경로 조작·인젝션·웹 취약점 탐색), 9100 포트의 엉뚱한 바이트를 IP 마다
 *   분류(서브그룹)별로 모아 보여 준다. 공격·침투 목적 분류는 즉시, 미상 경로는 창 안 횟수가 한도에 닿으면 자동 차단.
 * - 로그인 실패: 같은 IP 에서 기간(기본 30일) 안 한도(기본 10번)면 차단. PIN·비밀번호·계정 불일치 모두 1건, 성공 1번이면 목록 삭제.
 * - 차단 IP 는 HTTP 403, 게이트웨이 포트는 접속 즉시 끊김. 루프백·신뢰 IP 는 차단하지 않는다.
 * 화면: 요약 타일 → IP 검색 → 차단 목록 / 로그인 실패 / 스캐닝 (각각 빈 상태·상대 시간·행 동작), 설정은 ⚙ 모달.
 */
const fmtAbs = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—')
const ago = (ms, now) => { if (!ms) return '—'; const s = Math.max(0, Math.round((now - ms) / 1000)); if (s < 60) return `${s}초 전`; const m = Math.floor(s / 60); if (m < 60) return `${m}분 전`; const h = Math.floor(m / 60); if (h < 48) return `${h}시간 전`; return `${Math.floor(h / 24)}일 전` }
const left = (u, now) => { if (!u) return '수동 해제까지'; const s = Math.max(0, Math.round((u - now) / 1000)); const h = Math.floor(s / 3600); return h >= 48 ? `${Math.floor(h / 24)}일 남음` : h >= 1 ? `${h}시간 ${Math.floor((s % 3600) / 60)}분 남음` : `${Math.floor(s / 60)}분 남음` }
const KIND = { login: '로그인 실패', scan: '스캐닝', manual: '수동' }
const FAIL_KIND = { pin: 'PIN', credential: '비밀번호·계정', locked: '잠금 중 시도' }
const HOURS = [[24, '24시간'], [72, '3일'], [168, '7일'], [720, '30일'], [0, '수동 해제까지']]
const T = ({ ms, now }) => <span title={fmtAbs(ms)}>{ago(ms, now)}</span>

export default function AdminSecurity() {
  const me = useMe()
  const edit = can(me, 'page.security', 2)
  const [d, err, refresh] = usePoll(api.security.get, 5000)
  const [msg, setMsg] = useState(null) // { kind: 'ok'|'err', text }
  const [cfg, setCfg] = useState(false)
  const [blockDlg, setBlockDlg] = useState(null) // { ip, reason, hours }
  const [q, setQ] = useState('')
  const run = async (fn, ok) => { try { await fn(); setMsg(ok ? { kind: 'ok', text: ok } : null); refresh?.() } catch (e) { setMsg({ kind: 'err', text: e.message }) } }
  const hit = (ip) => !q.trim() || ip.includes(q.trim())
  if (err) return <div className="page"><h2 className="h">보안 운영</h2><p className="err">{err.message}</p></div>
  if (!d) return <div className="page"><p className="muted">불러오는 중…</p></div>
  const s = d.settings || {}
  const now = d.now_ms || Date.now()
  const blocked = d.blocked.filter((b) => hit(b.ip))
  const fails = d.login_fails.filter((f) => hit(f.ip))
  const scans = d.scans.filter((x) => hit(x.ip))
  const attackOpen = d.scans.filter((x) => x.attack && !x.blocked && !x.trusted).length
  return (
    <div className="page sec">
      <div className="sec-head">
        <div>
          <h2 className="h" style={{ margin: 0 }}>보안 운영</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>무단 스캐닝·로그인 실패 IP 를 자동 차단합니다. 차단 IP 는 콘솔·API·게이트웨이 포트가 모두 막히며 루프백과 신뢰 IP 는 예외입니다.</p>
        </div>
        <div className="sec-head-actions">
          <input className="mono sec-search" placeholder="IP 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          {edit && <button className="danger" onClick={() => setBlockDlg({ ip: q.trim(), reason: '', hours: 720 })}>+ IP 차단</button>}
          <button className="icon sec-gear" onClick={() => setCfg(true)} title="보안 운영 설정" aria-label="설정">⚙</button>
        </div>
      </div>
      {msg && <div className={'sec-toast ' + msg.kind}><span>{msg.text}</span><button className="icon" onClick={() => setMsg(null)}>✕</button></div>}

      <div className="tiles sec-tiles">
        <div className={'tile' + (d.blocked.length ? ' warn' : '')}><div className="tile-label">차단 중인 IP</div><div className="tile-value">{d.blocked.length}</div><div className="tile-sub">로그인 실패 {d.blocked.filter((b) => b.kind === 'login').length} · 스캐닝 {d.blocked.filter((b) => b.kind === 'scan').length} · 수동 {d.blocked.filter((b) => b.kind === 'manual').length}</div></div>
        <div className={'tile' + (d.login_fails.some((f) => f.count >= f.limit - 2 && !f.blocked) ? ' warn' : '')}><div className="tile-label">로그인 실패 추적</div><div className="tile-value">{d.login_fails.length}<small> IP</small></div><div className="tile-sub">{s.login_window_days}일 안 {s.login_fail_limit}회면 차단 · 자동 차단 {s.auto_block_login ? '켬' : '끔'}</div></div>
        <div className={'tile' + (attackOpen ? ' err' : '')}><div className="tile-label">무단 스캐닝 (7일)</div><div className="tile-value">{d.scans.length}<small> IP</small></div><div className="tile-sub">공격 서명 {d.scans.filter((x) => x.attack).length} IP{attackOpen ? ` (미차단 ${attackOpen})` : ''} · 시도 {fmtNum(d.scans.reduce((a, x) => a + x.count, 0))}건 · 자동 차단 {s.auto_block_scan ? '켬' : '끔'}</div></div>
        <div className="tile"><div className="tile-label">신뢰 IP</div><div className="tile-value">{(s.trusted || []).length}</div><div className="tile-sub">{(s.trusted || []).slice(0, 3).join(', ') || '없음 — 루프백은 항상 신뢰'}{(s.trusted || []).length > 3 ? ` 외 ${s.trusted.length - 3}` : ''}</div></div>
      </div>

      <Section title="차단 목록" count={blocked.length} total={d.blocked.length} q={q}
        empty="차단된 IP 가 없습니다." emptyHint="자동 차단이 켜져 있으면 조건에 닿는 IP 가 여기에 나타납니다. 우측 상단 '+ IP 차단' 으로 직접 차단할 수도 있습니다.">
        {blocked.length > 0 && <table className="tbl sec-tbl">
          <thead><tr><th>IP</th><th>종류</th><th>사유</th><th>차단</th><th>해제</th><th>누가</th><th className="act" /></tr></thead>
          <tbody>{blocked.map((b) => (
            <tr key={b.ip}>
              <td className="mono ip"><b>{b.ip}</b></td>
              <td><span className={'tag small ' + (b.kind === 'scan' ? 'err' : b.kind === 'login' ? 'warn' : '')}>{KIND[b.kind] || b.kind}</span></td>
              <td><div>{b.reason}</div>{b.detail && <div className="muted small mono ellip" title={b.detail}>{b.detail}</div>}</td>
              <td className="small"><T ms={b.created_ms} now={now} /></td>
              <td className="small">{b.until_ms ? <span title={fmtAbs(b.until_ms)}>{left(b.until_ms, now)}</span> : <span className="muted">수동 해제까지</span>}</td>
              <td className="small">{b.by}</td>
              <td className="act">{edit && <button onClick={() => window.confirm(`${b.ip} 차단을 해제할까요?`) && run(() => api.security.unblock(b.ip), `${b.ip} 차단을 해제했습니다`)}>해제</button>}</td>
            </tr>))}
          </tbody>
        </table>}
      </Section>

      <Section title="로그인 실패 IP" count={fails.length} total={d.login_fails.length} q={q}
        sub={`${s.login_window_days}일 안 ${s.login_fail_limit}회면 차단 · PIN·비밀번호·계정 불일치 모두 1회 · 성공 1회면 그 IP 목록 삭제`}
        right={edit && d.login_fails.length > 0 && <button onClick={() => window.confirm('로그인 실패 목록을 모두 지울까요? (차단은 유지됩니다)') && run(() => api.security.clear({ what: 'login' }), '로그인 실패 목록을 지웠습니다')}>전체 지우기</button>}
        empty="추적 중인 IP 가 없습니다." emptyHint="로그인에 실패한 IP 가 기간 안에 여기 쌓이고, 한도에 닿으면 차단됩니다.">
        {fails.length > 0 && <table className="tbl sec-tbl">
          <thead><tr><th>IP</th><th style={{ width: 180 }}>실패 / 한도</th><th>종류</th><th>시도한 계정</th><th>마지막</th><th>상태</th><th className="act" /></tr></thead>
          <tbody>{fails.map((f) => {
            const pct = Math.min(100, Math.round(f.count / f.limit * 100))
            return (
              <tr key={f.ip} className={f.count >= f.limit ? 'is-warn' : ''}>
                <td className="mono ip"><b>{f.ip}</b></td>
                <td><div className="sec-bar" title={`${f.count} / ${f.limit}`}><div className={'sec-bar-fill' + (pct >= 80 ? ' hot' : '')} style={{ width: `${pct}%` }} /><span>{f.count} / {f.limit}</span></div></td>
                <td className="small">{Object.entries(f.kinds || {}).map(([k, n]) => <span key={k} className="tag small" style={{ marginRight: 4 }}>{FAIL_KIND[k] || k} {n}</span>)}</td>
                <td className="small"><div className="sec-chips">{(f.accounts || []).slice(0, 5).map((a) => <span key={a.account} className="sec-chip mono">{a.account}<b>×{a.count}</b></span>)}{(f.accounts || []).length > 5 && <span className="muted">외 {f.accounts.length - 5}</span>}</div></td>
                <td className="small"><T ms={f.last_ms} now={now} /><div className="muted">처음 {ago(f.first_ms, now)}</div></td>
                <td>{f.blocked ? <span className="tag small warn">차단됨</span> : f.trusted ? <span className="tag small">신뢰 IP</span> : <span className="tag small">감시 중</span>}</td>
                <td className="act">
                  {edit && !f.blocked && !f.trusted && <button className="danger" onClick={() => setBlockDlg({ ip: f.ip, reason: `로그인 실패 ${f.count}회`, hours: s.login_block_hours })}>차단</button>}
                  {edit && <button className="ghost" onClick={() => run(() => api.security.clear({ ip: f.ip, what: 'login' }), `${f.ip} 실패 목록을 지웠습니다`)}>지우기</button>}
                </td>
              </tr>)
          })}</tbody>
        </table>}
      </Section>

      <Scans d={d} scans={scans} now={now} edit={edit} run={run} onBlock={(x) => setBlockDlg({ ip: x.ip, reason: '무단 스캐닝', hours: s.scan_block_hours })} q={q} />

      {cfg && <SettingsModal s={s} edit={edit} run={run} onClose={() => setCfg(false)} clientIp={d.client_ip} />}
      {blockDlg && <BlockModal init={blockDlg} onClose={() => setBlockDlg(null)} onSave={(b) => run(() => api.security.block(b), `${b.ip} 을(를) 차단했습니다`).then(() => setBlockDlg(null))} />}
    </div>
  )
}

/** 섹션 틀: 제목·건수·부제·우측 동작·빈 상태 */
function Section({ title, count, total, sub, right, empty, emptyHint, q, children }) {
  return (
    <section className="sec-card">
      <header className="sec-card-head">
        <h3>{title} <span className="sec-count">{q && count !== total ? `${count} / ${total}` : total}</span></h3>
        {sub && <span className="muted small sec-sub">{sub}</span>}
        <span className="spacer" />
        {right}
      </header>
      {count === 0 ? <div className="sec-empty"><b>{q && total ? `'${q}' 에 맞는 IP 가 없습니다.` : empty}</b>{!q && emptyHint && <span>{emptyHint}</span>}</div> : children}
    </section>
  )
}

function Scans({ d, scans, now, edit, run, onBlock, q }) {
  const [open, setOpen] = useState(null)
  const s = d.settings
  return (
    <Section title="무단 스캐닝 IP" count={scans.length} total={d.scans.length} q={q}
      sub={`공격 서명(${(d.categories?.attack || []).join('·')})은 즉시 차단 · 미상 경로 등은 ${s.scan_unknown_window_min}분 안 ${s.scan_unknown_limit}회면 차단 · 기록 7일`}
      right={edit && d.scans.length > 0 && <button onClick={() => window.confirm('스캐닝 기록을 모두 지울까요? (차단은 유지됩니다)') && run(() => api.security.clear({ what: 'scan' }), '스캐닝 기록을 지웠습니다')}>전체 지우기</button>}
      empty="기록된 스캐닝이 없습니다." emptyHint="콘솔·API·WS 가 아닌 경로 접근, 공격 서명, 게이트웨이 포트의 엉뚱한 바이트가 IP 별로 여기에 모입니다.">
      {scans.length > 0 && <table className="tbl sec-tbl">
        <thead><tr><th style={{ width: 28 }} /><th>IP</th><th>시도</th><th>분류 (서브그룹)</th><th>마지막</th><th>상태</th><th className="act" /></tr></thead>
        <tbody>{scans.map((x) => (
          <React.Fragment key={x.ip}>
            <tr className={(x.attack && !x.blocked ? 'is-err' : '') + (open === x.ip ? ' is-open' : '')} onClick={() => setOpen(open === x.ip ? null : x.ip)} style={{ cursor: 'pointer' }}>
              <td><span className="sec-caret">{open === x.ip ? '▾' : '▸'}</span></td>
              <td className="mono ip"><b>{x.ip}</b></td>
              <td><b>{fmtNum(x.count)}</b>{x.recent ? <div className="muted small">최근 창 {x.recent} / {s.scan_unknown_limit}</div> : null}</td>
              <td><div className="sec-chips">{x.groups.map((g) => <span key={g.category} className={'sec-chip' + (g.attack ? ' hot' : '')}>{g.category}<b>{fmtNum(g.count)}</b></span>)}</div></td>
              <td className="small"><T ms={x.last_ms} now={now} /><div className="muted">처음 {ago(x.first_ms, now)}</div></td>
              <td>{x.blocked ? <span className="tag small warn">차단됨</span> : x.trusted ? <span className="tag small">신뢰 IP</span> : x.attack ? <span className="tag small err">공격 서명</span> : <span className="tag small">감시 중</span>}</td>
              <td className="act" onClick={(e) => e.stopPropagation()}>
                {edit && !x.blocked && !x.trusted && <button className="danger" onClick={() => onBlock(x)}>차단</button>}
                {edit && <button className="ghost" onClick={() => run(() => api.security.clear({ ip: x.ip, what: 'scan' }), `${x.ip} 스캐닝 기록을 지웠습니다`)}>지우기</button>}
              </td>
            </tr>
            {open === x.ip && <tr className="sec-detail"><td /><td colSpan={6}>
              <div className="sec-groups">
                {x.groups.map((g) => (
                  <div key={g.category} className={'sec-group' + (g.attack ? ' hot' : '')}>
                    <div className="sec-group-head"><b>{g.category}</b>{g.attack && <span className="tag small err">즉시 차단 대상</span>}<span className="spacer" /><span>{fmtNum(g.count)}회</span><span className="muted small">· 마지막 <T ms={g.last_ms} now={now} /></span></div>
                    <ul className="sec-samples mono">{g.samples.map((p, i) => <li key={i}>{p}</li>)}</ul>
                  </div>))}
              </div>
            </td></tr>}
          </React.Fragment>))}
        </tbody>
      </table>}
    </Section>
  )
}

/** 수동 차단 모달 */
function BlockModal({ init, onClose, onSave }) {
  const [b, setB] = useState(init)
  const ok = /^[0-9a-fA-F:.]+$/.test(b.ip.trim()) && b.ip.trim().includes('.') || b.ip.trim().includes(':')
  React.useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal sec-modal" style={{ width: 'min(480px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>IP 차단</h2><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
        <div className="sec-form">
          <div className="sec-label">IP</div><div className="sec-field"><input className="mono" autoFocus value={b.ip} onChange={(e) => setB({ ...b, ip: e.target.value })} placeholder="예: 203.0.113.7" style={{ width: '100%' }} /></div>
          <div className="sec-label">사유</div><div className="sec-field"><input value={b.reason} onChange={(e) => setB({ ...b, reason: e.target.value })} placeholder="비워 두면 '수동 차단'" style={{ width: '100%' }} /></div>
          <div className="sec-label">기간</div><div className="sec-field"><select value={b.hours} onChange={(e) => setB({ ...b, hours: Number(e.target.value) })}>{HOURS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><div className="sec-help">차단 즉시 콘솔·API 는 403, 게이트웨이 포트는 접속이 끊깁니다. 신뢰 IP 는 차단되지 않습니다.</div></div>
        </div>
        <div className="toolbar sec-actions"><button className="danger" disabled={!ok} onClick={() => onSave({ ip: b.ip.trim(), reason: b.reason.trim(), hours: b.hours })}>차단</button><span className="spacer" /><button onClick={onClose}>취소</button></div>
      </div>
    </div>
  )
}

/** 설정 모달 (톱니바퀴 아이콘) — 섹션별 라벨/입력 정렬, 스위치, 단위, 도움말 */
function Switch({ on, onChange, disabled }) {
  return <button type="button" role="switch" aria-checked={on} className={'ctl-switch ' + (on ? 'on' : 'off')} onClick={() => !disabled && onChange(!on)} disabled={disabled}><span className="ctl-knob" /><span className="ctl-sw-text">{on ? '켬' : '끔'}</span></button>
}
function Row({ label, help, children }) {
  return <>
    <div className="sec-label">{label}</div>
    <div className="sec-field">{children}{help && <div className="sec-help">{help}</div>}</div>
  </>
}
function SettingsModal({ s, edit, run, onClose, clientIp }) {
  const [f, setF] = useState(null)
  const v = f || { ...s, trusted_text: (s.trusted || []).join('\n') }
  const set = (k, val) => setF({ ...v, [k]: val })
  const num = (k, w = 84) => <input type="number" className="sec-num" style={{ width: w }} value={v[k] ?? 0} onChange={(e) => set(k, Math.max(0, parseInt(e.target.value || '0', 10)))} disabled={!edit} />
  const save = () => run(() => api.security.saveSettings({ ...v, trusted: v.trusted_text.split(/\n|,/).map((x) => x.trim()).filter(Boolean) }), '설정 저장').then(() => { setF(null); onClose() })
  const addClient = () => { if (!clientIp) return; const cur = v.trusted_text.split(/\n|,/).map((x) => x.trim()).filter(Boolean); if (!cur.includes(clientIp)) set('trusted_text', [...cur, clientIp].join('\n')) }
  React.useEffect(() => { const k = (e) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  const dur = (k) => <span className="sec-inline">{num(k)}<span className="sec-unit">시간</span><span className="sec-note">{(v[k] ?? 0) === 0 ? '수동 해제까지' : (v[k] >= 48 ? `약 ${Math.round(v[k] / 24)}일` : '')}</span></span>
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal sec-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>보안 운영 설정 <small>{edit ? '저장하면 바로 적용됩니다' : '보기 전용 — 편집 권한이 없습니다'}</small></h2><span className="spacer" /><button className="icon" onClick={onClose} title="닫기">✕</button></div>

        <section className="sec-section">
          <h4>로그인 실패 차단</h4>
          <div className="sec-form">
            <Row label="자동 차단"><Switch on={!!v.auto_block_login} onChange={(x) => set('auto_block_login', x)} disabled={!edit} /></Row>
            <Row label="기간" help="같은 IP 의 실패를 세는 기간. 이 기간이 지난 실패는 잊습니다."><span className="sec-inline">{num('login_window_days')}<span className="sec-unit">일</span></span></Row>
            <Row label="한도" help="PIN · 비밀번호 · 계정 불일치 모두 1회로 셉니다. 한 번 성공하면 그 IP 의 실패 목록은 모두 지워집니다."><span className="sec-inline">{num('login_fail_limit')}<span className="sec-unit">회</span></span></Row>
            <Row label="차단 시간" help="0 이면 수동으로 해제할 때까지 차단합니다.">{dur('login_block_hours')}</Row>
          </div>
        </section>

        <section className="sec-section">
          <h4>무단 스캐닝 차단</h4>
          <div className="sec-form">
            <Row label="자동 차단"><Switch on={!!v.auto_block_scan} onChange={(x) => set('auto_block_scan', x)} disabled={!edit} /></Row>
            <Row label="즉시 차단" help="공격·침투 목적 서명이 한 번이라도 보이면 바로 차단합니다."><span className="sec-tags">{['경로 조작', '인젝션', '웹 취약점 탐색'].map((c) => <span key={c} className="tag small err">{c}</span>)}</span></Row>
            <Row label="한도형" help="콘솔·API·WS 가 아닌 경로, 로그인 없는 API 404, 게이트웨이 포트의 엉뚱한 바이트. 아래 창 안에 이 횟수면 차단합니다.">
              <span className="sec-tags" style={{ marginBottom: 6 }}>{['미상 경로', 'API 탐색', '게이트웨이 포트 탐색', '프로토콜 이상'].map((c) => <span key={c} className="tag small">{c}</span>)}</span>
              <span className="sec-inline">{num('scan_unknown_window_min')}<span className="sec-unit">분 안</span>{num('scan_unknown_limit')}<span className="sec-unit">회</span></span>
            </Row>
            <Row label="차단 시간" help="0 이면 수동으로 해제할 때까지 차단합니다.">{dur('scan_block_hours')}</Row>
          </div>
        </section>

        <section className="sec-section">
          <h4>신뢰 IP <small className="muted">절대 차단하지 않음</small></h4>
          <div className="sec-form">
            <Row label="목록" help="한 줄에 하나. 정확한 IP(192.168.0.10) 또는 IPv4 대역(10.0.0.0/8). 관리자 PC 와 에뮬레이터를 넣어 두면 실수로 잠기지 않습니다. 루프백(127.0.0.1)은 항상 신뢰. 신뢰로 넣으면 그 IP 의 차단은 바로 풀립니다.">
              <textarea rows={4} className="mono sec-trusted" value={v.trusted_text} onChange={(e) => set('trusted_text', e.target.value)} disabled={!edit} placeholder={'192.168.0.10\n10.0.0.0/8'} />
              {clientIp && <div className="sec-inline" style={{ marginTop: 6 }}><span className="muted small">지금 접속한 IP</span><code>{clientIp}</code>{edit && <button onClick={addClient}>목록에 추가</button>}</div>}
            </Row>
          </div>
        </section>

        <div className="toolbar sec-actions">
          {edit && <button className="primary" disabled={!f} onClick={save}>설정 저장</button>}
          {f && <button onClick={() => setF(null)}>되돌리기</button>}
          <span className="spacer" />
          <button onClick={onClose}>{f ? '저장하지 않고 닫기' : '닫기'}</button>
        </div>
      </div>
    </div>
  )
}
