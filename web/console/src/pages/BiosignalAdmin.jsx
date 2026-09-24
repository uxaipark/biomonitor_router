import React, { useEffect, useState } from 'react'
import { api, usePoll, fmtBytes } from '../api.js'

/**
 * 설정 › 생체신호 관리: 저장 파형(시간 파일) 백업 대상과 정책.
 * 카드 순서 = 우선순위(끌어서 놓기 또는 ▲▼). 필요 사본 수만큼 위에서부터 검증 백업이 끝나야 로컬 파일을 지울 수 있다.
 */
const KIND_LABEL = { nas: 'NAS (마운트 경로)', smb: 'SMB', ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP' }
const KIND_PORT = { smb: 445, ftp: 21, ftps: 21, sftp: 22 }
const EMPTY = { kind: 'sftp', name: '', host: '', port: 0, share: '', path: '', username: '', password: '', domain: '', key_path: '', insecure: false, enabled: true }

const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : '—')
/** `YYYYMMDD-HH` (UTC) → 로컬 시각 */
const hourLabel = (k) => {
  if (!k || k.length < 11) return '—'
  const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(9, 11)))
  return d.toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
const where = (t) => {
  if (t.kind === 'nas') return t.path
  const port = t.port ? `:${t.port}` : ''
  if (t.kind === 'smb') return `//${t.host}${port}/${t.share}${t.path ? '/' + t.path.replace(/^\/+/, '') : ''}`
  return `${t.kind}://${t.username ? t.username + '@' : ''}${t.host}${port}/${(t.path || '').replace(/^\/+/, t.kind === 'sftp' && t.path?.startsWith('/') ? '/' : '')}`
}

export default function BiosignalAdmin() {
  const [st, err, refresh] = usePoll(api.backup.status, 3000)
  const [edit, setEdit] = useState(null) // target being edited (or EMPTY for new)
  const [msg, setMsg] = useState('')
  const [drag, setDrag] = useState(null)
  const targets = st?.targets || []

  const move = async (from, to) => {
    if (to < 0 || to >= targets.length || from === to) return
    const ids = targets.map((t) => t.id)
    const [x] = ids.splice(from, 1)
    ids.splice(to, 0, x)
    try { await api.backup.order(ids); refresh?.() } catch (e) { setMsg('순서 저장 실패: ' + e.message) }
  }
  const toggle = async (t) => {
    try { await api.backup.update(t.id, { ...t, enabled: !t.enabled }); refresh?.() } catch (e) { setMsg('저장 실패: ' + e.message) }
  }
  const remove = async (t) => {
    if (!window.confirm(`백업 대상 '${t.name}'을(를) 삭제할까요?\n이미 올라간 원격 파일은 지우지 않습니다.`)) return
    try { await api.backup.remove(t.id); refresh?.() } catch (e) { setMsg('삭제 실패: ' + e.message) }
  }

  const p = st?.pending || {}
  const diskUsed = st ? st.disk_total - st.disk_free : 0
  const diskPct = st?.disk_total ? Math.round((diskUsed / st.disk_total) * 100) : null
  const enabled = targets.filter((t) => t.enabled).length

  return (
    <div className="page">
      <h2 className="h">생체신호 관리</h2>
      {err && <p className="err">상태를 불러오지 못했습니다: {String(err.message || err)}</p>}
      <div className="settings bk">
        <section>
          <h3>저장 파형 백업 현황</h3>
          <p className="muted">
            파형은 패치별 시간 파일(<code>patches/&lt;패치&gt;/&lt;UTC 시간&gt;.rec</code>)로 저장되고, 저장 상한에 닿으면 오래된 시간부터 지워집니다.
            백업 대상이 하나라도 켜져 있으면 <b>검증된 백업이 끝난 파일만</b> 지웁니다. 백업이 밀리면 상한을 넘어서도 보존하고,
            디스크 여유가 비상 기준 아래로 떨어질 때만 백업 안 된 파일을 지우고 사건으로 남깁니다.
          </p>
          <div className="tiles">
            <div className="tile"><div className="tile-label">로컬 저장</div><div className="tile-value">{st ? fmtBytes(st.store_bytes) : '—'}</div><div className="tile-sub">디스크 {st ? `${fmtBytes(diskUsed)} / ${fmtBytes(st.disk_total)} (${diskPct}%)` : '—'}</div></div>
            <div className={'tile' + (p.files > 2000 ? ' warn' : '')}><div className="tile-label">백업 대기</div><div className="tile-value">{p.files?.toLocaleString() ?? '—'}<small> 파일</small></div><div className="tile-sub">{fmtBytes(p.bytes || 0)} · 가장 오래된 {hourLabel(p.oldest)}</div></div>
            <div className="tile"><div className="tile-label">백업 완료 (삭제 가능)</div><div className="tile-value">{p.safe_files?.toLocaleString() ?? '—'}<small> 파일</small></div><div className="tile-sub">{fmtBytes(p.safe_bytes || 0)} · 로컬 전체 {p.local_files?.toLocaleString() ?? '—'}개</div></div>
            <div className={'tile' + (st?.blocked_bytes ? ' warn' : '')}><div className="tile-label">상한 초과 보존</div><div className="tile-value">{fmtBytes(st?.blocked_bytes || 0)}</div><div className="tile-sub">백업 전이라 지우지 못한 용량</div></div>
            <div className={'tile' + (st?.unbacked_deleted ? ' err' : '')}><div className="tile-label">비상 삭제 (백업 없이)</div><div className="tile-value">{st?.unbacked_deleted?.toLocaleString() ?? 0}<small> 파일</small></div><div className="tile-sub">{fmtBytes(st?.unbacked_deleted_bytes || 0)} · 라우터 시작 이후</div></div>
            <div className="tile"><div className="tile-label">전송 중</div><div className="tile-value">{st?.inflight?.length ?? 0}<small> / 대기열 {st?.queue?.toLocaleString() ?? 0}</small></div><div className="tile-sub">{st?.policy?.paused ? '일시 중지됨' : !st?.active ? '백업 대상 없음 (종전처럼 상한에서 삭제)' : `마지막 검사 ${fmtDateTime(st?.last_scan_ms)}`}</div></div>
          </div>
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <button onClick={async () => { await api.backup.scan(); setTimeout(() => refresh?.(), 1200) }}>지금 검사</button>
            {st && <button onClick={async () => { try { await api.backup.setPolicy({ ...st.policy, paused: !st.policy.paused }); refresh?.() } catch (e) { setMsg(e.message) } }}>{st.policy.paused ? '전송 재개' : '전송 일시 중지'}</button>}
            {msg && <span className="muted">{msg}</span>}
          </div>
        </section>

        <section>
          <div className="bk-head">
            <h3>백업 대상 <small className="muted">위에 있을수록 우선 · 활성 {enabled}개</small></h3>
            <span className="spacer" />
            <button className="primary" onClick={() => setEdit({ ...EMPTY })}>+ 대상 추가</button>
          </div>
          {!targets.length && <p className="muted">아직 백업 대상이 없습니다. 대상을 추가하면 끝난 시간 파일부터 백업을 시작합니다.</p>}
          <div className="bk-list">
            {targets.map((t, i) => {
              const s = t.stat || {}
              const down = s.down_s > 0
              return (
                <div key={t.id}
                  className={'bk-card' + (t.enabled ? '' : ' off') + (drag === i ? ' dragging' : '') + (down ? ' down' : '')}
                  draggable onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
                  onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag != null) move(drag, i); setDrag(null) }}>
                  <div className="bk-rank" title="끌어서 순서 변경"><span className="grip">⋮⋮</span><b>{i + 1}</b>
                    <button className="icon" disabled={i === 0} onClick={() => move(i, i - 1)} title="위로">▲</button>
                    <button className="icon" disabled={i === targets.length - 1} onClick={() => move(i, i + 1)} title="아래로">▼</button>
                  </div>
                  <div className="bk-main">
                    <div className="bk-title"><span className="tag">{KIND_LABEL[t.kind] || t.kind}</span><b>{t.name}</b>
                      <span className={'pill ' + (!t.enabled ? '' : down ? 'err' : s.last_ok_ms ? 'ok' : '')}>{!t.enabled ? '꺼짐' : down ? `오류 · ${s.down_s}초 뒤 재시도` : s.busy ? '전송 중' : s.last_ok_ms ? '정상' : '대기'}</span>
                    </div>
                    <div className="bk-where">{where(t)}</div>
                    <div className="bk-stats">
                      <span>오늘 {t.today?.files?.toLocaleString() || 0}개 · {fmtBytes(t.today?.bytes || 0)}</span>
                      <span>누적 {t.total?.files?.toLocaleString() || 0}개 · {fmtBytes(t.total?.bytes || 0)}</span>
                      <span>평균 {s.avg_ms ? `${(s.avg_ms / 1000).toFixed(1)}초/파일` : '—'}</span>
                      <span>마지막 성공 {fmtDateTime(s.last_ok_ms)}</span>
                      {s.fail > 0 && <span className="err">실패 {s.fail}회</span>}
                    </div>
                    {s.last_err && <div className="bk-err" title={s.last_err}>최근 오류 ({fmtDateTime(s.last_err_ms)}): {s.last_err}</div>}
                  </div>
                  <div className="bk-actions">
                    <label className="chk"><input type="checkbox" checked={t.enabled} onChange={() => toggle(t)} /> 사용</label>
                    <button onClick={() => setEdit({ ...t, password: '' })}>편집</button>
                    <button className="danger" onClick={() => remove(t)}>삭제</button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {st && <PolicyCard policy={st.policy} nTargets={Math.max(1, enabled)} onSaved={refresh} />}

        <section>
          <h3>최근 전송 기록</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl dense">
              <thead><tr><th>시각</th><th>대상</th><th>파일</th><th className="num">크기</th><th className="num">소요</th><th>결과</th></tr></thead>
              <tbody>
                {(st?.log || []).slice(0, 60).map((l, i) => (
                  <tr key={i}>
                    <td>{fmtDateTime(l.ts_ms)}</td><td>{l.target}</td><td className="mono">{l.rel}</td>
                    <td className="num">{fmtBytes(l.bytes)}</td><td className="num">{(l.ms / 1000).toFixed(1)}초</td>
                    <td className={l.ok ? 'ok' : 'err'} style={{ whiteSpace: 'normal' }}>{l.ok ? '✓ ' : '✕ '}{l.msg}</td>
                  </tr>
                ))}
                {!st?.log?.length && <tr><td colSpan={6} className="muted">아직 전송 기록이 없습니다 (라우터 재시작 시 비워짐).</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {edit && <TargetModal target={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh?.() }} />}
    </div>
  )
}

function Seg({ value, options, onChange }) {
  return <span className="seg wrap">{options.map(([v, l]) => <button key={String(v)} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>{l}</button>)}</span>
}

function PolicyCard({ policy, nTargets, onSaved }) {
  const [p, setP] = useState(policy)
  const [msg, setMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  useEffect(() => { if (!dirty) setP(policy) }, [policy, dirty])
  const set = (k, v) => { setP({ ...p, [k]: v }); setDirty(true) }
  const num = (k) => <input type="number" value={p[k]} onChange={(e) => set(k, Math.max(0, parseInt(e.target.value || '0', 10)))} style={{ width: 110, minWidth: 0 }} />
  const save = async () => {
    try { await api.backup.setPolicy(p); setDirty(false); setMsg('저장했습니다.'); onSaved?.() } catch (e) { setMsg('저장 실패: ' + e.message) }
  }
  const copies = Array.from({ length: Math.max(nTargets, p.copies) }, (_, i) => [i + 1, i === 0 ? '1 (장애 조치)' : `${i + 1} (중복)`])
  return (
    <section>
      <h3>백업 정책</h3>
      <div className="bk-form">
        <label>필요 사본 수</label>
        <div><Seg value={p.copies} options={copies} onChange={(v) => set('copies', v)} />
          <div className="muted">위 순위부터 이 수만큼 검증된 사본이 생겨야 로컬에서 지울 수 있습니다. 1이면 1순위가 실패할 때 다음 순위로 넘어가고, 2 이상이면 여러 곳에 중복 백업합니다.</div></div>
        <label>로컬 삭제 시점</label>
        <div><Seg value={p.delete_mode} options={[['cap', '저장 상한에 닿을 때'], ['immediate', '백업 검증 직후']]} onChange={(v) => set('delete_mode', v)} />
          <div className="muted">'저장 상한'은 최근 파형을 로컬에 남겨 이력 뷰어가 빠르게 읽습니다. '검증 직후'는 로컬 디스크를 가장 적게 씁니다.</div></div>
        <label>전송 검증</label>
        <div><Seg value={p.verify} options={[['sha256', '다시 읽어 SHA-256 비교'], ['size', '크기만 비교 (빠름)']]} onChange={(v) => set('verify', v)} />
          <div className="muted">SHA-256은 올린 파일을 다시 받아 한 바이트도 다르지 않은지 확인합니다. 네트워크 사용량이 두 배가 됩니다.</div></div>
        <label>백업 시작</label>
        <div>{num('min_age_min')} 분 <span className="muted">— 시간 파일이 끝나고 마지막 쓰기 뒤 이만큼 지나면 (늦게 도착하는 레코드 대비)</span></div>
        <label>비상 삭제</label>
        <div>디스크 여유 {num('emergency_free_pct')} % 미만 <span className="muted">— 이때만 백업 안 된 파일도 오래된 순으로 지웁니다</span></div>
        <label>동시 전송</label>
        <div><Seg value={p.parallel} options={[[1, '1'], [2, '2'], [4, '4'], [8, '8']]} onChange={(v) => set('parallel', v)} /> <span className="muted">파일</span></div>
        <label>속도 제한</label>
        <div>{num('rate_limit_kbps')} KB/s <span className="muted">— 대상별, 0 = 제한 없음 (FTP·SFTP)</span></div>
        <label>제한 시간</label>
        <div>{num('timeout_s')} 초 <span className="muted">— 파일 1개 전송 + 검증</span></div>
      </div>
      <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
        <button className="primary" onClick={save} disabled={!dirty}>정책 저장</button>
        {dirty && <button onClick={() => { setP(policy); setDirty(false) }}>되돌리기</button>}
        {msg && <span className="muted">{msg}</span>}
      </div>
    </section>
  )
}

function TargetModal({ target, onClose, onSaved }) {
  const isNew = !target.id
  const [t, setT] = useState(target)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [test, setTest] = useState(null)
  const set = (k, v) => setT({ ...t, [k]: v })
  const inp = (k, ph, type = 'text') => <input type={type} value={t[k] ?? ''} placeholder={ph} onChange={(e) => set(k, type === 'number' ? parseInt(e.target.value || '0', 10) : e.target.value)} autoComplete="off" />
  const body = () => ({ ...t, port: Number(t.port) || 0 })
  const save = async () => {
    setBusy(true); setErr('')
    try { if (isNew) await api.backup.create(body()); else await api.backup.update(t.id, body()); onSaved() } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const runTest = async () => {
    setBusy(true); setTest(null); setErr('')
    try { setTest(await api.backup.test(body())) } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const k = t.kind
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 'min(720px, 100%)' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{isNew ? '백업 대상 추가' : `백업 대상 편집 · ${target.name}`}</h2><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
        <div className="bk-form">
          <label>종류</label>
          <Seg value={k} options={Object.entries(KIND_LABEL)} onChange={(v) => setT({ ...t, kind: v, port: 0 })} />
          <label>이름</label>{inp('name', '예: 본관 NAS')}
          {k === 'nas' ? <>
            <label>마운트 경로</label>{inp('path', '/mnt/nas/biomonitor')}
            <label />
            <div className="muted">NAS 공유(NFS·SMB)를 이 Pi 에 미리 마운트한 폴더입니다. 마운트가 빠져 로컬 디스크에 쓰는 일을 막으려고 저장소와 같은 디스크면 거부합니다.</div>
            <label />
            <label className="chk"><input type="checkbox" checked={!!t.insecure} onChange={(e) => set('insecure', e.target.checked)} /> 마운트 확인 생략 (로컬 디스크·USB 허용)</label>
          </> : <>
            <label>호스트</label>{inp('host', '192.168.0.50 또는 nas.local')}
            <label>포트</label>{inp('port', `기본 ${KIND_PORT[k]}`, 'number')}
            {k === 'smb' && <><label>공유 이름</label>{inp('share', 'backup')}</>}
            <label>{k === 'smb' ? '공유 안 폴더' : '원격 경로 (필수)'}</label>
            {inp('path', k === 'sftp' ? '/data/biomonitor (절대) 또는 ~/biomonitor (홈 기준)' : k === 'smb' ? 'biomonitor/rp5' : 'biomonitor (로그인 폴더 기준)')}
            {k !== 'smb' && <><label /><div className="muted">루트(로그인 폴더)에는 쓰지 않습니다. 이 디렉터리는 서버에 미리 만들어 두세요 — 들어가서 그 안에만 폴더를 만들고 기록합니다.</div></>}
            <label>사용자</label>{inp('username', k === 'ftp' || k === 'ftps' ? 'anonymous 이면 비워 두기' : '')}
            <label>비밀번호</label>
            <div className="bk-pw">{inp('password', t.has_password ? '저장됨 — 바꿀 때만 입력' : '', 'password')}
              {t.has_password && <label className="chk"><input type="checkbox" checked={!!t.clear_password} onChange={(e) => set('clear_password', e.target.checked)} /> 저장된 비밀번호 지우기</label>}</div>
            {k === 'smb' && <><label>도메인</label>{inp('domain', 'WORKGROUP (선택)')}</>}
            {k === 'sftp' && <><label>개인 키</label>{inp('key_path', '/home/master/.ssh/id_ed25519 (비우면 비밀번호)')}</>}
            {(k === 'sftp' || k === 'ftps') && <><label /><label className="chk"><input type="checkbox" checked={!!t.insecure} onChange={(e) => set('insecure', e.target.checked)} /> {k === 'sftp' ? '호스트 키 확인 생략 (known_hosts 에 없는 서버)' : '인증서 확인 생략 (자체 서명 인증서)'}</label></>}
          </>}
          <label />
          <label className="chk"><input type="checkbox" checked={!!t.enabled} onChange={(e) => set('enabled', e.target.checked)} /> 사용</label>
        </div>
        <p className="muted" style={{ marginTop: 10 }}>파일은 <code>{'<경로>'}/patches/&lt;패치&gt;/&lt;UTC 시간&gt;.rec</code> 로 올라갑니다 (로컬과 같은 구조라 그대로 되돌려 넣을 수 있습니다).</p>
        {test && (
          <div className={'bk-test ' + (test.ok ? 'ok' : 'err')}>
            <b>{test.ok ? '연결 시험 성공' : '연결 시험 실패'}</b> <span className="muted">{test.where}</span>
            {test.steps.map((s, i) => <div key={i}>{s.ok ? '✓' : '✕'} {s.step}{s.ms != null ? ` · ${s.ms} ms` : ''}{s.msg ? ` — ${s.msg}` : ''}</div>)}
          </div>
        )}
        {err && <p className="err">{err}</p>}
        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <button onClick={runTest} disabled={busy}>{busy && !test ? '시험 중…' : '연결 시험'}</button>
          <span className="spacer" />
          <button onClick={onClose} disabled={busy}>취소</button>
          <button className="primary" onClick={save} disabled={busy}>{isNew ? '추가' : '저장'}</button>
        </div>
      </div>
    </div>
  )
}
