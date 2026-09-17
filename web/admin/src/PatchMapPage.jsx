import React, { useEffect, useMemo, useState } from 'react'
import GatewayWaveModal, { PatientWaveModal } from './GatewayWaveModal.jsx'
import ReportModal from './ReportModal.jsx'
import { API, EMU_API, VIEWER } from './endpoints.js'

const DOOR_W = 30

// ECG Patch Map — 건축 평면도 스타일 시각화 (병원별 JSON 정의 기반).
// 도면은 floorplans/<병원id>.json 이 정의하며, App 의 병원선택 메뉴로 전환된다.

const fmt = (s, b, f) =>
  s == null ? s : String(s).split('{b}').join(b).split('{f}').join(String(f))

// ---------- 위치/상태 판정 ----------
function locate(c) {
  const p = c.patient
  if (!p) return null
  const gw = c.gateway_id || ''
  if (c.space && !c.space.endsWith('호')) {
    const m = gw.match(/^GW-([A-Z])(\d+)(?:-(Z\d))?-(HALL|WC|EXAM)$/)
    if (m) return { building: m[1], floor: Number(m[2]), zone: m[3] || null, kind: m[4], room: null }
  }
  // 입원 병실이 아닌 다른 병실에 있는 경우(병문안) — 방문 위치로 표시 (입실 아님)
  if (c.space && c.space.endsWith('호') && p.room && c.space !== `${p.room}호`) {
    const m = gw.match(/^GW-([A-Z])(\d+)-(\d+)$/)
    if (m) return { building: m[1], floor: Number(m[2]), zone: p.zone, kind: 'ROOM', room: m[3], visit: true }
  }
  return { building: p.building, floor: Number(p.floor), zone: p.zone, kind: 'ROOM', room: p.room }
}

function statusOf(c) {
  if (!c.connected) return 'off'
  if (c.stale) return 'stall' // 소켓은 살아있으나 패킷 없음 (게이트웨이 장애 등)
  if (c.quality === 'weak') return 'weak'
  if (c.moving) return 'move'
  return 'ok'
}

const STATUS_LABEL = { ok: '정상', weak: '약신호', move: '이동', stall: '수신중단', off: '해제' }

function PatchChip({ c, hl, onClick }) {
  const st = statusOf(c)
  const p = c.patient || {}
  return (
    <span
      className={'p-chip clickable ' + st + (hl ? ' hl' : '')}
      title={`${p.name} · ${p.id}/${c.channel_id} · ${STATUS_LABEL[st]} · ${c.gateway_id} — 클릭: 실시간 파형`}
      onClick={onClick}
    >
      <i className={'p-dot ' + st} />
      <b>{p.name}</b>
      <small>{p.id}·{c.channel_id}</small>
    </span>
  )
}

// ---------- SVG 도면 프리미티브 ----------
const edgeSegs = (a1, a2, center, gap) =>
  [[a1, center - gap / 2], [center + gap / 2, a2]].filter(([a, b]) => b > a)

function wallLines(r, door, gap = DOOR_W) {
  const { x, y, w, h } = r
  const out = []
  const hLine = (yy, withGap) =>
    (withGap ? edgeSegs(x, x + w, x + w / 2, gap) : [[x, x + w]]).forEach(([a, b]) =>
      out.push([a, yy, b, yy]))
  const vLine = (xx, withGap) =>
    (withGap ? edgeSegs(y, y + h, y + h / 2, gap) : [[y, y + h]]).forEach(([a, b]) =>
      out.push([xx, a, xx, b]))
  hLine(y, door === 'N')
  hLine(y + h, door === 'S')
  vLine(x, door === 'W')
  vLine(x + w, door === 'E')
  return out
}

function doorArc(r, door, w = DOOR_W) {
  const { x, y, w: rw, h } = r
  const cx = x + rw / 2, cy = y + h / 2
  if (door === 'S') { const hx = cx - w / 2, yw = y + h; return `M ${hx} ${yw} L ${hx} ${yw - w} A ${w} ${w} 0 0 1 ${hx + w} ${yw}` }
  if (door === 'N') { const hx = cx - w / 2; return `M ${hx} ${y} L ${hx} ${y + w} A ${w} ${w} 0 0 0 ${hx + w} ${y}` }
  if (door === 'E') { const hy = cy - w / 2, xw = x + rw; return `M ${xw} ${hy} L ${xw - w} ${hy} A ${w} ${w} 0 0 0 ${xw} ${hy + w}` }
  if (door === 'W') { const hy = cy - w / 2; return `M ${x} ${hy} L ${x + w} ${hy} A ${w} ${w} 0 0 1 ${x} ${hy + w}` }
  return ''
}

const WALL = { stroke: 'var(--ink-2)', strokeWidth: 2.5, strokeLinecap: 'square' }
const ARC = { stroke: 'var(--ink-3)', strokeWidth: 1.2, fill: 'none' }

function SpaceSvg({ sp, failed, occupied }) {
  const r = sp.rect
  switch (sp.type) {
    case 'corridor':
    case 'open':
      return <rect {...r} width={r.w} height={r.h} fill="var(--surface-2)" />
    case 'zone':
      return failed ? <rect {...r} width={r.w} height={r.h} fill="var(--crit-bg)" /> : null
    case 'room': {
      const fill = failed ? 'var(--crit-bg)' : occupied ? 'var(--accent-soft)' : 'var(--surface)'
      return (
        <g>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} />
          {wallLines(r, sp.door).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...WALL} />
          ))}
          {sp.door && <path d={doorArc(r, sp.door)} {...ARC} />}
        </g>
      )
    }
    case 'facility':
      // 처치/준비실, 직원 라운지, 설비 등 — JSON 의 fill 색으로 구분
      return (
        <g>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={sp.fill || 'var(--line-soft)'} />
          {wallLines(r, sp.door).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...WALL} />
          ))}
          {sp.door && <path d={doorArc(r, sp.door)} {...ARC} />}
        </g>
      )
    case 'stairs':
      return (
        <g>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#hatch-stair)" />
          {wallLines(r, null).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...WALL} />
          ))}
        </g>
      )
    case 'elevator':
      return (
        <g>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="url(#hatch-cross)" />
          {wallLines(r, null).map(([x1, y1, x2, y2], i) => (
            <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} {...WALL} />
          ))}
          <line x1={r.x + r.w / 2 - 13} y1={r.y + 4} x2={r.x + r.w / 2 + 13} y2={r.y + 4} stroke="var(--ink-3)" strokeWidth="2.5" />
          <line x1={r.x + r.w / 2 - 13} y1={r.y + r.h - 4} x2={r.x + r.w / 2 + 13} y2={r.y + r.h - 4} stroke="var(--ink-3)" strokeWidth="2.5" />
        </g>
      )
    case 'station':
      return (
        <rect
          x={r.x} y={r.y} width={r.w} height={r.h} rx="4"
          fill="var(--ink-3)" stroke="var(--ink-2)" strokeWidth="1.5"
        />
      )
    case 'display':
      return (
        <g>
          <rect x={r.x} y={r.y} width={r.w} height={r.h} rx="4"
            fill="var(--ink-1)" stroke="var(--accent)" strokeWidth="2" />
          <line x1={r.x + r.w / 2 - 10} y1={r.y + r.h + 4} x2={r.x + r.w / 2 + 10} y2={r.y + r.h + 4}
            stroke="var(--ink-3)" strokeWidth="2.5" />
        </g>
      )
    case 'entrance':
      return (
        <g>
          <line x1={r.x} y1={r.y} x2={r.x + r.w} y2={r.y} stroke="var(--bg)" strokeWidth="8" />
          <path d={`M ${r.x} ${r.y} L ${r.x} ${r.y - r.w / 2} A ${r.w / 2} ${r.w / 2} 0 0 1 ${r.x + r.w / 2} ${r.y}`} {...ARC} />
          <path d={`M ${r.x + r.w} ${r.y} L ${r.x + r.w} ${r.y - r.w / 2} A ${r.w / 2} ${r.w / 2} 0 0 0 ${r.x + r.w / 2} ${r.y}`} {...ARC} />
        </g>
      )
    default:
      return null
  }
}

// 도면 좌표에 정렬되는 오버레이
function Overlay({ vb, sp, label, gw, failed, members, displayGroup, onDisplayClick, onGwClick, onPatientClick, highlight }) {
  const r = sp.rect
  const style = {
    left: `${(r.x / vb.w) * 100}%`,
    top: `${(r.y / vb.h) * 100}%`,
    width: `${(r.w / vb.w) * 100}%`,
    height: `${(r.h / vb.h) * 100}%`,
  }
  if (sp.type === 'display') {
    return (
      <button className="ov disp-btn" style={style} title={`${label} — 클릭하여 표시 그룹 설정`} onClick={onDisplayClick}>
        🖥 {displayGroup ? displayGroup.name : '그룹 미지정'}
      </button>
    )
  }
  if (['stairs', 'elevator', 'station', 'open', 'facility'].includes(sp.type) || (!gw && !sp.match)) {
    if (sp.type === 'entrance') {
      return (
        <div className="ov tag" style={{ ...style, top: `${((r.y - 34) / vb.h) * 100}%`, height: '28px' }}>
          <span className="ov-tag-label">▼ {label}</span>
        </div>
      )
    }
    return (
      <div className={'ov tag' + (sp.type === 'station' ? ' on-dark' : '')} style={style}>
        <span className="ov-tag-label">{label}</span>
      </div>
    )
  }
  if (sp.type === 'entrance') {
    return (
      <div className="ov tag" style={{ ...style, top: `${((r.y - 34) / vb.h) * 100}%`, height: '28px' }}>
        <span className="ov-tag-label">▼ {label}</span>
      </div>
    )
  }
  return (
    <div className={'ov' + (sp.compact ? ' compact' : '')} style={style}>
      <div className="ov-head">
        <span className="ov-label">{label}</span>
        {gw && (
          <button
            className="gw-link"
            title={`${gw} — 클릭: 이 게이트웨이의 실시간 파형 보기 (${failed ? '장애 중' : '정상'})`}
            onClick={onGwClick}
          >
            <i className={'gw-dot ' + (failed ? 'down' : 'up')} />
            <code className="gw-id">{gw}</code>
          </button>
        )}
        {failed && <span className="fail-tag">장애</span>}
      </div>
      <div className="ov-chips">
        {members.map((c) => (
          <PatchChip
            key={c.channel_id}
            c={c}
            hl={highlight === c.channel_id}
            onClick={() => onPatientClick(c)}
          />
        ))}
      </div>
    </div>
  )
}

// ---------- 이동 동선 타임라인 ----------
const fmtClock = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  if (s < 3600) return `${Math.floor(s / 60)}분 ${s % 60 ? s % 60 + '초' : ''}`.trim()
  return '1시간+'
}

// 여정 하나를 시간대별 세그먼트 체인으로 그린다:
// 과거 이력(최근 3~4개) → 현재 위치 → 예약 일정(있을 때만).
// 임의 이동(화장실/산책/병문안)의 복귀 시각은 추정 근거가 없어 표시하지 않고,
// 예약(검사/진료) 기반 이동만 복귀 예상 시각을 보여준다.
function JourneyRow({ j, nowMs, channel, onLocate }) {
  const st = channel ? statusOf(channel) : (j.moving ? 'move' : 'ok')
  const p = j.patient || {}
  const room = `${p.room}호`
  // 입원 병실이 아닌 다른 병실은 입실이 아니라 '방문' (이동 중 상태)
  const label = (space) =>
    space && space.endsWith('호') && space !== room ? `${space.slice(0, -1)}호 방문` : space
  const hist = j.log.slice(-4)
  const appt = j.next_appt
  const segs = [
    ...hist.map((e) => ({ kind: 'done', space: label(e.space), start: e.start_ms, end: e.end_ms })),
    { kind: 'cur', space: label(j.current.space), start: j.current.since_ms },
  ]
  return (
    <div className="mv-row">
      <div className="mv-head">
        <i className={'p-dot ' + st} />
        <b className="mv-name">{p.name}</b>
        <small>{p.id}·{j.channel_id} · 입원 {p.building}동 {room}</small>
        <span className={'mv-state' + (j.moving ? ' on' : '')}>
          {j.moving ? `이동 중 — 현재 ${label(j.current.space)}`
            : j.log.length ? `복귀 완료 — ${j.current.space}`
            : `재실 — ${j.current.space || room}`}
        </span>
        <span className="spacer" />
        <button className="mv-locate" onClick={onLocate} title="평면도에서 현재 위치 보기">
          위치 보기 →
        </button>
      </div>
      <div className="mv-tl">
        {segs.map((s, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="mv-arrow">→</span>}
            <span className={'mv-seg ' + s.kind}
              title={s.kind === 'cur' ? '현재 위치' : '지나온 구간'}>
              <b>{s.space}</b>
              <small>
                {fmtClock(s.start)} · {s.kind === 'cur'
                  ? `${fmtDur(nowMs - s.start)} 경과`
                  : fmtDur(s.end - s.start)}
              </small>
            </span>
          </React.Fragment>
        ))}
        {appt && (
          <>
            <span className="mv-arrow">→</span>
            <span className={'mv-seg appt' + (appt.status === 'in_progress' ? ' cur' : '')}
              title="예약 일정 (검사/진료) — DB(SQLite) 연동">
              <b>📋 {appt.title}</b>
              <small>
                {appt.place} · {appt.status === 'in_progress'
                  ? `복귀 예상 ${fmtClock(j.eta_return_ms || appt.eta_return_ms)}`
                  : `${fmtClock(appt.scheduled_ms)} 예약`}
              </small>
            </span>
          </>
        )}
      </div>
    </div>
  )
}

function MovesView({ journeys, nowMs, chMap, onLocate }) {
  // moving: 이동 중 | planned: 이동 예정(예약 보유) | history: 동선 기록
  const [tab, setTab] = useState(() => {
    const m = window.location.hash.match(/[?&]tab=(moving|planned|history)/)
    return m ? m[1] : 'moving'
  })
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const match = (j) => !needle || (j.patient?.name || '').toLowerCase().includes(needle)
  const lastEnd = (j) => j.log.length ? j.log[j.log.length - 1].end_ms : 0

  const movingAll = journeys.filter((j) => j.moving)
  // 이동 예정: 재실 중이거나 이동 중인 환자 가운데 예약이 잡혀 있는 사람
  const plannedAll = journeys
    .filter((j) => j.next_appt && j.next_appt.status === 'reserved')
    .sort((a, b) => a.next_appt.scheduled_ms - b.next_appt.scheduled_ms)
  const pastAll = journeys.filter((j) => !j.moving && j.log.length)
  const shown = (tab === 'moving' ? movingAll
    : tab === 'planned' ? plannedAll
    : [...pastAll].sort((a, b) => lastEnd(b) - lastEnd(a)))
    .filter(match)

  return (
    <div className="mv-page">
      <div className="mv-tabs">
        <button className={tab === 'moving' ? 'primary' : ''} onClick={() => setTab('moving')}>
          이동 중 ({movingAll.length})
        </button>
        <button className={tab === 'planned' ? 'primary' : ''} onClick={() => setTab('planned')}>
          이동 예정 ({plannedAll.length})
        </button>
        <button className={tab === 'history' ? 'primary' : ''} onClick={() => setTab('history')}>
          동선 기록 ({pastAll.length})
        </button>
        <input
          className="search mv-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="환자 이름 검색"
        />
      </div>
      {shown.length === 0 && (
        <p className="hint">
          {needle ? '검색 결과가 없습니다.'
            : tab === 'moving'
              ? '현재 이동 중인 환자가 없습니다. 환자는 평균 20분에 한 번 병실을 나서고, 예약 시간이 되면 검사실로 이동합니다.'
            : tab === 'planned'
              ? '예약(검사/진료)이 잡힌 환자가 없습니다. 에뮬레이터가 평균 12초에 한 건씩 예약을 생성합니다.'
              : '최근 30분 내 이동을 마친 환자가 없습니다.'}
        </p>
      )}
      {shown.map((j) => (
        <JourneyRow key={j.channel_id} j={j} nowMs={nowMs}
          channel={chMap.get(j.channel_id)} onLocate={() => onLocate(j)} />
      ))}
    </div>
  )
}

// 디스플레이 → 그룹 지정 모달
function DisplayModal({ dispId, label, groups, current, onClose, onSaved }) {
  const [sel, setSel] = useState(current || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async () => {
    if (!sel) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${API}/api/displays/${encodeURIComponent(dispId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: sel }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onSaved()
    } catch (e) {
      setError(`저장 실패: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-head">
          <h3>디스플레이 그룹 설정</h3>
          <span className="modal-sub">{label} · <code>{dispId}</code></span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="disp-group-list">
          {groups.map((g) => (
            <label key={g.id} className="filter-item">
              <input
                type="radio"
                name="disp-group"
                checked={sel === g.id}
                onChange={() => setSel(g.id)}
              />
              <span><b>{g.name}</b> <code>{g.id}</code> · {g.member_count}채널</span>
            </label>
          ))}
        </div>
        <p className="hint">
          이 디스플레이(뷰어)가 구독할 그룹을 지정합니다. 지정 후 아래 링크로 열면
          해당 그룹이 자동 선택된 뷰어가 뜹니다.
        </p>
        <div className="modal-actions">
          <button className="primary" disabled={busy || !sel} onClick={save}>저장</button>
          {sel && (
            <a className="viewer-link" href={`${VIEWER}/?group=${encodeURIComponent(sel)}`} target="_blank" rel="noreferrer">
              🖥 뷰어에서 열기 ↗
            </a>
          )}
          <div className="spacer" />
          <button disabled={busy} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}

export default function PatchMapPage({ channels, gwDown = [], groups = [], hospital }) {
  const VB = hospital.viewBox
  const BUILDINGS = hospital.buildings

  const located = useMemo(
    () => channels.map((c) => ({ c, loc: locate(c) })).filter((x) => x.loc),
    [channels],
  )

  // 채널 수에 맞춰 사용 중인 층만 표시 (병상은 저층부터 순차 충전됨)
  const usedFloors = useMemo(() => {
    const s = new Set()
    for (const x of located) s.add(x.loc.floor)
    return s
  }, [located])
  let FLOORS = hospital.floors.filter((f) => f === 1 || usedFloors.has(f))
  if (FLOORS.length <= 1) FLOORS = hospital.floors.slice(-2) // 데이터 없을 때 최소 표시
  const wardFloor = FLOORS.find((f) => f !== 1) ?? FLOORS[0]

  const [building, setBuilding] = useState(BUILDINGS[0])
  const [floor, setFloor] = useState(wardFloor)

  // 표시 층 목록이 바뀌어 현재 층이 사라지면 기본 층으로 이동
  useEffect(() => {
    if (!FLOORS.includes(floor)) setFloor(wardFloor)
  }, [FLOORS.join(','), floor]) // eslint-disable-line react-hooks/exhaustive-deps
  const downSet = useMemo(() => new Set(gwDown), [gwDown])
  const [displays, setDisplays] = useState({})
  const [dispModal, setDispModal] = useState(null)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(null)
  const [waveGw, setWaveGw] = useState(null)     // 게이트웨이 파형 모달
  const [wavePatient, setWavePatient] = useState(null) // 환자 파형 모달
  // floor: 평면도 | moves: 이동 동선 (#/patch-map?view=moves 로 직접 진입 가능)
  const [view, setView] = useState(
    window.location.hash.includes('view=moves') ? 'moves' : 'floor')
  // 환자 리포트 딥링크 (#/patch-map?report=<채널ID>)
  const [reportCh, setReportCh] = useState(() => {
    const m = window.location.hash.match(/[?&]report=([A-Za-z0-9_-]+)/)
    return m ? m[1] : null
  })
  const [journeys, setJourneys] = useState({ now_ms: 0, journeys: [] })

  // 이동 동선 폴링 (에뮬레이터 /journeys, 3초)
  useEffect(() => {
    const load = () =>
      fetch(`${EMU_API}/journeys`).then((r) => r.json()).then(setJourneys).catch(() => {})
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  const chMap = useMemo(
    () => new Map(channels.map((c) => [c.channel_id, c])), [channels])
  const movingJourneys = journeys.journeys.filter((j) => j.moving)

  // 동선 목록에서 '위치 보기': 현재 게이트웨이의 건물/층으로 평면도 전환
  const locateJourney = (j) => {
    const m = (j.current.gw || '').match(/^GW-([A-Z])(\d+)/)
    const b = m ? m[1] : j.patient?.building
    const f = m ? Number(m[2]) : Number(j.patient?.floor)
    if (b && BUILDINGS.includes(b)) setBuilding(b)
    if (f && FLOORS.includes(f)) setFloor(f)
    setView('floor')
    setHighlight(j.channel_id)
    setTimeout(() => setHighlight(null), 6000)
  }

  // 병원 전환 시 기본 층/건물로 리셋
  useEffect(() => {
    setBuilding(BUILDINGS[0])
    setFloor(wardFloor)
    setWaveGw(null)
    setWavePatient(null)
  }, [hospital.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadDisplays = () =>
    fetch(`${API}/api/displays`).then((r) => r.json()).then(setDisplays).catch(() => {})
  useEffect(() => {
    loadDisplays()
    const t = setInterval(loadDisplays, 5000)
    return () => clearInterval(t)
  }, [])

  const onFloor = (b, f) => located.filter((x) => x.loc.building === b && x.loc.floor === f)
  const current = onFloor(building, floor)

  const floorGateways = (b, f) => {
    const p = hospital.plans[String(f)] || hospital.plans.default
    return p.spaces.filter((s) => s.gw).map((s) => fmt(s.gw, b, f))
  }

  // 환자 검색
  const q = query.trim().toLowerCase()
  const results = q
    ? located
        .filter((x) => {
          const p = x.c.patient || {}
          return (
            (p.name || '').toLowerCase().includes(q) ||
            (p.id || '').toLowerCase().includes(q) ||
            x.c.channel_id.toLowerCase().includes(q)
          )
        })
        .slice(0, 12)
    : []

  const pickResult = (x) => {
    setBuilding(x.loc.building)
    setFloor(x.loc.floor)
    setHighlight(x.c.channel_id)
    setQuery('')
    setTimeout(() => setHighlight(null), 6000)
  }

  const plan = hospital.plans[String(floor)] || hospital.plans.default

  const spaces = plan.spaces.map((sp) => {
    const label = fmt(sp.label, building, floor)
    const gw = fmt(sp.gw, building, floor)
    const failed = gw ? downSet.has(gw) : false
    let members = []
    if (sp.match) {
      const room = fmt(sp.match.room, building, floor)
      members = current
        .filter((x) =>
          x.loc.kind === sp.match.kind &&
          (!sp.match.zone || x.loc.zone === sp.match.zone) &&
          (!room || x.loc.room === room))
        .map((x) => x.c)
    }
    let displayId = null
    let displayGroup = null
    if (sp.type === 'display') {
      displayId = fmt(sp.display, building, floor)
      const gid = displays[displayId]
      displayGroup = groups.find((g) => g.id === gid) || (gid ? { id: gid, name: gid } : null)
    }
    return { sp, label, gw, failed, members, displayId, displayGroup }
  })

  return (
    <div className="map-page">
      {view === 'moves' ? (
        <div className="map-main">
          <div className="map-controls">
            <div className="bld-tabs">
              <button onClick={() => setView('floor')}>← 평면도</button>
            </div>
            <h2 className="map-title">{hospital.name} · 이동 동선 타임라인</h2>
            <span className="map-count">
              이동 중 {movingJourneys.length}명 · 최근 30분 이동 {journeys.journeys.length}건 · 3초 갱신
            </span>
          </div>
          <MovesView
            journeys={journeys.journeys}
            nowMs={journeys.now_ms || Date.now()}
            chMap={chMap}
            onLocate={locateJourney}
          />
        </div>
      ) : (
      <div className="map-main">
        <div className="map-controls">
          {/* 건물 전환은 오른쪽 전층 미니맵에서 — 별도 A/B동 버튼 없음 */}
          <h2 className="map-title">{hospital.name} · {building}동 {floor}층 평면도</h2>
          <div className="map-search">
            <input
              className="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="환자 이름 / 환자ID / 채널ID 검색"
            />
            {results.length > 0 && (
              <div className="search-results">
                {results.map((x) => {
                  const p = x.c.patient || {}
                  const where = x.loc.room
                    ? `${x.loc.building}동 ${x.loc.floor}층 ${x.loc.room}호`
                    : `${x.loc.building}동 ${x.loc.floor}층 ${x.c.space}`
                  return (
                    <button key={x.c.channel_id} className="sr-item" onClick={() => pickResult(x)}>
                      <i className={'p-dot ' + statusOf(x.c)} />
                      <b>{p.name}</b>
                      <small>{p.id}·{x.c.channel_id}</small>
                      <span className="sr-where">{where}</span>
                    </button>
                  )
                })}
              </div>
            )}
            {q && results.length === 0 && (
              <div className="search-results"><div className="sr-empty">검색 결과 없음</div></div>
            )}
          </div>
          <span className="map-count">{current.length}명 재실</span>
        </div>

        <div
          className="arch-wrap"
          style={{
            // 폭은 카드를 항상 100% 채우고(빈 공간 없음),
            // 높이만 화면에 맞게 압축 → 세로 스크롤도 발생하지 않는다
            aspectRatio: `${VB.w} / ${VB.h}`,
            maxHeight: 'calc(100vh - 330px)',
          }}
        >
          <svg className="arch-svg" viewBox={`0 0 ${VB.w} ${VB.h}`} preserveAspectRatio="none">
            <defs>
              <pattern id="hatch-stair" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="9" height="9" fill="var(--surface)" />
                <line x1="0" y1="0" x2="0" y2="9" stroke="var(--ink-3)" strokeWidth="1.4" />
              </pattern>
              <pattern id="hatch-cross" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="10" height="10" fill="var(--surface)" />
                <line x1="0" y1="0" x2="0" y2="10" stroke="var(--ink-3)" strokeWidth="1.1" />
                <line x1="0" y1="0" x2="10" y2="0" stroke="var(--ink-3)" strokeWidth="1.1" />
              </pattern>
            </defs>
            {spaces.map(({ sp, failed, members }) => (
              <SpaceSvg key={sp.id} sp={sp} failed={failed} occupied={members.length > 0} />
            ))}
            <rect x="10" y="10" width={VB.w - 20} height={VB.h - 20} fill="none"
              stroke="var(--ink-1)" strokeWidth="5" />
            {spaces.filter((s) => s.sp.type === 'entrance').map(({ sp }) => (
              <line key={sp.id} x1={sp.rect.x} y1={sp.rect.y} x2={sp.rect.x + sp.rect.w} y2={sp.rect.y}
                stroke="var(--surface-2)" strokeWidth="6" />
            ))}
          </svg>

          {spaces.map(({ sp, label, gw, failed, members, displayId, displayGroup }) => (
            <Overlay
              key={sp.id}
              vb={VB}
              sp={sp}
              label={label}
              gw={gw}
              failed={failed}
              members={members}
              displayGroup={displayGroup}
              onDisplayClick={() => setDispModal({ id: displayId, label })}
              onGwClick={() => setWaveGw({ gw, label })}
              onPatientClick={(c) => setWavePatient(c)}
              highlight={highlight}
            />
          ))}
        </div>

        {waveGw && (
          <GatewayWaveModal
            gw={waveGw.gw}
            label={waveGw.label}
            channels={channels}
            onClose={() => setWaveGw(null)}
          />
        )}

        {wavePatient && (
          <PatientWaveModal
            ch={wavePatient}
            channels={channels}
            onClose={() => setWavePatient(null)}
          />
        )}

        {dispModal && (
          <DisplayModal
            dispId={dispModal.id}
            label={dispModal.label}
            groups={groups}
            current={displays[dispModal.id]}
            onClose={() => setDispModal(null)}
            onSaved={() => { setDispModal(null); loadDisplays() }}
          />
        )}

        <div className="map-legend">
          <span><i className="p-dot ok" /> 정상</span>
          <span><i className="p-dot weak" /> 약신호</span>
          <span><i className="p-dot move" /> 이동 중</span>
          <span><i className="p-dot stall" /> 수신중단 (GW 장애 등)</span>
          <span><i className="p-dot off" /> 해제</span>
          <span><i className="gw-dot up" /> GW 정상</span>
          <span><i className="gw-dot down" /> GW 장애</span>
          <span className="legend-note">도면 정의: src/floorplans/{hospital.id}.json (교체 가능)</span>
        </div>
        <div className="map-legend facility">
          <span><i className="sw sw-corridor" /> HALL&amp;CORRIDOR</span>
          <span><i className="sw sw-ev" /> ELEVATOR</span>
          <span><i className="sw sw-station" /> NURSE STATION</span>
          <span><i className="sw sw-stair" /> STAIR</span>
        </div>
      </div>
      )}

      {reportCh && <ReportModal channelId={reportCh} onClose={() => setReportCh(null)} />}

      {/* 미니맵: 전층 (게이트웨이/패치 2줄) */}
      <aside className="map-side">
        {/* 이동 카드 탭: 이동 중인 패치 아이콘 + 클릭 시 동선 타임라인 뷰 */}
        <button
          className={'move-tab' + (view === 'moves' ? ' active' : '')}
          onClick={() => setView(view === 'moves' ? 'floor' : 'moves')}
          title="클릭: 이동 중 환자들의 시간대별 동선 타임라인"
        >
          <span className="move-tab-head">
            <b>이동 중</b>
            <span className="move-tab-n">{movingJourneys.length}</span>
          </span>
          <span className="move-tab-icons">
            {movingJourneys.length === 0 && <small className="dim">이동 환자 없음</small>}
            {movingJourneys.slice(0, 40).map((j) => {
              const c = chMap.get(j.channel_id)
              return (
                <i
                  key={j.channel_id}
                  className={'p-dot ' + (c ? statusOf(c) : 'move')}
                  title={`${j.patient?.name} — ${j.current.space}`}
                />
              )
            })}
          </span>
          <span className="move-tab-go">동선 타임라인 {view === 'moves' ? '닫기' : '보기'} →</span>
        </button>
        <h2 className="map-title">전층 미니맵</h2>
        {BUILDINGS.map((b) => (
          <div key={b} className="mini-building">
            <div className="mini-bld-name">{b}동</div>
            {FLOORS.map((f) => {
              const patches = onFloor(b, f)
              const gws = floorGateways(b, f)
              const gwDownCnt = gws.filter((g) => downSet.has(g)).length
              const active = b === building && f === floor
              return (
                <button
                  key={f}
                  className={'mini-floor' + (active ? ' active' : '')}
                  onClick={() => { setBuilding(b); setFloor(f); setView('floor') }}
                  title={`${b}동 ${f}층 — 게이트웨이 ${gws.length}대(장애 ${gwDownCnt}) · 패치 ${patches.length}명`}
                >
                  <span className="mini-f">{f}F</span>
                  <span className="mini-rows">
                    <span className="mini-row-label">GW</span>
                    <span className="mini-icons">
                      {gws.map((g) => (
                        <i key={g} className={'gw-dot ' + (downSet.has(g) ? 'down' : 'up')} title={g} />
                      ))}
                    </span>
                    <span className="mini-row-label">패치</span>
                    <span className="mini-icons">
                      {patches.map((x) => (
                        <i key={x.c.channel_id} className={'p-dot ' + statusOf(x.c)} />
                      ))}
                    </span>
                  </span>
                  <span className="mini-n">{patches.length}</span>
                </button>
              )
            })}
          </div>
        ))}
      </aside>
    </div>
  )
}
