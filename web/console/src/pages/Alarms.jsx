import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { SEV_LABEL, ALARM_KIND, roomText, wardText, sortBy } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import { useQuery, go, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, PatientLink, GwLink, RoomLink, WardLink, wardOfRoom } from '../ListKit.jsx'
import { openLive } from '../App.jsx'

const RULE_FIELDS = [
  ['hr_low', '서맥 HR <', 'bpm'], ['hr_high', '빈맥 HR >', 'bpm'], ['hr_crit_low', '위험 HR ≤', 'bpm'], ['hr_crit_high', '위험 HR ≥', 'bpm'],
  ['spo2_low', 'SpO₂ <', '%'], ['spo2_crit_low', '위험 SpO₂ <', '%'], ['temp_low', '저체온 ≤', '°C'], ['temp_high', '고열 ≥', '°C'],
  ['resp_low', '서호흡 <', '/min'], ['resp_high', '빈호흡 >', '/min'], ['battery_low_pct', '배터리 ≤', '%'], ['patch_wear_days', '패치 최대 착용', '일'], ['patch_wear_warn_h', '교체 예정 알림', '시간 전'],
  ['sustain_s', '수치 지속', 's'], ['lead_off_s', '전극 탈락 지속', 's'], ['patch_silent_s', '패치 무응답', 's'], ['clear_s', '해제 유예', 's'],
]

const SEVS = ['critical', 'high', 'medium', 'low']
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }
const PAGE = 100

/** 알람: 활성/이력/규칙 탭 · 심각도·미확인 칩 · 병동/종류/검색 필터(주소에 남음) · 표 · 오른쪽 상세 */
export default function Alarms({ alarms }) {
  const [qs, setQs] = useQuery()
  const tab = qs.get('tab') || 'active', q = qs.get('q') || '', ward = qs.get('ward') || '', kind = qs.get('kind') || '', chip = qs.get('f') || '', sel = qs.get('sel') || ''
  const [hist] = usePoll(() => api.alarmHistory(500), 5000)
  const [rules, setRules] = useState(null)
  const [draft, setDraft] = useState(null)
  const [page, setPage] = useState(0)
  useEffect(() => { api.alarmRules().then((r) => { setRules(r); setDraft(r) }) }, [])
  const active = alarms?.alarms || []
  const ack = async (id) => { await api.ackAlarm(id) }
  const save = async () => { const r = await api.setAlarmRules(draft); setRules(r); setDraft(r) }
  const src = tab === 'active' ? active : hist || []
  const scoped = useMemo(() => src.filter((a) => (!ward || wardOfRoom(a.room) === ward) && (!kind || a.kind === kind)), [src, ward, kind])
  const chips = useMemo(() => [
    { key: 'all', label: '전체', count: scoped.length },
    ...SEVS.map((k) => ({ key: k, label: SEV_LABEL[k], count: scoped.filter((a) => a.severity === k).length, cls: `c-sev-${k}` })),
    ...(tab === 'active' ? [{ key: 'unacked', label: '미확인', count: scoped.filter((a) => !a.acked).length, cls: 'c-err' }] : []),
  ], [scoped, tab])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = scoped.filter((a) => !needle || [a.channel_id, a.patient_name, a.room, a.message, a.gateway_id && `gw ${a.gateway_id}`, ALARM_KIND[a.kind]].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (chip === 'unacked') v = v.filter((a) => !a.acked)
    else if (SEVS.includes(chip)) v = v.filter((a) => a.severity === chip)
    return tab === 'active' ? sortBy(v, (a) => SEV_RANK[a.severity] * 1e13 + a.since_ms, 'desc') : v
  }, [scoped, q, chip, tab])
  const wards = useMemo(() => {
    const c = new Map()
    for (const a of src) { const w = wardOfRoom(a.room); if (w) c.set(w, (c.get(w) || 0) + 1) }
    return [{ value: '', label: '모든 병동', count: src.length }, ...[...c].sort((x, y) => x[0].localeCompare(y[0])).map(([w, n]) => ({ value: w, label: wardText(w), count: n }))]
  }, [src])
  const kinds = useMemo(() => {
    const c = new Map()
    for (const a of src) c.set(a.kind, (c.get(a.kind) || 0) + 1)
    return [{ value: '', label: '모든 종류', count: src.length }, ...[...c].sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ value: k, label: ALARM_KIND[k] || k, count: n }))]
  }, [src])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const selA = sel ? src.find((a) => String(a.id) + (a.cleared_ms || '') === sel) || src.find((a) => String(a.id) === sel) : null
  const applied = [
    ward && { key: 'ward', label: `병동: ${wardText(ward)}`, clear: () => setQs({ ward: '' }) },
    kind && { key: 'kind', label: `종류: ${ALARM_KIND[kind] || kind}`, clear: () => setQs({ kind: '' }) },
    chip && { key: 'f', label: chip === 'unacked' ? '미확인' : SEV_LABEL[chip], clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  const setTab = (t) => { setQs({ tab: t === 'active' ? '' : t, sel: '', f: '' }); setPage(0) }
  return (
    <div className="page lk">
      <div className="toolbar lk-tabs">
        <span className="seg">{[['active', `활성 ${active.length}`], ['history', '이력'], ['rules', '규칙']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</span>
        {tab === 'active' && <button onClick={() => shown.filter((a) => !a.acked).forEach((a) => ack(a.id))} disabled={!shown.some((a) => !a.acked)}>보이는 알람 모두 확인 ({shown.filter((a) => !a.acked).length})</button>}
      </div>
      {tab !== 'rules' && <>
        <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="건" />
        <FilterBar applied={applied} onReset={() => setQs({ q: '', ward: '', kind: '', f: '' })}
          right={<><span className="muted">{shown.length.toLocaleString()}건{tab === 'history' ? ' · 최근 500건' : ''}</span><Pager page={cur} pages={pages} onPage={setPage} /></>}>
          <input placeholder="검색: 환자 · 패치 · 병실 · 내용 · GW" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
          <Dropdown value={ward} options={wards} onChange={(v) => { setQs({ ward: v }); setPage(0) }} placeholder="모든 병동" countUnit="건" width={180} />
          <Dropdown value={kind} options={kinds} onChange={(v) => { setQs({ kind: v }); setPage(0) }} placeholder="모든 종류" countUnit="건" width={180} />
        </FilterBar>
        <ListLayout detail={selA ? <AlarmDetail a={selA} onAck={ack} onClose={() => setQs({ sel: '' })} /> : null}>
          <table className="tbl">
            <thead><tr><th>심각도</th><th>종류</th><th>대상</th><th>위치</th><th>내용</th><th className="num">값</th><th>발생</th><th>{tab === 'active' ? '경과' : '해제'}</th><th /></tr></thead>
            <tbody>
              {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((a) => {
                const key = String(a.id) + (a.cleared_ms || '')
                return (
                  <tr key={key} className={`clickable sev-${a.severity} ${a.acked ? 'acked' : ''}${sel === key ? ' selected' : ''}`} onClick={() => setQs({ sel: sel === key ? '' : key })}>
                    <td><span className={`tag sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span></td>
                    <td title={a.kind}>{ALARM_KIND[a.kind] || a.kind}</td>
                    <td>{a.channel_id ? <PatientLink ch={a.channel_id}><b>{a.patient_name || a.channel_id}</b></PatientLink> : a.gateway_id ? <GwLink id={a.gateway_id} /> : <b>시스템</b>}{a.channel_id && <small className="mono muted"> {a.channel_id}</small>}</td>
                    <td title={a.room}><RoomLink room={a.room} /></td><td>{a.message}</td><td className="num">{a.value}</td><td className="muted">{fmtTime(a.since_ms)}</td>
                    <td>{tab === 'active' ? fmtAgo(a.since_ms) : a.cleared_ms ? fmtTime(a.cleared_ms) : <span className="muted">발생</span>}</td>
                    <td>{tab === 'active' && !a.acked && <button onClick={(e) => { e.stopPropagation(); ack(a.id) }}>확인</button>}{a.acked && <span className="muted">확인됨</span>}</td>
                  </tr>
                )
              })}
              {!shown.length && <tr><td colSpan="9" className="muted">{tab === 'active' ? '조건에 맞는 활성 알람이 없습니다.' : '조건에 맞는 알람 이력이 없습니다.'}</td></tr>}
            </tbody>
          </table>
        </ListLayout>
      </>}
      {tab === 'rules' && draft && (
        <div className="panel rules">
          <div className="rule-grid">
            {RULE_FIELDS.map(([k, label, unit]) => (
              <label key={k}><span>{label}</span><input type="number" step={k.startsWith('temp') ? 0.1 : 1} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /><small>{unit}</small></label>
            ))}
          </div>
          <div className="toolbar">
            <button className="primary" onClick={save} disabled={JSON.stringify(draft) === JSON.stringify(rules)}>저장</button>
            <button onClick={() => setDraft(rules)}>되돌리기</button>
            <span className="muted">수치 알람은 임계를 '지속' 시간 이상 벗어나야 발생하고, 조건이 사라진 뒤 '해제 유예' 시간이 지나면 자동 해제됩니다. 전극 탈락 중에는 수치 알람을 평가하지 않습니다.</span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 알람 상세: 알람 정보 · 대상 환자 요약 · 확인/파형/환자/지도로 가는 버튼 */
function AlarmDetail({ a, onAck, onClose }) {
  const [rows] = usePoll(() => (a.channel_id ? api.channelsScoped(`ids=${encodeURIComponent(a.channel_id)}`) : Promise.resolve([])), 5000, [a.channel_id])
  const r = rows?.[0]
  const v = r?.vitals || {}
  const p = r?.patient || {}
  return (
    <DetailPanel title={ALARM_KIND[a.kind] || a.kind} sub={SEV_LABEL[a.severity]} onClose={onClose}
      actions={<>
        {!a.acked && !a.cleared_ms && <button className="primary" onClick={() => onAck(a.id)}>확인</button>}
        {a.channel_id && <button onClick={() => openLive(a.channel_id)}>실시간 파형</button>}
        {a.channel_id && <button onClick={() => go('#/patients', { sel: a.channel_id })}>환자 상세</button>}
        {(a.channel_id || a.room) && <button onClick={() => go('#/map', a.channel_id ? { pat: a.channel_id } : { room: a.room })}>지도에서 보기</button>}
      </>}>
      <div className={`lk-alarm sev-${a.severity}`}><span className={`tag small sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span> {a.message}</div>
      <dl className="lk-kv">
        <KV k="값">{a.value}</KV>
        <KV k="발생">{fmtTime(a.since_ms)} ({fmtAgo(a.since_ms)})</KV>
        <KV k="해제">{a.cleared_ms ? fmtTime(a.cleared_ms) : '아직 발생 중'}</KV>
        <KV k="확인">{a.acked ? '확인됨' : '미확인'}</KV>
        <KV k="환자">{a.channel_id ? <PatientLink ch={a.channel_id}>{a.patient_name || a.channel_id}</PatientLink> : null}</KV>
        <KV k="병동">{a.room ? <WardLink ward={wardOfRoom(a.room)} /> : null}</KV>
        <KV k="위치">{a.room ? <RoomLink room={a.room}>{roomText(a.room)}</RoomLink> : null}</KV>
        <KV k="게이트웨이">{a.gateway_id || r?.gateway_id ? <GwLink id={a.gateway_id || r?.gateway_id} /> : null}</KV>
        {r && <KV k="현재 바이탈">HR <b>{v.hr ?? '—'}</b> · SpO₂ <b>{v.spo2 ?? '—'}</b> · RR <b>{v.resp ?? '—'}</b>{v.temp != null ? <> · <b>{v.temp.toFixed(1)}</b>°C</> : null}</KV>}
        {r && <KV k="진료">{[p.department, p.diagnosis].filter(Boolean).join(' · ')}</KV>}
      </dl>
    </DetailPanel>
  )
}
