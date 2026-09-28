import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtBytes, fmtNum, fmtDur } from '../api.js'
import { SEV_LABEL, ALARM_KIND, roomText, spaceName } from '../model.js'
import EventList from '../EventList.jsx'
import { openLive } from '../App.jsx'
import { can, useMe } from '../auth.js'
import { claimLive, releaseLive, latencyNow } from '../ws.js'
import { Pill, Spark, dur, go } from '../ListKit.jsx'
import './Dashboard.css'

/**
 * 이벤트보드 — "지금 손봐야 할 것" 을 위에서 아래로. (목록 재설계 시안 01, 2026-09-28)
 *   1) 지표 한 줄: 작은 라벨 + 큰 숫자, 상태가 나쁜 카드만 테두리 색
 *   2) 세 칸: 활성 알람(심각도 레일 · 환자 두 줄 · 확인/열기) · 최근 이벤트 · 수신 이상(값 + 최근 30회 폴링의 증가 추이)
 *   각 칸 제목을 누르면 해당 목록 페이지로 넘어간다.
 */
const Kpi = ({ label, value, unit, sub, cls, title }) => (
  <div className={'dash-kpi ' + (cls || '')} title={title}><small>{label}</small><b>{value}{unit && <span className="u"> {unit}</span>}</b>{sub && <span className="sub">{sub}</span>}</div>
)

const ANOM_LABEL = {
  bad_crc: 'CRC 오류', bad_payload: '페이로드 오류', bad_magic: 'magic 오류', bad_version: '버전 오류', oversize: '과대 프레임',
  garbage_bytes: '쓰레기 바이트', resync: '재동기화', seq_gap: 'GW seq 갭', seq_missing: 'GW 유실 프레임', seq_dup: 'GW 중복',
  seq_reorder: 'GW 역전', seq_restart: 'GW 재시작', patch_seq_gap: '패치 seq 갭', patch_seq_missing: '패치 유실 레코드',
  patch_seq_dup: '패치 중복', patch_seq_reorder: '패치 역전(핸드오버)', patch_seq_restart: '패치 재시작', meta_bad_json: 'META JSON 오류', ctrl_rx: '제어 프레임 수신',
}
const SEV_RANK = { critical: 3, high: 2, medium: 1, low: 0 }
const SPARK_KEEP = 30

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

/** 알람 한 줄의 "종류 값 (임계 · 지속) · GW" — 있는 필드만 이어 붙인다 */
function alarmWhat(x, now) {
  const parts = []
  parts.push(ALARM_KIND?.[x.kind] || x.message || x.kind)
  const inner = []
  if (x.threshold != null) inner.push(`임계 ${x.threshold}`)
  if (x.since_ms) inner.push(`${dur(now - x.since_ms)} 지속`)
  return { head: parts.join(' '), value: x.value, inner: inner.join(' · '), gw: x.gateway_id }
}

export default function Dashboard({ alarms }) {
  const me = useMe()
  const e2e = useE2eLatency(can(me, 'data.biosignal', 1))
  const [stats] = usePoll(api.stats, 1000)
  const [events] = usePoll(api.events, 4000)
  const canAck = can(me, 'action.alarm_ack', 2)
  const [tick, bump] = useState(0) // 확인 뒤 즉시 흐리게 (다음 알람 폴링 전까지)
  const ackedLocal = useRef(new Set())

  // Per-second rates from consecutive /api/stats snapshots. Computed only when a new snapshot arrives and
  // kept in a ref, so re-renders caused by the alarm/event polls do not blank the tiles.
  const prev = useRef(null)
  const rateRef = useRef(null)
  // 수신 이상 카운터의 최근 30회 폴링 증가분 (미니 그래프용). 키 → 값 배열
  const anomHist = useRef(new Map())
  const anomLast = useRef(null)
  useMemo(() => {
    if (!stats) return
    const p = prev.current
    if (p && p !== stats && stats.uptime_s > p.uptime_s) {
      const dt = stats.uptime_s - p.uptime_s
      const fresh = {
        frames: (stats.gateways.frames - p.gateways.frames) / dt,
        records: (stats.total_packets - p.total_packets) / dt,
        bytes: (stats.total_bytes - p.total_bytes) / dt,
        tx: (stats.total_tx_bytes - p.total_tx_bytes) / dt,
      }
      // light smoothing (≈3 s window) so the tiles do not jump every second
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
  const a = useMemo(() => {
    const list = (alarms?.alarms || []).map((x) => (ackedLocal.current.has(x.id) ? { ...x, acked: true } : x))
    return list.sort((p, q) => (SEV_RANK[q.severity] || 0) - (SEV_RANK[p.severity] || 0) || (p.acked ? 1 : 0) - (q.acked ? 1 : 0) || (q.since_ms || 0) - (p.since_ms || 0))
  }, [alarms, tick])
  const s = alarms?.summary || {}
  const unacked = a.filter((x) => !x.acked).length
  const memPct = stats ? Math.round((stats.mem_sys_used_bytes / stats.mem_sys_total_bytes) * 100) : 0
  const diskPct = stats ? Math.round(100 - (stats.disk_free_bytes / stats.disk_total_bytes) * 100) : 0
  // 운영 카드(게이트웨이 연결·수신·송신·유실·CPU/메모리·저장소·가동 시간·수신 이상)는 시스템 상태 권한이 있을 때만 — 의사·간호사·스태프는 기본 없음
  const sys = can(me, 'data.system')
  const lat = stats?.latency
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
    return rows.filter((r) => r.v || r.hist.some((x) => x)).sort((p, q) => q.recent - p.recent || q.v - p.v)
  }, [an, stats])

  return (
    <div className="page dash">
      <section className="dash-kpis">
        {sys && <Kpi label="게이트웨이" value={n0(g.connected)} unit={`/ ${n0(g.gateways)}`} sub={`다운 ${g.down ?? 0} · 무응답 ${g.silent ?? 0} · 저하 ${g.degraded ?? 0}`} cls={g.down ? 'err' : g.silent ? 'warn' : ''} />}
        <Kpi label="환자 (패치)" value={n0(stats?.channels_connected ?? stats?.channel_count)} sub={`전체 ${n0(stats?.channel_count)} · 저장 중 ${n0(stats?.store_patches)}`} />
        <Kpi label={s.critical ? '알람 위험 · 높음' : '알람 활성'} value={s.critical || s.high ? <><span style={{ color: 'var(--sev-critical)' }}>{s.critical || 0}</span> · <span style={{ color: 'var(--sev-high)' }}>{s.high || 0}</span></> : n0(s.active)} sub={`활성 ${n0(s.active)} · 중간 ${s.medium || 0} · 낮음 ${s.low || 0}`} cls={s.critical ? 'crit' : s.high ? 'err' : ''} />
        {sys && <Kpi label="수신" value={rate ? fmtNum(Math.round(rate.records)) : '—'} unit="rec/s" sub={rate ? `${fmtNum(Math.round(rate.frames))} fr/s · ${fmtBytes(rate.bytes)}/s` : ''} />}
        {sys && <Kpi label="송신 (WS·분석)" value={rate ? fmtBytes(rate.tx) : '—'} unit="/s" sub={`누적 ${fmtBytes(stats?.total_tx_bytes)}`} />}
        {sys && <Kpi label="유실 / 복구" value={n0(stats?.total_lost_packets)} unit={`/ ${n0(g.recovered)}`} sub={`NACK ${n0(g.nack_tx)} · 재전송 실패 ${n0(g.resend_lost)}`} cls={g.resend_lost ? 'warn' : ''} title={`복구 ${n0(g.recovered)}프레임${g.recovered_records != null ? ` / ${n0(g.recovered_records)}레코드` : ''}`} />}
        {sys && <Kpi label="전송 지연" value={e2e ? e2e.e2e : lat?.n ? lat.p50 : '—'} unit="ms" cls={(e2e?.e2e ?? lat?.p95) > 2000 ? 'warn' : ''}
          sub={e2e ? `종단 간 · 에뮬→라우터 ${e2e.e2r ?? lat?.p50 ?? '—'} · 라우터→브라우저 ${e2e.r2v ?? '—'}${lat?.offset_ms ? ` · 보정 +${lat.offset_ms}` : ''}` : lat?.n ? `에뮬→라우터 p50 · p95 ${lat.p95} ms · 측정 중…` : '프레임 없음'}
          title={lat?.n ? `라우터 전체 p50 ${lat.p50} / p95 ${lat.p95} ms · 표본 ${fmtNum(lat.n)}` : ''} />}
        {sys && <Kpi label="CPU (Max 400%) / 메모리" value={stats ? `${stats.cpu_process_percent.toFixed(0)}%` : '—'} unit={stats ? `/ ${memPct}%` : ''} sub={stats ? `시스템 ${stats.cpu_percent.toFixed(0)}% · RSS ${fmtBytes(stats.mem_process_bytes)}` : ''} cls={stats && (stats.cpu_process_percent > 300 || memPct > 80) ? 'warn' : ''} />}
        {sys && <Kpi label="저장소" value={fmtBytes(stats?.wave_store_bytes)} sub={`디스크 ${diskPct}% · 여유 ${fmtBytes(stats?.disk_free_bytes)} · 큐 드롭 ${n0(stats?.queue_dropped_wave)}`} cls={stats?.queue_dropped_wave ? 'err' : diskPct > 85 ? 'warn' : ''} />}
        {sys && <Kpi label="웹 뷰어 / 회선" value={stats ? `${n0(stats.ws_sessions)} / ${n0(stats.ws_subscribed_channels)}` : '—'} sub="세션 · 패치" />}
        {sys && <Kpi label="가동 시간" value={fmtDur(stats?.uptime_s)} sub={`분석 서버 ${stats?.analysis_connected ? '연결' : '패스스루'}`} />}
      </section>

      <div className={sys ? 'dash-cols' : ''}>
        <section className="dash-card">
          <h4><a href="#/alarms" title="알람 목록으로">활성 알람</a><span className="cnt">{fmtNum(a.length)} · 미확인 {fmtNum(unacked)}</span><span className="spacer" />
            {s.critical > 0 && <Pill tone="crit">위험 {s.critical}</Pill>}{s.high > 0 && <Pill tone="high">높음 {s.high}</Pill>}{s.medium > 0 && <Pill tone="med">중간 {s.medium}</Pill>}
            <a className="more" href="#/alarms">전체 →</a></h4>
          {a.length === 0 ? <div className="dash-empty">활성 알람 없음</div> : (
            <ul className="dash-alarms">
              {a.slice(0, 8).map((x) => {
                const w = alarmWhat(x, now)
                const who = x.patient_name || (x.gateway_id ? `GW ${x.gateway_id}` : '시스템')
                const where = x.now ? `${spaceName(x.now)} (${roomText(x.room)})` : roomText(x.room)
                return (
                  <li key={x.id} className={x.acked ? 'acked' : ''} onClick={() => open(x)} title={x.message}>
                    <span className={'r ' + x.severity} />
                    <span style={{ minWidth: 0 }}>
                      <span className="who"><b>{who}</b><small>{[where, x.channel_id].filter(Boolean).join(' · ')}</small></span>
                      <span className="what">{w.head}{x.value != null && x.value !== '' && <> <span className={'v' + (x.severity === 'critical' ? ' bad' : '')}>{x.value}</span></>}{w.inner && <> ({w.inner})</>}{w.gw ? ` · GW ${w.gw}` : ''}{x.acked ? ' · 확인됨' : ''}</span>
                    </span>
                    <span className="acts" onClick={(e) => e.stopPropagation()}>
                      {canAck && !x.acked && <button onClick={() => ack(x.id)}>확인</button>}
                      <button className="primary" onClick={() => open(x)}>열기</button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          <p className="lk-legend">심각도 → 발생 시각 순. 확인된 알람은 흐리게 아래로.{a.length > 8 ? ` 외 ${fmtNum(a.length - 8)}건은 알람 목록에서.` : ''}</p>
        </section>

        <section className="dash-card">
          <h4><a href="#/events" title="이벤트 목록으로">최근 이벤트</a><span className="cnt">라우터 메모리 · 최근 25건</span><span className="spacer" /><a className="more" href="#/events">전체 →</a></h4>
          <div className="dash-events"><EventList events={(events || []).slice(-25).reverse()} /></div>
        </section>

        {sys && <section className="dash-card">
          <h4><a href="#/" title="운영 통계로">수신 이상</a><span className="cnt">누적 · 최근 {SPARK_KEEP}회 추이</span></h4>
          <table className="dash-anom">
            <tbody>
              {anomRows.map((r) => (
                <tr key={r.k} className={(r.v ? '' : 'zero') + (r.recent ? ' grow' : '')}>
                  <td>{ANOM_LABEL[r.k] || r.k}</td>
                  <td className="num"><a href="#/" title="운영 통계에서 보기">{fmtNum(r.v)}</a></td>
                  <td className="sp"><Spark values={r.hist.length >= 2 ? r.hist : []} tone={r.recent ? (r.k.includes('missing') || r.k.includes('bad') ? 'warn' : 'accent') : 'muted'} width={84} height={20} title={r.recent ? `최근 5회 +${fmtNum(r.recent)}` : '변화 없음'} /></td>
                </tr>
              ))}
              {!anomRows.length && <tr><td colSpan="3" className="dash-empty">프레임 이상 없음</td></tr>}
              <tr className="sec"><td colSpan="3">누계</td></tr>
              <tr><td>프레임</td><td className="num">{n0(g.frames)}</td><td className="sp" /></tr>
              <tr><td>복구 (NACK 응답)</td><td className="num">{n0(g.recovered)}</td><td className="sp"><Spark values={(anomHist.current.get('__rec') || [])} tone="ok" width={84} height={20} /></td></tr>
              <tr><td>재전송 대기 / 실패</td><td className="num">{n0(g.resend_pending)} / {n0(g.resend_lost)}</td><td className="sp" /></tr>
              <tr><td>연속 레코드(페이스마크)</td><td className="num">{n0(g.continuation_records)}</td><td className="sp" /></tr>
              <tr><td>중복 gw 소켓 프레임</td><td className="num">{n0(g.dup_gw_frames)}</td><td className="sp" /></tr>
            </tbody>
          </table>
          <p className="lk-legend">0 인 항목은 회색 평선. 숫자를 누르면 운영 통계로.</p>
        </section>}
      </div>
    </div>
  )
}
