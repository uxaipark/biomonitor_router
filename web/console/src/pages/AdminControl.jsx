import React, { useState } from 'react'
import { api, usePoll } from '../api.js'
import { can, useMe } from '../auth.js'

/**
 * 운영관리 › 서비스 제어 — 라우터 주요 서비스를 한 곳에서 멈추고 다시 켠다.
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
// 서버 교체 순서: 끌 때는 바깥(알림·외부 전송)부터 막고 수신·저장을 마지막에, 켤 때는 받을 준비 → 수신 → 표시 → 알림·외부 전송 순
const ORDER = {
  stop: [
    ['alarm', '곧 연결이 끊기며 쏟아질 무응답·끊김 알람을 막습니다(위험 등급은 유지).'],
    ['emr', '교체 중 비거나 중복된 바이탈이 EMR에 기록되지 않게 합니다.'],
    ['backup', '가능하면 백업 대기 0을 확인한 뒤 멈춥니다.'],
    ['sync', '옮기는 동안 입원 명단이 바뀌지 않게 고정합니다.'],
    ['stream', '병동에 알린 뒤 중앙 모니터 파형을 끕니다.'],
    ['ingest', '게이트웨이는 못 보낸 데이터를 쌓아 두고 재접속을 시도합니다.'],
    ['store', '수신이 멈춘 뒤 마지막 기록까지 쓴 상태로 고정합니다. 이후 라우터를 끄고 data/ 를 복사합니다.'],
  ],
  start: [
    ['store', '데이터가 들어오기 전에 기록할 준비를 합니다.'],
    ['sync', '환자 이름·병실이 먼저 채워져야 들어오는 데이터가 누구인지 보입니다.'],
    ['ingest', '게이트웨이 연결 수가 예상치까지 오르고 유실·재전송이 안정되는지 봅니다.'],
    ['stream', '병동 한 곳에서 중앙 모니터 파형이 나오는지 확인합니다.'],
    ['alarm', '재접속 직후의 무응답 알람이 풀린 뒤(1~2분) 억제를 끝냅니다.'],
    ['emr', 'EMR 연동 화면에서 환자 매칭 수가 교체 전과 같은지 확인한 뒤 켭니다.'],
    ['backup', '밀린 파일을 한꺼번에 올리므로 마지막에. 먼저 백업 대상 연결 시험.'],
  ],
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
  const [mode, setMode] = useState('') // '' = 자동: 멈춘 게 있으면 켜는 순서, 없으면 끄는 순서
  const done = (r) => { setMsg(''); refresh?.(); window.dispatchEvent(new Event('control-changed')); return r }
  const act = async (svc, body) => {
    try { await api.control.set(svc, body); done() } catch (e) { setMsg(e.message) }
  }
  if (err) return <div className="page"><h2 className="h">서비스 제어</h2><p className="err">{err.message}</p></div>
  if (!st) return <div className="page"><p className="muted">불러오는 중…</p></div>
  // 서버가 status 에 dev_mode 를 아직 주지 않으면(구 바이너리) 로그인 정보의 값을 쓴다
  const dev = st.dev_mode ?? !!me?.dev_mode
  return (
    <div className="page ctl">
      <div className="ctl-head">
        <h2 className="h">서비스 제어</h2>
        <span className={'pill ' + (st.stopped ? 'warn' : 'ok')}>{st.stopped ? `${st.stopped}개 멈춤` : '모두 정상'}</span>
        <span className="muted">{dev
          ? '개발 모드: 사유 없이 스위치 한 번으로 켜고 끕니다(기록에는 "개발 모드"로 남음). 운영 모드로 바꾸면 사유가 필수가 됩니다.'
          : '멈추면 모든 화면 위에 띠로 알리고 감사 기록에 남습니다. 라우터를 재시작해도 멈춘 상태는 유지됩니다(알람 억제만 풀림).'}</span>
        <ModeSwitch me={me} dev={dev} />
      </div>
      {msg && <p className="err">{msg}</p>}
      <Maintenance st={st} edit={edit} dev={dev} onDone={done} setMsg={setMsg} />
      {st.reset && <FullReset r={st.reset} me={me} dev={dev} onDone={done} setMsg={setMsg} />}
      {(() => {
        const m = mode || (st.stopped ? 'start' : 'stop')
        const bySvc = new Map(st.services.map((s) => [s.service, s]))
        return <>
          <div className="ctl-order">
            <span className="seg">
              <button className={m === 'stop' ? 'active' : ''} onClick={() => setMode('stop')}>끄는 순서 (서버 교체 전)</button>
              <button className={m === 'start' ? 'active' : ''} onClick={() => setMode('start')}>켜는 순서 (서버 교체 후)</button>
            </span>
            <span className="muted small">{m === 'stop'
              ? '바깥(알림·EMR·백업)부터 막고 수신·저장을 마지막에 멈춥니다. 멈춘 상태는 router.db 에 남아 data/ 를 옮긴 새 서버도 멈춘 채로 시작합니다(알람 억제만 풀리므로 새 서버에서 다시 억제).'
              : '받을 준비(저장·환자 정보) → 수신 → 화면 → 알림·EMR → 백업 순으로 켭니다. 단계마다 확인한 뒤 다음으로 넘어가세요.'}</span>
          </div>
          <div className="ctl-grid">
            {ORDER[m].map(([svc, hint], i) => bySvc.get(svc) && <ServiceCard key={svc} s={bySvc.get(svc)} edit={edit} dev={dev} onAct={act} step={i + 1} hint={hint} mode={m} />)}
          </div>
        </>
      })()}
    </div>
  )
}

/** 개발 모드 ↔ 운영 모드 — 권한 설정 페이지의 개발 모드와 같은 스위치(auth.dev_mode, 수퍼 어드민만). 개발 모드면 사유 없이 켜고 끈다. */
function ModeSwitch({ me, dev }) {
  const [busy, setBusy] = useState(false)
  const sa = me?.user?.role === 'super_admin'
  const flip = async () => {
    if (!sa || busy) return
    if (dev && !window.confirm('운영 모드로 바꾸면 서비스를 멈출 때 사유가 필수가 되고, 수퍼 어드민도 개인정보·생체신호가 가려지며 로그인 화면의 시험용 계정 표시가 사라집니다. 계속할까요?')) return
    if (!dev && !window.confirm('개발 모드로 바꾸면 사유 없이 서비스를 멈추고 켤 수 있고, 수퍼 어드민이 전체 권한을 갖습니다. 병원 운영 중에는 쓰지 마세요. 계속할까요?')) return
    setBusy(true)
    try { await api.admin.devMode(!dev); window.location.reload() } catch (e) { window.alert(e.message); setBusy(false) }
  }
  return (
    <span className={'ctl-mode seg' + (dev ? ' dev' : '')} title={sa ? '수퍼 어드민만 바꿀 수 있습니다' : '수퍼 어드민만 바꿀 수 있습니다 (보기만)'}>
      <button className={dev ? 'active' : ''} disabled={!sa || busy} onClick={() => !dev && flip()}>개발 모드</button>
      <button className={!dev ? 'active' : ''} disabled={!sa || busy} onClick={() => dev && flip()}>운영 모드</button>
    </span>
  )
}

function ServiceCard({ s, edit, dev, onAct, step, hint, mode }) {
  const info = INFO[s.service] || {}
  const [reason, setReason] = useState('')
  const [auto, setAuto] = useState(s.service === 'alarm' ? 30 : 0)
  const [keepCrit, setKeepCrit] = useState(true)
  const [open, setOpen] = useState(false) // 켜진 스위치를 누르면 멈춤 입력이 펼쳐진다
  const stop = () => {
    if (!reason.trim()) { window.alert('멈추는 사유를 적어 주세요'); return }
    if (info.danger && !window.confirm(`${s.label}을(를) 멈춥니다.\n\n${info.stop}\n\n계속할까요?`)) return
    setOpen(false)
    onAct(s.service, { on: false, reason, minutes: auto || undefined, keep_critical: keepCrit })
  }
  const flip = () => {
    if (!edit) return
    // 개발 모드: 사유·확인 없이 바로 켜고 끈다
    if (dev) { setOpen(false); onAct(s.service, s.on ? { on: false, minutes: s.service === 'alarm' ? 30 : undefined, keep_critical: true } : { on: true }); return }
    if (s.on) { setOpen(!open); return }
    if (window.confirm(`${s.label}을(를) ${s.service === 'alarm' ? '다시 알리게' : '다시 켜게'} 합니다. 계속할까요?`)) onAct(s.service, { on: true })
  }
  const stateText = s.on ? '동작 중' : s.service === 'alarm' ? '억제 중' : '멈춤'
  return (
    <section className={'ctl-card' + (s.on ? '' : ' off') + (info.danger ? ' danger' : '')}>
      <header>
        {step && <span className={'ctl-step' + ((mode === 'stop' ? !s.on : s.on) ? ' done' : '')} title={mode === 'stop' ? '끄는 순서' : '켜는 순서'}>{step}</span>}
        <b>{s.label}</b>
        {/* 상태 표시 겸 스위치: 켜짐 → 누르면 멈춤 입력 펼침, 멈춤 → 누르면 확인 후 다시 켬 */}
        <button role="switch" aria-checked={s.on} className={'ctl-switch' + (s.on ? ' on' : ' off') + (open ? ' pending' : '')} onClick={flip} disabled={!edit}
          title={!edit ? '권한이 없어 바꿀 수 없습니다' : dev ? (s.on ? '멈추기 (개발 모드: 사유 없음)' : '다시 켜기') : s.on ? (open ? '멈춤 입력 닫기' : '멈추기 — 사유를 적습니다') : '다시 켜기'}>
          <span className="ctl-knob" /><span className="ctl-sw-text">{stateText}</span>
        </button>
      </header>
      {hint && <p className="ctl-hint small">{mode === 'stop' ? '끌 때' : '켤 때'}: {hint}</p>}
      {s.on ? (
        <>
          <p className="muted small">{info.stop}</p>
          {edit && open && (
            <div className="ctl-form">
              <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && stop()} placeholder="사유 (필수) — 예: 게이트웨이 교체 작업" />
              <select value={auto} onChange={(e) => setAuto(Number(e.target.value))}>
                {(s.service === 'alarm' ? MUTE : AUTO).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {s.service === 'alarm' && <label className="chk"><input type="checkbox" checked={keepCrit} onChange={(e) => setKeepCrit(e.target.checked)} /> 위험 등급은 계속 알림</label>}
              <button className={info.danger ? 'danger' : 'primary'} onClick={stop}>{s.service === 'alarm' ? '알림 억제' : '멈추기'}</button>
              <button onClick={() => setOpen(false)}>취소</button>
            </div>
          )}
        </>
      ) : (
        <dl className="ctl-kv">
          <dt>사유</dt><dd>{s.reason || '—'}{s.maintenance ? ' (유지보수 모드)' : ''}</dd>
          <dt>누가 · 언제</dt><dd>{s.by || '—'} · {fmt(s.at_ms)}</dd>
          <dt>{s.service === 'alarm' ? '남은 시간' : '자동 재개'}</dt><dd>{s.until_ms ? `${left(s.until_ms)} 뒤 (${fmt(s.until_ms)})` : '수동으로 켤 때까지'}</dd>
        </dl>
      )}
    </section>
  )
}

/**
 * 가동 초기화: 모든 서비스를 멈춘 상태에서 로컬 파형 저장소와 원격 백업 파일을 모두 지우고, 카운터·운영 통계·알람·
 * 패치/게이트웨이 표를 비운 뒤 서비스를 다시 켠다. 되돌릴 수 없으므로 확인 문구를 그대로 입력해야 하고,
 * 권한은 '백업 파일 전체 삭제'(기본 수퍼 어드민)가 필요하다. 진행 상태는 3초마다 갱신된다.
 */
const STEP_ICON = { wait: '○', run: '◐', ok: '●', fail: '✕', skip: '–' }
function FullReset({ r, me, dev, onDone, setMsg }) {
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const allowed = can(me, 'action.backup_purge', 2)
  const running = !!r.running
  // 개발 모드: 서비스 제어와 같이 사유·확인 문구 없이 실행 (브라우저 확인 대화만)
  const ready = dev || (confirm.trim() === r.confirm && reason.trim())
  const go = async () => {
    if (!ready || busy) return
    const names = (r.targets || []).map((t) => `${t.name} (${t.kind}${t.enabled ? '' : ', 꺼짐'})`)
    if (!window.confirm(`가동 초기화를 시작합니다. 되돌릴 수 없습니다.\n\n• 모든 서비스 멈춤 → 게이트웨이 연결 끊김\n• 로컬 파형 저장소 전체 삭제\n• 원격 백업 파일 전체 삭제: ${names.length ? names.join(', ') : '(대상 없음)'}\n• 카운터·운영 통계·알람·패치/게이트웨이 표 비움\n• 서비스 다시 켬\n\n계속할까요?`)) return
    setBusy(true)
    try { await api.control.reset({ confirm: confirm.trim(), reason: reason.trim() }); setOpen(false); setConfirm(''); onDone() } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }
  const last = !running && r.done_ms > 0 // 불리언으로 — 숫자 0 을 쓰면 React 가 '0' 을 그린다
  return (
    <section className={'ctl-maint ctl-reset' + (running ? ' on' : '')}>
      <div style={{ flex: 1, minWidth: 260 }}>
        <b>가동 초기화</b> {running && <span className="tag small warn">진행 중</span>}{last && !r.error && <span className="tag small ok">완료 {fmt(r.done_ms)}</span>}{last && r.error && <span className="tag small err">일부 실패 {fmt(r.done_ms)}</span>}
        <p className="muted small">모든 서비스를 멈춘 상태에서 <b>로컬 파형 저장소</b>와 <b>원격 백업 서버의 파일</b>({(r.targets || []).length ? (r.targets || []).map((t) => t.name).join(', ') : '대상 없음'})을 모두 지우고,
          카운터·운영 통계·알람·패치/게이트웨이 표를 비운 뒤 서비스를 다시 켭니다. 되돌릴 수 없습니다. 설정(계정·권한·백업 대상·정책·그룹)은 그대로 둡니다.</p>
        {(running || last) && (
          <ol className="ctl-reset-steps small">
            {(r.steps || []).map((s) => <li key={s.key} className={s.state}><span className="ico">{STEP_ICON[s.state] || '○'}</span> {s.label}{s.detail ? <span className="muted"> — {s.detail}</span> : null}</li>)}
          </ol>
        )}
        {last && <p className={'small ' + (r.error ? 'err' : 'muted')}>{r.by} · 시작 {fmt(r.started_ms)} · {r.reason || '개발 모드'}{r.error ? ` · ${r.error}` : ''}</p>}
      </div>
      {allowed && !running && dev && <button className="danger" disabled={busy} onClick={go} title="개발 모드: 사유·확인 문구 없이 실행 (확인 대화만)">가동 초기화 실행 (개발 모드)</button>}
      {allowed && !running && !dev && (open
        ? <div className="ctl-form" style={{ flexDirection: 'column', alignItems: 'stretch', minWidth: 300 }}>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 (필수) — 예: 시범 운영 종료, 실운영 시작" />
            <input value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} placeholder={`확인 문구 "${r.confirm}" 입력`} />
            <div className="ctl-form">
              <button className="danger" disabled={!ready || busy} onClick={go}>가동 초기화 실행</button>
              <button onClick={() => { setOpen(false); setConfirm('') }}>취소</button>
            </div>
          </div>
        : <button className="danger" onClick={() => setOpen(true)}>가동 초기화…</button>)}
      {!allowed && !running && <span className="muted small">'백업 파일 전체 삭제' 권한이 있어야 실행할 수 있습니다</span>}
    </section>
  )
}

/** 유지보수 모드: 백업·EMR 전송 멈춤 + 알람 알림 억제(최대 60분)를 한 번에, 끝낼 때도 한 번에 */
function Maintenance({ st, edit, dev, onDone, setMsg }) {
  const [reason, setReason] = useState('')
  const [min, setMin] = useState(60)
  const on = st.maintenance
  const go = async (start) => {
    if (start && !reason.trim() && !dev) { window.alert('사유를 적어 주세요'); return }
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
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={dev ? '사유 (개발 모드: 생략 가능)' : '사유 (필수) — 예: NAS 점검'} />
            <select value={min} onChange={(e) => setMin(Number(e.target.value))}>{MUTE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <button onClick={() => go(true)}>유지보수 시작</button>
          </div>)}
    </section>
  )
}
