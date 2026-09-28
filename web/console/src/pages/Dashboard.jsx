import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtBytes, fmtNum } from '../api.js'
import { SEV_LABEL, ALARM_KIND, roomText, spaceName, wardText } from '../model.js'
import EventList from '../EventList.jsx'
import { openLive } from '../App.jsx'
import { can, useMe } from '../auth.js'
import { claimLive, releaseLive, latencyNow } from '../ws.js'
import { Spark, dur, go, wardOfRoom } from '../ListKit.jsx'
import './Dashboard.css'

/**
 * 이벤트보드 — 알람 트리아지 (개선안 ② 2026-09-28).
 *   제목 줄: 수신 상태 칩 · 검색 · 병동 · 알람음
 *   지표 카드 한 장: 게이트웨이 · 환자 · 수신/송신 · 유실 · 전송 지연 → 운영 통계
 *   본문: 활성 알람(심각도 묶음, 미확인만, 측정값 크게, 확인/파형) | 수신 이상 · 최근 이벤트
 *   CPU·메모리·저장소·뷰어·가동 시간은 운영 통계(#/)에서 본다.
 */
const ANOM_LABEL = {
  bad_crc: 'CRC 오류', bad_payload: '페이로드 오류', bad_magic: 'magic 오류', bad_version: '버전 오류', oversize: '과대 프레임',
  garbage_bytes: '쓰레기 바이트', resync: '재동기화', seq_gap: 'GW seq 갭', seq_missing: 'GW 유실 프레임', seq_dup: 'GW 중복',
  seq_reorder: 'GW 역전', seq_restart: 'GW 재시작', patch_seq_gap: '패치 seq 갭', patch_seq_missing: '패치 유실 레코드',
  patch_seq_dup: '패치 중복', patch_seq_reorder: '패치 역전(핸드오버)', patch_seq_restart: '패치 재시작', meta_bad_json: 'META JSON 오류', ctrl_rx: '제어 프레임 수신',
}
const SEV_RANK = { critical: 3, high: 2, medium: 1, low: 0 }
const SEV_ORDERED = ['critical', 'high', 'medium', 'low']
const SPARK_KEEP = 30
const PER_GROUP = 8
const SOUND_KEY = 'board.sound'

/**
 * 전송 지연 — 이 브라우저 기준 종단 간(에뮬레이터→뷰어). 대시보드는 파형을 그리지 않으므로 지연 측정용으로 패치 하나만
 * 구독한다(초당 5프레임 남짓). 페이지를 떠나면 구독을 놓는다.
 */
function useE2eLatency(enabled) {
  const [l, setL] = useState(null)
  useEffect(() => {
    if (!enabled) return
    let dead = false
    api.channels().then((ch) => {
      const rows = Array.isArray(ch) ? ch : ch?.channels || []
      const one = rows.find((c) => c.connected) || rows[0]
      if (!dead && one) claimLive('dashboard-latency', [one.channel_id])
    }).catch(() => {})
    const t = setInterval(() => setL(latencyNow()), 1000)
    return () => { dead = true; clearInterval(t); releaseLive('dashboard-latency') }
  }, [enabled])
  return l
}

const fmtClock = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })

export default function Dashboard({ alarms }) {
  const me = useMe()
  const e2e = useE2eLatency(can(me, 'data.biosignal', 1))
  const [stats] = usePoll(api.stats, 1000)
  const [events] = usePoll(api.events, 4000)
  const canAck = can(me, 'action.alarm_ack', 2)
  const [tick, bump] = useState(0) // 확인 뒤 즉시 흐리게 (다음 알람 폴링 전까지)
  const ackedLocal = useRef(new Set())
  // 트리아지 조건
  const [q, setQ] = useState('')
  const [ward, setWard] = useState('')
  const [sev, setSev] = useState('')
  const [unackedOnly, setUnackedOnly] = useState(true)
  const [sound, setSound] = useState(() => { try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true } })
  const toggleSound = () => { const v = !sound; setSound(v); try { localStorage.setItem(SOUND_KEY, v ? '1' : '0') } catch { /* ignore */ } }
  // 경과 시간을 1초마다 갱신
  const [, clock] = useState(0)
  useEffect(() => { const t = setInterval(() => clock((n) => n + 1), 1000); return () => clearInterval(t) }, [])

  // Per-second rates from consecutive /api/stats snapshots. Computed only when a new snapshot arrives and
  // kept in a ref, so re-renders caused by the alarm/event polls do not blank the tiles.
  const prev = useRef(null)
  const rateRef = useRef(null)
  const lastStatsAt = useRef(0)
  // 수신 이상 카운터의 최근 30회 폴링 증가분 (미니 그래프용). 키 → 값 배열
  const anomHist = useRef(new Map())
  const anomLast = useRef(null)
  useMemo(() => {
    if (!stats) return
    lastStatsAt.current = Date.now()
    const p = prev.current
    if (p && p !== stats && stats.uptime_s > p.uptime_s) {
      const dt = stats.uptime_s - p.uptime_s
      const fresh = {
        frames: (stats.gateways.frames - p.gateways.frames) / dt,
        records: (stats.total_packets - p.total_packets) / dt,
        bytes: (stats.total_bytes - p.total_bytes) / dt,
        tx: (stats.total_tx_bytes - p.total_tx_bytes) / dt,
      }
      // light smoothing (≈3 s window) so the figures do not jump every second
      const old = rateRef.current
      rateRef.current = old ? Object.fromEntries(Object.entries(fresh).map(([k, v]) => [k, old[k] + (v - old[k]) * 0.4])) : fresh
    }
    if (!p || stats.uptime_s !== p.uptime_s) prev.current = stats
    // 이상 카운터 증가분 (복구 프레임도 __rec 로 함께) — 재시작(uptime 감소)이면 이력을 비운다
    const an = { ...(stats.gateways?.anomalies || {}), __rec: stats.gateways?.recovered || 0 }
    const last = anomLast.current
    if (last && stats.uptime_s < last.uptime) anomHist.current.clear()
    if (last && stats.uptime_s !== last.uptime) {
      for (const k of new Set([...Object.keys(an), ...Object.keys(last.an)])) {
        const d = Math.max(0, (an[k] || 0) - (last.an[k] || 0))
        const arr = anomHist.current.get(k) || []
        arr.push(d)
        if (arr.length > SPARK_KEEP) arr.shift()
        anomHist.current.set(k, arr)
      }
    }
    if (!last || stats.uptime_s !== last.uptime) anomLast.current = { uptime: stats.uptime_s, an: { ...an } }
  }, [stats])
  const rate = rateRef.current
  const g = stats?.gateways || {}
  const an = g.anomalies || {}
  const now = Date.now()
  // 라우터가 응답하지 않으면(폴링 실패로 stats 갱신이 멈춤) "일시정지 · 마지막 시각" 로 표시
  const live = stats && now - lastStatsAt.current < 6000
  const s = alarms?.summary || {}
  const sys = can(me, 'data.system')
  const lat = stats?.latency

  const all = useMemo(() => (alarms?.alarms || []).map((x) => (ackedLocal.current.has(x.id) ? { ...x, acked: true } : x)), [alarms, tick])
  const wards = useMemo(() => {
    const m = new Map()
    for (const x of all) { const w = wardOfRoom(x.room); if (w) m.set(w, (m.get(w) || 0) + 1) }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [all])
  // 조건 적용: 검색(환자·MRN·병실) → 병동 → 미확인만 → 심각도 (심각도 칩의 건수는 심각도 전 단계 기준)
  const base = useMemo(() => {
    const n = q.trim().toLowerCase()
    return all.filter((x) => (!ward || wardOfRoom(x.room) === ward)
      && (!unackedOnly || !x.acked)
      && (!n || [x.patient_name, x.channel_id, x.mrn, x.room, roomText(x.room), x.gateway_id].some((v) => v != null && String(v).toLowerCase().includes(n))))
  }, [all, q, ward, unackedOnly])
  const sevCount = useMemo(() => { const c = { critical: 0, high: 0, medium: 0, low: 0 }; for (const x of base) c[x.severity] = (c[x.severity] || 0) + 1; return c }, [base])
  const groups = useMemo(() => SEV_ORDERED.filter((k) => !sev || sev === k).map((k) => {
    const rows = base.filter((x) => x.severity === k).sort((p, r) => (p.acked ? 1 : 0) - (r.acked ? 1 : 0) || (p.since_ms || 0) - (r.since_ms || 0)) // 오래 지속된 것부터
    return { k, rows: rows.slice(0, PER_GROUP), more: Math.max(0, rows.length - PER_GROUP), total: rows.length }
  }).filter((gr) => gr.total > 0), [base, sev])
  const shownCount = base.filter((x) => !sev || x.severity === sev).length
  const unackedTotal = all.filter((x) => !x.acked && (!ward || wardOfRoom(x.room) === ward)).length

  const ack = async (id) => {
    try { await api.ackAlarm(id); ackedLocal.current.add(id); bump((n) => n + 1) } catch { /* 다음 폴링이 사실을 보여 준다 */ }
  }
  const open = (x) => { if (x.channel_id) openLive(x.channel_id); else go('#/alarms', { sel: x.id }) }
  const n0 = (v) => (v == null ? '—' : fmtNum(v))

  // 수신 이상: 0 이 아니거나 최근에 움직인 항목을 위로, 그 다음 0 항목 (회색 평선)
  const anomRows = useMemo(() => {
    const keys = new Set([...Object.keys(ANOM_LABEL), ...Object.keys(an).filter((k) => !k.startsWith('__'))])
    const rows = [...keys].map((k) => {
      const hist = anomHist.current.get(k) || []
      const recent = hist.slice(-5).reduce((x, y) => x + y, 0)
      return { k, v: an[k] || 0, hist, recent }
    })
    return rows.sort((p, r) => r.recent - p.recent || r.v - p.v || (p.k < r.k ? -1 : 1)).slice(0, 8)
  }, [an, stats])

  return (
    <div className="page dash">
      <div className="dash-head">
        <h2 className="h">이벤트보드</h2>
        <span className={'dash-status' + (live ? ' live' : '')} title={live ? '라우터에서 1초마다 받는 중' : '라우터 응답이 멈춰 마지막 수신 시각 기준으로 보입니다'}>
          <i />{live ? '수신 중' : '일시정지'} · {lastStatsAt.current ? fmtClock(lastStatsAt.current) : '—'} 기준
        </span>
        <span className="spacer" />
        <label className="dash-search">
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="환자 · MRN · 병실" aria-label="알람 검색" />
        </label>
        <select value={ward} onChange={(e) => setWard(e.target.value)} aria-label="병동" title="병동으로 거르기">
          <option value="">모든 병동 · {fmtNum(all.length)}</option>
          {wards.map(([w, n]) => <option key={w} value={w}>{wardText(w)} · {n}</option>)}
        </select>
        <button className={'dash-sound' + (sound ? ' on' : '')} onClick={toggleSound} title={sound ? '알람음 끄기' : '알람음 켜기'} aria-pressed={sound}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M11 5 6 9H2v6h4l5 4z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />{sound ? <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /> : <path d="m16 9 5 6m0-6-5 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}</svg>
          {sound ? '알람음 켜짐' : '알람음 꺼짐'}
        </button>
      </div>

      {sys && <section className="dash-kpi-card">
        <div className={'k' + (g.down ? ' err' : g.silent ? ' warn' : '')}><small>게이트웨이 연결</small><b>{n0(g.connected)} <span className="u">/ {n0(g.gateways)}</span></b></div>
        <div className="k"><small>모니터링 환자 (패치)</small><b>{n0(stats?.channels_connected ?? stats?.channel_count)}</b></div>
        <div className="k"><small>수신 / 송신</small><b>{rate ? `${fmtNum(Math.round(rate.records))}` : '—'} <span className="u">rec/s</span> / {rate ? fmtBytes(rate.tx) : '—'}<span className="u">/s</span></b></div>
        <div className={'k' + (g.resend_lost ? ' warn' : '')}><small>유실 레코드</small><b>{n0(stats?.total_lost_packets)}</b></div>
        <div className={'k' + ((e2e?.e2e ?? lat?.p95) > 2000 ? ' warn' : '')} title={lat?.n ? `라우터 전체 p50 ${lat.p50} / p95 ${lat.p95} ms${lat.offset_ms ? ` · 시계 보정 +${lat.offset_ms} ms` : ''}` : ''}><small>전송 지연</small><b>{e2e ? e2e.e2e : lat?.n ? lat.p50 : '—'} <span className="u">ms</span></b></div>
        <a href="#/" className="dash-ops-link">운영 통계 →</a>
      </section>}

      <div className={sys ? 'dash-grid' : ''}>
        <section className="dash-card dash-alarmcard" aria-label="활성 알람">
          <div className="dash-ah">
            <h4>활성 알람 <span className="cnt">{fmtNum(shownCount)}</span></h4>
            <span className="seg dash-sevseg" role="group" aria-label="심각도 필터">
              <button className={!sev ? 'active' : ''} onClick={() => setSev('')}>전체 {fmtNum(base.length)}</button>
              {SEV_ORDERED.map((k) => <button key={k} className={'s-' + k + (sev === k ? ' active' : '') + (sevCount[k] ? '' : ' zero')} onClick={() => setSev(sev === k ? '' : k)}>{SEV_LABEL[k]} {sevCount[k]}</button>)}
            </span>
            <label className="chk"><input type="checkbox" checked={unackedOnly} onChange={(e) => setUnackedOnly(e.target.checked)} /> 미확인만 ({fmtNum(unackedTotal)})</label>
            <span className="spacer" />
            <span className="muted small">정렬: 심각도 → 경과시간</span>
          </div>
          <div className="dash-row dash-cols-head"><span /><span>환자</span><span>알람</span><span>위치</span><span className="num">측정값</span><span>경과</span><span>발생</span><span /></div>
          {groups.length === 0 && <div className="dash-empty">{all.length ? '조건에 맞는 알람이 없습니다.' : '활성 알람 없음'}</div>}
          {groups.map((gr) => (
            <React.Fragment key={gr.k}>
              <div className={'dash-grp s-' + gr.k}><i />{SEV_LABEL[gr.k]} <span className="cnt">{fmtNum(gr.total)}건</span></div>
              {gr.rows.map((x) => {
                const who = x.patient_name || (x.gateway_id ? `GW ${x.gateway_id}` : '시스템')
                const where = x.now ? `${spaceName(x.now)} (${roomText(x.room)})` : roomText(x.room)
                return (
                  <div key={x.id} className={'dash-row s-' + x.severity + (x.acked ? ' acked' : '')} onClick={() => open(x)} title={x.message}>
                    <span className="rail" />
                    <span className="who"><b>{who}</b><small className="mono">{x.mrn || x.channel_id || ''}</small></span>
                    <span className="kind">{ALARM_KIND?.[x.kind] || x.kind}</span>
                    <span className="loc">{where || (x.gateway_id ? `GW ${x.gateway_id}` : '—')}</span>
                    <span className="val num">{x.value != null && x.value !== '' ? x.value : '—'}</span>
                    <span className="age num">{x.since_ms ? dur(now - x.since_ms) : '—'}</span>
                    <span className="at num">{x.since_ms ? fmtClock(x.since_ms) : '—'}</span>
                    <span className="acts" onClick={(e) => e.stopPropagation()}>
                      {x.channel_id && <button className="icon" onClick={() => openLive(x.channel_id)} title="뷰어에서 파형 보기" aria-label="뷰어에서 파형 보기"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M3 12h4l2-5 3 10 2-5h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>}
                      {canAck && !x.acked && <button className="ack" onClick={() => ack(x.id)}>확인</button>}
                      {x.acked && <span className="muted small">확인됨</span>}
                    </span>
                  </div>
                )
              })}
              {gr.more > 0 && <a className="dash-more" href={`#/alarms?f=${gr.k}${ward ? `&ward=${ward}` : ''}`}>{SEV_LABEL[gr.k]} 알람 {fmtNum(gr.more)}건 더 보기</a>}
            </React.Fragment>
          ))}
        </section>

        {sys && <aside className="dash-aside">
          <section className="dash-card" aria-label="수신 이상 카운터">
            <h4><a href="#/" title="운영 통계로">수신 이상</a><span className="cnt">누적</span></h4>
            <table className="dash-anom">
              <tbody>
                {anomRows.map((r) => (
                  <tr key={r.k} className={(r.v ? '' : 'zero') + (r.recent ? ' grow' : '')}>
                    <td>{ANOM_LABEL[r.k] || r.k}</td>
                    <td className="num"><a href="#/" title="운영 통계에서 보기">{fmtNum(r.v)}</a></td>
                    <td className="sp"><Spark values={r.hist.length >= 2 ? r.hist : []} tone={r.recent ? (r.k.includes('missing') || r.k.includes('bad') ? 'warn' : 'accent') : 'muted'} width={72} height={18} title={r.recent ? `최근 5회 +${fmtNum(r.recent)}` : '변화 없음'} /></td>
                  </tr>
                ))}
                <tr className="sec"><td colSpan="3">누계</td></tr>
                <tr><td>복구 (NACK 응답)</td><td className="num">{n0(g.recovered)}</td><td className="sp"><Spark values={(anomHist.current.get('__rec') || [])} tone="ok" width={72} height={18} /></td></tr>
                <tr><td>재전송 대기 / 실패</td><td className="num">{n0(g.resend_pending)} / {n0(g.resend_lost)}</td><td className="sp" /></tr>
              </tbody>
            </table>
            <p className="lk-legend">0 이 아닌 항목만 강조 · 숫자를 누르면 운영 통계로</p>
          </section>
          <section className="dash-card" aria-label="최근 이벤트">
            <h4><a href="#/events" title="이벤트 로그로">최근 이벤트</a><span className="spacer" /><a className="more" href="#/events">전체 보기</a></h4>
            <div className="dash-events"><EventList events={(events || []).slice(-20).reverse()} /></div>
          </section>
        </aside>}
      </div>
    </div>
  )
}
