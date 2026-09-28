import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtAgo } from '../api.js'
import Dropdown from '../Dropdown.jsx'
import { EVENT_KIND, SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'
import { useQuery, go, FilterBar, ListLayout, DetailPanel, KV, Pager, PatientLink, GwLink, Timeline, Kbd } from '../ListKit.jsx'
import './Events.css'

// 요약 칩 = 이벤트 묶음
const GROUPS = [
  ['alarm', '알람', (k) => k === 'alarm', 'c-err'],
  ['link', '게이트웨이 연결', (k) => /^(link|silent|bad_crc|gateway|gw_|ingest)/.test(k), 'c-warn'],
  ['security', '보안', (k) => /^(security|latency_reset)$/.test(k) || /^security/.test(k), 'c-sev-critical'],
  ['control', '제어', (k) => /^(control|metrics_reset|stats_reset|wave_reset)$/.test(k), ''],
  ['store', '저장·백업', (k) => /^(backup|wave|store)/.test(k), ''],
  ['config', '설정·관리', (k) => /(_config|_rules|registry_prune)$/.test(k) || /^(alarm_rules)$/.test(k), ''],
]
const groupOf = (k) => GROUPS.find(([, , f]) => f(k))?.[0] || 'etc'
/** 칩 앞 점 색과 히스토그램 막대 색 (분류 = 색) */
const GROUP_COLOR = { alarm: 'var(--sev-critical)', link: 'var(--accent)', security: 'var(--err)', control: 'var(--warn)', store: 'var(--ok)', config: 'var(--muted)', etc: 'var(--muted)' }
const MINUTES = 60
const PERIODS = [['', '전체'], ['10', '최근 10분'], ['60', '최근 1시간']]
const SEV_OF = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' }
const SEV_TONE = { critical: 'crit', high: 'high', medium: 'med', low: 'low' }
const PAGE = 100
/** "[High] 이름 메시지" → { sev, text } */
const parse = (e) => { const m = /^\[(Critical|High|Medium|Low)\]\s*(.*)$/.exec(e.message || ''); return { sev: m && SEV_OF[m[1]], text: m ? m[2] : e.message } }
/** 메시지 속 게이트웨이 번호 ("gw 123", "GW 123", "GW-103-0088") */
const gwIn = (msg) => { const m = /\bgw[ -#]?(\d{1,5})\b/i.exec(msg || ''); return m ? m[1] : '' }
/** 알약 색: 보안 → 빨강, 제어·링크 → 주황(주의), 알람 → 심각도, 나머지 회색 (색 = 사람이 봐야 할 것) */
const toneOf = (e) => (e.sev ? SEV_TONE[e.sev] : e.grp === 'security' ? 'err' : e.grp === 'control' || e.grp === 'link' ? 'med' : '')
const hm = (ms) => new Date(ms).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' })
const ls = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v === '1' } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* ignore */ } }

/**
 * 이벤트: 표 대신 타임라인. 날짜 구분줄 · 고정폭 시각 · 종류 알약 · 대상 링크 · 내용.
 *  - 묶어 보기(기본): 같은 종류 + 같은 대상이 연달아 오면 한 줄로 접고 시각 범위와 "×N 묶음" 을 보인다. 눌러 펼친다.
 *  - 자동 스크롤: 켜져 있으면 새 이벤트가 위에 쌓이고, 끄면 목록을 고정해 보던 자리가 흔들리지 않는다.
 *  - 조건(검색·종류·기간·묶음 칩·선택)은 주소에 남는다.
 */
export default function Events() {
  const [live] = usePoll(api.events, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', kind = qs.get('kind') || '', chip = qs.get('f') || '', period = qs.get('period') || '', sel = qs.get('sel') || ''
  const [page, setPage] = useState(0)
  const [fold, setFold] = useState(() => ls('events.fold', true))
  const [follow, setFollow] = useState(() => ls('events.follow', true))
  const [expanded, setExpanded] = useState(() => new Set())
  // 자동 스크롤을 끄면 그 순간의 목록을 붙잡아 둔다 (새 이벤트는 다시 켤 때 한꺼번에)
  const [frozen, setFrozen] = useState(null)
  // 시간대별 발생 히스토그램에서 끌어 고른 분 범위 [from, to] (지금 기준 −분, from ≤ to); null = 전체
  const [range, setRange] = useState(null)
  const dragRef = useRef(null)
  useEffect(() => { if (follow) setFrozen(null); else if (!frozen && live) setFrozen(live) }, [follow, live]) // eslint-disable-line react-hooks/exhaustive-deps
  const events = follow ? live : frozen || live
  const pendingNew = !follow && frozen && live ? Math.max(0, live.length - frozen.length) : 0

  const all = useMemo(() => (events || []).map((e, i) => ({ ...e, key: `${e.ts_ms}-${i}`, grp: groupOf(e.kind), ...parse(e) })).reverse(), [events])
  const scoped = useMemo(() => {
    const since = period ? Date.now() - Number(period) * 60000 : 0
    const now = Date.now()
    return all.filter((e) => e.ts_ms >= since && (!kind || e.kind === kind)
      && (!range || (now - e.ts_ms >= range[0] * 60000 && now - e.ts_ms < (range[1] + 1) * 60000)))
  }, [all, period, kind, range])
  // 시간대별 발생: 최근 60분을 분 단위 60칸으로, 칸마다 건수와 가장 많은 분류 (검색·칩 전 단계 = 종류·기간 필터만 반영)
  const bars = useMemo(() => {
    const now = Date.now()
    const b = Array.from({ length: MINUTES }, () => ({ n: 0, by: {} }))
    for (const e of all) {
      if (kind && e.kind !== kind) continue
      const m = Math.floor((now - e.ts_ms) / 60000)
      if (m < 0 || m >= MINUTES) continue
      const slot = b[MINUTES - 1 - m]
      slot.n++; slot.by[e.grp] = (slot.by[e.grp] || 0) + 1
    }
    const max = Math.max(1, ...b.map((x) => x.n))
    return b.map((x, i) => ({ ...x, i, ago: MINUTES - 1 - i, h: x.n ? Math.max(2, Math.round((x.n / max) * 44)) : 2, top: Object.entries(x.by).sort((a, c) => c[1] - a[1])[0]?.[0] }))
  }, [all, kind])
  // 끌어서 범위 선택: pointerdown 으로 시작, move 로 넓히고, up 으로 확정 (한 칸만 눌러도 그 1분)
  const barAgo = (el) => Number(el?.dataset?.ago)
  const onBarDown = (e) => { const a = barAgo(e.target); if (Number.isNaN(a)) return; dragRef.current = a; setRange([a, a]); e.currentTarget.setPointerCapture?.(e.pointerId) }
  const onBarMove = (e) => {
    if (dragRef.current == null) return
    const el = document.elementFromPoint(e.clientX, e.clientY); const a = barAgo(el)
    if (Number.isNaN(a)) return
    const s0 = dragRef.current; setRange([Math.min(s0, a), Math.max(s0, a)]); setPage(0)
  }
  const onBarUp = () => { dragRef.current = null }
  const chips = useMemo(() => [
    { key: 'all', label: '전체', count: scoped.length },
    ...GROUPS.map(([k, l, , cls]) => ({ key: k, label: l, count: scoped.filter((e) => e.grp === k).length, cls })).filter((c) => c.count || c.key === 'alarm' || c.key === 'link'),
    { key: 'etc', label: '기타', count: scoped.filter((e) => e.grp === 'etc').length },
  ], [scoped])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = scoped.filter((e) => !needle || [e.channel_id, e.message, EVENT_KIND[e.kind], e.kind].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (chip) v = v.filter((e) => e.grp === chip)
    return v
  }, [scoped, q, chip])
  // 묶기: 최신순 배열에서 같은 종류 + 같은 대상이 연속되면 한 항목 (첫 = 최신, 마지막 = 가장 오래된)
  const rows = useMemo(() => {
    if (!fold) return shown.map((e) => ({ ...e, items: [e], count: 1 }))
    const out = []
    for (const e of shown) {
      const tgt = e.channel_id || gwIn(e.message) || ''
      const last = out[out.length - 1]
      if (last && last.kind === e.kind && last.tgt === tgt && !last.sev && !e.sev) { last.items.push(e); last.count++; continue }
      out.push({ ...e, tgt, items: [e], count: 1 })
    }
    return out
  }, [shown, fold])
  const kinds = useMemo(() => {
    const c = new Map()
    for (const e of all) c.set(e.kind, (c.get(e.kind) || 0) + 1)
    return [{ value: '', label: '모든 종류', count: all.length }, ...[...c].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ value: k, label: EVENT_KIND[k] || k, count: n }))]
  }, [all])
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const selE = sel ? all.find((e) => e.key === sel) : null
  const applied = [
    kind && { key: 'kind', label: `종류: ${EVENT_KIND[kind] || kind}`, clear: () => setQs({ kind: '' }) },
    period && { key: 'period', label: PERIODS.find(([k]) => k === period)?.[1], clear: () => setQs({ period: '' }) },
    chip && { key: 'f', label: chips.find((c) => c.key === chip)?.label || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
    range && { key: 'range', label: range[0] === range[1] ? `${range[0]}분 전 (1분)` : `${range[1]}분 전 ~ ${range[0] ? `${range[0]}분 전` : '지금'}`, clear: () => setRange(null) },
  ].filter(Boolean)
  const toggleFold = (v) => { setFold(v); lsSet('events.fold', v); setExpanded(new Set()); setPage(0) }
  const toggleFollow = () => { const v = !follow; setFollow(v); lsSet('events.follow', v) }

  // 타임라인 항목: 묶음은 시각 범위 + 펼치기, 펼친 묶음은 원래 행들로
  const items = []
  for (const r of rows.slice(cur * PAGE, cur * PAGE + PAGE)) {
    const open = expanded.has(r.key)
    const list = r.count > 1 && !open ? [r] : r.items
    for (const e of list) {
      const gw = gwIn(e.message)
      const grouped = e === r && r.count > 1 && !open
      items.push({
        key: e.key, ts_ms: e.ts_ms, kindLabel: EVENT_KIND[e.kind] || e.kind, tone: toneOf(e),
        range: grouped ? `${hm(r.items[r.items.length - 1].ts_ms)} ~ ${hm(r.items[0].ts_ms)}` : undefined,
        count: grouped ? r.count : 1,
        onExpand: grouped ? () => setExpanded((s) => new Set([...s, r.key])) : undefined,
        onClick: () => setQs({ sel: sel === e.key ? '' : e.key }),
        body: (
          <>
            {e.channel_id ? <PatientLink ch={e.channel_id}><span className="mono">{e.channel_id}</span></PatientLink> : gw ? <GwLink id={gw} /> : null}
            {(e.channel_id || gw) && ' · '}
            {e.sev && <span className={`tag small sev-${e.sev}`}>{SEV_LABEL[e.sev]}</span>}
            <span className={sel === e.key ? 'lk-tl-sel' : ''} title={e.message}>{e.text}</span>
            {grouped && <span className="muted small"> (같은 종류 · 같은 대상 {r.count}건)</span>}
            {open && e === r.items[0] && r.count > 1 && <span className="lk-fold" onClick={(ev) => { ev.stopPropagation(); setExpanded((s) => { const n = new Set(s); n.delete(r.key); return n }) }}> 접기</span>}
          </>
        ),
      })
    }
  }
  const total = (live || []).length
  return (
    <div className="page lk events">
      {/* 제목 줄: 이름 · 부제 · (오른쪽) 자동 스크롤 · 건수 */}
      <div className="ev-head">
        <h2 className="h">이벤트 로그</h2>
        <span className="muted">패치 · 환자 · 게이트웨이에서 일어난 모든 기록</span>
        <span className="spacer" />
        <label className="ev-follow" title={follow ? '새 이벤트가 위에 쌓입니다. 끄면 목록이 고정됩니다.' : '목록이 고정되어 있습니다. 켜면 새 이벤트를 반영합니다.'}>
          <input type="checkbox" checked={follow} onChange={toggleFollow} /> 새 이벤트 자동 스크롤{pendingNew ? <b className="ev-new"> · 새 {pendingNew}건</b> : null}
        </label>
        <span className="muted mono">{shown.length.toLocaleString()}건 · 라우터 메모리 최근 {total.toLocaleString()}건</span>
      </div>

      {/* 필터 카드: 검색 · 분류 칩(점 색 = 분류) · 기간 · 보기 방식 */}
      <div className="ev-card ev-filter">
        <input placeholder="패치 · 환자 · 게이트웨이 · 내용" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} aria-label="이벤트 검색" />
        <div className="ev-chips" role="group" aria-label="분류">
          {chips.map((c) => (
            <button key={c.key} className={'ev-chip' + ((chip || 'all') === c.key ? ' on' : '') + (!c.count && c.key !== 'all' ? ' zero' : '')} onClick={() => { setQs({ f: c.key === 'all' ? '' : c.key }); setPage(0) }}>
              {c.key !== 'all' && <i style={{ background: GROUP_COLOR[c.key] || 'var(--muted)' }} />}{c.label} <b className="mono">{c.count.toLocaleString()}</b>
            </button>
          ))}
        </div>
        <Dropdown value={kind} options={kinds} onChange={(v) => { setQs({ kind: v }); setPage(0) }} placeholder="모든 종류" countUnit="건" width={190} />
        <span className="spacer" />
        <span className="seg" role="group" aria-label="기간">{PERIODS.map(([k, l]) => <button key={k} className={period === k ? 'active' : ''} onClick={() => { setQs({ period: k }); setRange(null); setPage(0) }}>{l}</button>)}</span>
        <span className="seg" role="group" aria-label="보기 방식" title="같은 종류 · 같은 대상이 연달아 오면 한 줄로 접습니다">
          <button className={fold ? 'active' : ''} onClick={() => toggleFold(true)}>대상별 묶기</button>
          <button className={!fold ? 'active' : ''} onClick={() => toggleFold(false)}>모두 펼침</button>
        </span>
      </div>
      {applied.length > 0 && <FilterBar applied={applied} onReset={() => { setQs({ q: '', kind: '', f: '', period: '' }); setRange(null) }} />}

      {/* 시간대별 발생: 최근 60분 · 분 단위 막대 · 끌어서 범위 선택 */}
      <div className="ev-card ev-hist">
        <div className="ev-hist-head">
          <b>시간대별 발생</b>
          <span className="muted">막대를 끌어 기간 선택 · 색 = 그 분의 가장 많은 분류</span>
          {range && <a className="lk-link" onClick={() => setRange(null)}>선택 해제</a>}
          <span className="spacer" />
          <span className="muted mono">최근 60분 {bars.reduce((a, b) => a + b.n, 0).toLocaleString()}건</span>
        </div>
        <div className="ev-bars" onPointerDown={onBarDown} onPointerMove={onBarMove} onPointerUp={onBarUp} onPointerCancel={onBarUp}>
          {bars.map((b) => (
            <div key={b.i} data-ago={b.ago} className={'ev-bar' + (range && b.ago >= range[0] && b.ago <= range[1] ? ' sel' : '') + (b.n ? '' : ' empty')}
              style={{ height: b.h, background: b.n ? GROUP_COLOR[b.top] || 'var(--muted)' : undefined }}
              title={`${b.ago ? `${b.ago}분 전` : '지금'} · ${b.n}건${b.top ? ` · ${chips.find((c) => c.key === b.top)?.label || b.top}` : ''}`} />
          ))}
        </div>
        <div className="ev-ticks mono"><span>−60분</span><span>−45</span><span>−30</span><span>−15</span><span>지금</span></div>
      </div>

      <ListLayout detail={selE ? <EventDetail e={selE} onClose={() => setQs({ sel: '' })} /> : <EventDetailEmpty />}>
        <div className="ev-list-head mono"><span>시각</span><span>분류</span><span>대상 · 내용 · 값</span><span className="spacer" /><Pager page={cur} pages={pages} onPage={setPage} /></div>
        {items.length ? <Timeline items={items} /> : (
          <div className="ev-empty">
            <b>{total ? '조건에 맞는 기록이 없습니다' : '기록이 없습니다'}</b>
            <span>{total ? '검색·분류·기간·시간대 선택을 지우면 전체 기록이 보입니다.' : '라우터가 재시작되면 메모리 기록이 비워지고, 이벤트가 생기는 대로 다시 쌓입니다.'}</span>
          </div>
        )}
        <p className="lk-legend">보안·제어·연결 이벤트만 색이 있고 나머지는 회색입니다. 대상을 누르면 환자·게이트웨이 목록으로, 줄을 누르면 오른쪽에 상세. <Kbd>Esc</Kbd> 상세 닫기</p>
      </ListLayout>
    </div>
  )
}

/** 아무 줄도 고르지 않았을 때의 오른쪽 안내 */
function EventDetailEmpty() {
  return (
    <aside className="lk-detail ev-detail-empty" aria-label="이벤트 상세">
      <header><div className="lk-dh"><h3>상세</h3></div></header>
      <div className="lk-dbody">
        <p className="muted">행을 누르면 여기에 열립니다. 대상 환자·게이트웨이로 바로 이동하고, 같은 대상의 앞뒤 이벤트를 함께 보여 줍니다. <Kbd>Esc</Kbd> 로 닫기.</p>
        <div className="ev-sk"><i style={{ width: '60%', height: 14 }} /><i style={{ width: '90%' }} /><i style={{ width: '80%' }} /><i style={{ width: '40%' }} /></div>
      </div>
    </aside>
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
