import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtNum, fmtAgo } from '../api.js'
import { gatewayAlarmIndex, GW_STATUS, SEV_LABEL, sortBy } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import { openLive } from '../App.jsx'
import { useQuery, go, useRevealSelected, GwName, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, PatientLink, RoomLink } from '../ListKit.jsx'

const COLS = [
  ['gw_id', 'GW'], ['name', '이름'], ['type', '유형'], ['loc', '위치'], ['state', '상태'], ['patches', '패치'], ['frames', '프레임'],
  ['nack_tx', 'NACK'], ['recovered', '복구'], ['resend_lost', '재전송 실패'], ['seq_gap', 'seq 갭'], ['seq_reorder', '역전'], ['bad_crc', 'CRC'],
  ['cpu', 'CPU %'], ['mem', 'MEM %'], ['net', 'NET'], ['wan_rssi', 'RSSI'], ['temp', '온도 °C'], ['since_last_s', '마지막 프레임'],
]
const PAGE = 100
const NUM = new Set(['patches', 'frames', 'nack_tx', 'recovered', 'resend_lost', 'seq_gap', 'seq_reorder', 'bad_crc', 'cpu', 'mem', 'net', 'wan_rssi', 'temp'])
const GW_TYPE = {
  room: '병실', corridor: '복도', support: '지원 시설', toilet: '화장실', mobile: '이동형(MCOT)', stairs: '계단', nurse_station: '간호사실',
  exam: '검사실', elevator: '엘리베이터', lobby: '로비', er: '응급실',
}
// counters: 0 is the normal case, so it is drawn faint and anything else stands out
const Z = ({ v, bad }) => (v ? <span className={bad ? 'nz-bad' : ''}>{fmtNum(v)}</span> : <span className="zero">0</span>)

// 요약 칩: 상태별 (누르면 그 상태만)
const CHIPS = [
  ['ok', '정상', (g) => g.state === 0, 'c-ok'],
  ['degraded', '저하', (g) => g.state === 1, 'c-warn'],
  ['down', '끊김/무응답', (g) => !g.connected || g.silent || g.state === 2, 'c-err'],
  ['problem', '문제 있음', (g) => g.state > 0 || g.alarm || g.resend_lost || g.bad_crc, 'c-err'],
  ['patched', '패치 연결됨', (g) => g.patches > 0, ''],
]
const STATE_TAG = (g) => (!g.connected ? <span className="tag err small">끊김</span> : g.silent ? <span className="tag err small">무응답</span> : g.state === 2 ? <span className="tag err small">DOWN</span> : g.state === 1 ? <span className="tag warn small">저하</span> : <span className="tag ok small">정상</span>)

/** 게이트웨이 목록: 상태 칩 · 건물/층·유형·검색 필터(주소에 남음) · 표 · 오른쪽 상세(연결된 환자) */
export default function Gateways({ alarms }) {
  const [rows] = usePoll(api.gateways, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', chip = qs.get('f') || '', floor = qs.get('floor') || '', type = qs.get('type') || '', sel = qs.get('sel') || ''
  const [sort, setSort] = useState(['state', 'desc'])
  const [page, setPage] = useState(0)
  const gidx = useMemo(() => gatewayAlarmIndex(alarms?.alarms), [alarms])
  const flat = useMemo(() => (rows || []).map((g) => {
    const st = g.status || {}
    const state = !g.connected ? 3 : g.silent ? 2 : st.status === 2 ? 2 : st.status === 1 ? 1 : 0
    const fl = [g.location?.building, g.location?.floor && `${g.location.floor}F`].filter(Boolean).join(' ')
    return { ...g, fl, loc: [fl, g.location?.room].filter(Boolean).join(' '), state, cpu: st.cpu, mem: st.mem, net: st.net, wan_rssi: st.wan_rssi, temp: st.temp, stLabel: GW_STATUS[st.status], alarm: gidx.get(String(g.gw_id)) }
  }), [rows, gidx])
  const floors = useMemo(() => {
    const c = new Map()
    for (const g of flat) if (g.fl) c.set(g.fl, (c.get(g.fl) || 0) + 1)
    return [{ value: '', label: '모든 건물·층', count: flat.length }, ...[...c].sort((a, b) => a[0].localeCompare(b[0], 'ko', { numeric: true })).map(([f, n]) => ({ value: f, label: f, count: n }))]
  }, [flat])
  const types = useMemo(() => {
    const c = new Map()
    for (const g of flat) c.set(g.type, (c.get(g.type) || 0) + 1)
    return [{ value: '', label: '모든 유형', count: flat.length }, ...[...c].map(([t, n]) => ({ value: t, label: GW_TYPE[t] || t, count: n }))]
  }, [flat])
  const scoped = useMemo(() => flat.filter((g) => (!floor || g.fl === floor) && (!type || g.type === type)), [flat, floor, type])
  const chips = useMemo(() => [{ key: 'all', label: '전체', count: scoped.length }, ...CHIPS.map(([k, l, f, cls]) => ({ key: k, label: l, count: scoped.filter(f).length, cls }))], [scoped])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = scoped.filter((g) => !needle || [g.gw_id, g.name, g.loc, g.type].some((x) => String(x || '').toLowerCase().includes(needle)))
    const c = CHIPS.find(([k]) => k === chip)
    if (c) v = v.filter(c[2])
    return sortBy(v, sort[0], sort[1])
  }, [scoped, q, chip, sort])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const selRow = sel ? flat.find((g) => String(g.gw_id) === sel) : null
  useRevealSelected(sel, shown, (g) => String(g.gw_id), PAGE, setPage)
  const applied = [
    floor && { key: 'floor', label: `위치: ${floor}`, clear: () => setQs({ floor: '' }) },
    type && { key: 'type', label: `유형: ${GW_TYPE[type] || type}`, clear: () => setQs({ type: '' }) },
    chip && { key: 'f', label: CHIPS.find(([k]) => k === chip)?.[1] || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  return (
    <div className="page lk">
      <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="대" />
      <FilterBar applied={applied} onReset={() => setQs({ q: '', f: '', floor: '', type: '' })}
        right={<><span className="muted">표시 {fmtNum(shown.length)} / {fmtNum(flat.length)}대</span><Pager page={cur} pages={pages} onPage={setPage} /></>}>
        <input placeholder="검색: GW 번호 · 이름 · 위치" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
        <Dropdown value={floor} options={floors} onChange={(v) => { setQs({ floor: v }); setPage(0) }} placeholder="모든 건물·층" countUnit="대" width={180} />
        <Dropdown value={type} options={types} onChange={(v) => { setQs({ type: v }); setPage(0) }} searchable={false} placeholder="모든 유형" countUnit="대" width={170} />
      </FilterBar>
      <ListLayout detail={selRow ? <GatewayDetail g={selRow} onClose={() => setQs({ sel: '' })} /> : sel ? <DetailPanel title={`GW ${sel}`} onClose={() => setQs({ sel: '' })}><p className="muted">라우터에 접속한 적 없는 게이트웨이입니다.</p></DetailPanel> : null}>
        <table className="tbl dense">
          <thead><tr>{COLS.map(([k, l]) => <th key={k} className={'sortable' + (NUM.has(k) ? ' num' : '')} onClick={() => setSort([k, sort[0] === k && sort[1] === 'asc' ? 'desc' : 'asc'])}>{l}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>)}</tr></thead>
          <tbody>
            {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((g) => (
              <tr key={g.gw_id} className={'clickable ' + (g.alarm ? `sev-${g.alarm.severity}` : g.state === 3 ? 'stale' : '') + (sel === String(g.gw_id) ? ' selected' : '')} onClick={() => setQs({ sel: sel === String(g.gw_id) ? '' : String(g.gw_id) })}>
                <td className="mono"><b>{g.gw_id}</b></td><td className="mono"><GwName id={g.gw_id} name={g.name} /></td><td>{GW_TYPE[g.type] || g.type}</td>
                <td>{g.fl} <RoomLink room={g.location?.room}>{g.location?.room}</RoomLink></td>
                <td>{STATE_TAG(g)}</td>
                <td className="num"><Z v={g.patches} /></td><td className="num">{fmtNum(g.frames)}</td>
                <td className="num"><Z v={g.nack_tx} /></td><td className="num"><Z v={g.recovered} /></td><td className="num"><Z v={g.resend_lost} bad /></td><td className="num"><Z v={g.seq_gap} bad /></td><td className="num"><Z v={g.seq_reorder} /></td><td className="num"><Z v={g.bad_crc} bad /></td>
                <td className="num">{g.cpu ?? '—'}</td><td className="num">{g.mem ?? '—'}</td><td className="num">{g.net ?? '—'}</td><td className="num">{g.wan_rssi ?? '—'}</td><td className="num">{g.temp ?? '—'}</td>
                <td className="muted">{g.since_last_s != null ? `${g.since_last_s.toFixed(1)}s` : '—'}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={COLS.length} className="muted">조건에 맞는 게이트웨이가 없습니다.</td></tr>}
          </tbody>
        </table>
      </ListLayout>
    </div>
  )
}

/** 게이트웨이 상세: 상태·부하·수신 통계, 연결된 환자(누르면 환자 상세) */
function GatewayDetail({ g, onClose }) {
  const [pats] = usePoll(() => api.channelsScoped(`gw=${encodeURIComponent(g.gw_id)}`), 5000, [g.gw_id])
  const st = g.status || {}
  return (
    <DetailPanel title={<GwName id={g.gw_id} name={g.name} />} sub={[`#${g.gw_id}`, GW_TYPE[g.type] || g.type].filter(Boolean).join(' · ')} onClose={onClose}
      actions={<>
        <button onClick={() => go('#/map', { gw: g.gw_id })}>지도에서 보기</button>
        <button onClick={() => go('#/alarms', { q: `GW ${g.gw_id}`, tab: 'history' })}>알람 이력</button>
        <button onClick={() => go('#/events', { q: String(g.gw_id) })}>이벤트</button>
      </>}>
      {g.alarm && <div className={`lk-alarm sev-${g.alarm.severity}`}><span className={`tag small sev-${g.alarm.severity}`}>{SEV_LABEL[g.alarm.severity]}</span> {g.alarm.message}</div>}
      <dl className="lk-kv">
        <KV k="상태">{STATE_TAG(g)} {g.stLabel || ''}</KV>
        <KV k="위치">{g.fl} <RoomLink room={g.location?.room}>{g.location?.room}</RoomLink></KV>
        <KV k="연결 패치">{g.patches ?? 0}</KV>
        <KV k="CPU · MEM · NET">{st.cpu ?? '—'}% · {st.mem ?? '—'}% · {st.net ?? '—'}%</KV>
        <KV k="WAN · 온도">{st.wan_rssi ?? '—'} dBm · {st.temp ?? '—'}°C</KV>
        <KV k="수신">프레임 {fmtNum(g.frames)} · 마지막 {g.since_last_s != null ? `${g.since_last_s.toFixed(1)}초 전` : '—'}</KV>
        <KV k="NACK · 복구 · 실패">{fmtNum(g.nack_tx)} · {fmtNum(g.recovered)} · {fmtNum(g.resend_lost)}</KV>
        <KV k="seq 갭 · 역전 · CRC">{fmtNum(g.seq_gap)} · {fmtNum(g.seq_reorder)} · {fmtNum(g.bad_crc)}</KV>
      </dl>
      <h4 className="lk-sub">연결된 환자 {pats ? `${pats.length}명` : ''}</h4>
      <table className="tbl dense lk-mini">
        <tbody>
          {(pats || []).map((r) => (
            <tr key={r.channel_id} className="clickable" onClick={() => openLive(r.channel_id)} title="실시간 파형">
              <td><PatientLink ch={r.channel_id}><b>{r.patient?.name || r.mrn}</b></PatientLink></td>
              <td className="muted"><RoomLink room={r.patient?.room || r.space} /></td>
              <td className="num">{r.rssi} dBm</td>
            </tr>
          ))}
          {pats && !pats.length && <tr><td className="muted">연결된 환자가 없습니다.</td></tr>}
        </tbody>
      </table>
    </DetailPanel>
  )
}
