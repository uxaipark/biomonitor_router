import React, { useEffect, useState } from 'react'
import { api, usePoll, fmtBytes } from '../api.js'
import { can, useMe } from '../auth.js'
import { ReadOnly } from '../ReadOnly.jsx'
import './BiosignalAdmin.css'
import NasMigration from './NasMigration.jsx'

/**
 * 운영관리 › 데이터 관리: 파형 저장 단위, 무결성 봉인, 백업 대상과 정책.
 * 카드 순서 = 우선순위(끌어서 놓기 또는 ▲▼). 필요 사본 수만큼 위에서부터 검증 백업이 끝나야 로컬 파일을 지울 수 있다.
 */
const KIND_LABEL = { nas: 'NAS (마운트 경로)', smb: 'SMB', ftp: 'FTP', ftps: 'FTPS', sftp: 'SFTP' }
const KIND_PORT = { smb: 445, ftp: 21, ftps: 21, sftp: 22 }
const EMPTY = { kind: 'sftp', name: '', host: '', port: 0, share: '', path: '', username: '', password: '', domain: '', key_path: '', insecure: false, enabled: true, mirror: false }

const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : '—')
/** `YYYYMMDD-HH` (UTC) → 로컬 시각 */
const hourLabel = (k) => {
  if (!k || k.length < 11) return '—'
  const d = new Date(Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8), +k.slice(9, 11)))
  const n = +(k.slice(11).match(/^_(\d+)h/)?.[1] || 1) // `_2h` = 2시간 파일, 없으면 옛 1시간 파일
  const s = d.toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const e = new Date(d.getTime() + n * 3600000).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })
  return `${s}–${e}`
}
const where = (t) => {
  if (t.kind === 'nas') return t.path
  const port = t.port ? `:${t.port}` : ''
  if (t.kind === 'smb') return `//${t.host}${port}/${t.share}${t.path ? '/' + t.path.replace(/^\/+/, '') : ''}`
  return `${t.kind}://${t.username ? t.username + '@' : ''}${t.host}${port}/${(t.path || '').replace(/^\/+/, t.kind === 'sftp' && t.path?.startsWith('/') ? '/' : '')}`
}

export default function BiosignalAdmin() {
  const me = useMe()
  const canEdit = can(me, 'page.settings_biosignal', 2) // '보기' 면 현황만 보고 정책·대상·백업 동작은 잠근다
  const [st, err, refresh] = usePoll(api.backup.status, 3000)
  const [edit, setEdit] = useState(null)
  const [wizard, setWizard] = useState(false) // target being edited (or EMPTY for new)
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
    <div className="page dm">
      <div className="dm-head">
        <div>
          <h2 className="h" style={{ margin: 0 }}>데이터 관리</h2>
          <p className="muted small" style={{ margin: '4px 0 0' }}>저장된 파형 파일이 <b>기록 → 봉인 → 백업 → 정리</b>되는 흐름</p>
        </div>
      </div>
      {err && <p className="err">상태를 불러오지 못했습니다: {String(err.message || err)}</p>}
      <div className="settings bk">
        <ReadOnly edit={canEdit}>
        {/* 맨 위 줄: 로컬 저장/디스크 · 지금 검사 · 백업 대상 안내 · + 대상 추가 */}
        <div className="dm-top">
          <div className="dm-store">
            <small>로컬 저장 / 디스크</small>
            <b className={st?.store_cap && st.store_bytes > st.store_cap ? 'warn' : ''}>{st ? fmtBytes(st.store_bytes) : '—'} <span className="muted">/ {st ? `${fmtBytes(diskUsed)} · 여유 ${fmtBytes(st.disk_free)}` : '—'}</span></b>
            <small>{st?.store_cap ? `상한 ${fmtBytes(st.store_cap)} (${Math.round(st.store_bytes / st.store_cap * 100)}%)` : '상한 없음'}{diskPct != null ? ` · 디스크 사용률 ${diskPct}%` : ''}</small>
          </div>
          <button onClick={async () => { await api.backup.scan(); setTimeout(() => refresh?.(), 1200) }}>지금 검사</button>
          {st && (st.policy.paused
            ? <button className="primary" onClick={async () => { try { await api.backup.setPolicy({ ...st.policy, paused: false }); refresh?.() } catch (e) { setMsg(e.message) } }}>백업 재개</button>
            : st.active && <button className="danger" title="전송 중인 파일까지 바로 끊고 멈춥니다 (끊긴 파일은 재개할 때 처음부터 다시 올립니다)" onClick={async () => { try { const r = await api.backup.abort(); setMsg(r.killed ? `백업을 중단했습니다 — 전송 중이던 ${r.killed}건을 끊었습니다` : '백업을 중단했습니다'); refresh?.() } catch (e) { setMsg(e.message) } }}>백업 중단</button>)}
          {st && !targets.length && <span className="dm-notice"><b>백업 대상이 없습니다.</b> 저장 상한에 닿으면 가장 오래된 파형 파일이 백업 없이 삭제됩니다.</span>}
          {st && targets.length > 0 && !st.active && <span className="dm-notice"><b>켜진 백업 대상이 없습니다.</b> 상한에 닿으면 백업 없이 삭제됩니다.</span>}
          {msg && <span className="muted small">{msg}</span>}
          <span className="spacer" />
          <button onClick={() => setWizard(true)} title="로컬 비우기 → 설정 시간 확보 → 새 NAS 연결 → 기존 백업 이관까지 단계별로 안내">NAS 이관</button>
          <button className="primary" onClick={() => setEdit({ ...EMPTY })}>+ 백업 대상 추가</button>
        </div>
        {wizard && st && <NasMigration st={st} refresh={refresh} onClose={() => setWizard(false)} onAddTarget={(preset) => setEdit({ ...EMPTY, ...preset })} />}

        {/* 파형 파일 수명 주기 — 다섯 단계와 살아 있는 숫자 */}
        <section className="dm-life">
          <h3>파형 파일 수명 주기</h3>
          <div className="dm-stages">
            <div className="dm-stage">
              <div className="dm-stage-n">①</div><div className="dm-stage-t">기록</div>
              <div className="dm-stage-v">{p.local_files != null ? <><b>{p.local_files.toLocaleString()}</b> 파일</> : <b>—</b>}</div>
              <div className="dm-stage-s">패치별 {st?.policy?.block_hours ?? 2}시간 단위 파일<br /><code>patches/&lt;패치&gt;/&lt;UTC&gt;_{st?.policy?.block_hours ?? 2}h.rec</code></div>
            </div>
            <div className="dm-arrow" aria-hidden="true">→</div>
            <div className={'dm-stage' + (p.bad_sealed_files ? ' err' : '')}>
              <div className="dm-stage-n">②</div><div className="dm-stage-t">봉인</div>
              <div className="dm-stage-v">{p.unsealed_files != null ? <><b>{p.unsealed_files.toLocaleString()}</b> 확인 중</> : <b>—</b>}</div>
              <div className="dm-stage-s">닫힐 때 항목 CRC 재확인 후 CRC-32 · SHA-256 을 <code>.sum</code> 에 봉인{p.bad_sealed_files ? <><br /><span className="err">CRC 오류 파일 {p.bad_sealed_files}</span></> : null}</div>
            </div>
            <div className="dm-arrow" aria-hidden="true">→</div>
            <div className={'dm-stage' + (p.files > 2000 ? ' warn' : '')}>
              <div className="dm-stage-n">③</div><div className="dm-stage-t">백업 대기</div>
              <div className="dm-stage-v"><b>{p.files?.toLocaleString() ?? '—'}</b> 파일 · {fmtBytes(p.bytes || 0)}</div>
              <div className="dm-stage-s">가장 오래된 {hourLabel(p.oldest)}</div>
            </div>
            <div className="dm-arrow" aria-hidden="true">→</div>
            <div className={'dm-stage' + (st?.policy?.paused ? ' warn' : '')}>
              <div className="dm-stage-n">④</div><div className="dm-stage-t">전송 중</div>
              <div className="dm-stage-v"><b>{st?.inflight?.length ?? 0}</b> · 대기열 {st?.queue?.toLocaleString() ?? 0}</div>
              <div className="dm-stage-s">{st?.policy?.paused ? <span className="warn">일시 중지됨</span> : !st?.active ? '백업 대상 없음' : `마지막 검사 ${fmtDateTime(st?.last_scan_ms)}`} · 봉인 파일도 함께 올림</div>
            </div>
            <div className="dm-arrow" aria-hidden="true">→</div>
            <div className="dm-stage">
              <div className="dm-stage-n">⑤</div><div className="dm-stage-t">백업 완료 · 삭제 가능</div>
              <div className="dm-stage-v"><b>{p.safe_files?.toLocaleString() ?? '—'}</b> 파일 · {fmtBytes(p.safe_bytes || 0)}</div>
              <div className="dm-stage-s">로컬 전체 {p.local_files?.toLocaleString() ?? '—'}개 · 상한에 닿으면 이 파일부터 삭제</div>
            </div>
          </div>
          <div className="dm-side">
            <span className={st?.blocked_bytes ? 'warn' : ''}><b>상한 초과 보존</b> {fmtBytes(st?.blocked_bytes || 0)} <span className="muted">— 백업이 밀리면 상한을 넘어도 지우지 않음</span></span>
            <span className={st?.unbacked_deleted ? 'err' : ''}><b>비상 삭제 (백업 없이)</b> {st?.unbacked_deleted?.toLocaleString() ?? 0} 파일 · {fmtBytes(st?.unbacked_deleted_bytes || 0)} <span className="muted">— 디스크가 비상 기준 아래일 때만 · 사건 기록</span></span>
          </div>
        </section>

        <section>
          <div className="bk-head">
            <h3>백업 대상 <small className="muted">위에 있을수록 우선 · 활성 {enabled}개</small></h3>
            <span className="spacer" />
            <span className="muted small">위에 있을수록 먼저 올립니다. 끌어서 순서를 바꿉니다.</span>
            <button className="primary" onClick={() => setEdit({ ...EMPTY })}>+ 대상 추가</button>
          </div>
          {!targets.length && <div className="dm-empty"><b>아직 백업 대상이 없습니다</b><span>추가하면 봉인이 끝난 파일부터 백업을 시작합니다</span></div>}
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
                    <label className="chk" title="받는 쪽에만 켭니다: 다른 켜진 대상에는 있고 이 대상에는 없는 파일(로컬에서 지워진 것 포함)을 저속으로 계속 끌어와 완전히 같게 유지합니다. 원본 대상에는 표시할 필요 없고, 둘 다 켜면 양방향으로 맞춥니다"><input type="checkbox" checked={!!t.mirror} onChange={async () => { try { await api.backup.update(t.id, { ...t, mirror: !t.mirror }); refresh?.() } catch (e) { setMsg('저장 실패: ' + e.message) } }} /> 미러링</label>
                    {t.mirror && t.mirror_state && <span className={'pill small ' + (t.mirror_state.running ? 'ok' : t.mirror_state.paused ? 'warn' : '')} title={t.mirror_state.last_err || ''}>{t.mirror_state.running ? `미러링 중 · 남은 ${t.mirror_state.todo?.toLocaleString()}개 · 완료 ${t.mirror_state.done?.toLocaleString()}` : t.mirror_state.paused ? '미러링 일시 중지' : `미러링 동기화 완료 (${t.mirror_state.done?.toLocaleString() || 0}개)`}</span>}
                    <button onClick={() => setEdit({ ...t, password: '' })}>편집</button>
                    <button className="danger" onClick={() => remove(t)}>삭제</button>
                  </div>
                </div>
              )
            })}
          </div>
        </section>

        {st && <PolicyCard policy={st.policy} nTargets={Math.max(1, enabled)} onSaved={refresh} capEnvGb={st.store_cap_env_gb} diskTotal={st.disk_total} />}
        </ReadOnly>

        {st?.targets?.length > 0 && <BackupCatalog targets={st.targets} canEdit={canEdit} />}

        <section>
          <h3>최근 전송 기록 <small className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>라우터 재시작 시 비워짐 · 최근 60건</small></h3>
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
                {!st?.log?.length && <tr><td colSpan={6}><div className="dm-empty"><b>아직 전송 기록이 없습니다</b><span>백업 대상이 켜지고 봉인된 파일이 생기면 여기에 쌓입니다</span></div></td></tr>}
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

function PolicyCard({ policy, nTargets, onSaved, capEnvGb, diskTotal }) {
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
      <h3>저장 · 백업 정책</h3>
      <div className="bk-form bk-policy">
        <label>파일 저장 단위</label>
        <div><Seg value={p.block_hours ?? 2} options={[1, 2, 3, 4, 6, 8, 12, 24].map((h) => [h, `${h}시간`])} onChange={(v) => set('block_hours', v)} />
          <div className="muted">
            환자(패치) 1명당 이 시간마다 파일 하나. 파일 1개 ≈ {(3.6 * (p.block_hours ?? 2)).toFixed(1)} MB(비압축, 실측 시간당 약 3.6 MB),
            동시 2,000명이면 하루 {Math.round((2000 * 24) / (p.block_hours ?? 2)).toLocaleString()}개 · 2년 {Math.round((2000 * 24 * 730) / (p.block_hours ?? 2) / 10000) / 100}백만 개.
            길게 잡을수록 파일 수는 줄고, 봉인·백업은 그 단위가 끝난 뒤에 시작합니다. 바꾸면 다음 기록부터 적용됩니다(이미 있는 파일은 그대로).
          </div></div>
        <label>로컬 저장 상한</label>
        <div>{num('store_max_gb')} GB <span className="muted">— 0 = 런처 값(<code>ROUTER_STORE_MAX_GB</code>, 지금 {capEnvGb ? `${capEnvGb} GB` : '무제한'}){diskTotal ? ` · 디스크 ${Math.round(diskTotal / 2 ** 30)} GB` : ''}</span>
          <div className="muted">
            {(() => { const gb = p.store_max_gb > 0 ? p.store_max_gb : capEnvGb; if (!gb) return '상한 없음 — 디스크가 찰 때까지 보존합니다.'; const h = gb / 8; return `이 상한에 닿으면 오래된 파일부터 지웁니다(백업 대상이 있으면 백업이 끝난 파일만). 환자 2,000명 전 채널(약 8 GB/h)이면 로컬에 약 ${h >= 48 ? `${(h / 24).toFixed(1)}일` : `${Math.round(h)}시간`}치가 남고, 그 구간은 백업과 이중으로 보관됩니다. 저장 즉시 적용(다음 정리 주기, 1분 안).` })()}
          </div></div>
        <label>봉인 속도</label>
        <div>{num('seal_per_sec')} 파일/초 <span className="muted">— 0 = 제한 없음</span>
          <div className="muted">저장 단위가 끝나는 정각에 환자 수만큼 파일이 한꺼번에 닫히며 봉인(CRC·SHA-256)됩니다. 속도를 제한하면 그 순간의 CPU 피크가 펼쳐지고, 봉인이 끝난 파일부터 백업이 시작되므로 그만큼 늦어집니다.
            {(p.seal_per_sec ?? 0) > 0 ? ` 환자 2,000명이면 약 ${Math.round(2000 / p.seal_per_sec)}초에 걸쳐 봉인합니다.` : ' 제한 없음은 1분 남짓에 한 코어를 씁니다.'} 저장 즉시 적용.</div></div>
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
        <div>{num('min_age_min')} 분 <span className="muted">— 저장 단위 파일이 끝나고 마지막 쓰기 뒤 이만큼 지나면 (늦게 도착하는 레코드 대비)</span></div>
        <label>비상 삭제</label>
        <div>디스크 여유 {num('emergency_free_pct')} % 미만 <span className="muted">— 이때만 백업 안 된 파일도 오래된 순으로 지웁니다</span></div>
        <label>동시 전송</label>
        <div><Seg value={p.parallel} options={[[1, '1'], [2, '2'], [4, '4'], [8, '8']]} onChange={(v) => set('parallel', v)} /> <span className="muted">파일</span></div>
        <label>속도 제한</label>
        <div>{num('rate_limit_kbps')} KB/s <span className="muted">— 대상별, 0 = 제한 없음 (FTP·SFTP)</span></div>
        <label>제한 시간</label>
        <div>{num('timeout_s')} 초 <span className="muted">— 파일 1개 전송 + 검증</span></div>
        <label>미러링 속도</label>
        <div>{num('mirror_kbps')} KB/s <span className="muted">— 대상 간 미러링 상한, 0 = 제한 없음 (NAS 이관 때 마법사가 잠시 0 으로)</span></div>
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
          <label className="chk" title="받는 쪽에만 켭니다 — 다른 켜진 대상의 파일을 이 대상으로 저속 미러링 (원본 대상에는 불필요, 둘 다 켜면 양방향)"><input type="checkbox" checked={!!t.mirror} onChange={(e) => set('mirror', e.target.checked)} /> 다른 대상의 기존 파일도 미러링</label>
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

/** 백업 저장소별 목록: 대상 → 파일 단위(UTC 블록)별 요약 → 그 블록의 패치 파일 */
function BackupCatalog({ targets, canEdit = true }) {
  const canPurge = canEdit && can(useMe(), 'action.backup_purge', 2) // 권한 설정 › 운영관리 › 데이터 관리 › 백업 파일 전체 삭제
  const [tid, setTid] = useState(targets[0]?.id)
  const id = targets.some((t) => t.id === tid) ? tid : targets[0]?.id
  const [cat, err, refresh] = usePoll(() => api.backup.catalog(id), 10000, [id])
  const [open, setOpen] = useState(null) // 펼친 시간
  const [q, setQ] = useState('')
  const [files, setFiles] = useState(null)
  const [msg, setMsg] = useState('')
  useEffect(() => { setOpen(null); setFiles(null) }, [id])
  useEffect(() => {
    if (!open) return
    let dead = false
    const t = setTimeout(() => api.backup.catalog(id, open, q).then((r) => { if (!dead) setFiles(r.list || []) }).catch((e) => setMsg(e.message)), 200)
    return () => { dead = true; clearTimeout(t) }
  }, [id, open, q])
  const sync = cat?.sync
  const t = targets.find((x) => x.id === id)
  const startSync = async () => { setMsg(''); try { await api.backup.catalogSync(id); setTimeout(() => refresh?.(), 800) } catch (e) { setMsg(e.message) } }
  const purge = async () => {
    setMsg('')
    const v = window.prompt(`'${t?.name}' 의 백업 파일을 전부 지웁니다 (${where(t)} 안의 patches/ 폴더).\n` +
      '로컬에서 이미 지워진 시간의 파형은 되살릴 수 없습니다. 삭제하는 동안 백업은 중단되고, 끝난 뒤 "백업 재개"를 누르면 로컬에 남은 파일부터 다시 올립니다.\n\n' +
      `계속하려면 대상 이름을 그대로 입력하세요: ${t?.name}`)
    if (v == null) return
    try { await api.backup.catalogPurge(id, v); setOpen(null); setTimeout(() => refresh?.(), 800) } catch (e) { setMsg(e.message) }
  }
  return (
    <section>
      <h3>백업 저장소별 목록</h3>
      <div className="toolbar">
        <Seg value={id} options={targets.map((x) => [x.id, x.name])} onChange={setTid} />
        <span className="muted">{t && where(t)} · 파일 {(cat?.files ?? 0).toLocaleString()}개 · {fmtBytes(cat?.bytes || 0)}</span>
        <span className="spacer" />
        {t?.kind !== 'smb' && <button onClick={startSync} disabled={!canEdit || sync?.running} title="원격 저장소의 patches/ 를 읽어 목록에 없는 파일을 채웁니다 (목록 기능 이전에 올린 파일 포함)">{sync?.running && sync.op !== 'purge' ? `원격 목록 읽는 중… ${sync.dirs || 0}/${sync.dirs_total ?? '?'}` : '원격 목록 읽기'}</button>}
        {canPurge && <button className="danger" onClick={purge} disabled={sync?.running}>{sync?.running && sync.op === 'purge' ? `삭제 중… 폴더 ${sync.dirs || 0}/${sync.dirs_total ?? '?'} · 파일 ${(sync.deleted || 0).toLocaleString()}` : '백업 파일 전체 삭제'}</button>}
      </div>
      {sync && !sync.running && sync.done_ms && sync.op === 'purge' && (
        <p className={sync.error ? 'err' : 'muted'}>백업 파일 전체 삭제 {fmtDateTime(sync.done_ms)}: {sync.error ? sync.error : `파일 ${(sync.deleted ?? 0).toLocaleString()}개 삭제 · 백업은 중단 상태입니다 ("백업 재개"로 다시 시작)`}</p>
      )}
      {sync && !sync.running && sync.done_ms && sync.op !== 'purge' && (
        <p className={sync.error ? 'err' : 'muted'}>
          원격 목록 읽기 {fmtDateTime(sync.done_ms)}: {sync.error ? sync.error : `폴더 ${sync.dirs_total ?? 0}개 · 파일 ${(sync.found ?? 0).toLocaleString()}개 확인 · ${(sync.added ?? 0).toLocaleString()}개 추가${sync.missing ? ` · 목록에 있으나 원격에 없음 ${sync.missing}개` : ''}${sync.dir_errors ? ` · 읽기 실패 폴더 ${sync.dir_errors}개` : ''}`}
        </p>
      )}
      {(err || msg) && <p className="err">{msg || err.message}</p>}
      <div style={{ overflowX: 'auto', maxHeight: 520, overflowY: 'auto' }}>
        <table className="tbl dense">
          <thead><tr><th>저장 단위 (현지 시각)</th><th className="num">패치 파일</th><th className="num">크기</th><th>백업 시각</th><th /></tr></thead>
          <tbody>
            {(cat?.hours || []).map((h) => (
              <React.Fragment key={h.hour}>
                <tr className="clickable" onClick={() => { setFiles(null); setOpen(open === h.hour ? null : h.hour) }}>
                  <td><b>{hourLabel(h.hour)}</b> <span className="mono muted">{h.hour}</span></td>
                  <td className="num">{h.files.toLocaleString()}</td>
                  <td className="num">{fmtBytes(h.bytes)}</td>
                  <td className="muted">{h.remote_only === h.files ? '원격 목록에서 확인' : `${fmtDateTime(h.first_ms)} ~ ${new Date(h.last_ms).toLocaleTimeString('ko-KR', { hour12: false })}`}</td>
                  <td>{open === h.hour ? '▾' : '▸'}</td>
                </tr>
                {open === h.hour && (
                  <tr><td colSpan={5} style={{ background: 'var(--bg2, transparent)' }}>
                    <div className="toolbar"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="패치 번호 찾기" style={{ width: 200 }} /><span className="muted">{files ? `${files.length.toLocaleString()}개${files.length >= 5000 ? ' (앞 5000개)' : ''}` : '불러오는 중…'}</span></div>
                    <table className="tbl dense">
                      <thead><tr><th>패치</th><th>원격 파일</th><th className="num">크기</th><th>검증</th><th>백업 시각</th></tr></thead>
                      <tbody>
                        {(files || []).map((f) => (
                          <tr key={f.rel}>
                            <td className="mono">{f.patch}</td><td className="mono muted">{f.rel}</td><td className="num">{fmtBytes(f.size)}</td>
                            <td className="mono">{f.sha ? `SHA-256 ${f.sha.slice(0, 12)}…` : <span className="muted">원격 목록 (크기만)</span>}</td>
                            <td className="muted">{f.src === 'remote' ? '—' : fmtDateTime(f.done_ms)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td></tr>
                )}
              </React.Fragment>
            ))}
            {!cat?.hours?.length && <tr><td colSpan={5} className="muted">이 저장소에 기록된 백업이 없습니다.{t?.kind !== 'smb' ? ' 목록 기능 이전에 올린 파일은 "원격 목록 읽기"로 채울 수 있습니다.' : ''}</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}
