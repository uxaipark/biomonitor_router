import React, { useMemo, useRef, useState } from 'react'
import { api, usePoll, fmtNum } from '../api.js'
import { gatewayAlarmIndex, GW_STATUS, SEV_LABEL, sortBy, gwLabel } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import { openLive } from '../App.jsx'
import './Gateways.css'
import {
  useQuery, go, useRevealSelected, GwName, Cols, tableMin, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager, PatientLink, RoomLink,
  TwoLine, Pill, Spark, useDensity, DensityToggle, RowActions, Ago,
} from '../ListKit.jsx'

/**
 * 게이트웨이 목록 (시안 05). 게이트웨이는 "건강 상태" 가 핵심:
 *  상태 칩(정상·저하·무응답·다운·이동형·중복 ID) → 필터 줄(검색·건물/층·유형·밀도·표|층 지도) → 표.
 *  기본 정렬은 "문제 → 위치" 라 위 몇 줄만 보면 되고, 정상 행은 레일 없이 조용하다.
 *  프레임/s 미니 그래프는 폴링 사이의 frames 카운터 차분으로 화면에 보이는 행만 클라이언트에서 만든다.
 */
const PAGE = 100
const SPARK_KEEP = 100 // 3 s 폴링 × 100 ≈ 5분
const GW_TYPE = {
  room: '병실', corridor: '복도', support: '지원 시설', toilet: '화장실', mobile: '이동형(MCOT)', stairs: '계단', nurse_station: '간호사실',
  exam: '검사실', elevator: '엘리베이터', lobby: '로비', er: '응급실',
}
// 열: 레일 · 장치 · 위치 · 상태 · 패치 · 마지막 프레임 · 프레임/s · 링크 품질(종합 1칸 또는 펼치면 6열) · CPU · MEM · NET · RSSI · 온도 · 동작
const QUALITY = [
  ['framing', '프레이밍', 62], ['nack_tx', 'NACK', 56], ['recovered', '복구', 52], ['resend_lost', '재전송 실패', 74], ['seq_gap', 'seq 갭', 60], ['bad_crc', 'CRC', 50],
]
const colsFor = (expanded) => [
  ['rail', '', 4], ['name', '게이트웨이', 190], ['loc', '위치', null], ['problem', '상태', 84], ['patches', '패치', 52], ['since_last_s', '마지막 프레임', 92], ['fps', '프레임/s (5분)', 118],
  ...(expanded ? QUALITY : [['quality', '링크 품질 (최근 5분)', 128]]),
  ['cpu', 'CPU', 52], ['mem', 'MEM', 52], ['net', 'NET', 52], ['wan_rssi', 'RSSI', 74], ['temp', '온도', 54], ['act', '', 60],
]
const NUM = new Set(['patches', 'framing', 'nack_tx', 'recovered', 'resend_lost', 'seq_gap', 'bad_crc', 'wan_rssi', 'cpu', 'mem', 'net', 'temp'])
const SORTABLE = new Set(['name', 'loc', 'problem', 'patches', 'framing', 'nack_tx', 'recovered', 'resend_lost', 'seq_gap', 'bad_crc', 'wan_rssi', 'cpu', 'mem', 'net', 'temp', 'since_last_s'])
/** 온도 경고 기준 (°C) — 게이트웨이 status.temp_c */
const TEMP_WARN = 60

/**
 * 링크 품질 6지표 → 정상(ok)/주의(warn)/문제(bad). 표에서는 작은 네모 6개로 요약하고, 마우스를 올리면 수치가 보인다.
 *  프레이밍 = bad_crc + bad_magic + garbage (0 ok, 1–9 주의, ≥10 문제) · NACK 는 복구율(복구/NACK ≥ 0.9 ok, ≥ 0.5 주의) ·
 *  복구 = 같은 복구율 · 재전송 실패 (0 ok, else 문제) · seq 갭 (0 ok, ≤5 주의, else 문제) · CRC (0 ok, ≤5 주의, else 문제)
 */
function quality(g) {
  const framing = (g.bad_crc || 0) + (g.bad_magic || 0) + (g.garbage || 0) + (g.garbage_bytes || 0)
  const nack = g.nack_tx || 0, rec = g.recovered || 0
  const ratio = nack ? rec / nack : 1
  const ratioTone = ratio >= 0.9 ? 'ok' : ratio >= 0.5 ? 'warn' : 'bad'
  const band = (v, warnMax) => (v === 0 ? 'ok' : v <= warnMax ? 'warn' : 'bad')
  return [
    { key: 'framing', label: '프레이밍', val: framing, tone: framing === 0 ? 'ok' : framing < 10 ? 'warn' : 'bad' },
    { key: 'nack_tx', label: 'NACK', val: nack, tone: nack === 0 ? 'ok' : ratioTone, text: nack ? `${nack} (복구율 ${Math.round(ratio * 100)}%)` : '0' },
    { key: 'recovered', label: '복구', val: rec, tone: nack === 0 ? 'ok' : ratioTone },
    { key: 'resend_lost', label: '재전송 실패', val: g.resend_lost || 0, tone: g.resend_lost ? 'bad' : 'ok' },
    { key: 'seq_gap', label: 'seq 갭', val: g.seq_gap || 0, tone: band(g.seq_gap || 0, 5) },
    { key: 'bad_crc', label: 'CRC', val: g.bad_crc || 0, tone: band(g.bad_crc || 0, 5) },
  ]
}
const TONE_LABEL = { ok: '정상', warn: '주의', bad: '문제' }
/** 6지표를 네모 6개로 (종합 셀·상세) */
function QualityCell({ g, size = 10 }) {
  const items = quality(g)
  const worst = items.some((i) => i.tone === 'bad') ? 'bad' : items.some((i) => i.tone === 'warn') ? 'warn' : 'ok'
  const title = items.map((i) => `${i.label} ${i.text ?? fmtNum(i.val)} · ${TONE_LABEL[i.tone]}`).join('\n')
  return (
    <span className={'gwl-q ' + worst} title={title}>
      {items.map((i) => <i key={i.key} className={'gwl-q-sq ' + i.tone} style={{ width: size, height: size }} />)}
      <small>{TONE_LABEL[worst]}</small>
    </span>
  )
}

// 문제 등급: 다운 3 · 무응답 2 · 저하/재전송 실패/CRC 1 · 정상 0 (기본 정렬 = 이 값 내림차순 → 위치)
const problemRank = (g) => (!g.connected || g.st === 2 ? 3 : g.silent ? 2 : g.st === 1 || g.resend_lost > 0 || g.bad_crc > 0 ? 1 : 0)
const statePill = (g) => (!g.connected ? <Pill tone="crit">끊김</Pill> : g.st === 2 ? <Pill tone="crit">다운</Pill> : g.silent ? <Pill tone="high">무응답</Pill> : g.st === 1 ? <Pill tone="med">저하</Pill> : <Pill tone="ok">정상</Pill>)
const rowClass = (g) => (problemRank(g) >= 2 ? 'st-err' : problemRank(g) === 1 ? 'st-warn' : '')

// 요약 칩: 상태별 (누르면 그 상태만). 'problem' 은 다른 화면 링크(#/gateways?f=problem)가 쓰므로 유지
const CHIPS = [
  ['ok', '정상', (g) => problemRank(g) === 0, 'c-ok'],
  ['degraded', '저하', (g) => g.connected && !g.silent && g.st === 1, 'c-warn'],
  ['silent', '무응답', (g) => g.connected && g.silent, 'c-sev-high'],
  ['down', '다운', (g) => !g.connected || g.st === 2, 'c-sev-critical'],
  ['temp', '온도 경고', (g) => g.temp != null && g.temp >= TEMP_WARN, 'c-warn'],
  ['patched', '패치 연결됨', (g) => (g.patches || 0) > 0, 'c-ok'],
  ['mobile', '이동형', (g) => g.type === 'mobile', ''],
  ['dup', '중복 ID', (g) => g.dup_conn > 0, 'c-err'],
  ['problem', '문제 있음', (g) => problemRank(g) > 0 || !!g.alarm, 'c-err'],
]
const Z = ({ v, bad }) => (v ? <span className={'v' + (bad ? ' bad' : '')}>{fmtNum(v)}</span> : <span className="v dim">0</span>)

/** 위치 문구: 건물 · 층 · 병실(링크). 병실이 아닌 유형은 용도를 함께 적는다 (복도·엘리베이터·간호사실 …) */
function Loc({ g }) {
  const label = GW_TYPE[g.type]
  return (
    <span className="gwl-loc">
      {g.fl && <span>{g.fl}</span>}
      {g.location?.room ? <> · <RoomLink room={g.location.room}>{g.location.room}</RoomLink></> : null}
      {g.type !== 'room' && label && <span className="muted"> ({label})</span>}
    </span>
  )
}

export default function Gateways({ alarms }) {
  const [rows] = usePoll(api.gateways, 3000)
  const [qs, setQs] = useQuery()
  const q = qs.get('q') || '', chip = qs.get('f') || '', floor = qs.get('floor') || '', type = qs.get('type') || '', sel = qs.get('sel') || ''
  const [sort, setSort] = useState(['problem', 'desc'])
  const [page, setPage] = useState(0)
  const [density, setDensity] = useDensity('gateways')
  // 링크 품질: 종합 1칸(기본) ↔ 6열 펼침 (브라우저에 기억)
  const [qExp, setQExp] = useState(() => { try { return localStorage.getItem('gw.quality.expanded') === '1' } catch { return false } })
  const toggleQ = () => { const v = !qExp; setQExp(v); try { localStorage.setItem('gw.quality.expanded', v ? '1' : '0') } catch { /* ignore */ } }
  const COLS = useMemo(() => colsFor(qExp), [qExp])
  const W = COLS.map((c) => c[2])
  const gidx = useMemo(() => gatewayAlarmIndex(alarms?.alarms), [alarms])

  // 프레임/s 링: gw_id → [{t, frames}] (화면에 보이는 행만 채운다; 안 보이게 되면 그대로 두었다가 자연히 밀린다)
  const ring = useRef(new Map())

  const flat = useMemo(() => (rows || []).map((g) => {
    const s = g.status || {}
    const st = !g.connected ? 3 : s.status === 2 ? 2 : s.status === 1 ? 1 : 0
    const fl = [g.location?.building, g.location?.floor && `${g.location.floor}F`].filter(Boolean).join(' ')
    return {
      ...g, st, fl, loc: [fl, g.location?.room].filter(Boolean).join(' '),
      problem: 0, // 아래에서 채움 (sortBy 가 키로 읽는다)
      cpu: s.cpu, mem: s.mem, net: s.net, wan_rssi: s.wan_rssi, temp: s.temp_c ?? s.temp, stLabel: GW_STATUS[s.status], alarm: gidx.get(String(g.gw_id)),
      framing: (g.bad_crc || 0) + (g.bad_magic || 0) + (g.garbage || 0) + (g.garbage_bytes || 0),
      last_ms: g.last_ts_ms || (g.since_last_s != null ? Date.now() - g.since_last_s * 1000 : 0),
    }
  }).map((g) => ({ ...g, problem: problemRank(g) })), [rows, gidx])

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
    let v = scoped.filter((g) => !needle || [g.gw_id, gwLabel(g.name), g.loc, g.type, g.addr, GW_TYPE[g.type]].some((x) => String(x || '').toLowerCase().includes(needle)))
    const c = CHIPS.find(([k]) => k === chip)
    if (c) v = v.filter(c[2])
    if (sort[0] === 'problem') {
      // 문제 → 위치 → 번호 (desc = 문제가 위)
      const dir = sort[1] === 'desc' ? 1 : -1
      return [...v].sort((a, b) => (b.problem - a.problem) * dir || a.loc.localeCompare(b.loc, 'ko', { numeric: true }) || a.gw_id - b.gw_id)
    }
    if (sort[0] === 'name') return sortBy(v.map((g) => ({ ...g, _n: gwLabel(g.name) || String(g.gw_id) })), '_n', sort[1])
    return sortBy(v, sort[0], sort[1])
  }, [scoped, q, chip, sort])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const visible = shown.slice(cur * PAGE, cur * PAGE + PAGE)

  // 보이는 행의 프레임/s 표본을 폴링마다 하나씩 쌓는다
  const now = Date.now()
  for (const g of visible) {
    const r = ring.current.get(g.gw_id) || []
    const last = r[r.length - 1]
    if (!last || last.frames !== g.frames || now - last.t > 2500) {
      if (!last || now - last.t > 1000) {
        r.push({ t: now, frames: g.frames || 0 })
        if (r.length > SPARK_KEEP) r.shift()
        ring.current.set(g.gw_id, r)
      }
    }
  }
  const fpsOf = (gw_id) => {
    const r = ring.current.get(gw_id) || []
    const out = []
    for (let i = 1; i < r.length; i++) {
      const dt = (r[i].t - r[i - 1].t) / 1000
      if (dt > 0) out.push(Math.max(0, (r[i].frames - r[i - 1].frames) / dt))
    }
    return out
  }

  const selRow = sel ? flat.find((g) => String(g.gw_id) === sel) : null
  useRevealSelected(sel, shown, (g) => String(g.gw_id), PAGE, setPage)
  const applied = [
    floor && { key: 'floor', label: `위치: ${floor}`, clear: () => setQs({ floor: '' }) },
    type && { key: 'type', label: `유형: ${GW_TYPE[type] || type}`, clear: () => setQs({ type: '' }) },
    chip && { key: 'f', label: CHIPS.find(([k]) => k === chip)?.[1] || chip, clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  const toMap = () => go('#/map', { floor: floor || undefined, gw: sel || undefined, q: q || undefined })
  const th = (k, l) => {
    const sortable = SORTABLE.has(k)
    if (k === 'quality') {
      return (
        <th key={k} className="gwl-q-th" title="6개 품질 지표를 칸 하나씩 색으로 요약(정상/주의/문제). 마우스를 올리면 수치가 보이고, 펼치면 개별 열로 풀립니다.">
          {l} <button className="gwl-q-tog" onClick={toggleQ} title="개별 열로 펼치기">펼치기 ▸</button>
        </th>
      )
    }
    const isQ = QUALITY.some(([qk]) => qk === k)
    return (
      <th key={k} className={(sortable ? 'sortable' : '') + (NUM.has(k) ? ' num' : '') + (isQ ? ' gwl-q-col' : '')} onClick={sortable ? () => setSort([k, sort[0] === k && sort[1] === 'asc' ? 'desc' : 'asc']) : undefined} title={sortable ? '누르면 정렬' : undefined}>
        {l}{sort[0] === k ? (sort[1] === 'asc' ? ' ▲' : ' ▼') : ''}
        {qExp && k === 'framing' && <button className="gwl-q-tog" onClick={(e) => { e.stopPropagation(); toggleQ() }} title="종합 1칸으로 접기">◂ 접기</button>}
      </th>
    )
  }
  return (
    <div className="page lk gwl">
      <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="대" />
      <FilterBar applied={applied} onReset={() => setQs({ q: '', f: '', floor: '', type: '' })}
        right={<>
          <span className="seg lk-density" title="표 또는 병원 지도"><button className="active">표</button><button onClick={toMap} title="같은 조건으로 병원 지도 보기">층 지도</button></span>
          <DensityToggle value={density} onChange={setDensity} />
          <span className="muted">표시 {fmtNum(shown.length)} / {fmtNum(flat.length)}대</span>
          <Pager page={cur} pages={pages} onPage={setPage} />
        </>}>
        <input placeholder="검색: 이름 · 번호 · 위치 · IP" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
        <Dropdown value={floor} options={floors} onChange={(v) => { setQs({ floor: v }); setPage(0) }} placeholder="모든 건물·층" countUnit="대" width={180} />
        <Dropdown value={type} options={types} onChange={(v) => { setQs({ type: v }); setPage(0) }} searchable={false} placeholder="모든 유형" countUnit="대" width={170} />
        <Dropdown value={sort[0] === 'problem' ? 'problem' : 'other'} options={[{ value: 'problem', label: '정렬: 문제 → 위치' }, { value: 'other', label: `정렬: ${COLS.find((c) => c[0] === sort[0])?.[1] || sort[0]}` }]}
          onChange={(v) => v === 'problem' && setSort(['problem', 'desc'])} searchable={false} width={170} />
      </FilterBar>
      <ListLayout detail={selRow ? <GatewayDetail g={selRow} fps={fpsOf(selRow.gw_id)} onClose={() => setQs({ sel: '' })} /> : sel ? <DetailPanel title={`GW ${sel}`} onClose={() => setQs({ sel: '' })}><p className="muted">라우터에 접속한 적 없는 게이트웨이입니다.</p></DetailPanel> : null}>
        <table className={'tbl fixed' + (density === 'dense' ? ' dense' : '')} style={{ minWidth: tableMin(W, 200) }}>
          <Cols w={W} />
          <thead><tr>{COLS.map(([k, l]) => th(k, l))}</tr></thead>
          <tbody>
            {visible.map((g) => {
              const isSel = sel === String(g.gw_id)
              const fps = fpsOf(g.gw_id)
              const tone = problemRank(g) >= 2 ? (problemRank(g) === 3 ? 'crit' : 'high') : problemRank(g) === 1 ? 'warn' : 'ok'
              return (
                <tr key={g.gw_id} className={'clickable ' + rowClass(g) + (g.alarm ? ` sev-${g.alarm.severity}` : '') + (isSel ? ' selected' : '')} onClick={() => setQs({ sel: isSel ? '' : String(g.gw_id) })}>
                  <td className="lk-rail" />
                  <td><TwoLine main={<GwName id={g.gw_id} name={g.name} />} sub={`#${g.gw_id}${g.addr ? ' · ' + g.addr : ''}${g.type === 'mobile' ? ' · WAN' : ''}`} /></td>
                  <td><Loc g={g} /></td>
                  <td>{statePill(g)}{g.alarm && <span className={`tag small sev-${g.alarm.severity}`} style={{ marginLeft: 4 }} title={g.alarm.message}>{SEV_LABEL[g.alarm.severity]}</span>}</td>
                  <td className="num"><Z v={g.patches} /></td>
                  <td className="muted"><Ago ms={g.last_ms} now={now} /></td>
                  <td>{fps.length >= 2 ? <Spark values={fps} tone={tone} title={`최근 ${fps.length}표본 · 지금 ${fps[fps.length - 1].toFixed(1)}/s`} /> : <Spark values={[]} title="표본 모으는 중" />}</td>
                  {qExp ? quality(g).map((i) => <td key={i.key} className={'num gwl-q-col' + (i.tone === 'bad' ? ' is-bad' : i.tone === 'warn' ? ' is-warn' : '')} title={`${i.label} · ${TONE_LABEL[i.tone]}`}><Z v={i.val} bad={i.tone === 'bad'} /></td>)
                    : <td><QualityCell g={g} /></td>}
                  <td className="num"><span className={'v' + (g.cpu >= 90 ? ' bad' : g.cpu >= 70 ? ' warnv' : '')}>{g.cpu != null ? `${g.cpu}%` : '—'}</span></td>
                  <td className="num"><span className={'v' + (g.mem >= 90 ? ' bad' : g.mem >= 75 ? ' warnv' : '')}>{g.mem != null ? `${g.mem}%` : '—'}</span></td>
                  <td className="num"><span className="v">{g.net != null ? `${g.net}%` : '—'}</span></td>
                  <td className="num"><span className="v">{g.wan_rssi != null ? `${g.wan_rssi}${g.type === 'mobile' ? ' WAN' : ''}` : '—'}</span></td>
                  <td className="num"><span className={'v' + (g.temp >= TEMP_WARN ? ' bad' : g.temp >= TEMP_WARN - 10 ? ' warnv' : '')}>{g.temp != null ? `${g.temp}°` : '—'}</span></td>
                  <RowActions><button className={isSel ? 'primary' : ''} onClick={() => setQs({ sel: isSel ? '' : String(g.gw_id) })}>열기</button></RowActions>
                </tr>
              )
            })}
            {!shown.length && <tr><td colSpan={COLS.length} className="muted">조건에 맞는 게이트웨이가 없습니다.</td></tr>}
          </tbody>
        </table>
        <p className="lk-legend">정상 행은 레일 없음 · 저하/재전송 실패/CRC 는 주황 · 무응답·다운은 빨강. 링크 품질은 프레이밍 · NACK · 복구 · 재전송 실패 · seq 갭 · CRC 여섯 지표를 네모 하나씩 정상/주의/문제 색으로 요약합니다(마우스를 올리면 수치, 머리글의 '펼치기' 로 개별 열). 온도 경고는 {TEMP_WARN}°C 이상. 프레임/s 는 이 화면이 열린 뒤 쌓인 표본(3초 간격, 최대 5분)입니다.</p>
      </ListLayout>
    </div>
  )
}

/** 게이트웨이 상세: 상태·부하·수신 통계·프레임/s 추이, 연결된 환자(누르면 실시간 파형) */
function GatewayDetail({ g, fps = [], onClose }) {
  const [pats] = usePoll(() => api.channelsScoped(`gw=${encodeURIComponent(g.gw_id)}`), 5000, [g.gw_id])
  const st = g.status || {}
  const tone = problemRank(g) >= 2 ? (problemRank(g) === 3 ? 'crit' : 'high') : problemRank(g) === 1 ? 'warn' : 'ok'
  return (
    <DetailPanel title={<GwName id={g.gw_id} name={g.name} />} sub={[`#${g.gw_id}`, GW_TYPE[g.type] || g.type, g.addr].filter(Boolean).join(' · ')} onClose={onClose}
      actions={<>
        <button onClick={() => go('#/map', { gw: g.gw_id })}>지도에서 보기</button>
        <button onClick={() => go('#/alarms', { q: `GW ${g.gw_id}`, tab: 'history' })}>알람 이력</button>
        <button onClick={() => go('#/events', { q: String(g.gw_id) })}>이벤트 로그</button>
      </>}>
      {g.alarm && <div className={`lk-alarm sev-${g.alarm.severity}`}><span className={`tag small sev-${g.alarm.severity}`}>{SEV_LABEL[g.alarm.severity]}</span> {g.alarm.message}</div>}
      <h4 className="lk-sub">품질 추이</h4>
      <div className="gwl-spark-big">
        <Spark values={fps} tone={tone} width={280} height={44} title="프레임/s" />
        <small className="muted">프레임/s · {fps.length ? `지금 ${fps[fps.length - 1].toFixed(1)}/s · 최대 ${Math.max(...fps).toFixed(1)}/s` : '표본 모으는 중'}</small>
      </div>
      <div className="gwl-q-detail">
        {quality(g).map((i) => <div key={i.key} className={'gwl-q-row ' + i.tone}><i className={'gwl-q-sq ' + i.tone} /><span>{i.label}</span><b className="v">{i.text ?? fmtNum(i.val)}</b><small>{TONE_LABEL[i.tone]}</small></div>)}
      </div>
      <dl className="lk-kv">
        <KV k="상태">{statePill(g)} {g.stLabel || ''}</KV>
        <KV k="위치"><Loc g={g} /></KV>
        <KV k="연결 환자">{g.patches ?? 0}명</KV>
        <KV k="CPU · MEM · NET">{st.cpu ?? '—'}% · {st.mem ?? '—'}% · {st.net ?? '—'}%</KV>
        <KV k="신호 · 온도">{st.wan_rssi ?? '—'} dBm{g.type === 'mobile' ? ' (WAN)' : ''} · {g.temp ?? '—'}°C</KV>
        <KV k="수신">프레임 {fmtNum(g.frames)} · 레코드 {fmtNum(g.records)} · 마지막 <Ago ms={g.last_ms} /></KV>
        <KV k="NACK · 복구 · 실패">{fmtNum(g.nack_tx)} · {fmtNum(g.recovered)} · <span className={g.resend_lost ? 'v bad' : ''}>{fmtNum(g.resend_lost)}</span></KV>
        <KV k="seq 갭 · 역전 · 재시작 · CRC">{fmtNum(g.seq_gap)} · {fmtNum(g.seq_reorder)} · {fmtNum(g.seq_restart)} · {fmtNum(g.bad_crc)}</KV>
        <KV k="소켓">{g.conn ? `#${g.conn}` : '—'}{g.dup_conn ? ` · 중복 접속 ${g.dup_conn}회` : ''}{g.uptime_s != null ? ` · 연결 ${Math.floor(g.uptime_s / 60)}분` : ''}</KV>
      </dl>
      <h4 className="lk-sub">연결된 패치 {pats ? `${pats.length}개` : ''}</h4>
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
