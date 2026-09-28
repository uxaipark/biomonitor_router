import React, { useEffect, useMemo, useState } from 'react'
import { can, useMe } from '../auth.js'
import { ReadOnly } from '../ReadOnly.jsx'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { SEV_LABEL, ALARM_KIND, roomText, wardText, sortBy, spaceName } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import {
  useQuery, go, useRevealSelected, Cols, tableMin, SummaryChips, FilterBar, ListLayout, DetailPanel, KV, Pager,
  PatientLink, GwLink, RoomLink, WardLink, wardOfRoom, TwoLine, Pill, Bar, GroupRow, useDensity, DensityToggle, RowActions, Ago, dur, TONE, Kbd,
} from '../ListKit.jsx'
import { openLive } from '../App.jsx'
import './Alarms.css'

const RULE_FIELDS = [
  ['hr_low', '서맥 HR <', 'bpm'], ['hr_high', '빈맥 HR >', 'bpm'], ['hr_crit_low', '위험 HR ≤', 'bpm'], ['hr_crit_high', '위험 HR ≥', 'bpm'],
  ['spo2_low', 'SpO₂ <', '%'], ['spo2_crit_low', '위험 SpO₂ <', '%'], ['temp_low', '저체온 ≤', '°C'], ['temp_high', '고열 ≥', '°C'],
  ['resp_low', '서호흡 <', '/min'], ['resp_high', '빈호흡 >', '/min'], ['battery_low_pct', '배터리 ≤', '%'], ['patch_wear_days', '패치 최대 착용', '일'], ['patch_wear_warn_h', '교체 예정 알림', '시간 전'],
  ['sustain_s', '수치 지속', 's'], ['lead_off_s', '전극 탈락 지속', 's'], ['patch_silent_s', '패치 무응답', 's'], ['clear_s', '해제 유예', 's'],
]

const SEVS = ['critical', 'high', 'medium', 'low']
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }
const PAGE = 100
// 열 폭: 레일 · 심각도 · 환자·위치(남는 폭) · 종류 · 값/임계 · 지속 · 발생 · 게이트웨이 · 상태 · 동작
const W = [4, 64, null, 110, 150, 96, 80, 118, 78, 110]
const GW_KINDS = new Set(['gateway_down', 'gateway_status_down', 'gateway_silent', 'gateway_degraded'])

/**
 * 값 / 임계: 알람 값 문자열("135 bpm", "70%")의 숫자와 규칙의 임계를 짝지어 "얼마나 벗어났나" 를 막대로.
 * 상한형(high)은 값/임계, 하한형(low)은 임계/값 — 둘 다 100 % 가 딱 임계, 넘으면 100 % 이상(빨강).
 */
function threshold(kind, rules) {
  if (!rules) return null
  const map = {
    hr_high: [rules.hr_high, 'high', 'bpm'], hr_low: [rules.hr_low, 'low', 'bpm'], hr_critical: [rules.hr_crit_high, 'high', 'bpm'],
    spo2_low: [rules.spo2_low, 'low', '%'], spo2_critical: [rules.spo2_crit_low, 'low', '%'],
    resp_high: [rules.resp_high, 'high', '/min'], resp_low: [rules.resp_low, 'low', '/min'],
    temp_high: [rules.temp_high, 'high', '°C'], temp_low: [rules.temp_low, 'low', '°C'], battery_low: [rules.battery_low_pct, 'low', '%'],
  }
  const t = map[kind]
  return t && t[0] != null ? { limit: t[0], dir: t[1], unit: t[2] } : null
}
const numOf = (s) => { const m = /-?\d+(\.\d+)?/.exec(String(s ?? '')); return m ? Number(m[0]) : null }
function ValueCell({ a, rules }) {
  const n = numOf(a.value)
  const t = threshold(a.kind, rules)
  if (n == null) return <span className="v dim">{a.value || '—'}</span>
  if (!t) return <span className="v">{a.value}</span>
  // 심박수 위험은 상한·하한 둘 다 있어 값이 어느 쪽인지로 고른다
  let { limit, dir } = t
  if (a.kind === 'hr_critical' && rules.hr_crit_low != null && n <= rules.hr_crit_low) { limit = rules.hr_crit_low; dir = 'low' }
  const pct = dir === 'high' ? (n / limit) * 100 : (limit / Math.max(n, 0.01)) * 100
  const over = pct >= 100
  return (
    <span className="al-val" title={`${a.value} · 임계 ${dir === 'high' ? '>' : '<'} ${limit}${t.unit}`}>
      <span className={'v' + (over ? (a.severity === 'critical' ? ' bad' : ' warnv') : '')}>{n}</span>
      <small className="muted"> /{limit}</small>
      <Bar pct={pct} tone={over ? (a.severity === 'critical' ? 'crit' : 'warn') : ''} />
    </span>
  )
}

/** 알람: 활성/이력/규칙 탭 · 심각도·미확인 칩 · 병동/종류/검색 필터(주소에 남음) · 병동 묶음 표 · 오른쪽 상세 */
export default function Alarms({ alarms }) {
  const me = useMe() // 규칙 편집은 action.alarm_rules '편집', 확인은 action.alarm_ack '편집'
  const canAck = can(me, 'action.alarm_ack', 2)
  const [qs, setQs] = useQuery()
  const tab = qs.get('tab') || 'active', q = qs.get('q') || '', ward = qs.get('ward') || '', kind = qs.get('kind') || '', chip = qs.get('f') || '', sel = qs.get('sel') || ''
  const [hist] = usePoll(() => api.alarmHistory(500), 5000)
  const [rules, setRules] = useState(null)
  const [draft, setDraft] = useState(null)
  const [page, setPage] = useState(0)
  const [density, setDensity] = useDensity('alarms')
  const [group, setGroup] = useState(() => { try { return (localStorage.getItem('lk.alarms.group') ?? '1') === '1' } catch { return true } })
  const setGrp = (v) => { setGroup(v); try { localStorage.setItem('lk.alarms.group', v ? '1' : '0') } catch { /* ignore */ } }
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
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
    { key: 'gw', label: '게이트웨이', count: scoped.filter((a) => GW_KINDS.has(a.kind)).length },
  ], [scoped, tab])
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let v = scoped.filter((a) => !needle || [a.channel_id, a.patient_name, a.room, a.message, a.gateway_id && `gw ${a.gateway_id}`, ALARM_KIND[a.kind]].some((x) => String(x || '').toLowerCase().includes(needle)))
    if (chip === 'unacked') v = v.filter((a) => !a.acked)
    else if (chip === 'gw') v = v.filter((a) => GW_KINDS.has(a.kind))
    else if (SEVS.includes(chip)) v = v.filter((a) => a.severity === chip)
    // 활성: 심각도 → 미확인 먼저 → 최근 발생. 확인된 행은 같은 심각도 안에서 아래로
    return tab === 'active' ? sortBy(v, (a) => SEV_RANK[a.severity] * 1e14 + (a.acked ? 0 : 1e13) + a.since_ms, 'desc') : v
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
  // 오늘 같은 환자·같은 종류 알람 횟수 (이력 + 활성) — 상세 패널 "오늘 N회"
  const todayCount = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    const c = new Map()
    for (const a of [...active, ...(hist || [])]) {
      if (a.since_ms < start.getTime()) continue
      const k = `${a.channel_id || a.gateway_id}|${a.kind}`
      c.set(k, (c.get(k) || 0) + 1)
    }
    return c
  }, [active, hist])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const keyOf = (a) => String(a.id) + (a.cleared_ms || '')
  const selA = sel ? src.find((a) => keyOf(a) === sel) || src.find((a) => String(a.id) === sel) : null
  useRevealSelected(sel, shown, keyOf, PAGE, setPage)
  const pageRows = shown.slice(cur * PAGE, cur * PAGE + PAGE)
  // 병동 묶음: 활성 탭 기본 켬. 병동 없는(게이트웨이·시스템) 알람은 '기타' 로
  const grouped = useMemo(() => {
    if (!group) return [[null, pageRows]]
    const m = new Map()
    for (const a of pageRows) { const w = wardOfRoom(a.room) || (GW_KINDS.has(a.kind) ? '__gw' : '__etc'); if (!m.has(w)) m.set(w, []); m.get(w).push(a) }
    return [...m.entries()]
  }, [pageRows, group])
  const applied = [
    ward && { key: 'ward', label: `병동: ${wardText(ward)}`, clear: () => setQs({ ward: '' }) },
    kind && { key: 'kind', label: `종류: ${ALARM_KIND[kind] || kind}`, clear: () => setQs({ kind: '' }) },
    chip && { key: 'f', label: chip === 'unacked' ? '미확인' : chip === 'gw' ? '게이트웨이' : SEV_LABEL[chip], clear: () => setQs({ f: '' }) },
    q && { key: 'q', label: `검색: ${q}`, clear: () => setQs({ q: '' }) },
  ].filter(Boolean)
  const setTab = (t) => { setQs({ tab: t === 'active' ? '' : t, sel: '', f: '' }); setPage(0) }
  const select = (a) => setQs({ sel: sel === keyOf(a) ? '' : keyOf(a) })

  // 키보드: ↑↓ 행 이동, Enter 상세 열기/닫기, A 확인 (입력란에 포커스가 있으면 무시)
  useEffect(() => {
    if (tab === 'rules') return
    const f = (e) => {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
      const i = shown.findIndex((a) => keyOf(a) === sel)
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const n = e.key === 'ArrowDown' ? Math.min(shown.length - 1, i + 1) : Math.max(0, i - 1)
        if (shown[n]) { setQs({ sel: keyOf(shown[n]) }); setPage(Math.floor(n / PAGE)) }
      } else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); setQs({ sel: '' }) }
      else if ((e.key === 'a' || e.key === 'A') && i >= 0 && tab === 'active' && canAck && !shown[i].acked) { e.preventDefault(); ack(shown[i].id) }
    }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [shown, sel, tab, canAck]) // eslint-disable-line react-hooks/exhaustive-deps

  const groupLabel = (w, rows) => {
    const name = w === '__gw' ? '게이트웨이' : w === '__etc' ? '기타' : wardText(w)
    const un = rows.filter((a) => !a.acked).length
    return `${name} · ${tab === 'active' ? '활성' : '이력'} ${rows.length}${tab === 'active' && un ? ` · 미확인 ${un}` : ''}`
  }
  return (
    <div className="page lk alarms">
      <div className="toolbar lk-tabs">
        <span className="seg">{[['active', `활성 ${active.length}`], ['history', '이력'], ['rules', '규칙']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</span>
        {tab === 'active' && canAck && <button onClick={() => shown.filter((a) => !a.acked).forEach((a) => ack(a.id))} disabled={!shown.some((a) => !a.acked)}>보이는 알람 모두 확인 ({shown.filter((a) => !a.acked).length})</button>}
      </div>
      {tab !== 'rules' && <>
        <SummaryChips items={chips} value={chip || 'all'} onChange={(k) => { setQs({ f: k === 'all' ? '' : k }); setPage(0) }} unit="건" />
        <FilterBar applied={applied} onReset={() => setQs({ q: '', ward: '', kind: '', f: '' })}
          right={<>
            <label className="chk al-grp" title="병동별로 묶어 보기"><input type="checkbox" checked={group} onChange={(e) => setGrp(e.target.checked)} /> 병동 묶기</label>
            <DensityToggle value={density} onChange={setDensity} />
            <span className="muted">{shown.length.toLocaleString()}건{tab === 'history' ? ' · 최근 500건' : ''}</span>
            <Pager page={cur} pages={pages} onPage={setPage} />
          </>}>
          <input placeholder="검색: 환자 · 패치 · 병실 · 내용 · GW" value={q} onChange={(e) => { setQs({ q: e.target.value }); setPage(0) }} />
          <Dropdown value={ward} options={wards} onChange={(v) => { setQs({ ward: v }); setPage(0) }} placeholder="모든 병동" countUnit="건" width={180} />
          <Dropdown value={kind} options={kinds} onChange={(v) => { setQs({ kind: v }); setPage(0) }} placeholder="모든 종류" countUnit="건" width={180} />
        </FilterBar>
        <ListLayout detail={selA ? <AlarmDetail a={selA} rules={rules} today={todayCount.get(`${selA.channel_id || selA.gateway_id}|${selA.kind}`) || 0} canAck={canAck} onAck={ack} onClose={() => setQs({ sel: '' })} /> : null}>
          <table className={'tbl fixed al-tbl' + (density === 'dense' ? ' dense' : '')} style={{ minWidth: tableMin(W, 220) }}>
            <Cols w={W} />
            <thead><tr><th /><th>심각도</th><th>환자 · 위치</th><th>종류</th><th className="num">값 / 임계</th><th>지속</th><th>발생</th><th>게이트웨이</th><th>상태</th><th /></tr></thead>
            <tbody>
              {grouped.map(([w, rows]) => (
                <React.Fragment key={w ?? 'all'}>
                  {w != null && <GroupRow colSpan={10}>{groupLabel(w, rows)}</GroupRow>}
                  {rows.map((a) => {
                    const key = keyOf(a)
                    const isGw = GW_KINDS.has(a.kind)
                    const where = a.now ? `${spaceName(a.now)} (${roomText(a.room)})` : roomText(a.room)
                    return (
                      <tr key={key} className={`clickable sev-${a.severity}${a.acked ? ' acked' : ''}${sel === key ? ' selected' : ''}`} onClick={() => select(a)}>
                        <td className="lk-rail" />
                        <td><Pill tone={TONE[a.severity]}>{SEV_LABEL[a.severity]}</Pill></td>
                        <td className="al-who">
                          {a.channel_id
                            ? <TwoLine main={<PatientLink ch={a.channel_id}>{a.patient_name || a.channel_id}</PatientLink>} sub={<>{where && <RoomLink room={a.now || a.room}>{where}</RoomLink>}{where ? ' · ' : ''}<span className="mono">{a.channel_id}</span></>} />
                            : isGw || a.gateway_id
                              ? <TwoLine main={<GwLink id={a.gateway_id} />} sub={where || '게이트웨이'} />
                              : <TwoLine main="시스템" sub={a.message} />}
                        </td>
                        <td title={a.message}><span className="al-kind">{ALARM_KIND[a.kind] || a.kind}</span><small className="al-msg muted">{a.message}</small></td>
                        <td className="num"><ValueCell a={a} rules={rules} /></td>
                        <td className="v" title={`발생 ${fmtTime(a.since_ms)}`}>{tab === 'active' ? dur(now - a.since_ms) : a.cleared_ms ? dur(a.cleared_ms - a.since_ms) : '—'}</td>
                        <td className="v muted">{fmtTime(a.since_ms)}</td>
                        <td>{a.gateway_id ? <GwLink id={a.gateway_id} /> : <span className="muted">—</span>}</td>
                        <td>{a.cleared_ms ? <Pill tone="off">해제 {fmtTime(a.cleared_ms)}</Pill> : a.acked ? <Pill tone="ok">확인됨</Pill> : <Pill>미확인</Pill>}</td>
                        <RowActions>
                          {tab === 'active' && !a.acked && canAck && <button onClick={() => ack(a.id)} title="확인 (A)">확인</button>}
                          <button className={sel === key ? '' : 'primary'} onClick={() => select(a)} title="상세 열기 (Enter)">{sel === key ? '닫기' : '열기'}</button>
                        </RowActions>
                      </tr>
                    )
                  })}
                </React.Fragment>
              ))}
              {!shown.length && <tr><td colSpan="10" className="muted">{tab === 'active' ? '조건에 맞는 활성 알람이 없습니다.' : '조건에 맞는 알람 이력이 없습니다.'}</td></tr>}
            </tbody>
          </table>
          <p className="lk-legend">심각도 → 미확인 → 최근 발생 순. 확인된 알람은 같은 심각도 안에서 아래로. 값 옆 막대는 임계 대비 정도(가득 = 임계 도달). <Kbd>↑↓</Kbd> 이동 · <Kbd>Enter</Kbd> 상세 닫기 · <Kbd>A</Kbd> 확인</p>
        </ListLayout>
      </>}
      {tab === 'rules' && draft && (
        <ReadOnly edit={can(me, 'action.alarm_rules', 2)}>
          <RulesEditor draft={draft} rules={rules} setDraft={setDraft} onSave={save} onRevert={() => setDraft(rules)} />
        </ReadOnly>
      )}
    </div>
  )
}

/* ───────── 규칙 탭 (개선안 ④): 바이탈별 범위 막대 카드 · 패치·기기 · 발생·해제 타이밍 · 하단 고정 저장 바 ───────── */
const RULE_LABEL = Object.fromEntries(RULE_FIELDS.map(([k, l, u]) => [k, [l, u]]))
/** 바이탈 카드 정의: 축 범위와 구간(키 순서대로 낮은 값 → 높은 값). 키가 규칙에 없으면 그 구간은 생략된다. */
const VITAL_CARDS = [
  { id: 'hr', title: '심박수 HR', unit: 'bpm', axis: [0, 220], step: 1,
    stops: [['hr_crit_low', 'crit', '위험'], ['hr_low', 'warn', '서맥'], ['hr_high', 'ok', '정상'], ['hr_crit_high', 'warn', '빈맥'], [null, 'crit', '위험']] },
  { id: 'spo2', title: '산소포화도 SpO₂', unit: '%', axis: [70, 100], step: 1,
    stops: [['spo2_crit_low', 'crit', '위험'], ['spo2_low', 'warn', '저산소'], [null, 'ok', '정상']] },
  { id: 'resp', title: '호흡수 RR', unit: '/min', axis: [0, 40], step: 1,
    stops: [['resp_low', 'warn', '서호흡'], ['resp_high', 'ok', '정상'], [null, 'warn', '빈호흡']] },
  { id: 'temp', title: '체온', unit: '°C', axis: [33, 41], step: 0.1,
    stops: [['temp_low', 'warn', '저체온'], ['temp_high', 'ok', '정상'], [null, 'warn', '고열']] },
]
const DEVICE_KEYS = ['battery_low_pct', 'patch_wear_days', 'patch_wear_warn_h']
const TIMING_KEYS = ['sustain_s', 'lead_off_s', 'patch_silent_s', 'clear_s']

/**
 * 범위 막대: stops 는 [경계 키, 톤, 라벨] — 각 구간은 이전 경계에서 이 경계까지, 마지막(null)은 축 끝까지.
 * 경계값은 draft 에서 읽고, 축 밖이면 축 끝으로 자른다. 경계마다 아래에 눈금 숫자.
 */
function RangeBar({ card, draft }) {
  const [lo, hi] = card.axis
  const span = hi - lo || 1
  const clamp = (v) => Math.min(hi, Math.max(lo, v))
  const segs = []
  const ticks = [{ v: lo, x: 0 }]
  let prev = lo
  for (const [key, tone, label] of card.stops) {
    if (key && draft[key] == null) continue
    const v = key ? clamp(Number(draft[key])) : hi
    const w = Math.max(0, (v - prev) / span * 100)
    segs.push({ key: key || 'end', tone, label, w })
    if (key) ticks.push({ v: Number(draft[key]), x: (v - lo) / span * 100 })
    prev = v
  }
  ticks.push({ v: hi, x: 100 })
  return (
    <div className="rl-range">
      <div className="rl-bar">{segs.map((g) => <div key={g.key} className={'rl-seg ' + g.tone} style={{ width: `${g.w}%` }} title={g.label}>{g.w >= 8 ? g.label : ''}</div>)}</div>
      <div className="rl-ticks">{ticks.map((t, i) => <span key={i} className="v" style={{ left: `${t.x}%` }}>{t.v}</span>)}</div>
    </div>
  )
}

function RuleInput({ k, draft, rules, setDraft, step }) {
  const [label, unit] = RULE_LABEL[k] || [k, '']
  const changed = rules && draft[k] !== rules[k]
  return (
    <label className={'rl-field' + (changed ? ' changed' : '')}>
      <span>{label}{changed && <em> · 변경됨</em>}</span>
      <span className="rl-inp"><input type="number" step={step ?? (k.startsWith('temp') || k === 'patch_wear_days' ? 0.1 : 1)} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} aria-label={label} /><small>{unit}</small></span>
    </label>
  )
}

function RulesEditor({ draft, rules, setDraft, onSave, onRevert }) {
  const has = (k) => draft[k] != null
  const usedKeys = new Set([...VITAL_CARDS.flatMap((c) => c.stops.map((s) => s[0]).filter(Boolean)), ...DEVICE_KEYS, ...TIMING_KEYS])
  const others = Object.keys(draft).filter((k) => !usedKeys.has(k) && typeof draft[k] === 'number')
  const changes = rules ? Object.keys(draft).filter((k) => draft[k] !== rules[k]) : []
  const fmtChange = (k) => `${(RULE_LABEL[k]?.[0] || k).replace(/\s*[<>≤≥]\s*$/, '')} ${rules[k]} → ${draft[k]}`
  return (
    <div className="rules-x">
      <p className="muted small rl-intro">모든 병동에 공통 적용됩니다. 막대는 지금 입력한 값 기준으로 구간을 보여 주고, 값을 바꾸면 바로 다시 그려집니다.</p>
      <div className="rl-grid">
        {VITAL_CARDS.filter((c) => c.stops.some(([k]) => k && has(k))).map((c) => (
          <section key={c.id} className="rl-card">
            <h3>{c.title} <small>{c.unit}</small></h3>
            <RangeBar card={c} draft={draft} />
            <div className="rl-fields">{c.stops.map(([k]) => k && has(k) ? <RuleInput key={k} k={k} draft={draft} rules={rules} setDraft={setDraft} step={c.step} /> : null)}</div>
          </section>
        ))}
        {DEVICE_KEYS.some(has) && (
          <section className="rl-card">
            <h3>패치 · 기기</h3>
            <div className="rl-fields">{DEVICE_KEYS.filter(has).map((k) => <RuleInput key={k} k={k} draft={draft} rules={rules} setDraft={setDraft} />)}</div>
          </section>
        )}
        {TIMING_KEYS.some(has) && (
          <section className="rl-card">
            <h3>발생 · 해제 타이밍</h3>
            <div className="rl-fields">{TIMING_KEYS.filter(has).map((k) => <RuleInput key={k} k={k} draft={draft} rules={rules} setDraft={setDraft} />)}</div>
            <div className="rl-flow">
              <span>임계 이탈</span><i>→</i>
              <span className="warn"><b className="v">{draft.sustain_s ?? '—'}s</b> 지속</span><i>→</i>
              <span className="fire">알람 발생</span><i>→</i>
              <span>조건 해소</span><i>→</i>
              <span className="ok"><b className="v">{draft.clear_s ?? '—'}s</b> 유예 후 자동 해제</span>
            </div>
            <p className="muted small">전극 탈락 중에는 수치 알람을 평가하지 않습니다. 전극 탈락·패치 무응답은 각각의 지속 시간을 넘겨야 알람이 됩니다.</p>
          </section>
        )}
        {others.length > 0 && (
          <section className="rl-card">
            <h3>기타</h3>
            <div className="rl-fields">{others.map((k) => <RuleInput key={k} k={k} draft={draft} rules={rules} setDraft={setDraft} />)}</div>
          </section>
        )}
      </div>
      <div className={'rl-savebar' + (changes.length ? ' dirty' : '')}>
        <i className="rl-dot" />
        {changes.length
          ? <><b>저장 안 된 변경 {changes.length}건</b><span className="muted small rl-diff">{changes.slice(0, 3).map(fmtChange).join(' · ')}{changes.length > 3 ? ` 외 ${changes.length - 3}` : ''}</span></>
          : <span className="muted small">변경 없음 — 값을 바꾸면 여기에 표시됩니다</span>}
        <span className="muted small">저장하면 즉시 모든 병동에 적용되며 감사 기록에 남습니다</span>
        <span className="spacer" />
        <button onClick={onRevert} disabled={!changes.length}>되돌리기</button>
        <button className="primary" onClick={onSave} disabled={!changes.length}>저장</button>
      </div>
    </div>
  )
}

/** 알람 상세: 값·임계·지속·오늘 횟수·담당 · 대상 환자 요약 · 확인/침상 뷰어/환자/지도 */
function AlarmDetail({ a, rules, today, canAck, onAck, onClose }) {
  const [rows] = usePoll(() => (a.channel_id ? api.channelsScoped(`ids=${encodeURIComponent(a.channel_id)}`) : Promise.resolve([])), 5000, [a.channel_id])
  const r = rows?.[0]
  const v = r?.vitals || {}
  const p = r?.patient || {}
  const t = threshold(a.kind, rules)
  const doctor = p.doctor || p.attending || p.physician || null
  const nurse = p.nurse || null
  return (
    <DetailPanel title={ALARM_KIND[a.kind] || a.kind} sub={`${SEV_LABEL[a.severity]}${a.patient_name ? ` · ${a.patient_name}` : ''}`} onClose={onClose}
      actions={<>
        {!a.acked && !a.cleared_ms && canAck && <button className="primary" onClick={() => onAck(a.id)}>확인</button>}
        {a.channel_id && <button onClick={() => openLive(a.channel_id)}>침상 뷰어</button>}
        {a.channel_id && <button onClick={() => go('#/patients', { sel: a.channel_id })}>환자 상세</button>}
        {(a.channel_id || a.room) && <button onClick={() => go('#/map', a.channel_id ? { pat: a.channel_id } : { room: a.room })}>지도에서 보기</button>}
      </>}>
      <div className={`lk-alarm sev-${a.severity}`}><Pill tone={TONE[a.severity]}>{SEV_LABEL[a.severity]}</Pill> {a.message}</div>
      <dl className="lk-kv">
        <KV k="값">{a.value}</KV>
        <KV k="임계">{t ? `${t.dir === 'high' ? '>' : '<'} ${t.limit}${t.unit}${rules?.sustain_s && !['battery_low'].includes(a.kind) ? ` · ${rules.sustain_s}초 지속` : ''}` : null}</KV>
        <KV k="지속">{a.cleared_ms ? dur(a.cleared_ms - a.since_ms) : dur(Date.now() - a.since_ms)}</KV>
        <KV k="발생">{fmtTime(a.since_ms)} ({fmtAgo(a.since_ms)})</KV>
        <KV k="해제">{a.cleared_ms ? fmtTime(a.cleared_ms) : '아직 발생 중'}</KV>
        <KV k="확인">{a.acked ? '확인됨' : '미확인'}</KV>
        <KV k="오늘 이력">{today > 1 ? `같은 알람 ${today}회` : today === 1 ? '오늘 처음' : null}</KV>
        <KV k="환자">{a.channel_id ? <PatientLink ch={a.channel_id}>{a.patient_name || a.channel_id}</PatientLink> : null}</KV>
        <KV k="병동">{a.room ? <WardLink ward={wardOfRoom(a.room)} /> : null}</KV>
        <KV k="입원 병실">{a.room ? <RoomLink room={a.room}>{roomText(a.room)}</RoomLink> : null}</KV>
        <KV k="지금 위치">{a.now ? <RoomLink room={a.now}>{spaceName(a.now)}</RoomLink> : null}</KV>
        <KV k="게이트웨이">{a.gateway_id || r?.gateway_id ? <GwLink id={a.gateway_id || r?.gateway_id} /> : null}</KV>
        {r && <KV k="현재 바이탈">HR <b>{v.hr ?? '—'}</b> · SpO₂ <b>{v.spo2 ?? '—'}</b> · RR <b>{v.resp ?? '—'}</b>{v.temp != null ? <> · <b>{v.temp.toFixed(1)}</b>°C</> : null}</KV>}
        {r && <KV k="진료">{[p.department, p.diagnosis].filter(Boolean).join(' · ')}</KV>}
        {(doctor || nurse) && <KV k="담당">{[doctor && `의사 ${doctor}`, nurse && `간호사 ${nurse}`].filter(Boolean).join(' · ')}</KV>}
      </dl>
    </DetailPanel>
  )
}
