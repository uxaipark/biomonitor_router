import React, { useMemo, useRef } from 'react'
import { api, usePoll, fmtBytes, fmtNum, fmtDur, fmtTime } from '../api.js'
import { SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'

const Tile = ({ label, value, sub, cls }) => (
  <div className={'tile ' + (cls || '')}><div className="tile-label">{label}</div><div className="tile-value">{value}</div>{sub && <div className="tile-sub">{sub}</div>}</div>
)

const ANOM_LABEL = {
  bad_crc: 'CRC 오류', bad_payload: '페이로드 오류', bad_magic: 'magic 오류', bad_version: '버전 오류', oversize: '과대 프레임',
  garbage_bytes: '쓰레기 바이트', resync: '재동기화', seq_gap: 'GW seq 갭', seq_missing: 'GW 유실 프레임', seq_dup: 'GW 중복',
  seq_reorder: 'GW 역전', seq_restart: 'GW 재시작', patch_seq_gap: '패치 seq 갭', patch_seq_missing: '패치 유실 레코드',
  patch_seq_dup: '패치 중복', patch_seq_reorder: '패치 역전(핸드오버)', patch_seq_restart: '패치 재시작', meta_bad_json: 'META JSON 오류', ctrl_rx: '제어 프레임 수신',
}

export default function Dashboard({ alarms }) {
  const [stats] = usePoll(api.stats, 1000)
  const [events] = usePoll(api.events, 4000)
  // Per-second rates from consecutive /api/stats snapshots. Computed only when a new snapshot arrives and
  // kept in a ref, so re-renders caused by the alarm/event polls do not blank the tiles.
  const prev = useRef(null)
  const rateRef = useRef(null)
  useMemo(() => {
    if (!stats) return
    const p = prev.current
    if (p && p !== stats && stats.uptime_s > p.uptime_s) {
      const dt = stats.uptime_s - p.uptime_s
      rateRef.current = {
        frames: (stats.gateways.frames - p.gateways.frames) / dt,
        records: (stats.total_packets - p.total_packets) / dt,
        bytes: (stats.total_bytes - p.total_bytes) / dt,
        tx: (stats.total_tx_bytes - p.total_tx_bytes) / dt,
      }
    }
    if (!p || stats.uptime_s !== p.uptime_s) prev.current = stats
  }, [stats])
  const rate = rateRef.current
  const g = stats?.gateways || {}
  const an = g.anomalies || {}
  const a = alarms?.alarms || []
  const s = alarms?.summary || {}
  const memPct = stats ? Math.round((stats.mem_sys_used_bytes / stats.mem_sys_total_bytes) * 100) : 0
  const diskPct = stats ? Math.round(100 - (stats.disk_free_bytes / stats.disk_total_bytes) * 100) : 0
  return (
    <div className="page">
      <section className="tiles">
        <Tile label="게이트웨이 연결" value={`${fmtNum(g.connected)} / ${fmtNum(g.gateways)}`} sub={`다운 ${g.down ?? 0} · 무응답 ${g.silent ?? 0} · 저하 ${g.degraded ?? 0}`} cls={g.down || g.silent ? 'warn' : ''} />
        <Tile label="패치 (환자)" value={fmtNum(stats?.channel_count)} sub={`저장 중 ${fmtNum(stats?.store_patches)}`} />
        <Tile label="수신" value={rate ? `${fmtNum(Math.round(rate.frames))} fr/s` : '—'} sub={rate ? `${fmtNum(Math.round(rate.records))} rec/s · ${fmtBytes(rate.bytes)}/s` : ''} />
        <Tile label="송신 (WS·분석)" value={rate ? `${fmtBytes(rate.tx)}/s` : '—'} sub={`누적 ${fmtBytes(stats?.total_tx_bytes)}`} />
        <Tile label="유실 레코드" value={fmtNum(stats?.total_lost_packets)} sub={`NACK ${fmtNum(g.nack_tx)} · 복구 ${fmtNum(g.recovered)} · 재전송 실패 ${fmtNum(g.resend_lost)}`} cls={g.resend_lost ? 'warn' : ''} />
        <Tile label="알람" value={fmtNum(s.active)} sub={`위험 ${s.critical || 0} · 높음 ${s.high || 0} · 중간 ${s.medium || 0} · 낮음 ${s.low || 0}`} cls={s.critical ? 'crit' : s.high ? 'err' : ''} />
        <Tile label="CPU / 메모리" value={stats ? `${stats.cpu_percent.toFixed(0)}% / ${memPct}%` : '—'} sub={`라우터 RSS ${fmtBytes(stats?.mem_process_bytes)}`} cls={stats && (stats.cpu_percent > 70 || memPct > 80) ? 'warn' : ''} />
        <Tile label="저장소" value={fmtBytes(stats?.wave_store_bytes)} sub={`디스크 사용 ${diskPct}% · 여유 ${fmtBytes(stats?.disk_free_bytes)} · 큐 드롭 ${fmtNum(stats?.queue_dropped_wave)}`} cls={stats?.queue_dropped_wave ? 'err' : diskPct > 85 ? 'warn' : ''} />
        <Tile label="가동 시간" value={fmtDur(stats?.uptime_s)} sub={`분석 서버 ${stats?.analysis_connected ? '연결' : '패스스루'}`} />
      </section>

      <div className="cols">
        <section className="panel">
          <h3>활성 알람 <small>{a.length}</small></h3>
          <table className="tbl">
            <thead><tr><th>심각도</th><th>환자</th><th>위치</th><th>내용</th><th>값</th><th>발생</th></tr></thead>
            <tbody>
              {a.slice(0, 15).map((x) => (
                <tr key={x.id} className={`sev-${x.severity} clickable`} onClick={() => x.channel_id && openLive(x.channel_id)}>
                  <td><span className={`tag sev-${x.severity}`}>{SEV_LABEL[x.severity]}</span></td>
                  <td>{x.patient_name || (x.gateway_id ? `GW ${x.gateway_id}` : '시스템')}</td>
                  <td>{x.room}</td><td>{x.message}</td><td>{x.value}</td><td>{fmtTime(x.since_ms)}</td>
                </tr>
              ))}
              {!a.length && <tr><td colSpan="6" className="muted">활성 알람 없음</td></tr>}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h3>수신 이상 카운터 <small>누적</small></h3>
          <table className="tbl">
            <tbody>
              {Object.entries(an).map(([k, v]) => <tr key={k}><td>{ANOM_LABEL[k] || k}</td><td className="num">{fmtNum(v)}</td></tr>)}
              {!Object.keys(an).length && <tr><td className="muted">이상 없음</td></tr>}
              <tr><td>프레임 누적</td><td className="num">{fmtNum(g.frames)}</td></tr>
              <tr><td>keepalive</td><td className="num">{fmtNum(g.keepalive)}</td></tr>
              <tr><td>META 블록</td><td className="num">{fmtNum(g.meta_blocks)}</td></tr>
              <tr><td>연속 레코드(페이스마크)</td><td className="num">{fmtNum(g.continuation_records)}</td></tr>
              <tr><td>중복 gw 소켓 프레임</td><td className="num">{fmtNum(g.dup_gw_frames)}</td></tr>
              <tr><td>재전송 대기</td><td className="num">{fmtNum(g.resend_pending)}</td></tr>
            </tbody>
          </table>
        </section>
      </div>

      <section className="panel">
        <h3>최근 이벤트</h3>
        <div className="events">
          {(events || []).slice(-25).reverse().map((e, i) => (
            <div key={i} className={'ev ev-' + e.kind}><span className="ts">{fmtTime(e.ts_ms)}</span><span className="kind">{e.kind}</span><span>{e.message}</span></div>
          ))}
        </div>
      </section>
    </div>
  )
}
