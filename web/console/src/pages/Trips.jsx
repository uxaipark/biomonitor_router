import React, { useMemo } from 'react'
import { api, usePoll } from '../api.js'
import { openLive } from '../App.jsx'
import { useQuery, go, Cols, tableMin, GwName, RoomLink } from '../ListKit.jsx'

/**
 * 이동 중 환자 (에뮬레이터 `/api/v1/emr/trips`, 라우터 EMR 프록시): 검사·방문·전동·화장실·산책·재활 이동의
 * 현재 단계 · 진행 · 타임테이블(현재 → 예정) · 다음 예정 검사, 검사실별 사용 현황.
 * 환자는 침대 id 로 라우터의 패치 행과 잇는다(이름을 누르면 파형·환자 정보 모달).
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
  // ── 칩·머리글 숫자는 모두 이 목록(trips)에서 센다 ──
  // 에뮬레이터 stats(kinds·rooms.in_room/load)는 표 행과 기준이 달라(검사실 점유는 exam 만, 재활·이동 중 제외 등)
  // 칩 수와 눌렀을 때 보이는 행 수가 어긋났다. 상위(전체)·하위(종류/검사실) 칩은 서로의 필터를 반영한다.
  const shortOf = (r) => (r.room || '').split(' ').slice(1).join(' ')
  const inRoom = (t, r) => t.location === r.room_id
  const heading = (t, r) => { const sh = shortOf(r); return !!sh && !inRoom(t, r) && (t.steps || []).some((s) => s.state !== 'done' && s.label.startsWith(sh)) }
  const roomObj = room ? rooms.find((r) => r.room_id === room) : null
  const matchRoom = (t) => !roomObj || inRoom(t, roomObj) || heading(t, roomObj)
  const matchKind = (t) => !kind || (kind === 'shadow' ? t.shadow : t.kind === kind)
  const shown = useMemo(() => trips.filter((t) => matchKind(t) && matchRoom(t)), [trips, kind, room, rooms]) // eslint-disable-line react-hooks/exhaustive-deps
  // 종류 칩: 검사실 필터를 적용한 목록에서 (전체 = 그 합)
  const byRoom = useMemo(() => trips.filter(matchRoom), [trips, room, rooms]) // eslint-disable-line react-hooks/exhaustive-deps
  const kindCounts = useMemo(() => { const c = {}; for (const t of byRoom) c[t.kind] = (c[t.kind] || 0) + 1; return c }, [byRoom])
  const shadowN = byRoom.filter((t) => t.shadow).length
  // 검사실 칩: 종류 필터를 적용한 목록에서 "지금 그 실에 있는 수 / 정원 (+그 실로 가는 중)"
  const byKind = useMemo(() => trips.filter(matchKind), [trips, kind])
  const roomStat = useMemo(() => rooms.map((r) => ({ ...r, in_n: byKind.filter((t) => inRoom(t, r)).length, head_n: byKind.filter((t) => heading(t, r)).length })), [rooms, byKind]) // eslint-disable-line react-hooks/exhaustive-deps
  const used = roomStat.reduce((s, r) => s + r.in_n, 0), cap = roomStat.reduce((s, r) => s + (r.capacity || 0), 0), moving = roomStat.reduce((s, r) => s + r.head_n, 0)
  // 1시간(upcoming_h) 안 검사 예정: 목록의 next_exams 로 직접 센다 (환자 수)
  const soonS = (st.upcoming_h ?? 1) * 3600
  const examsSoon = trips.filter((t) => (t.next_exams || []).some((x) => x.in_s != null && x.in_s <= soonS)).length
  if (err) return <p className="err">이동 정보를 불러오지 못했습니다: {err.message}</p>
  if (!d) return <p className="muted">이동 정보를 불러오는 중…</p>
  return (
    <div className="trips">
      <div className="trips-head">
        <b>이동 중 환자</b>
        <span>이동 중 <b>{trips.length}</b></span>
        <span title="지금 검사·치료실 안에 있는 환자 / 정원 (+ 그 실로 이동 중)">검사실 사용 <b>{used}/{cap}</b> (+{moving} 이동 중)</span>
        <span className={trips.some((t) => t.shadow) ? 'warn' : ''}>음영 <b>{trips.filter((t) => t.shadow).length}</b></span>
        <span>{st.upcoming_h ?? 1}시간 내 검사 예정 <b>{examsSoon}</b></span>
        <span className="muted">시뮬 시각 {hms(d.sim_time)}</span>
      </div>
      <div className="trips-kinds">
        <button className={!kind ? 'on' : ''} onClick={() => setQs({ tk: '' })}>전체 {byRoom.length}</button>
        {Object.keys(KIND).concat(Object.keys(kindCounts).filter((k) => !KIND[k])).filter((k) => kindCounts[k] > 0).map((k) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setQs({ tk: kind === k ? '' : k })}>{KIND[k] || k} {kindCounts[k]}</button>)}
        {shadowN > 0 && <button className={'warn' + (kind === 'shadow' ? ' on' : '')} onClick={() => setQs({ tk: kind === 'shadow' ? '' : 'shadow' })}>음영 {shadowN}</button>}
      </div>
      {/* 검사·치료실 칩: 건물별로 묶고 구분선 — 이름 첫 단어(본관·별관·신관)가 건물 */}
      <div className="trips-rooms">
        {(() => {
          const list = roomStat.filter((r) => r.in_n > 0 || r.head_n > 0 || r.capacity > 0)
          const groups = []
          for (const r of list) {
            const b = (r.room || '').split(' ')[0] || '기타'
            let g = groups.find((x) => x.name === b)
            if (!g) { g = { name: b, rooms: [], in_n: 0, head_n: 0 }; groups.push(g) }
            g.rooms.push(r); g.in_n += r.in_n; g.head_n += r.head_n
          }
          return groups.map((g) => (
            <div key={g.name} className="tr-bld">
              <div className="tr-bld-label" title={`${g.name} — 안에 ${g.in_n}${g.head_n ? ` · 이동 중 ${g.head_n}` : ''}`}>{g.name} <b>{g.in_n}</b>{g.head_n > 0 && <em>+{g.head_n}</em>}</div>
              <div className="tr-bld-rooms">
                {g.rooms.map((r) => {
                  const full = r.capacity > 0 && r.in_n >= r.capacity
                  const label = shortOf(r) || r.room
                  return (
                    <button key={r.room_id} className={'tr-room' + (full ? ' full' : '') + (room === r.room_id ? ' on' : '') + (!r.in_n && !r.head_n ? ' idle' : '')} onClick={() => setQs({ tr: room === r.room_id ? '' : r.room_id })} title={`${r.room} · 안에 ${r.in_n}${r.capacity ? `/${r.capacity}` : ''}${r.head_n ? ` · 이동 중 ${r.head_n}` : ''} — 누르면 이 실에 있거나 가는 중인 환자만`}>
                      {label} <b>{r.in_n}{r.capacity ? `/${r.capacity}` : ''}</b>{r.head_n > 0 && <em> +{r.head_n}</em>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))
        })()}
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
                <tr key={t.id} className={(row ? 'clickable' : '') + (t.shadow ? ' tr-shadow' : '')} >
                  <td>
                    {row ? <a className="lk-link" onClick={() => openLive(row.channel_id)} title="파형·환자 정보 보기"><b>{t.name}</b></a> : <b>{t.name}</b>} <small className="muted">{SEX[t.sex] || t.sex}/{t.age}</small>
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
                    <a className="lk-link" onClick={() => go('#/map', { room: t.location, gw: gwNo, b: t.building_idx, f: t.floor })} title="병원 지도에서 보기">{t.location_name} <small className="muted mono">{t.location}</small></a>
                    <div className="muted small">{BLD[t.building_idx] || ''} {t.floor}F</div>
                  </td>
                  <td>{t.shadow || gwNo == null
                    ? <a className="lk-link" onClick={() => go('#/map', { room: t.location, b: t.building_idx, f: t.floor })} title="병원 지도에서 이 위치 보기"><span className="tag small warn">음영 · 연결 없음</span></a>
                    : <a className="lk-link mono" onClick={() => go('#/map', { gw: gwNo })} title="병원 지도에서 이 게이트웨이 보기"><GwName id={gwNo} name={t.gateway} /></a>}</td>
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
