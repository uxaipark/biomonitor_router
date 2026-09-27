import React, { useState } from 'react'
import { api, usePoll } from '../api.js'
import { can, useMe } from '../auth.js'

/**
 * 관리 › 서비스 제어 — 라우터 주요 서비스를 한 곳에서 멈추고 다시 켠다.
 * 멈출 때는 사유가 필요하고, 자동 재개 시간을 고를 수 있다. 알람은 '알림 억제'만(판정·기록은 계속, 최대 60분).
 * 모든 변경은 감사 기록에 남고, 멈춘 동안 모든 화면 위에 띠가 뜬다.
 */
const INFO = {
  ingest: { stop: '게이트웨이 연결을 받지 않고 열린 연결을 끊습니다. 모든 환자의 실시간 수신·알람 판정·저장이 멈춥니다. 게이트웨이는 계속 재접속을 시도하고, 다시 켜면 곧 붙습니다.', danger: true },
  store: { stop: '파형 기록만 건너뜁니다. 실시간 화면·알람은 계속되지만 멈춘 동안의 파형은 나중에 볼 수 없습니다.', danger: true },
  stream: { stop: '중앙 모니터·뷰어·환자 창으로 가는 실시간 파형이 멈춥니다. 수신·저장·알람은 계속됩니다.', danger: true },
  alarm: { stop: '알람 판정과 기록은 계속하고 화면 알림(깜박임·강조)만 억제합니다. 최대 60분, 시간이 지나면 저절로 다시 켜집니다.' },
  backup: { stop: '백업을 멈춥니다(전송 중인 파일까지 끊음). 로컬 저장은 계속되고, 다시 켜면 밀린 파일부터 올립니다.' },
  emr: { stop: 'EMR 바이탈 전송을 멈춥니다. 재원 명단·입퇴원 수신은 계속됩니다.' },
  sync: { stop: '에뮬레이터 EMR 동기화(입원 목록·환자 정보)를 멈춥니다. 새 입원·전동이 반영되지 않습니다.' },
}
const AUTO = [[0, '자동 재개 없음'], [15, '15분 뒤'], [30, '30분 뒤'], [60, '1시간 뒤'], [240, '4시간 뒤']]
const MUTE = [[10, '10분'], [15, '15분'], [30, '30분'], [45, '45분'], [60, '60분 (최대)']]
const fmt = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')
const left = (u) => { if (!u) return ''; const s = Math.max(0, Math.round((u - Date.now()) / 1000)); const m = Math.floor(s / 60); return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분 ${s % 60}초` }

export default function AdminControl() {
  const me = useMe()
  const edit = can(me, 'page.service_control', 2)
  const [st, err, refresh] = usePoll(api.control.status, 3000)
  const [msg, setMsg] = useState('')
  const done = (r) => { setMsg(''); refresh?.(); window.dispatchEvent(new Event('control-changed')); return r }
  const act = async (svc, body) => {
    try { await api.control.set(svc, body); done() } catch (e) { setMsg(e.message) }
  }
  if (err) return <div className="page"><h2 className="h">서비스 제어</h2><p className="err">{err.message}</p></div>
  if (!st) return <div className="page"><p className="muted">불러오는 중…</p></div>
  return (
    <div className="page ctl">
      <div className="ctl-head">
        <h2 className="h">서비스 제어</h2>
        <span className={'pill ' + (st.stopped ? 'warn' : 'ok')}>{st.stopped ? `${st.stopped}개 멈춤` : '모두 정상'}</span>
        <span className="muted">멈추면 모든 화면 위에 띠로 알리고 감사 기록에 남습니다. 라우터를 재시작해도 멈춘 상태는 유지됩니다(알람 억제만 풀림).</span>
      </div>
      {msg && <p className="err">{msg}</p>}
      <Maintenance st={st} edit={edit} onDone={done} setMsg={setMsg} />
      <div className="ctl-grid">
        {st.services.map((s) => <ServiceCard key={s.service} s={s} edit={edit} onAct={act} />)}
      </div>
    </div>
  )
}

function ServiceCard({ s, edit, onAct }) {
  const info = INFO[s.service] || {}
  const [reason, setReason] = useState('')
  const [auto, setAuto] = useState(s.service === 'alarm' ? 30 : 0)
  const [keepCrit, setKeepCrit] = useState(true)
  const stop = () => {
    if (!reason.trim()) { window.alert('멈추는 사유를 적어 주세요'); return }
    if (info.danger && !window.confirm(`${s.label}을(를) 멈춥니다.\n\n${info.stop}\n\n계속할까요?`)) return
    onAct(s.service, { on: false, reason, minutes: auto || undefined, keep_critical: keepCrit })
  }
  return (
    <section className={'ctl-card' + (s.on ? '' : ' off') + (info.danger ? ' danger' : '')}>
      <header>
        <b>{s.label}</b>
        <span className={'tag small ' + (s.on ? 'ok' : 'warn')}>{s.on ? '동작 중' : s.service === 'alarm' ? '억제 중' : '멈춤'}</span>
      </header>
      {s.on ? (
        <>
          <p className="muted small">{info.stop}</p>
          {edit && (
            <div className="ctl-form">
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (필수) — 예: 게이트웨이 교체 작업" />
              <select value={auto} onChange={(e) => setAuto(Number(e.target.value))}>
                {(s.service === 'alarm' ? MUTE : AUTO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {s.service === 'alarm' && <label className="chk"><input type="checkbox" checked={keepCrit} onChange={(e) => setKeepCrit(e.target.checked)} /> 위험 등급은 계속 알림</label>}
              <button className={info.danger ? 'danger' : ''} onClick={stop}>{s.service === 'alarm' ? '알림 억제' : '멈추기'}</button>
            </div>
          )}
        </>
      ) : (
        <>
          <dl className="ctl-kv">
            <dt>사유</dt><dd>{s.reason || '—'}{s.maintenance ? ' (유지보수 모드)' : ''}</dd>
            <dt>누가 · 언제</dt><dd>{s.by || '—'} · {fmt(s.at_ms)}</dd>
            <dt>{s.service === 'alarm' ? '남은 시간' : '자동 재개'}</dt><dd>{s.until_ms ? `${left(s.until_ms)} 뒤 (${fmt(s.until_ms)})` : '수동으로 켤 때까지'}</dd>
          </dl>
          {edit && <button className="primary" onClick={() => onAct(s.service, { on: true })}>{s.service === 'alarm' ? '억제 끝내기' : '다시 켜기'}</button>}
        </>
      )}
    </section>
  )
}

/** 유지보수 모드: 백업·EMR 전송 멈춤 + 알람 알림 억제(최대 60분)를 한 번에, 끝낼 때도 한 번에 */
function Maintenance({ st, edit, onDone, setMsg }) {
  const [reason, setReason] = useState('')
  const [min, setMin] = useState(60)
  const on = st.maintenance
  const go = async (start) => {
    if (start && !reason.trim()) { window.alert('사유를 적어 주세요'); return }
    try { await api.control.maintenance(start ? { on: false, reason, minutes: min, keep_critical: true } : { on: true }); onDone() } catch (e) { setMsg(e.message) }
  }
  return (
    <section className={'ctl-maint' + (on ? ' on' : '')}>
      <div>
        <b>유지보수 모드</b> {on && <span className="tag small warn">진행 중</span>}
        <p className="muted small">백업·EMR 전송을 멈추고 알람 알림을 억제합니다(위험 등급은 계속 알림). 정한 시간이 지나면 셋 다 저절로 다시 켜집니다.</p>
      </div>
      {edit && (on
        ? <button className="primary" onClick={() => go(false)}>유지보수 끝내기</button>
        : <div className="ctl-form">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (필수) — 예: NAS 점검" />
            <select value={min} onChange={(e) => setMin(Number(e.target.value))}>{MUTE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <button onClick={() => go(true)}>유지보수 시작</button>
          </div>)}
    </section>
  )
}
