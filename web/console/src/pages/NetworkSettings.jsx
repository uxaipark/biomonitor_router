import React, { useEffect, useState } from 'react'
import { api, usePoll } from '../api.js'
import { latencyNow } from '../ws.js'
import { can, useMe } from '../auth.js'
import { ReadOnly } from '../ReadOnly.jsx'
import './NetworkSettings.css'

/**
 * 운영관리 › 네트워크 설정: 라우터가 접속하는 상대 주소(에뮬레이터·분석 서버·DB API)를 브라우저에서 지정한다.
 * 저장하면 router.db 에 남고 재시작 없이 반영된다. 비우고 저장하면 환경변수 값으로 돌아간다.
 */
const FIELDS = [
  {
    key: 'emulator_addr', kind: 'emulator', label: '에뮬레이터 (RP5#1)', ph: '192.168.0.125 (포트 생략 시 5445)', port: 5445,
    desc: '환자 명단·병동·도면(EMR API)을 가져오고 라우터 상태를 보고하는 곳입니다. 비어 있으면 병원 지도와 환자 정보가 "HTTP 503"으로 실패합니다.',
    env: 'ROUTER_EMULATOR_ADDR',
  },
  {
    key: 'analysis_addr', kind: 'analysis', label: '분석 서버', ph: '127.0.0.1 (포트 생략 시 7100)', port: 7100,
    desc: 'ECG 를 넘겨 HR·부정맥 분석을 받는 곳입니다. 연결되지 않으면 파형은 그대로 통과하고 분석 값만 빠집니다.',
    env: 'ROUTER_ANALYSIS_ADDR',
  },
  {
    key: 'db_addr', kind: 'db', label: 'DB API', ph: '127.0.0.1 (포트 생략 시 7601)', port: 7601,
    desc: '환자·패치 메타를 밀어 넣는 곳입니다. 없어도 라우터 동작에는 지장이 없습니다.',
    env: 'ROUTER_DB_ADDR',
  },
]

const SOURCE = { db: '저장값', env: '환경변수', unset: '없음' }
/** 필수 = 없으면 환자·지도가 실패, 선택 = 없어도 라우터는 동작 */
const REQUIRED = { emulator: true }

/** 전송 지연 시계 보정 — 에뮬레이터 시계가 앞서 음수 나이가 보이면 그 최대 절대값을 보정값으로 두고 모든 지연에 더한다. 여기서 또는 가동 초기화 때만 0 으로. */
function LatencyCard({ canEdit = true }) {
  const [stats, , refresh] = usePoll(api.stats, 5000)
  const [msg, setMsg] = useState('')
  const l = stats?.latency || {}
  // 라우터(웹서버) ↔ 브라우저(이 PC): HTTP 왕복(RTT)과 편도 추정(RTT/2), 시계 차 = 서버 시각 − 왕복 중간 시각. 5초마다, 최근 12회 중앙값.
  // 사용자 디바이스는 시계 관리가 안 되는 경우가 많아 대략적인 파악 용도(사용자 결정).
  const [http, setHttp] = useState(null)
  const [ws, setWs] = useState(null)
  useEffect(() => {
    let dead = false; const rtts = [], diffs = []
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null }
    const probe = async () => {
      const t0 = Date.now()
      try {
        const r = await api.time(); const t3 = Date.now()
        rtts.push(t3 - t0); diffs.push(r.now_ms - (t0 + t3) / 2)
        if (rtts.length > 12) { rtts.shift(); diffs.shift() }
        if (!dead) setHttp({ rtt: med(rtts), oneWay: Math.round(med(rtts) / 2), diff: Math.round(med(diffs)), n: rtts.length })
      } catch { /* 다음 회차 */ }
      if (!dead) setWs(latencyNow())
    }
    probe(); const t = setInterval(probe, 5000)
    return () => { dead = true; clearInterval(t) }
  }, [])
  const reset = async () => {
    if (!window.confirm(`지연시간 계산을 리셋합니다. 시계 보정값 ${l.offset_ms ?? 0} ms 와 표본이 0 이 되고, 다음 프레임부터 다시 계산합니다. 계속할까요?`)) return
    try { await api.net.latencyReset(); setMsg('리셋했습니다.'); refresh?.() } catch (e) { setMsg('실패: ' + e.message) }
  }
  return (
    <section>
      <h3>전송 지연 · 시계 보정 <small className="muted" style={{ fontWeight: 400, fontSize: 12, marginLeft: 8 }}>기준 지표는 에뮬레이터 → 라우터 구간</small></h3>
      <div className="kv">
        <div><small>에뮬레이터 → 라우터 (보정 후)</small><span>{l.n ? <>p50 <b>{l.p50} ms</b> · p95 {l.p95} ms · 최소 {l.min} · 최대 {l.max} · 표본 {l.n.toLocaleString()}</> : '프레임 없음'}</span></div>
        <div><small>시계 보정값 (라우터)</small><span><b>{l.offset_ms ?? 0} ms</b> <span className="muted">— 관측된 음수 나이의 최대 절대값(에뮬레이터 시계 앞섬). 모든 지연 표시에 더해집니다.</span></span></div>
        <div><small>라우터 → 이 PC · HTTP <span className="muted">(참고용)</span></small><span>{http ? <>편도 약 <b>{http.oneWay} ms</b> · 왕복 {http.rtt} ms · 시계 차 {http.diff > 0 ? '+' : ''}{http.diff} ms <span className="muted">(라우터 − 브라우저, 왕복 중간 시각 기준, 최근 {http.n}회 중앙값)</span></> : '측정 중…'}</span></div>
        <div><small>라우터 → 이 PC · WS <span className="muted">(참고용)</span></small><span>{ws && ws.r2v != null ? <><b>{ws.r2v} ms</b> · 종단 간 {ws.e2e} ms <span className="muted">(뷰어·대시보드가 열려 스트림을 받을 때만{ws.mine?.r2v ? ` · 이 브라우저 보정 +${ws.mine.r2v} ms` : ''})</span></> : <span className="muted">수신 중인 스트림 없음 — 대시보드나 뷰어를 열어 두면 측정됩니다</span>}</span></div>
      </div>
      <p className="muted small" style={{ margin: '8px 0 0' }}>브라우저 쪽 값은 <b>대략적인 파악 용도</b>입니다. 사용자 디바이스는 시계가 관리되지 않는 경우가 많아 편차가 큽니다. 기준 지표는 에뮬레이터→라우터 구간입니다.</p>
      <div className="toolbar" style={{ marginTop: 10, marginBottom: 0 }}>
        <button onClick={reset} disabled={!canEdit} title={canEdit ? '' : '편집 권한이 필요합니다'}>지연시간 계산 리셋</button>
        <span className="muted small">보정값과 표본을 0 으로. 가동 초기화 때도 0 이 됩니다.</span>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </section>
  )
}

export default function NetworkSettings() {
  const canEdit = can(useMe(), 'page.settings_network', 2) // '보기' 면 연결 상태·지연만 보고 주소 변경·리셋은 잠근다
  const [net, err, refresh] = usePoll(api.net.get, 5000)
  const [draft, setDraft] = useState({})
  const [tests, setTests] = useState({})
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (net) setDraft((d) => (Object.keys(d).length ? d : {})) }, [net])
  const valueOf = (k) => (draft[k] !== undefined ? draft[k] : net?.[k]?.value ?? '')
  const dirtyFields = FIELDS.filter((f) => draft[f.key] !== undefined && draft[f.key] !== (net?.[f.key]?.value ?? ''))
  const dirty = dirtyFields.length > 0

  const save = async () => {
    setBusy(true); setMsg('')
    try {
      const body = {}
      for (const f of FIELDS) if (draft[f.key] !== undefined) body[f.key] = draft[f.key]
      const r = await api.net.set(body)
      setDraft({})
      setMsg(r.changed?.length ? `저장했습니다 — ${r.changed.join(', ')} (재시작 없이 적용됨)` : '변경된 내용이 없습니다.')
      refresh?.()
    } catch (e) { setMsg('저장 실패: ' + e.message) } finally { setBusy(false) }
  }
  const test = async (f) => {
    setTests((t) => ({ ...t, [f.key]: { pending: true } }))
    try {
      const r = await api.net.test(f.kind, valueOf(f.key))
      setTests((t) => ({ ...t, [f.key]: r }))
    } catch (e) { setTests((t) => ({ ...t, [f.key]: { ok: false, msg: e.message } })) }
  }

  const emuOk = net?.emulator_connected
  const lastOk = net?.emulator_last_ok_ms ? new Date(net.emulator_last_ok_ms).toLocaleString('ko-KR', { hour12: false }) : '없음'

  return (
    <div className={'page net' + (dirty ? ' has-bar' : '')}>
      <h2 className="h" style={{ marginBottom: 2 }}>네트워크 설정</h2>
      <p className="muted small" style={{ margin: '0 0 12px' }}>라우터가 연결하는 외부 서비스. 저장한 값은 <code>router.db</code> 에 남아 재시작 후에도 유지되며 환경변수보다 우선합니다.</p>
      {err && <p className="err">설정을 불러오지 못했습니다: {String(err.message || err)}</p>}
      <div className="settings">
        <section>
          <h3>연결 상태</h3>
          <div className="kv">
            <div><small>에뮬레이터</small><span className="net-status"><span className={'dot ' + (net ? (emuOk ? 'ok' : 'err') : 'off')} />{net ? (emuOk ? '연결됨' : '응답 없음') : '—'} <span className="muted mono">{net?.emulator_addr?.value || '주소 미설정'}</span></span></div>
            <div><small>에뮬레이터 마지막 정상 응답</small>{lastOk}</div>
            <div><small>분석 서버</small><span className="net-status"><span className={'dot ' + (net ? (net.analysis_connected ? 'ok' : 'warn') : 'off')} />{net ? (net.analysis_connected ? '연결됨' : '연결 안 됨 (패스스루)') : '—'} <span className="muted mono">{net?.analysis_addr?.value}</span></span></div>
            <div><small>수신 대기(ingest) · 웹/API — 환경변수, 재시작 필요</small><span className="mono">{net?.ingest_addr} · {net?.http_addr}</span></div>
          </div>
          {net && !net.emulator_addr?.value && (
            <p className="err" style={{ marginTop: 10 }}>
              에뮬레이터 주소가 없습니다. 아래에 주소를 넣고 저장하면 병원 지도·환자 명단이 바로 살아납니다.
            </p>
          )}
        </section>

        <LatencyCard canEdit={canEdit} />
        <ReadOnly edit={canEdit}>

        <div className="net-cards">
        {FIELDS.map((f) => {
          const cur = net?.[f.key]
          const t = tests[f.key]
          const changed = draft[f.key] !== undefined && draft[f.key] !== (cur?.value ?? '')
          const required = !!REQUIRED[f.kind]
          const conn = f.kind === 'emulator' ? emuOk : f.kind === 'analysis' ? net?.analysis_connected : null
          const src = cur?.source === 'db' ? `저장값 ${cur.value}` : cur?.source === 'env' ? `환경변수 ${f.env}=${cur.env || cur.value || ''}` : `— (미저장)`
          return (
            <section key={f.key} className={'net-card' + (changed ? ' changed' : '') + (required && !cur?.value ? ' missing' : '')}>
              <div className="net-card-h">
                <h3 style={{ margin: 0 }}>{f.label}</h3>
                <span className={'net-req ' + (required ? 'req' : 'opt')}>{required ? '필수' : '선택'}</span>
                {conn != null && <span className="net-status"><span className={'dot ' + (net ? (conn ? 'ok' : required ? 'err' : 'warn') : 'off')} />{net ? (conn ? '연결됨' : required ? '응답 없음' : '연결 안 됨') : '—'}</span>}
                {changed && <span className="net-changed">변경됨</span>}
              </div>
              <p className="muted" style={{ margin: '6px 0 0' }}>{f.desc}</p>
              {f.kind === 'emulator' && <div className="muted small" style={{ marginTop: 4 }}>마지막 정상 응답 · <b>{lastOk}</b></div>}
              <div className="net-row" style={{ marginTop: 10 }}>
                <span className="net-input">
                  <input
                    id={'net-' + f.key}
                    value={valueOf(f.key)}
                    placeholder={f.ph}
                    onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                    spellCheck={false}
                  />
                  <span className="net-port mono">:{f.port}</span>
                </span>
                <button onClick={() => test(f)} disabled={busy || !valueOf(f.key)}>연결 시험</button>
              </div>
              <dl className="net-src">
                <dt>값 출처</dt><dd>{src}</dd>
                <dt>환경변수</dt><dd className="mono">{f.env}{cur?.env ? `=${cur.env}` : ' 없음'}</dd>
              </dl>
              <div className="muted small">IP 또는 호스트 이름만 넣으면 포트 <b>{f.port}</b> 이 붙습니다{cur?.source === 'db' ? ' · 비우고 저장하면 환경변수 값으로 돌아갑니다' : ''}</div>
              {t && (
                <p className={'net-test ' + (t.pending ? 'muted' : t.ok ? 'ok' : 'err')}>
                  {t.pending ? '시험 중…' : `${t.ok ? '✓' : '✕'} ${t.msg}${t.ms != null ? ` (${t.ms} ms)` : ''}`}
                </p>
              )}
            </section>
          )
        })}
        </div>

        <p className="muted small" style={{ margin: '4px 0 0' }}>
          수신 포트(ingest)와 웹/API 포트는 실행 환경변수로만 바꿀 수 있으며 재시작이 필요합니다.
          {msg && <> · <span>{msg}</span></>}
        </p>
        </ReadOnly>
      </div>

      {dirty && canEdit && (
        <div className="net-bar" role="status">
          <span className="net-bar-dot" />
          <b>저장 안 된 변경 {dirtyFields.length}건</b>
          <span className="muted">· {dirtyFields.map((f) => f.label.replace(/\s*\(.*\)$/, '')).join(' · ')}</span>
          <span className="muted small">저장 전 연결 시험을 권장합니다</span>
          <span className="spacer" />
          <button onClick={() => { setDraft({}); setMsg('') }} disabled={busy}>되돌리기</button>
          <button className="primary" onClick={save} disabled={busy}>저장</button>
        </div>
      )}
    </div>
  )
}
