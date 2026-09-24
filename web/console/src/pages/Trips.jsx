import React, { useMemo } from 'react'
import { api, usePoll } from '../api.js'
import { openLive } from '../App.jsx'
import { useQuery, go, Cols, tableMin, GwLink, RoomLink } from '../ListKit.jsx'

/**
 * 이동 중 환자 (에뮬레이터 `/api/v1/emr/trips`, 라우터 EMR 프록시): 검사·방문·전동·화장실·산책·재활 이동의
 * 현재 단계 · 진행 · 타임테이블(현재 → 예정) · 다음 예정 검사, 검사실별 사용 현황.
 * 환자는 침대 id 로 라우터의 패치 행과 잇는다(이름을 누르면 환자 상세, 두 번 누르면 실시간 파형).
 */
const KIND = { exam: '검사', visit: '방문', transfer: '병실 이동', shadowtrip: '음영 이동', toilet: '화장실', walk: '산책', shower: '샤워', rehab: '재활' }
const BLD = ['본관', '별관', '신관']
const SEX = { M: 'M', F: 'F' }
const W = [150, 170, 170, 170, 116, 150, null, 190]
const hm = (t) => (t ? String(t).slice(11, 16) : '')
const hms = (t) => (t ? String(t).slice(11, 19) : '')
/** 초 → "2:30" / "1:05:10" */
const dur = (s) => {
  if (s == null || !isFinite(s)) return '—'
  s = Math.max(0, Math.round(s))
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`
}
const inText = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m 후` : `${m}m 후` }

export default function Trips({ bedIndex }) {
  const [d, err] = usePoll(api.emu.trips, 5000)
  const [qs, setQs] = useQuery()
  const kind = qs.get('tk') || '', room = qs.get('tr') || ''
  const trips = d?.trips || []
  const st = d?.stats || {}
  const rooms = st.rooms || []
  // 검사실 칩: 지금 그 실에 있거나 아직 남은 단계가 그 실인 환자 ("본관 ECG실" → 단계 이름이 "ECG실 …")
  const roomShort = room ? (rooms.find((r) => r.room_id === room)?.room || '').split(' ').slice(1).join(' ') : ''
  const shown = useMemo(() => trips.filter((t) => (!kind || (kind === 'shadow' ? t.shadow : t.kind === kind))
    && (!room || t.location === room || (roomShort && (t.steps || []).some((s) => s.state !== 'done' && s.label.startsWith(roomShort))))), [trips, kind, room, roomShort])
  const used = rooms.reduce((s, r) => s + (r.in_room || 0), 0), cap = rooms.reduce((s, r) => s + (r.capacity || 0), 0), moving = rooms.reduce((s, r) => s + Math.max(0, (r.load || 0) - (r.in_room || 0)), 0)
  if (err) return <p className="err">이동 정보를 불러오지 못했습니다: {err.message}</p>
  if (!d) return <p className="muted">이동 정보를 불러오는 중…</p>
  return (
    <div className="trips">
      <div className="trips-head">
        <b>이동 중 환자</b>
        <span>이동 중 <b>{st.moving ?? trips.length}</b></span>
        <span>검사실 사용 <b>{used}/{cap}</b> (+{moving} 이동 중)</span>
        <span className={st.shadow ? 'warn' : ''}>음영 <b>{st.shadow ?? 0}</b></span>
        <span>{st.upcoming_h ?? 1}시간 내 검사 예정 <b>{st.exams_soon ?? 0}</b></span>
        <span className="muted">시뮬 시각 {hms(d.sim_time)}</span>
      </div>
      <div className="trips-kinds">
        <button className={!kind ? 'on' : ''} onClick={() => setQs({ tk: '' })}>전체 {trips.length}</button>
        {Object.entries(st.kinds || {}).filter(([, n]) => n > 0).map(([k, n]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setQs({ tk: kind === k ? '' : k })}>{KIND[k] || k} {n}</button>)}
        {st.shadow > 0 && <button className={'warn' + (kind === 'shadow' ? ' on' : '')} onClick={() => setQs({ tk: kind === 'shadow' ? '' : 'shadow' })}>음영 {st.shadow}</button>}
      </div>
      <div className="trips-rooms">
        {rooms.map((r) => {
          const extra = Math.max(0, (r.load || 0) - (r.in_room || 0))
          const full = r.load >= r.capacity && r.capacity > 0
          return (
            <button key={r.room_id} className={'tr-room' + (full ? ' full' : '') + (room === r.room_id ? ' on' : '') + (!r.load ? ' idle' : '')} onClick={() => setQs({ tr: room === r.room_id ? '' : r.room_id })} title={`${r.room} · 사용 ${r.in_room}/${r.capacity}${extra ? ` · 이동 중 ${extra}` : ''}`}>
              {r.room} <b>{r.in_room}/{r.capacity}</b>{extra > 0 && <em> +{extra} 이동 중</em>}
            </button>
          )
        })}
      </div>
      <div className="lk-main">
        <table className="tbl fixed trips-tbl" style={{ minWidth: tableMin(W, 260) }}>
          <Cols w={W} />
          <thead><tr><th>환자</th><th>이동</th><th>현재 단계</th><th>위치</th><th>게이트웨이</th><th>진행</th><th>타임테이블 (현재 → 예정)</th><th>다음 예정 검사</th></tr></thead>
          <tbody>
            {shown.map((t) => {
              const row = bedIndex?.get(t.bed)
              const steps = t.steps || []
              const cur = steps.findIndex((s) => s.state === 'current')
              const view = steps.slice(Math.max(0, cur), Math.max(0, cur) + 3)
              const total = (t.elapsed || 0) + (t.total_remaining || 0)
              const pct = total > 0 ? Math.min(100, ((t.elapsed || 0) / total) * 100) : (t.progress || 0) * 100
              const gwNo = t.gateway_idx != null && t.gateway_idx >= 0 ? t.gateway_idx + 1 : null
              return (
                <tr key={t.id} className={(row ? 'clickable' : '') + (t.shadow ? ' tr-shadow' : '')} onDoubleClick={() => row && openLive(row.channel_id)} title={row ? '두 번 누르면 실시간 파형' : ''}>
                  <td>
                    {row ? <a className="lk-link" onClick={() => go('#/patients', { sel: row.channel_id })}><b>{t.name}</b></a> : <b>{t.name}</b>} <small className="muted">{SEX[t.sex] || t.sex}/{t.age}</small>
                    <div className="muted small">{t.bed} · {t.ward}</div>
                  </td>
                  <td>
                    <span className={'tag small' + (t.kind === 'exam' ? ' warn' : '')}>{KIND[t.kind] || t.kind}</span>
                    <div className="small">{t.note}</div>
                    <div className="muted small mono">{hms(t.started)} → {hms(t.ends)}</div>
                  </td>
                  <td>
                    <b>{t.stage}</b>
                    <div className="muted small">남은 {dur(t.stage_remaining)} · 단계 {t.step_no}/{t.n_steps}</div>
                    {t.lead_off && <div className="small err">리드오프</div>}
                    {t.patch_removed && <div className="small warn">패치 분리 (MRI)</div>}
                  </td>
                  <td>
                    {t.location_name} <small className="muted mono">{t.location}</small>
                    <div className="muted small">{BLD[t.building_idx] || ''} {t.floor}F</div>
                  </td>
                  <td>{t.shadow || gwNo == null ? <span className="tag small warn">음영 · 연결 없음</span> : <GwLink id={gwNo} name={t.gateway} />}</td>
                  <td>
                    <div className={'tr-bar' + (t.shadow ? ' shadow' : '')}><i style={{ width: `${pct.toFixed(1)}%` }} /></div>
                    <div className="muted small">경과 {dur(t.elapsed)} · 남은 {dur(t.total_remaining)}</div>
                  </td>
                  <td className="tr-steps">
                    {view.map((s, i) => (
                      <div key={i} className={'tr-step ' + s.state}>
                        {s.state === 'current' ? '▶' : '○'} {s.label} <span className="mono">{hms(s.start)}</span>
                        {s.state === 'current' ? <b> ({dur(s.remaining)} 남음)</b> : s.dur > 0 ? <span className="muted"> {dur(s.dur)}</span> : null}
                      </div>
                    ))}
                  </td>
                  <td className="tr-next">
                    {(t.next_exams || []).slice(0, 2).map((x, i) => (
                      <div key={i}><b>{x.type}</b> {hm(x.time)} <span className="muted">({inText(x.in_s)} · {x.room} · {x.duration_min}분{x.patch_policy === 'remove' ? ' · 패치 분리' : ''})</span></div>
                    ))}
                    {!(t.next_exams || []).length && <span className="muted">예정 없음</span>}
                  </td>
                </tr>
              )
            })}
            {!shown.length && <tr><td colSpan={8} className="muted">조건에 맞는 이동 중 환자가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      {room && <p className="muted small">검사실 필터: <RoomLink room={room}>{rooms.find((r) => r.room_id === room)?.room || room}</RoomLink> (지도에서 보기)</p>}
    </div>
  )
}
