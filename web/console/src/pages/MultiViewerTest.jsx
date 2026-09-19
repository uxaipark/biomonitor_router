import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtBytes } from '../api.js'
import { TEMPLATES, viewerUrl } from '../viewer/templates.js'
import Dropdown from '../Dropdown.jsx'
import { sortBy } from '../model.js'

/** Load test: open browser tabs running a viewer template, one ward each, to see how many live viewers the
 *  router and a viewer PC sustain. Bulk opens run sequentially: a tab is opened, we wait for its page to finish
 *  loading (same-origin readyState) and for a 3 s gap, then the next one opens — opening dozens at once made the
 *  browser stall and gave a useless measurement. Counts above the ward count wrap around the wards again.
 *  Browsers allow one popup per click unless the site is allowed to open popups, so bulk opens need that
 *  permission; "다음 병동 열기" opens one per click without it. */
const GAP_MS = 3000
const LOAD_TIMEOUT_MS = 15000
const BULK_COUNTS = [20, 40, 60]
export default function MultiViewerTest() {
  const [rows] = usePoll(api.channels, 10000)
  const [stats] = usePoll(api.stats, 2000)
  const [tpl, setTpl] = useState('central')
  const [next, setNext] = useState(0)
  const [log, setLog] = useState({ opened: 0, blocked: 0 })
  const [bulk, setBulk] = useState(null) // { total, done, ward } while a sequential open runs
  const stopRef = useRef(false)
  const timerRef = useRef(null)
  const [sort, setSort] = useState(['ward', 'asc'])
  const wins = useRef(new Map()) // ward → Window
  const [, tick] = useState(0)
  const live = useMemo(() => (rows || []).filter((r) => r.connected), [rows])
  const wards = useMemo(() => {
    const m = new Map()
    for (const r of live) if (r.patient?.ward) {
      if (!m.has(r.patient.ward)) m.set(r.patient.ward, { names: [], gws: new Set() })
      const e = m.get(r.patient.ward); e.names.push(r.patient.name || r.mrn || r.channel_id); if (r.gateway_id) e.gws.add(r.gateway_id)
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0], 'ko')).map(([w, e]) => ({ ward: w, count: e.names.length, names: e.names.sort((a, b) => String(a).localeCompare(String(b), 'ko')), gws: [...e.gws].sort((a, b) => a - b) }))
  }, [live])
  const tplOpts = TEMPLATES.map((t) => ({ value: t.id, label: t.name, count: undefined }))
  const urlOf = (w) => viewerUrl({ tpl, ward: w })
  // poll the opened windows so closed tabs drop out of the "open" count
  useEffect(() => { const t = setInterval(() => { for (const [w, win] of wins.current) if (win.closed) wins.current.delete(w); tick((x) => x + 1) }, 1000); return () => clearInterval(t) }, [])
  // tabs are keyed by ward plus a slot number, so asking for more tabs than wards opens the wards again
  const slotKey = (w, slot) => (slot ? `${w}#${slot}` : w)
  const wardOfKey = (k) => k.split('#')[0]
  const openSlot = (w, slot = 0) => {
    const key = slotKey(w, slot)
    const cur = wins.current.get(key)
    if (cur && !cur.closed) { cur.focus(); return cur }
    const win = window.open(urlOf(w), `viewer-${key}`)
    if (win) wins.current.set(key, win)
    return win
  }
  const openOne = (w) => !!openSlot(w, 0)
  const sleep = (ms) => new Promise((r) => { timerRef.current = setTimeout(r, ms) })
  /** wait until the new tab reports a finished load (same-origin), then out the rest of the 3 s gap */
  const waitReady = async (win, openedAt) => {
    const deadline = performance.now() + LOAD_TIMEOUT_MS
    while (performance.now() < deadline) {
      if (!win || win.closed || stopRef.current) break
      let done = false
      try { done = win.document.readyState === 'complete' } catch { done = true } // not inspectable: fall back to the gap
      if (done) break
      await sleep(200)
    }
    const rest = GAP_MS - (performance.now() - openedAt)
    if (rest > 0 && !stopRef.current) await sleep(rest)
  }
  const openMany = async (n) => {
    if (!wards.length || bulk) return
    stopRef.current = false
    let opened = 0, blocked = 0
    for (let i = 0; i < n; i++) {
      if (stopRef.current) break
      const ward = wards[i % wards.length].ward
      setBulk({ total: n, done: i, ward })
      const at = performance.now()
      const win = openSlot(ward, Math.floor(i / wards.length))
      if (win) opened++; else blocked++
      setLog({ opened, blocked })
      if (!win) break // popup blocked: stop instead of firing the rest into the void
      if (i < n - 1) await waitReady(win, at)
    }
    setBulk(null)
    setNext(Math.min(n, wards.length))
    tick((x) => x + 1)
  }
  const stopBulk = () => { stopRef.current = true; clearTimeout(timerRef.current) }
  useEffect(() => () => { stopRef.current = true; clearTimeout(timerRef.current) }, [])
  const openNext = () => {
    if (next >= wards.length) { setNext(0); return }
    const ok = openOne(wards[next].ward)
    setLog((l) => ({ opened: l.opened + (ok ? 1 : 0), blocked: l.blocked + (ok ? 0 : 1) }))
    setNext(next + 1)
  }
  const closeAll = () => { stopBulk(); for (const win of wins.current.values()) { try { win.close() } catch { /* ignore */ } } wins.current.clear(); setNext(0); setLog({ opened: 0, blocked: 0 }) }
  const openWards = [...wins.current.entries()].filter(([, w]) => !w.closed).map(([w]) => w)
  const openCount = openWards.length
  const isOpen = (w) => { const win = wins.current.get(w); return !!(win && !win.closed) }
  const sortedWards = sortBy(wards, sort[0] === 'gws' ? (w) => w.gws.length : sort[0] === 'open' ? (w) => (isOpen(w.ward) ? 0 : 1) : sort[0], sort[1])
  const th = (col, label) => <th key={col} className="sortable" onClick={() => setSort([col, sort[0] === col && sort[1] === 'asc' ? 'desc' : 'asc'])}>{label}{sort[0] === col ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}</th>
  const countOf = new Map(wards.map((w) => [w.ward, w.count]))
  const openPatients = openWards.reduce((n, k) => n + (countOf.get(wardOfKey(k)) || 0), 0)
  const memPct = stats ? Math.round(stats.mem_sys_used_bytes / stats.mem_sys_total_bytes * 100) : null
  return (
    <div className="page">
      <div className="stat-line">
        <span className="stat"><small>열린 뷰어 탭</small><b style={{ minWidth: '3ch' }}>{openCount}</b><small>병동 {wards.length}곳</small></span>
        <span className="stat"><small>표시 중인 환자 파형</small><b style={{ minWidth: '5ch' }}>{openPatients.toLocaleString()}</b><small>명</small></span>
        <span className="stat"><small>라우터 WS 세션</small><b style={{ minWidth: '3ch' }}>{stats?.ws_sessions ?? '—'}</b><small>구독 채널 {stats?.ws_subscribed_channels?.toLocaleString() ?? '—'}</small></span>
        <span className={'stat' + (stats?.cpu_process_percent > 150 ? ' warn' : '')}><small>라우터 CPU</small><b style={{ minWidth: '3ch' }}>{stats ? stats.cpu_process_percent.toFixed(0) : '—'}</b><small>% (1코어=100)</small></span>
        <span className={'stat' + (stats?.cpu_percent > 70 ? ' warn' : '')}><small>시스템 CPU</small><b style={{ minWidth: '3ch' }}>{stats ? stats.cpu_percent.toFixed(0) : '—'}</b><small>%</small></span>
        <span className="stat"><small>라우터 메모리</small><b style={{ minWidth: '9ch' }}>{stats ? fmtBytes(stats.mem_process_bytes) : '—'}</b></span>
        <span className={'stat' + (memPct > 80 ? ' warn' : '')}><small>시스템 메모리</small><b style={{ minWidth: '3ch' }}>{memPct ?? '—'}</b><small>% ({stats ? fmtBytes(stats.mem_sys_used_bytes) : '—'} / {stats ? fmtBytes(stats.mem_sys_total_bytes) : '—'})</small></span>
        <span className={'stat' + (stats?.ws_lagged > 0 ? ' warn' : '')}><small>WS 지연 건너뜀</small><b style={{ minWidth: '7ch' }}>{stats?.ws_lagged?.toLocaleString() ?? '—'}</b></span>
      </div>
      <h2 className="h">멀티 뷰어 테스트</h2>
      <p className="muted">병동마다 브라우저 탭을 하나씩 열고 그 병동의 뷰어를 띄웁니다. 병동 {wards.length}곳 · 환자 {live.length.toLocaleString()}명. 탭은 3초 간격으로 하나씩, 앞 탭이 다 뜬 뒤에 열립니다. 요청 개수가 병동 수보다 많으면 병동을 다시 돌며 엽니다. 탭마다 WebSocket 1개를 열어 그 병동 채널만 구독하므로 라우터 WS 세션·구독 채널 수와 브라우저 부하를 함께 볼 수 있습니다.</p>
      <div className="toolbar">
        <Dropdown value={tpl} options={tplOpts} onChange={setTpl} searchable={false} width={300} />
        <span className="muted">순차 열기 (3초 간격)</span>
        <span className="seg">
          {BULK_COUNTS.map((n) => <button key={n} onClick={() => openMany(n)} disabled={!wards.length || !!bulk}>{n}개</button>)}
          <button className={bulk ? '' : 'active'} onClick={() => openMany(wards.length)} disabled={!wards.length || !!bulk}>모든 병동 {wards.length}개</button>
        </span>
        {bulk
          ? <button className="danger" onClick={stopBulk}>중지 ({bulk.done + 1}/{bulk.total} · {bulk.ward})</button>
          : <button onClick={openNext} disabled={!wards.length}>{next >= wards.length ? '처음부터 다시' : `다음 병동 열기 (${next + 1}/${wards.length}: ${wards[next]?.ward})`}</button>}
        <button onClick={closeAll} disabled={!openCount && !bulk}>열린 탭 모두 닫기 ({openCount})</button>
        <span className="muted">열림 {openCount} · 차단 {log.blocked}</span>
      </div>
      {log.blocked > 0 && <p className="err">팝업이 브라우저에 막혀 순차 열기를 멈췄습니다. 주소창 오른쪽의 팝업 차단 아이콘에서 이 사이트의 팝업을 항상 허용한 뒤 다시 누르거나, "다음 병동 열기"로 한 번에 하나씩 여세요.</p>}
      <table className="tbl dense mv-table">
        <thead><tr><th>#</th>{th('ward', '병동')}{th('gws', '게이트웨이')}{th('count', '환자')}{th('open', '탭')}<th></th></tr></thead>
        <tbody>
          {sortedWards.map(({ ward, count, names, gws }, i) => {
            const win = wins.current.get(ward)
            const open = win && !win.closed
            return (
              <tr key={ward} className={open ? '' : 'stale'}>
                <td className="num muted idx">{i + 1}</td><td className="ward"><b>{ward}</b></td><td className="names mono"><b>{gws.length}대</b><div className="list">{gws.join(' ')}</div></td>
                <td className="names"><b>{count}명</b><div className="list">{names.join(', ')}</div></td>
                <td className="tab">{open ? <span className="tag ok">열림</span> : <span className="tag">닫힘</span>}</td>
                <td className="act">{open ? <button onClick={() => { win.focus() }}>보기</button> : <a href={urlOf(ward)} target={`viewer-${ward}`} rel="noopener" onClick={(e) => { e.preventDefault(); openOne(ward); tick((x) => x + 1) }}>열기</a>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
