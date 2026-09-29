import React, { useEffect, useMemo, useState } from 'react'
import { api, fmtBytes, usePoll } from '../api.js'

/**
 * NAS 이관 마법사 — 백업 저장소를 더 큰 NAS 로 옮기는 전 과정을 단계별로 안내한다. 단계 상태는 라우터(backup_kv 'migration')에
 * 남아 페이지를 새로고침해도 이어진다.
 *  ① 로컬 비우기: 백업을 최대로 돌리고(즉시 삭제 모드) 검증된 파일을 지워 로컬 여유 공간을 최대화 — 설정 시간 동안 로컬만으로 버틸 시간을 계산
 *  ② 설정 시간: 백업 일시 중지, NAS 를 물리적으로 붙이는 동안 남은 시간(로컬 여유 ÷ 저장 증가 속도)을 카운트다운
 *  ③ 새 NAS 연결: 대상 추가·연결 시험 (기존 대상 폼 재사용)
 *  ④ 이관: 새 대상에 미러링을 켜고 속도 제한을 풀어 기존 대상의 파일을 전부 복사 — 진행률·남은 개수
 *  ⑤ 마무리: 백업 재개, 새 대상을 1순위로, (선택) 기존 대상 사용 중지, 삭제 모드·미러링 속도 원복
 */
const STEPS = ['로컬 비우기', '설정 시간', '새 NAS 연결', '이관', '마무리']
const fmtDur = (s) => { if (!isFinite(s) || s < 0) return '—'; const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}일 ${h}시간` : h ? `${h}시간 ${m}분` : `${m}분` }

export default function NasMigration({ st, refresh, onClose, onAddTarget }) {
  const [m, setM] = useState(st.migration || null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [mig] = usePoll(api.backup.migration, 5000)
  useEffect(() => { if (mig !== null && mig !== undefined) setM(mig) }, [mig])
  const phase = m?.phase || 'idle'
  const step = { idle: 0, empty: 0, window: 1, connect: 2, migrate: 3, finish: 4, done: 4 }[phase] ?? 0
  const save = async (next) => { setBusy(true); setErr(''); try { const v = { ...(m || {}), ...next, updated_ms: Date.now() }; const r = await api.backup.setMigration(v); setM(r); refresh?.(); return r } catch (e) { setErr(e.message); throw e } finally { setBusy(false) } }
  const policy = st.policy || {}
  const targets = st.targets || []
  const oldTargets = targets.filter((t) => t.id !== m?.new_target_id)
  const newT = targets.find((t) => t.id === m?.new_target_id)
  // 로컬만으로 버틸 시간: (상한 또는 디스크 여유까지 남은 용량) ÷ 저장 증가 속도
  const room = Math.max(0, (st.store_cap ? Math.min(st.store_cap - st.store_bytes, st.disk_free) : st.disk_free) - (st.disk_total || 0) * ((policy.emergency_free_pct || 5) / 100))
  const rate = st.store_rate_bps || 0
  const hold = rate > 0 ? room / rate : Infinity
  const pend = st.pending || {}
  const safeFree = pend.safe_bytes || 0 // 이미 백업된(지울 수 있는) 로컬 용량

  const start = async () => {
    await api.backup.setPolicy({ ...policy, delete_mode: 'immediate', paused: false })
    await api.backup.scan()
    await save({ phase: 'empty', started_ms: Date.now(), prev_delete_mode: policy.delete_mode, prev_mirror_kbps: policy.mirror_kbps })
  }
  const toWindow = async () => { await api.backup.setPolicy({ ...policy, paused: true }); await save({ phase: 'window', window_ms: Date.now() }) }
  const toConnect = async () => save({ phase: 'connect' })
  const pickNew = async (id) => save({ new_target_id: id })
  const toMigrate = async () => {
    if (!newT) return
    await api.backup.update(newT.id, { ...newT, enabled: true, mirror: true })
    await api.backup.setPolicy({ ...policy, paused: false, mirror_kbps: 0 })
    await api.backup.mirrorKick()
    await save({ phase: 'migrate', migrate_ms: Date.now() })
  }
  const toFinish = async (disableOld) => {
    if (newT) {
      const ids = [newT.id, ...targets.filter((t) => t.id !== newT.id).map((t) => t.id)]
      await api.backup.order(ids)
      if (disableOld) for (const t of oldTargets) await api.backup.update(t.id, { ...t, enabled: false })
    }
    await api.backup.setPolicy({ ...policy, paused: false, delete_mode: m?.prev_delete_mode || 'cap', mirror_kbps: m?.prev_mirror_kbps ?? 2048 })
    await save({ phase: 'done', done_ms: Date.now(), disabled_old: !!disableOld })
  }
  const cancel = async () => {
    if (!window.confirm('이관을 취소할까요? 삭제 모드·미러링 속도를 원래대로 돌리고 백업을 재개합니다.')) return
    await api.backup.setPolicy({ ...policy, paused: false, delete_mode: m?.prev_delete_mode || policy.delete_mode, mirror_kbps: m?.prev_mirror_kbps ?? policy.mirror_kbps })
    setBusy(true); try { await api.backup.setMigration(null); setM(null); refresh?.() } finally { setBusy(false) }
  }
  const ms = newT?.mirror_state
  const pct = ms && (ms.done || ms.todo) ? Math.round((ms.done / Math.max(1, ms.done + ms.todo)) * 100) : 0

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal nas-wiz" onClick={(e) => e.stopPropagation()}>
        <header className="nas-h"><b>NAS 이관</b><span className="muted small">백업 저장소를 더 큰 NAS 로 옮기기 — 단계 상태는 라우터에 저장되어 새로고침해도 이어집니다</span><span className="spacer" /><button className="icon" onClick={onClose} title="닫기 (진행 상태는 유지)">✕</button></header>
        <ol className="nas-steps">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step && phase !== 'idle' ? 'cur' : ''}><i>{i + 1}</i>{s}</li>)}</ol>
        {err && <p className="err small">{err}</p>}

        {phase === 'idle' && (
          <section className="nas-body">
            <h4>시작 전 확인</h4>
            <ul className="nas-facts">
              <li>로컬 저장 <b>{fmtBytes(st.store_bytes)}</b>{st.store_cap ? ` / 상한 ${fmtBytes(st.store_cap)}` : ''} · 디스크 여유 <b>{fmtBytes(st.disk_free)}</b></li>
              <li>백업 대상 <b>{targets.filter((t) => t.enabled).length}</b>개 켜짐 · 아직 백업 안 된 파일 <b>{(pend.files || 0).toLocaleString()}</b>개 ({fmtBytes(pend.bytes || 0)})</li>
              <li>저장 증가 속도 <b>{rate ? `${fmtBytes(rate)}/s (${fmtBytes(rate * 3600)}/시간)` : '측정 중…'}</b></li>
            </ul>
            <p className="muted small">① 은 삭제 모드를 잠시 '검증 직후'로 바꿔 백업된 파일부터 로컬에서 비웁니다. 파형은 백업 대상에 남아 이력 조회는 그대로입니다.</p>
            <div className="toolbar"><button className="primary" onClick={start} disabled={busy || !targets.some((t) => t.enabled)}>① 로컬 비우기 시작</button>{!targets.some((t) => t.enabled) && <span className="muted small">켜진 백업 대상이 있어야 로컬을 비울 수 있습니다</span>}</div>
          </section>
        )}

        {phase === 'empty' && (
          <section className="nas-body">
            <h4>① 로컬 비우기 — 백업 최대로, 검증된 파일은 바로 삭제</h4>
            <ul className="nas-facts">
              <li>남은 백업 <b>{(pend.files || 0).toLocaleString()}</b>개 ({fmtBytes(pend.bytes || 0)}) · 전송 중 {(st.inflight || []).length} · 대기 {st.queue || 0}</li>
              <li>로컬 저장 <b>{fmtBytes(st.store_bytes)}</b> · 디스크 여유 <b>{fmtBytes(st.disk_free)}</b> · 지울 수 있는(백업 완료) <b>{fmtBytes(safeFree)}</b></li>
              <li>지금 여유로 로컬만 버틸 수 있는 시간 <b>{fmtDur(hold)}</b> <span className="muted">(증가 {rate ? fmtBytes(rate * 3600) + '/시간' : '측정 중'})</span></li>
            </ul>
            <p className="muted small">남은 백업이 0 에 가까워지고 여유 시간이 설정 작업에 충분하면 다음 단계로. 이 단계에서는 백업이 계속 돌아갑니다.</p>
            <div className="toolbar"><button className="primary" onClick={toWindow} disabled={busy}>② 설정 시간 시작 (백업 일시 중지)</button><button onClick={cancel} disabled={busy}>취소</button></div>
          </section>
        )}

        {phase === 'window' && (
          <section className="nas-body">
            <h4>② 설정 시간 — 백업이 멈춰 있습니다. NAS 를 연결·마운트하세요</h4>
            <div className="nas-hold"><small>로컬만으로 버틸 수 있는 시간</small><b className={hold < 3600 ? 'err' : hold < 4 * 3600 ? 'warn' : ''}>{fmtDur(hold)}</b><small>여유 {fmtBytes(room)} · 증가 {rate ? fmtBytes(rate * 3600) + '/시간' : '측정 중'} · 시작 {m?.window_ms ? new Date(m.window_ms).toLocaleTimeString('ko-KR') : ''}</small></div>
            <p className="muted small">NAS 마운트(예: <code>/mnt/nas2</code>)나 FTP/SFTP 계정을 준비한 뒤 ③ 으로 넘어가세요. 촉박하면 '백업 재개'로 기존 대상에 백업하며 준비해도 됩니다.</p>
            <div className="toolbar"><button className="primary" onClick={toConnect} disabled={busy}>③ 새 NAS 연결</button><button onClick={async () => { await api.backup.setPolicy({ ...policy, paused: false }); refresh?.() }} disabled={busy}>백업 재개(기존 대상)</button><button onClick={cancel} disabled={busy}>취소</button></div>
          </section>
        )}

        {phase === 'connect' && (
          <section className="nas-body">
            <h4>③ 새 NAS 연결 — 대상을 추가하고 연결 시험</h4>
            <div className="toolbar"><button className="primary" onClick={() => onAddTarget({ kind: 'nas', name: '새 NAS', mirror: true })}>+ 새 NAS 대상 추가</button><span className="muted small">추가 창에서 "연결 시험"으로 확인한 뒤 저장 — 미러링 옵션이 켜진 채로 만들어집니다</span></div>
            <h5>새 NAS 로 쓸 대상 선택</h5>
            <div className="nas-pick">{targets.map((t) => <label key={t.id} className={'nas-pick-i' + (m?.new_target_id === t.id ? ' on' : '')}><input type="radio" name="newt" checked={m?.new_target_id === t.id} onChange={() => pickNew(t.id)} /><b>{t.name}</b><small className="muted">{t.kind} · {t.path || t.host}{t.enabled ? '' : ' · 꺼짐'}</small></label>)}</div>
            <div className="toolbar"><button className="primary" onClick={toMigrate} disabled={busy || !newT}>④ 이관 시작 (미러링 · 속도 제한 해제)</button><button onClick={cancel} disabled={busy}>취소</button></div>
          </section>
        )}

        {phase === 'migrate' && (
          <section className="nas-body">
            <h4>④ 이관 — {newT?.name || '새 대상'} 으로 기존 백업을 복사하는 중</h4>
            <div className="nas-prog"><div className="nas-bar"><i style={{ width: `${pct}%` }} /></div><b>{pct}%</b></div>
            <ul className="nas-facts">
              <li>완료 <b>{(ms?.done || 0).toLocaleString()}</b>개 ({fmtBytes(ms?.bytes || 0)}) · 남음 <b>{(ms?.todo || 0).toLocaleString()}</b>개 · 오류 {ms?.errors || 0}{ms?.last_err ? <span className="err"> · {ms.last_err}</span> : null}</li>
              <li>지금 파일 <span className="mono small">{ms?.current || '—'}</span></li>
              <li>백업은 재개된 상태 — 새 파일은 우선순위대로 백업되고, 옛 파일은 미러링으로 따라갑니다</li>
            </ul>
            {ms && !ms.running && ms.todo === 0 && <p className="ok"><b>이관 완료</b> — 기존 대상의 파일이 모두 새 대상에 있습니다.</p>}
            <label className="chk"><input type="checkbox" checked={!!m?.disable_old} onChange={(e) => save({ disable_old: e.target.checked })} /> 마무리할 때 기존 대상 사용 중지</label>
            <div className="toolbar"><button className="primary" onClick={() => toFinish(!!m?.disable_old)} disabled={busy || !(ms && !ms.running && ms.todo === 0)}>⑤ 마무리 (새 대상 1순위 · 설정 원복)</button><button onClick={cancel} disabled={busy}>취소</button></div>
          </section>
        )}

        {phase === 'done' && (
          <section className="nas-body">
            <h4>⑤ 완료</h4>
            <ul className="nas-facts">
              <li>새 대상 <b>{newT?.name}</b> 이 1순위{m?.disabled_old ? ' · 기존 대상은 사용 중지' : ''}</li>
              <li>삭제 모드 <b>{policy.delete_mode === 'cap' ? '상한 도달 시' : '검증 직후'}</b> · 미러링 속도 <b>{policy.mirror_kbps ? `${policy.mirror_kbps} KB/s` : '제한 없음'}</b> 로 원복</li>
              <li>새 대상의 "미러링"은 켜 둔 상태라 앞으로도 다른 대상과 저속으로 계속 맞춥니다 (끄려면 대상 카드에서)</li>
            </ul>
            <div className="toolbar"><button className="primary" onClick={async () => { await api.backup.setMigration(null); setM(null); onClose() }}>닫기</button></div>
          </section>
        )}
      </div>
    </div>
  )
}
