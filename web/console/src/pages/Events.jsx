import React, { useMemo, useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import Dropdown from '../Dropdown.jsx'
import { EVENT_KIND, SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'
import { useQuery, go, Cols, tableMin, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, PatientLink, GwLink } from '../ListKit.jsx'

// 요약 칩 = 이벤트 묶음
const GROUPS = [
  ['alarm', '알람', (k) => k === 'alarm', 'c-err'],
  ['link', '게이트웨이·연결', (k) => /^(link|silent|bad_crc|gateway|gw_|ingest)/.test(k), 'c-warn'],
  ['store', '저장·백업', (k) => /^(backup|wave|store)/.test(k), ''],
  ['config', '설정·관리', (k) => /(_config|_reset|_rules|registry_prune)$/.test(k) || /^(alarm_rules|metrics_reset|stats_reset)$/.test(k), ''],
]
const groupOf = (k) => GROUPS.find(([, , f]) => f(k))?.[0] || 'etc'
const PERIODS = [['', '전체'], ['10', '최근 10분'], ['60', '최근 1시간']]
const SEV_OF = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' }
const PAGE = 100
const W = [84, 120, 130, null] // 시각 · 종류 · 대상 · 내용(남는 폭)
/** "[High] 이름 메시지" → { sev, text } */
const parse = (e) => { const m = /^\[(Critical|High|Medium|Low)\]\s*(.*)$/.exec(e.message || ''); return { sev: m && SEV_OF[m[1]], text: m ? m[2] : e.message } }
/** 메시지 속 게이트웨이 번호 ("gw 123", "GW 123", "GW-103-0088") */
const gwIn = (msg) => { const m = /\bgw[ -#]?(\d{1,5})\b/i.exec(msg || ''); return m ? m[1] : '' }

/** 이벤트: 묶음 칩 · 종류/기간/검색 필터(주소에 남음) · 시간순 표(최신 위) · 오른쪽 상세 */
export default function Events() {
  const [events] = usePoll(api.events, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', kind = qs.get('kind') || '', chip = qs.get('f') || '', period = qs.get('period') || '', sel = qs.get('sel') || ''
  const [page, setPage] = useState(0)
  const all = useMemo(() => (events || []).map((e, i) => ({ ...e, key: `${e.ts_ms}-${i}`, grp: groupOf(e.kind), ...parse(e) })).reverse(), [events])
  const scoped = useMemo(() => {
    const since = period ? Date.now() - Number(period) * 60000 : 0
    return all.filter((e) => e.ts_ms >= since && (!kind || e.kind === kind))
  }, [all, period, kind])
  const chips = useMemo(() => [{ key: 'all', label: '전체', count: scoped.length }, ...GROUPS.map(([k, l, , cls]) => ({ key: k, label: l, count: scoped.filter((e) => e.grp === k).length, cls })), { key: 'etc', label: '기타', count: scoped.filter((e) => e.grp === 'etc').length }], [scoped])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = scoped.filter((e) => !needle || [e.channel_id, e.message, EVENT_KIND[e.kind], e.kind].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (chip) v = v.filter((e) => e.grp === chip)
    return v
  }, [scoped, q, chip])
  const kinds = useMemo(() => {
    const c = new Map()
    for (const e of all) c.set(e.kind, (c.get(e.kind) || 0) + 1)
    return [{ value: '', label: '모든 종류', count: all.length }, ...[...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, label: EVENT_KIND[k] || k, count: n }))]
  }, [all])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const selE = sel ? all.find((e) => e.key === sel) : null
  const applied = [
    kind && { key: 'kind', label: `종류: ${EVENT_KIND[kind] || kind}`, clear: () => setQs({ kind: '' }) },
    period && { key: 'period', label: PERIODS.find(([k]) => k === period)?.[1], clear: () => setQs({ period: '' }) },
    chip && { key: 'f', label: chips.find((c) => c.key === chip)?.label || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  return (
    <div className="page lk">
      <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="건" />
      <FilterBar applied={applied} onReset={() => setQs({ q: '', kind: '', f: '', period: '' })}
        right={<><span className="muted">{shown.length.toLocaleString()}건 · 라우터 메모리의 최근 이벤트</span><Pager page={cur} pages={pages} onPage={setPage} /></>}>
        <input placeholder="검색: 패치 · 환자 · 내용" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
        <Dropdown value={kind} options={kinds} onChange={(v) => { setQs({ kind: v }); setPage(0) }} placeholder="모든 종류" countUnit="건" width={200} />
        <span className="seg">{PERIODS.map(([k, l]) => <button key={k} className={period === k ? 'active' : ''} onClick={() => { setQs({ period: k }); setPage(0) }}>{l}</button>)}</span>
      </FilterBar>
      <ListLayout detail={selE ? <EventDetail e={selE} onClose={() => setQs({ sel: '' })} /> : null}>
        <table className="tbl dense fixed" style={{ minWidth: tableMin(W, 300) }}>
          <Cols w={W} />
          <thead><tr><th>시각</th><th>종류</th><th>대상</th><th>내용</th></tr></thead>
          <tbody>
            {shown.slice(cur * PAGE, cur * PAGE + PAGE).map((e) => {
              const gw = gwIn(e.message)
              return (
                <tr key={e.key} className={'clickable' + (e.sev ? ` sev-${e.sev}` : '') + (sel === e.key ? ' selected' : '')} onClick={() => setQs({ sel: sel === e.key ? '' : e.key })}>
                  <td className="mono muted">{fmtTime(e.ts_ms)}</td>
                  <td>{EVENT_KIND[e.kind] || e.kind}</td>
                  <td>{e.channel_id ? <PatientLink ch={e.channel_id}><span className="mono">{e.channel_id}</span></PatientLink> : gw ? <GwLink id={gw} /> : <span className="muted">시스템</span>}</td>
                  <td title={e.message}>{e.sev && <span className={`tag small sev-${e.sev}`}>{SEV_LABEL[e.sev]}</span>} {e.text}</td>
                </tr>
              )
            })}
            {!shown.length && <tr><td colSpan="4" className="muted">조건에 맞는 이벤트가 없습니다.</td></tr>}
          </tbody>
        </table>
      </ListLayout>
    </div>
  )
}

function EventDetail({ e, onClose }) {
  const gw = gwIn(e.message)
  return (
    <DetailPanel title={EVENT_KIND[e.kind] || e.kind} sub={`${new Date(e.ts_ms).toLocaleString('ko-KR', { hour12: false })} · ${fmtAgo(e.ts_ms)}`} onClose={onClose}
      actions={<>
        {e.channel_id && <button className="primary" onClick={() => openLive(e.channel_id)}>실시간 파형</button>}
        {e.channel_id && <button onClick={() => go('#/patients', { sel: e.channel_id })}>환자 상세</button>}
        {e.channel_id && <button onClick={() => go('#/alarms', { q: e.channel_id, tab: 'history' })}>알람 이력</button>}
        {gw && <button onClick={() => go('#/gateways', { sel: gw })}>게이트웨이</button>}
        <button onClick={() => go('#/events', { q: e.channel_id || gw || '', kind: e.channel_id || gw ? '' : e.kind })}>{e.channel_id || gw ? '같은 대상 이벤트' : '같은 종류 이벤트'}</button>
      </>}>
      {e.sev && <div className={`lk-alarm sev-${e.sev}`}><span className={`tag small sev-${e.sev}`}>{SEV_LABEL[e.sev]}</span> {e.text}</div>}
      <dl className="lk-kv">
        <KV k="종류">{EVENT_KIND[e.kind] || e.kind} <small className="mono muted">{e.kind}</small></KV>
        <KV k="내용">{e.message}</KV>
        <KV k="패치">{e.channel_id ? <PatientLink ch={e.channel_id}><span className="mono">{e.channel_id}</span></PatientLink> : null}</KV>
        <KV k="게이트웨이">{gw ? <GwLink id={gw} /> : null}</KV>
      </dl>
    </DetailPanel>
  )
}
