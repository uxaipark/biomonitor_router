import React, { useEffect, useRef, useState } from 'react'
import GroupEditor from './GroupEditor.jsx'
import TopBarProfile from './TopBarProfile.jsx'
import TransferModal, { computeAvailableRooms } from './TransferModal.jsx'
import GatewayWaveModal, { CohortWaveModal, PatientWaveModal } from './GatewayWaveModal.jsx'
import PatchMapPage from './PatchMapPage.jsx'
import { hospitals, hospitalById } from './hospitalPlans.js'
import PatchListPage from './PatchListPage.jsx'
import TimeLogPage from './TimeLogPage.jsx'
import AppointmentsPage from './AppointmentsPage.jsx'
import { applyTemplate, savedTemplateId, saveTemplateId, templates } from './templateLoader.js'
import { API, EMU_API, DB_API, VIEWER, REMOTE_EMU_HOSTS, REMOTE_EMU_LABELS, reprobeEmu } from './endpoints.js'

const DEPT_KO = {
  Cardiology: '순환기내과',
  InternalMedicine: '내과',
  Neurology: '신경과',
  Pulmonology: '호흡기내과',
}

// DB 리셋 후 기본 그룹 시딩.
// 실제 채널 분포에서 값을 뽑아 작은 규모(병실)부터 큰 규모(건물/복수 병동)까지
// 10개를 만든다. 기존 그룹은 '전체 채널'만 남기고 정리한다.
async function seedDefaultGroups() {
  // 리로드 직후 meta 수신을 잠시 대기 (환자 속성이 채워질 때까지)
  let chs = []
  for (let i = 0; i < 10; i++) {
    chs = await fetch(`${API}/api/channels`).then((r) => r.json())
    if (chs.length && chs.filter((c) => c.patient).length >= chs.length * 0.9) break
    await new Promise((res) => setTimeout(res, 700))
  }
  const ps = chs.map((c) => c.patient).filter(Boolean)
  if (!ps.length) return 0

  // key(속성 또는 함수)별 환자 수 상위 n 개 [값, 수]
  const top = (key, n = 1) => {
    const m = new Map()
    for (const p of ps) {
      const k = typeof key === 'function' ? key(p) : p[key]
      if (k) m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  }

  const [rb, rr] = top((p) => `${p.building}|${p.room}`)[0][0].split('|')
  const [zb, zf, zz] = top((p) => `${p.building}|${p.floor}|${p.zone}`)[0][0].split('|')
  const [fb, ff] = top((p) => `${p.building}|${p.floor}`)[0][0].split('|')
  const nurse = top('nurse')[0][0]
  const doctor = top('doctor')[0][0]
  const wards = top('ward', 2).map((e) => e[0])
  const depts = top('department', 2).map((e) => e[0])
  const bld = top('building')[0][0]
  // 병동이 하나뿐인 소규모 로스터: 복수 병동 대신 복수 층 통합 그룹으로 대체
  const fbFloors = [...new Set(ps.filter((p) => p.building === fb).map((p) => p.floor))]
    .sort((a, b) => Number(a) - Number(b)).slice(0, 2)
  // 그룹의 주요 사용자: 조건에 해당하는 환자들의 최다 담당자 (간호사/주치의)
  const topIn = (flt, key) => {
    const m = new Map()
    for (const p of ps) if (flt(p) && p[key]) m.set(p[key], (m.get(p[key]) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ''
  }

  const groups = [
    // 소규모 → 대규모 순. owner = 그룹의 주요 사용자 (담당 간호사/주치의/전광판/관제)
    { id: `room-${(rb + rr).toLowerCase()}`, name: `병실 ${rb}동 ${rr}호`,
      description: `${rb}동 ${rr}호 재원 환자 (병실 단위 집중 관찰)`,
      owner: topIn((p) => p.building === rb && p.room === rr, 'nurse') || '담당 간호사',
      criteria: { building: [rb], room: [rr] } },
    { id: `zone-${(zb + zf + zz).toLowerCase()}`, name: `구역 ${zb}${zf} ${zz}`,
      description: `${zb}동 ${zf}층 ${zz} 구역 (간호 구역 단위)`,
      owner: topIn((p) => p.building === zb && p.floor === zf && p.zone === zz, 'nurse')
        || '담당 간호사',
      criteria: { building: [zb], floor: [zf], zone: [zz] } },
    { id: 'nurse-top', name: `간호사 ${nurse} 담당`,
      description: `담당 간호사 ${nurse} 배정 환자`, owner: nurse,
      criteria: { nurse: [nurse] } },
    { id: 'doctor-top', name: `주치의 ${doctor} 담당`,
      description: `주치의 ${doctor} 담당 환자`, owner: doctor,
      criteria: { doctor: [doctor] } },
    { id: `floor-${(fb + ff).toLowerCase()}`, name: `${fb}동 ${ff}층`,
      description: `${fb}동 ${ff}층 전체 재원 환자`, owner: `${fb}${ff} 전광판`,
      criteria: { building: [fb], floor: [ff] } },
    { id: `ward-${wards[0].toLowerCase()}`, name: `병동 ${wards[0]}`,
      description: `${wards[0]} 병동 재원 환자 (층 밴드)`, owner: '수간호사',
      criteria: { ward: [wards[0]] } },
    { id: `dept-${depts[0].toLowerCase()}`, name: DEPT_KO[depts[0]] || depts[0],
      description: `${DEPT_KO[depts[0]] || depts[0]} 소속 환자`,
      owner: topIn((p) => p.department === depts[0], 'doctor') || '진료과장',
      criteria: { department: [depts[0]] } },
    ...(depts[1] ? [{ id: `dept-${depts[1].toLowerCase()}`, name: DEPT_KO[depts[1]] || depts[1],
      description: `${DEPT_KO[depts[1]] || depts[1]} 소속 환자`,
      owner: topIn((p) => p.department === depts[1], 'doctor') || '진료과장',
      criteria: { department: [depts[1]] } }] : []),
    { id: `bld-${bld.toLowerCase()}`, name: `${bld}동 전체`,
      description: `${bld}동 전체 재원 환자 (건물 단위)`, owner: '로비 전광판',
      criteria: { building: [bld] } },
    ...(wards[1] ? [{ id: 'wards-watch', name: '통합 관찰 병동',
      description: `${wards[0]}·${wards[1]} 병동 통합 모니터링 (복수 병동)`,
      owner: '중앙관제', criteria: { ward: wards } }]
      : fbFloors.length > 1 ? [{ id: 'floors-watch', name: '통합 관찰 층',
        description: `${fb}동 ${fbFloors.join('·')}층 통합 모니터링 (복수 층)`,
        owner: '중앙관제', criteria: { building: [fb], floor: fbFloors } }] : []),
  ]

  // 기존 그룹은 '전체 채널'(all)만 남기고 정리
  const existing = await fetch(`${API}/api/groups`).then((r) => r.json())
  for (const gr of existing) {
    if (gr.id !== 'all') {
      await fetch(`${API}/api/groups/${encodeURIComponent(gr.id)}`, { method: 'DELETE' })
        .catch(() => {})
    }
  }
  // 기본 그룹 '전체 채널'의 주요 사용자는 중앙관제 (관제 데스크 상시 모니터링)
  const all = existing.find((gr) => gr.id === 'all')
  if (all && all.owner !== '중앙관제') {
    await fetch(`${API}/api/groups/all`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...all, owner: '중앙관제' }),
    }).catch(() => {})
  }
  let created = 0
  for (const gr of groups) {
    const res = await fetch(`${API}/api/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner: 'system', include: [], exclude: [], ...gr }),
    })
    if (res.ok) created += 1
  }
  return created
}

// 시스템 모니터링 숫자는 소수점 없이 정수로만 표기
const fmtBytes = (n) => {
  if (n >= 1024 ** 3) return Math.round(n / 1024 ** 3) + ' GB'
  if (n >= 1024 ** 2) return Math.round(n / 1024 ** 2) + ' MB'
  if (n >= 1024) return Math.round(n / 1024) + ' KB'
  return Math.round(n) + ' B'
}

const fmtUptime = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}시간 ${m}분` : `${m}분 ${s % 60}초`
}

const toGB = (n) => Math.round(n / 1024 ** 3)

// 리소스 카드의 행: 라벨 | 바 그래프 | 수치. alert=true 면 빨간색
function ResourceRow({ label, pct, text, alert }) {
  const p = Math.min(100, Math.max(0, pct || 0))
  return (
    <div className="res-row">
      <span className="res-label">{label}</span>
      <span className="res-bar"><span className={'res-fill' + (alert ? ' crit' : '')} style={{ width: `${p}%` }} /></span>
      <span className={'res-val' + (alert ? ' crit' : '')}>{text}</span>
    </div>
  )
}

// Top Bar 중앙관제 메뉴: 관제 페이지 링크 모음
function ControlMenu({ page }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const items = [
    { id: 'console', href: '#/', name: 'ECG Channel Router Console', desc: '채널 라우터 관제' },
    { id: 'map', href: '#/patch-map', name: 'ECG Patch Map', desc: '건물 구조도 · 게이트웨이 · 패치 위치' },
    { id: 'patches', href: '#/patches', name: '패치 관리', desc: '재고 · 사용 내역 (SQLite)' },
    { id: 'timelog', href: '#/timelog', name: '타임 로그', desc: '가동/다운타임 · 이벤트 시계열' },
    { id: 'appts', href: '#/appointments', name: '예약 목록', desc: '검사/진료 예약 (SQLite)' },
  ]

  return (
    <div className="menubar-item" ref={ref}>
      <button className={'menu-btn' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
        중앙관제 {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="menu-dropdown">
          {items.map((it) => (
            <a
              key={it.id}
              className={'pm-item pm-link' + (page === it.id ? ' active' : '')}
              href={it.href}
              onClick={() => setOpen(false)}
            >
              <span className="pm-item-text">
                {it.name}
                <small>{it.desc}{page === it.id ? ' (현재 페이지)' : ''}</small>
              </span>
              {page === it.id && <span className="check">✓</span>}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}

// Top Bar 병원선택 메뉴: 병원(=floor plan) 전환.
// floorplans/*.json 파일을 추가하면 자동으로 하위 메뉴에 나타난다.
// 병원을 전환하면 에뮬레이터가 그 병원의 DB(SQLite) 명단을 로드한다 (재생성 없음).
// 이전 병원 채널은 일시 중단(suspend)될 뿐 DB 는 그대로 보존된다.
function HospitalMenu({ hospitalId, onSelect }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div className="menubar-item" ref={ref}>
      <button className={'menu-btn' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
        병원선택 {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="menu-dropdown" style={{ width: 280 }}>
          {hospitals.map((h) => (
            <button
              key={h.id}
              className={'pm-item' + (h.id === hospitalId ? ' active' : '')}
              onClick={() => { setOpen(false); onSelect(h) }}
            >
              <span className="pm-item-text">
                {h.name}
                <small>Floor Plan · {h.buildings.join('/')}동 · 층당 병실 {h.plans.default.spaces.filter((s) => s.type === 'room' && s.gw).length}개</small>
              </span>
              {h.id === hospitalId && <span className="check">✓</span>}
            </button>
          ))}
          <div className="pm-hint">floorplans/ 폴더에 JSON을 추가하면 자동 등록됩니다</div>
        </div>
      )}
    </div>
  )
}

// 입력 소스 패널 (테스트 메뉴 상단): 원격 게이트웨이(IP 2개) / 로컬 에뮬레이터 선택
function SourcePanel({ ingestSrc, localEmu, busy, onSwitch }) {
  const localRunning = !!(localEmu && localEmu.running)
  const allow = ingestSrc?.allow ?? null // null = 전체 허용
  const srcMap = {}
  for (const s of ingestSrc?.sources || []) srcMap[s.ip] = s.connections
  // 원격 IP 허용 여부: allow 가 null 이면 전부 허용된 상태
  const ipAllowed = (ip) => allow == null || allow.includes(ip)
  const mode = localRunning ? 'local' : 'remote'

  const toggleIp = (ip) => {
    const cur = REMOTE_EMU_HOSTS.filter(ipAllowed)
    const next = cur.includes(ip) ? cur.filter((x) => x !== ip) : [...cur, ip]
    onSwitch('remote', next)
  }

  return (
    <>
      <div className="pm-title">입력 소스</div>
      <button
        className="pm-item"
        disabled={busy || mode === 'remote'}
        onClick={() => onSwitch('remote', REMOTE_EMU_HOSTS)}
      >
        <span className="pm-item-text">
          {mode === 'remote' ? '◉' : '○'} 원격 게이트웨이 (라즈베리파이)
        </span>
      </button>
      {mode === 'remote' && REMOTE_EMU_HOSTS.map((ip) => {
        const conns = srcMap[ip] || 0
        const label = REMOTE_EMU_LABELS[ip]
        return (
          <button key={ip} className="pm-item" disabled={busy} onClick={() => toggleIp(ip)}>
            <span className="pm-item-text">
              {'  '}{ipAllowed(ip) ? '☑' : '☐'} {label ? label + ' ' : ''}{ip}
              <small>{conns > 0 ? ` ${conns}회선 수신 중` : ' 무신호'}</small>
            </span>
          </button>
        )
      })}
      <button
        className="pm-item"
        disabled={busy || mode === 'local'}
        onClick={() => onSwitch('local')}
      >
        <span className="pm-item-text">
          {mode === 'local' ? '◉' : '○'} 로컬 에뮬레이터 (이 서버에서 생성)
          <small>{localRunning ? ` 실행 중 (pid ${localEmu.pid})` : ' 중지됨 — 선택 시 기동'}</small>
        </span>
      </button>
      <div className="pm-sep" />
    </>
  )
}

// Top Bar 테스트 드롭다운 메뉴: 채널 에뮬레이터 제어
function TestMenu({ emu, busy, onAction, onScenario, ingestSrc, localEmu, onSwitchSource }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const run = (action, count) => {
    setOpen(false)
    onAction(action, count)
  }

  return (
    <div className="menubar-item" ref={ref}>
      <button className={'menu-btn' + (open ? ' open' : '')} onClick={() => setOpen(!open)}>
        테스트 {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="menu-dropdown">
          <SourcePanel
            ingestSrc={ingestSrc}
            localEmu={localEmu}
            busy={busy}
            onSwitch={onSwitchSource}
          />
          <div className="pm-title">
            채널 에뮬레이터 {emu ? `— ${emu.count}채널 실행 중` : '— 연결 안 됨'}
          </div>
          <button className="pm-item" disabled={!emu || busy} onClick={() => run('add', 20)}>
            <span className="pm-item-text">＋ 채널 20개 생성</span>
          </button>
          <button className="pm-item" disabled={!emu || busy} onClick={() => run('add', 100)}>
            <span className="pm-item-text">＋ 채널 100개 생성</span>
          </button>
          <button
            className="pm-item"
            disabled={!emu || busy || (emu && emu.count === 0)}
            onClick={() => run('remove', 20)}
          >
            <span className="pm-item-text">− 앞 채널 20개 삭제</span>
          </button>
          <div className="pm-sep" />
          <div className="pm-title">시나리오 (건수 1~10 랜덤)</div>
          {[
            ['replace', '패치 교체 (랜덤)'],
            ['transfer', '트랜스퍼 (랜덤)'],
            ['discharge', '퇴원 (랜덤)'],
            ['admit', '신규입원 (랜덤)'],
          ].map(([k, label]) => (
            <button
              key={k}
              className="pm-item"
              disabled={!emu || busy}
              onClick={() => { setOpen(false); onScenario(k) }}
            >
              <span className="pm-item-text">{label}</span>
            </button>
          ))}
          <div className="pm-sep" />
          {[200, 500, 1000, 2000].map((n) => (
            <button
              key={n}
              className="pm-item"
              disabled={!emu || busy}
              onClick={() => run('reset', n)}
            >
              <span className="pm-item-text">⟳ 초기화 ({n}개)</span>
            </button>
          ))}
          <div className="pm-sep" />
          <button
            className="pm-item"
            disabled={!emu || busy}
            onClick={() => { setOpen(false); onScenario('dbreset') }}
          >
            <span className="pm-item-text">
              🗄 DB 리셋
              <small>병원별 DB 개별 재생성 · 각 200채널 · 재고 시드</small>
            </span>
          </button>
          <button
            className="pm-item"
            disabled={busy}
            onClick={() => { setOpen(false); onScenario('wavereset') }}
          >
            <span className="pm-item-text">
              🗑 파형 저장소 리셋
              <small>라우터의 저장 파형 파일(waves/) 전체 삭제</small>
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

export default function App() {
  const [health, setHealth] = useState(null)
  const [channels, setChannels] = useState([])
  const [groups, setGroups] = useState([])
  const [editing, setEditing] = useState(null) // null | 'new' | group object
  const [error, setError] = useState('')
  const [filterGroup, setFilterGroup] = useState('')
  const [emu, setEmu] = useState(null) // 에뮬레이터 상태 {count}
  const [emuBusy, setEmuBusy] = useState(false)
  // 입력 소스: 라우터 ingest 소스 현황 {allow, sources[]} + 로컬 에뮬레이터 {running}
  const [ingestSrc, setIngestSrc] = useState(null)
  const [localEmu, setLocalEmu] = useState(null)
  const [transferCh, setTransferCh] = useState(null) // 트랜스퍼 모달 대상 채널
  const [waveModal, setWaveModal] = useState(null) // 파형 모달 {type: patient|gateway|cohort, ...}
  const [notice, setNotice] = useState('')
  const [gwDown, setGwDown] = useState([]) // 장애 중인 게이트웨이 ID 목록
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState('channel_id')
  const [sortDir, setSortDir] = useState(1) // 1: 오름차순, -1: 내림차순
  const [gSortKey, setGSortKey] = useState('id') // 그룹 리스트 정렬
  const [gSortDir, setGSortDir] = useState(1)
  const [showFilters, setShowFilters] = useState(false)
  const [colFilters, setColFilters] = useState({}) // 컬럼 키 -> 선택된 값 배열
  const [stats, setStats] = useState(null)
  const [rates, setRates] = useState({ bps: 0, txBps: 0, pps: 0 })
  const prevStats = useRef(null)
  const [events, setEvents] = useState([])
  const [eventsOpen, setEventsOpen] = useState(false) // 기본값: 접힘
  const [groupsOpen, setGroupsOpen] = useState(true)
  const [channelsOpen, setChannelsOpen] = useState(true)

  // 병원 선택 (에뮬레이터와 동기화 — 전환 시 그 병원 DB 명단을 로드)
  const [hospitalId, setHospitalId] = useState(hospitals[0]?.id)
  useEffect(() => {
    fetch(`${EMU_API}/hospital`)
      .then((r) => r.json())
      .then((j) => { if (j.id) setHospitalId(j.id) })
      .catch(() => {})
  }, [])

  const selectHospital = async (h) => {
    if (h.id === hospitalId) return
    try {
      const res = await fetch(`${EMU_API}/hospital?id=${encodeURIComponent(h.id)}`, { method: 'POST' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json().catch(() => ({}))
      setHospitalId(h.id)
      window.location.hash = '#/patch-map'
      setNotice(j.source === 'db'
        ? `${h.name}(으)로 전환됨 — DB 명단 ${j.count}채널 로드 (재생성 없음)`
        : `${h.name}(으)로 전환됨 — DB 비어있음: ${j.count ?? ''}채널 신규 생성`)
      setTimeout(() => setNotice(''), 5000)
      // 이전 병원의 일시 중단 채널 잔재를 레지스트리에서 정리
      fetch(`${API}/api/channels/prune`, { method: 'POST' }).catch(() => {})
      refresh()
    } catch (e) {
      setError(`병원 전환 실패: ${e.message} — 에뮬레이터(:7500) 상태를 확인하세요`)
    }
  }

  // 벌크 시나리오 실행 (건수는 1~10 랜덤)
  const runScenario = async (kind) => {
    if (kind === 'dbreset'
      && !confirm('DB 리셋: 병원별 SQLite DB(hospital-<id>.db)를 새로 생성하고\n각 병원 200채널 데이터 + 패치 재고(병원별 고유 번호)로 초기화합니다.\n현재 병원의 라이브 채널도 DB 명단 기준으로 재생성됩니다.')) return
    if (kind === 'wavereset') {
      if (!confirm('파형 저장소 리셋: 라우터에 저장된 채널별 파형 파일(waves/)을 전부 삭제합니다.\n리포트의 과거 파형 조회 구간이 사라지며 되돌릴 수 없습니다.\n삭제 후 유입되는 파형부터 새로 저장됩니다.')) return
      setEmuBusy(true)
      setError('')
      try {
        const r = await fetch(`${API}/api/wave/reset`, { method: 'POST' })
        if (!r.ok) throw new Error(`${r.status}`)
        setNotice('파형 저장소 리셋 완료 — 이후 유입 파형부터 새로 저장됩니다')
        refresh()
      } catch (e) {
        setError(`파형 저장소 리셋 실패: ${e.message}`)
      } finally {
        setEmuBusy(false)
      }
      return
    }
    const n = 1 + Math.floor(Math.random() * 10)
    const pickRandom = (arr, k) => {
      const a = [...arr]
      const out = []
      while (out.length < k && a.length) {
        out.push(a.splice(Math.floor(Math.random() * a.length), 1)[0])
      }
      return out
    }
    const nameOf = (c) => `${c.patient?.name || c.channel_id}`
    setEmuBusy(true)
    setError('')
    try {
      if (kind === 'admit') {
        // 신규입원: 새 채널 n개 생성 (빈 병상에 자동 배치)
        await fetch(`${EMU_API}/channels/add?count=${n}`, { method: 'POST' })
        setNotice(`시나리오: 신규입원 ${n}명`)
      } else if (kind === 'discharge') {
        // 퇴원: 활성 채널 중 무작위 n명 종료
        const targets = pickRandom(channels.filter((c) => c.connected), n)
        for (const c of targets) {
          await fetch(`${EMU_API}/channel/discharge?id=${encodeURIComponent(c.channel_id)}`, { method: 'POST' })
        }
        setNotice(`시나리오: 퇴원 ${targets.length}명 — ${targets.slice(0, 5).map(nameOf).join(', ')}${targets.length > 5 ? ' 외' : ''}`)
      } else if (kind === 'replace') {
        // 패치 교체: 무작위 n명, SQLite 재고(in_stock) 우선 사용
        let stock = []
        try {
          const j = await (await fetch(`${DB_API}/patches?status=in_stock`)).json()
          stock = (j.patches || []).map((x) => x.patch_id)
        } catch { /* DB 미기동 시 자동 발급 */ }
        const targets = pickRandom(channels.filter((c) => c.connected), n)
        let i = 0
        for (const c of targets) {
          const nu = stock[i++]
          await fetch(
            `${EMU_API}/channel/replace?id=${encodeURIComponent(c.channel_id)}${nu ? `&new=${encodeURIComponent(nu)}` : ''}`,
            { method: 'POST' },
          )
        }
        setNotice(`시나리오: 패치 교체 ${targets.length}개 (재고 사용 ${Math.min(targets.length, stock.length)}개)`)
      } else if (kind === 'transfer') {
        // 트랜스퍼: 무작위 n명을 잔여 병상이 있는 병실로 이동.
        // 간호사는 구역 담당제로 에뮬레이터가 자동 재배정, 30% 는 주치의도 변경
        const rooms = computeAvailableRooms(hospital, channels)
        const doctors = [...new Set(channels.map((c) => c.patient?.doctor).filter(Boolean))]
        const targets = pickRandom(channels.filter((c) => c.connected && c.patient), n)
        let moved = 0
        for (const c of targets) {
          const cand = rooms.filter((r) => r.free > 0 && r.room !== c.patient.room)
          if (!cand.length) break
          const r = cand[Math.floor(Math.random() * cand.length)]
          r.free -= 1
          const body = {
            building: r.b, floor: String(r.f), ward: r.ward, zone: r.zone, room: r.room,
          }
          if (doctors.length > 1 && Math.random() < 0.3) {
            const others = doctors.filter((d) => d !== c.patient.doctor)
            body.doctor = others[Math.floor(Math.random() * others.length)]
          }
          await fetch(`${EMU_API}/channel/patient?id=${encodeURIComponent(c.channel_id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          moved += 1
        }
        setNotice(`시나리오: 트랜스퍼 ${moved}명 — 병동/병실 이동 · 간호사 자동 재배정 · 일부 주치의 변경`)
      } else if (kind === 'dbreset') {
        // 병원별 DB 개별 재생성 (각 200채널 + 병원별 고유 재고) → 라이브 채널 DB 기준 재생성
        const r = await fetch(`${DB_API}/db/reset`, { method: 'POST' })
        if (!r.ok) throw new Error(`DB API ${r.status}`)
        const j = await r.json()
        await fetch(`${EMU_API}/channels/reload`, { method: 'POST' })
        // 이전 잔재(비정상 종료로 남은 해제 채널)를 레지스트리에서 정리
        await fetch(`${API}/api/channels/prune`, { method: 'POST' }).catch(() => {})
        await fetch(`${API}/api/stats/reset`, { method: 'POST' }).catch(() => {})
        const g = await seedDefaultGroups().catch(() => 0)
        setNotice(`DB 리셋 완료: ${Object.values(j.reset)
          .map((v) => `${v.name} ${v.patients}명·재고 ${v.stock}`)
          .join(' / ')}${g ? ` · 기본 그룹 ${g}개 생성` : ''}`)
      }
      setTimeout(() => setNotice(''), 6000)
      refresh()
    } catch (e) {
      setError(`시나리오 실패: ${e.message}`)
    } finally {
      setEmuBusy(false)
    }
  }

  // 해시 라우팅: #/ (콘솔) | #/patch-map (패치 맵) | #/patches (패치 관리)
  // ?view=moves 같은 쿼리 파라미터를 허용하므로 접두사 매칭
  const pageOf = () =>
    window.location.hash.startsWith('#/patch-map') ? 'map'
      : window.location.hash.startsWith('#/patches') ? 'patches'
      : window.location.hash.startsWith('#/timelog') ? 'timelog'
      : window.location.hash.startsWith('#/appointments') ? 'appts'
      : 'console'
  const [page, setPage] = useState(pageOf())
  useEffect(() => {
    const onHash = () => setPage(pageOf())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 화면 템플릿: 색상뿐 아니라 레이아웃(통계 표시, 이벤트 위치)까지 제어
  const [tplId, setTplId] = useState(savedTemplateId())
  useEffect(() => {
    applyTemplate(tplId)
  }, [tplId])
  const layout = {
    showStats: true,
    showEvents: true,
    eventsPosition: 'top', // 'top' | 'afterChannels'
    ...(templates.find((t) => t.id === tplId)?.layout || {}),
  }

  const refresh = () => {
    fetch(`${API}/api/health`).then((r) => r.json()).then(setHealth).catch(() => setHealth(null))
    fetch(`${API}/api/channels`).then((r) => r.json()).then(setChannels).catch(() => {})
    fetch(`${API}/api/groups`).then((r) => r.json()).then(setGroups).catch(() => {})
    fetch(`${EMU_API}/status`).then((r) => r.json()).then(setEmu).catch(() => setEmu(null))
    // 입력 소스 현황 (라우터 소스별 회선 수 + 허용목록, 로컬 에뮬레이터 실행 여부)
    fetch(`${API}/api/ingest/sources`).then((r) => r.json()).then(setIngestSrc).catch(() => setIngestSrc(null))
    fetch(`${DB_API}/emulator/local`).then((r) => r.json()).then(setLocalEmu).catch(() => setLocalEmu(null))
    // 게이트웨이 상태: 에뮬레이터가 데이터 경로로 push → 라우터 /api/gateways 에서 조회
    fetch(`${API}/api/gateways`).then((r) => r.json()).then((j) => setGwDown(j.down || [])).catch(() => setGwDown([]))
    fetch(`${API}/api/stats`)
      .then((r) => r.json())
      .then((s) => {
        // 이전 표본과의 차분으로 실시간 속도 계산
        const now = Date.now()
        const prev = prevStats.current
        if (prev && now > prev.t) {
          const dt = (now - prev.t) / 1000
          setRates({
            bps: Math.max(0, (s.total_bytes - prev.total_bytes) / dt),
            txBps: Math.max(0, (s.total_tx_bytes - prev.total_tx_bytes) / dt),
            pps: Math.max(0, (s.total_packets - prev.total_packets) / dt),
          })
        }
        prevStats.current = { ...s, t: now }
        setStats(s)
      })
      .catch(() => setStats(null))
    fetch(`${API}/api/events`).then((r) => r.json()).then(setEvents).catch(() => {})
  }

  const emuChannels = async (action, count) => {
    if (action === 'reset' && !confirm(`모든 채널을 종료하고 ${count}개를 새로 생성할까요?`)) return
    setEmuBusy(true)
    setError('')
    try {
      const res = await fetch(`${EMU_API}/channels/${action}?count=${count}`, { method: 'POST' })
      if (!res.ok) throw new Error(`${res.status}`)
      await res.json()
      if (action === 'reset') {
        // 채널 초기화 시 라우터의 수신/송신 데이터 카운터도 함께 리셋
        await fetch(`${API}/api/stats/reset`, { method: 'POST' }).catch(() => {})
        prevStats.current = null // 속도 계산 기준점도 초기화
      }
      refresh()
    } catch (e) {
      setError(`에뮬레이터 제어 실패 (${e.message}) — 에뮬레이터(:7500)가 실행 중인지 확인하세요`)
    } finally {
      setEmuBusy(false)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [])

  // 입력 소스 전환: 'local' = 로컬 에뮬레이터 기동 + 외부 차단,
  // 'remote' = 로컬 중지 + 선택한 원격 IP 만 허용 (ips: 허용할 원격 IP 배열)
  const switchSource = async (mode, ips) => {
    setEmuBusy(true)
    setError('')
    try {
      if (mode === 'local') {
        await fetch(`${API}/api/ingest/allow`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ips: [] }), // 외부 차단 (루프백은 항상 허용)
        })
        const r = await fetch(`${DB_API}/emulator/start?channels=32`, { method: 'POST' })
        if (!r.ok) throw new Error(`emulator/start ${r.status}`)
      } else {
        await fetch(`${DB_API}/emulator/stop`, { method: 'POST' }).catch(() => {})
        const r = await fetch(`${API}/api/ingest/allow`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ips }),
        })
        if (!r.ok) throw new Error(`ingest/allow ${r.status}`)
      }
      // 이전 소스의 잔재(해제 채널) 정리 + 제어 API 재프로브
      setTimeout(async () => {
        await fetch(`${API}/api/channels/prune`, { method: 'POST' }).catch(() => {})
        await reprobeEmu()
        refresh()
      }, 1500)
      refresh()
    } catch (e) {
      setError(`입력 소스 전환 실패: ${e.message}`)
    } finally {
      setEmuBusy(false)
    }
  }

  const saveGroup = async (cfg) => {
    setError('')
    const isNew = editing === 'new'
    const res = await fetch(
      isNew ? `${API}/api/groups` : `${API}/api/groups/${encodeURIComponent(cfg.id)}`,
      {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      },
    )
    if (!res.ok) {
      setError(`저장 실패: ${res.status} ${await res.text()}`)
      return
    }
    setEditing(null)
    refresh()
  }

  const deleteGroup = async (id) => {
    if (!confirm(`그룹 "${id}" 를 삭제할까요?`)) return
    await fetch(`${API}/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' })
    setEditing(null)
    refresh()
  }

  // 필터 컬럼 정의: 테이블 헤더 셀 별 중복 체크 드롭다운
  const FILTER_COLS = [
    { key: 'status', label: '상태' },
    { key: 'name', label: '환자' },
    { key: 'location', label: '위치' },
    { key: 'doctor', label: '주치의' },
    { key: 'department', label: '진료과' },
    { key: 'nurse', label: '간호사' },
    { key: 'groups', label: '소속 그룹' },
  ]

  // 필터/표시용 셀 값
  const cellVal = (c, key) => {
    const p = c.patient || {}
    switch (key) {
      case 'status':
        return !c.connected ? '해제'
          : c.stale ? '수신중단'
          : c.quality === 'weak' ? '약신호' : '정상'
      case 'name': return p.name || '(메타 없음)'
      case 'location':
        return `${p.building || '?'}동 ${p.floor || '?'}층 ${p.ward || '?'}/${p.zone || '?'} ${p.room || '?'}호`
      case 'doctor': return p.doctor || '(메타 없음)'
      case 'department': return p.department || '(메타 없음)'
      case 'nurse': return p.nurse || '(메타 없음)'
      default: return ''
    }
  }

  // 컬럼별 고유 값 목록 (전체 채널 기준이라 필터를 골라도 선택지가 유지됨)
  const colOptions = (key) => {
    const set = new Set()
    for (const c of channels) {
      if (key === 'groups') c.groups.forEach((g) => set.add(g))
      else if (key === 'status') { set.add(cellVal(c, key)); if (c.moving) set.add('이동 중') }
      else set.add(cellVal(c, key))
    }
    return [...set].sort((a, b) => String(a).localeCompare(String(b), 'ko'))
  }

  const toggleFilterVal = (key, val) => {
    setColFilters((prev) => {
      const cur = prev[key] || []
      const next = cur.includes(val) ? cur.filter((v) => v !== val) : [...cur, val]
      return { ...prev, [key]: next }
    })
  }

  const activeFilterCount = Object.values(colFilters).reduce((n, arr) => n + arr.length, 0)

  const passesColFilters = (c) => {
    for (const [key, sel] of Object.entries(colFilters)) {
      if (!sel.length) continue
      if (key === 'groups') {
        if (!c.groups.some((g) => sel.includes(g))) return false
      } else if (key === 'status') {
        // 같은 컬럼 내 다중 선택은 OR ('이동 중'은 상태와 독립 플래그)
        const ok = sel.some((s) => (s === '이동 중' ? c.moving : cellVal(c, 'status') === s))
        if (!ok) return false
      } else if (!sel.includes(cellVal(c, key))) {
        return false
      }
    }
    return true
  }

  // 정렬용 값 추출기 (컬럼 키 → 비교 값)
  const sortVal = (c, key) => {
    const p = c.patient || {}
    switch (key) {
      case 'channel_id': return c.channel_id
      case 'status': {
        // 심각도 순: 정상(0) < 이동(1) < 약신호(2) < 수신중단(3) < 해제(4)
        if (!c.connected) return 4
        if (c.stale) return 3
        if (c.quality === 'weak') return 2
        if (c.moving) return 1
        return 0
      }
      case 'name': return p.name || ''
      case 'location':
        return `${p.building || ''}-${p.floor || ''}-${p.ward || ''}-${p.zone || ''}-${p.room || ''}`
      case 'gateway': return c.gateway_id || ''
      case 'doctor': return p.doctor || ''
      case 'department': return p.department || ''
      case 'nurse': return p.nurse || ''
      case 'last_seq': return c.last_seq
      case 'groups': return c.groups.join(',')
      default: return c.channel_id
    }
  }

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(-sortDir)
    else { setSortKey(key); setSortDir(1) }
  }

  const q = search.trim().toLowerCase()
  const shown = channels
    .filter((c) => !filterGroup || c.groups.includes(filterGroup))
    .filter(passesColFilters)
    .filter((c) => {
      if (!q) return true
      const p = c.patient || {}
      return (p.name || '').toLowerCase().includes(q)
        || c.channel_id.toLowerCase().includes(q)
        || (p.id || '').toLowerCase().includes(q)
    })
    .sort((a, b) => {
      const va = sortVal(a, sortKey)
      const vb = sortVal(b, sortKey)
      let cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'ko')
      cmp *= sortDir
      // 동순위는 항상 채널 ID 오름차순으로 고정 (방향 토글 시에도 안정적)
      if (cmp === 0) cmp = a.channel_id.localeCompare(b.channel_id)
      return cmp
    })

  const Th = ({ k, children }) => (
    <th className="sortable" onClick={() => toggleSort(k)}>
      {children}
      <span className="arrow">{sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )

  // 그룹 리스트 정렬 (채널 테이블과 동일한 양방향 토글, 'all' 은 항상 맨 위 고정)
  const gSortVal = (g, key) => {
    switch (key) {
      case 'name': return g.name
      case 'id': return g.id
      case 'owner': return g.owner || ''
      case 'member_count': return g.member_count
      case 'description': return g.description || ''
      default: return g.id
    }
  }
  const toggleGSort = (key) => {
    if (gSortKey === key) setGSortDir(-gSortDir)
    else { setGSortKey(key); setGSortDir(1) }
  }
  const sortedGroups = [...groups].sort((a, b) => {
    // 기본 그룹 '전체 채널'은 정렬 방향과 무관하게 붙박이 최상단
    const pin = (a.id !== 'all') - (b.id !== 'all')
    if (pin !== 0) return pin
    const va = gSortVal(a, gSortKey)
    const vb = gSortVal(b, gSortKey)
    let cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb), 'ko')
    cmp *= gSortDir
    if (cmp === 0) cmp = a.id.localeCompare(b.id) // 동순위는 그룹 ID 로 고정
    return cmp
  })
  const GTh = ({ k, className = '', children }) => (
    <th className={('sortable ' + className).trim()} onClick={() => toggleGSort(k)}>
      {children}
      <span className="arrow">{gSortKey === k ? (gSortDir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )

  // 게이트웨이 현황: 정상동작 수 / 전체 배치 수.
  // 병상이 저층부터 충전되므로 '사용 중인 층'만큼만 게이트웨이가 배치된 것으로 계산
  const hospital = hospitalById(hospitalId)
  const usedWardFloors = new Set(
    channels.map((c) => Number(c.patient?.floor)).filter((f) => f && f !== 1),
  )
  const gwPerWard = hospital ? hospital.plans.default.spaces.filter((s) => s.gw).length : 0
  const gwFloor1 = hospital?.plans['1']
    ? hospital.plans['1'].spaces.filter((s) => s.gw).length
    : 0
  const GW_TOTAL = hospital
    ? hospital.buildings.length * (usedWardFloors.size * gwPerWard + gwFloor1)
    : 0
  const gwHealthy = Math.max(0, GW_TOTAL - gwDown.length)

  // 실시간 이벤트 섹션 — 템플릿 레이아웃에 따라 표시 여부/위치가 달라진다
  const eventsSection = layout.showEvents && (
    <section>
      <div className="section-head">
        <h2
          className="collapsible"
          onClick={() => setEventsOpen(!eventsOpen)}
        >
          {eventsOpen ? '▾' : '▸'} 실시간 이벤트 (총 {events.length}건{eventsOpen ? '' : ' — 최근 3건 표시, 클릭하여 펼치기'})
        </h2>
      </div>
      <div className={'event-log' + (eventsOpen ? ' open' : '')}>
        {events.slice(0, eventsOpen ? 100 : 3).map((e, i) => (
          <div key={`${e.ts_ms}-${i}`} className={'log-line ' + e.kind}>
            <span className="log-time">
              {new Date(e.ts_ms).toLocaleTimeString('ko-KR', { hour12: false })}
            </span>
            <span className={'log-kind ' + e.kind}>{e.kind}</span>
            <span className="log-msg">{e.message}</span>
          </div>
        ))}
        {events.length === 0 && (
          <div className="log-line empty-log">아직 이벤트가 없습니다 (분석 지연/다운 발생 시 표시)</div>
        )}
      </div>
    </section>
  )

  return (
    <div className="app">
      <header>
        {/* 얇은 메뉴 바 */}
        <div className="topbar">
          <a className="topbar-brand" href="/" title="ECG Channel Router Console 홈">
            <svg className="pulse" viewBox="0 0 48 24" width="22" height="11" aria-hidden="true">
              <polyline
                points="0,12 12,12 16,5 22,20 27,3 31,12 48,12"
                fill="none" stroke="currentColor" strokeWidth="3"
                strokeLinejoin="round" strokeLinecap="round"
              />
            </svg>
            <span className="topbar-name">ECG Channel Router Console</span>
          </a>
          <HospitalMenu hospitalId={hospitalId} onSelect={selectHospital} />
          <ControlMenu page={page} />
          <TestMenu
            emu={emu}
            busy={emuBusy}
            onAction={emuChannels}
            onScenario={runScenario}
            ingestSrc={ingestSrc}
            localEmu={localEmu}
            onSwitchSource={switchSource}
          />
          <div className="spacer" />
          <span className={'pill ' + (health ? 'ok' : 'bad')}>
            라우터 {health ? '정상' : '연결 안 됨'}
          </span>
          <span className={'pill ' + (health?.analysis_connected ? 'ok' : 'warn')}>
            분석 서버 {health?.analysis_connected ? '연결됨' : '패스스루'}
          </span>
          <span className="pill">{channels.length} 채널</span>
          <TopBarProfile
            tplId={tplId}
            onSelect={(id) => { saveTemplateId(id); setTplId(id) }}
          />
        </div>
      </header>

      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {page === 'map' && hospital && (
        <PatchMapPage channels={channels} gwDown={gwDown} groups={groups} hospital={hospital} />
      )}

      {page === 'patches' && <PatchListPage />}

      {page === 'timelog' && <TimeLogPage />}

      {page === 'appts' && <AppointmentsPage />}

      {page === 'console' && <>
      {layout.showStats && stats && (
        <div className="stats-bar">
          {/* 시스템 리소스: 메모리/CPU/스토리지 통합 카드 (바 그래프 + 수치) */}
          <div className="stat wide">
            <span className="stat-label">시스템 리소스</span>
            {(() => {
              const cpu = stats.cpu_percent
              const memPct = stats.mem_sys_total_bytes
                ? (stats.mem_sys_used_bytes / stats.mem_sys_total_bytes) * 100 : 0
              const diskUsedPct = stats.disk_total_bytes
                ? ((stats.disk_total_bytes - stats.disk_free_bytes) / stats.disk_total_bytes) * 100 : 0
              const diskFreePct = 100 - diskUsedPct
              return (
                <>
                  {/* 경고(빨강) 기준: CPU ≥70% · 메모리 ≥70% · 스토리지 여유 ≤20% */}
                  <ResourceRow label="CPU" pct={cpu} alert={cpu >= 70}
                    text={`${Math.round(cpu)}%`} />
                  <ResourceRow label="메모리" pct={memPct} alert={memPct >= 70}
                    text={`${Math.round(memPct)}% · ${toGB(stats.mem_sys_used_bytes)}/${toGB(stats.mem_sys_total_bytes)} GB`} />
                  <ResourceRow label="스토리지" pct={diskUsedPct} alert={diskFreePct <= 20}
                    text={`${Math.round(diskUsedPct)}% · 여유 ${toGB(stats.disk_free_bytes)} GB`} />
                </>
              )
            })()}
            <span className="stat-sub">라우터 프로세스 {fmtBytes(stats.mem_process_bytes)}</span>
          </div>
          {/* 데이터 I/O: 수신/송신 통합 (1칸 카드) */}
          <div className="stat">
            <span className="stat-label">데이터 I/O</span>
            <div className="res-row io">
              <span className="res-label">↓ 수신</span>
              <span className="io-total">{fmtBytes(stats.total_bytes)}</span>
              <span className="res-val">{(rates.bps / 1048576).toFixed(1)} MB/s</span>
            </div>
            <div className="res-row io">
              <span className="res-label">↑ 송신</span>
              <span className="io-total">{fmtBytes(stats.total_tx_bytes)}</span>
              <span className="res-val">{(rates.txBps / 1048576).toFixed(1)} MB/s</span>
            </div>
            <div className="res-row io">
              {/* 라벨 칼럼이 42px 고정이라 짧게 (수신/송신과 동일 폭) */}
              <span className="res-label" title="라우터에 저장된 파형 파일 전체 용량 (waves/)">◼ 저장</span>
              <span className="io-total">{fmtBytes(stats.wave_store_bytes || 0)}</span>
              <span className="res-val">파형 파일</span>
            </div>
          </div>
          <div className="stat">
            <span className="stat-label">
              ECG 패킷
              <button
                className="icon-btn"
                title="패킷/유실 카운터 리셋"
                style={{ marginLeft: 6 }}
                onClick={async () => {
                  await fetch(`${API}/api/stats/reset`, { method: 'POST' }).catch(() => {})
                  prevStats.current = null // 속도 계산 기준점도 초기화
                  refresh()
                }}
              >
                ⟲
              </button>
            </span>
            <span className="stat-value">{stats.total_packets.toLocaleString()}</span>
            <span className="stat-sub">{Math.round(rates.pps).toLocaleString()} pkt/s</span>
            <span className="stat-sub">
              <span className={stats.total_lost_packets > 0 ? 'loss' : ''}>
                유실 {stats.total_lost_packets.toLocaleString()}
                {stats.total_packets > 0
                  ? ` (${((stats.total_lost_packets / (stats.total_packets + stats.total_lost_packets)) * 100).toFixed(2)}%)`
                  : ''}
              </span>
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">게이트웨이</span>
            <span className="stat-value">
              {gwHealthy} <small className="of-total">/ {GW_TOTAL}</small>
            </span>
            <span className="patch-counts">
              <span title="정상 동작"><i className="gw-dot up" />{gwHealthy}</span>
              <span title="장애"><i className="gw-dot down" />{gwDown.length}</span>
            </span>
          </div>
          <div className="stat">
            <span className="stat-label">패치</span>
            <span className="stat-value">
              {stats.ingest_connections} <small className="of-total">/ {stats.channel_count}</small>
            </span>
            {(() => {
              const sc = { ok: 0, move: 0, weak: 0, stall: 0, off: 0 }
              channels.forEach((c) => {
                const s = !c.connected ? 'off' : c.stale ? 'stall'
                  : c.quality === 'weak' ? 'weak' : c.moving ? 'move' : 'ok'
                sc[s]++
              })
              return (
                <span className="patch-counts">
                  <span title="정상"><i className="p-dot ok" />{sc.ok}</span>
                  <span title="이동 중"><i className="p-dot move" />{sc.move}</span>
                  <span title="약신호"><i className="p-dot weak" />{sc.weak}</span>
                  <span title="수신중단"><i className="p-dot stall" />{sc.stall}</span>
                  <span title="해제"><i className="p-dot off" />{sc.off}</span>
                </span>
              )
            })()}
          </div>
          <div className="stat">
            <span className="stat-label">가동 시간</span>
            <span className="stat-value">{fmtUptime(stats.uptime_s)}</span>
            <span className="stat-sub">
              <span className={stats.downtime_ms > 0 ? 'loss' : ''}>
                다운타임 누적 {stats.downtime_ms >= 1000
                  ? fmtUptime(Math.round(stats.downtime_ms / 1000))
                  : '0초'}
              </span>
              {' '}· 분석 링크
            </span>
          </div>
        </div>
      )}

      {layout.eventsPosition === 'top' && eventsSection}

      <section>
        <div className="section-head">
          <h2 className="collapsible" onClick={() => setGroupsOpen(!groupsOpen)}>
            {groupsOpen ? '▾' : '▸'} 그룹 ({groups.length})
          </h2>
          <button className="primary" onClick={() => setEditing('new')}>+ 새 그룹</button>
        </div>
        {groupsOpen && (
          <div className="group-scroll">
          <table className="group-table">
            <thead>
              <tr>
                <GTh k="name">그룹 이름</GTh>
                <GTh k="id">소속 그룹</GTh>
                <GTh k="owner">사용자</GTh>
                <GTh k="member_count">멤버</GTh>
                <GTh k="description" className="g-desc">설명(메모)</GTh>
                <th>조건</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortedGroups.map((g) => (
                <tr
                  key={g.id}
                  className={(g.id === 'all' ? 'pinned-row ' : '') + (filterGroup === g.id ? 'active-row' : '')}
                  onClick={() => setFilterGroup(filterGroup === g.id ? '' : g.id)}
                  title="클릭하면 아래 채널 목록을 이 그룹으로 필터링"
                >
                  <td className="g-name"><b>{g.name}</b></td>
                  <td><code>{g.id}</code></td>
                  <td>{g.owner || <span className="dim">—</span>}</td>
                  <td><span className="member">{g.member_count}</span></td>
                  <td className="g-desc">{g.description || <span className="dim">—</span>}</td>
                  <td>
                    <div className="g-criteria">
                      {Object.entries(g.criteria || {}).map(([k, v]) => (
                        <span key={k} className="chip">{k}: {v.join('|')}</span>
                      ))}
                      {g.include?.length > 0 && <span className="chip inc">+{g.include.join(',')}</span>}
                      {g.exclude?.length > 0 && <span className="chip exc">-{g.exclude.join(',')}</span>}
                      {!Object.keys(g.criteria || {}).length && !g.include?.length && (
                        <span className="chip all">전체 채널</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      title="편집"
                      onClick={(e) => { e.stopPropagation(); setEditing(g) }}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      title="뷰어로 보기 (팝업)"
                      onClick={(e) => {
                        e.stopPropagation()
                        // 그룹별 창 이름 → 같은 그룹 재클릭 시 기존 팝업 재사용
                        window.open(
                          `${VIEWER}/?group=${encodeURIComponent(g.id)}`,
                          `viewer-${g.id}`,
                          'width=1280,height=800',
                        )
                      }}
                    >
                      ⧉
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {editing && (
          <GroupEditor
            key={editing === 'new' ? 'new' : editing.id}
            group={editing === 'new' ? null : editing}
            isNew={editing === 'new'}
            channels={channels}
            onSave={saveGroup}
            onDelete={deleteGroup}
            onCancel={() => setEditing(null)}
          />
        )}
      </section>

      <section>
        <div className="section-head">
          <h2 className="collapsible" onClick={() => setChannelsOpen(!channelsOpen)}>
            {channelsOpen ? '▾' : '▸'} 채널 {filterGroup ? `— 그룹 "${filterGroup}" (${shown.length})` : `(${shown.length})`}
          </h2>
          <input
            className="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="환자 이름 / 채널 / 환자ID 검색"
          />
          {search && <button onClick={() => setSearch('')}>지우기</button>}
          <button
            className={showFilters || activeFilterCount ? 'primary' : ''}
            onClick={() => setShowFilters(!showFilters)}
          >
            필터 {activeFilterCount > 0 ? `(${activeFilterCount})` : ''} {showFilters ? '▴' : '▾'}
          </button>
          {activeFilterCount > 0 && (
            <button onClick={() => setColFilters({})}>필터 모두 해제</button>
          )}
          {filterGroup && (
            <button onClick={() => setFilterGroup('')}>그룹 필터 해제</button>
          )}
        </div>
        {channelsOpen && showFilters && (
          <div className="filter-bar">
            {FILTER_COLS.map(({ key, label }) => {
              const sel = colFilters[key] || []
              return (
                <div className="filter-col" key={key}>
                  <div className="filter-col-head">
                    {label} {sel.length > 0 && <em>({sel.length})</em>}
                    {sel.length > 0 && (
                      <button
                        className="mini"
                        onClick={() => setColFilters({ ...colFilters, [key]: [] })}
                      >
                        해제
                      </button>
                    )}
                  </div>
                  <div className="filter-list">
                    {colOptions(key).map((v) => (
                      <label key={v} className="filter-item">
                        <input
                          type="checkbox"
                          checked={sel.includes(v)}
                          onChange={() => toggleFilterVal(key, v)}
                        />
                        <span>{v}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        {channelsOpen && (
        <table className="ch-table">
          <thead>
            <tr>
              <Th k="channel_id">채널</Th>
              <Th k="status">상태</Th>
              <Th k="name">환자</Th>
              <Th k="location">위치</Th>
              <Th k="gateway">게이트웨이</Th>
              <Th k="doctor">주치의</Th>
              <Th k="department">진료과</Th>
              <Th k="nurse">간호사</Th>
              <Th k="last_seq">seq</Th>
              <Th k="groups">소속 그룹</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const p = c.patient || {}
              return (
                <tr key={c.channel_id} className={c.connected ? '' : 'off'}>
                  <td><code>{c.channel_id}</code></td>
                  <td>
                    <span
                      className={
                        'dot ' +
                        (!c.connected ? 'offd'
                          : c.stale ? 'stall'
                          : c.quality === 'weak' ? 'weak'
                          : c.moving ? 'move'
                          : 'on')
                      }
                    />
                    {!c.connected ? '해제'
                      : c.stale ? '수신중단'
                      : c.quality === 'weak' ? '약신호' : '정상'}
                    {c.moving && c.connected && !c.stale ? ' · 이동' : ''}
                  </td>
                  <td className="patient-cell">
                    <button
                      className="xfer-btn"
                      title="환자 트랜스퍼 (병실 이동 / 퇴원 / 패치 교체 / 담당 변경)"
                      onClick={() => setTransferCh(c)}
                    >
                      ⇄
                    </button>
                    <span
                      className="cell-link"
                      title="클릭: 이 환자의 실시간 파형"
                      onClick={() => setWaveModal({ type: 'patient', ch: c })}
                    >
                      {p.name}
                    </span>{' '}
                    <small>({p.id})</small>
                  </td>
                  <td>{p.building}동 {p.floor}층 {p.ward}/{p.zone} {p.room}호</td>
                  <td className="gw">
                    {c.gateway_id
                      ? (
                        <button
                          className="gw-link"
                          title={`클릭: ${c.gateway_id} 게이트웨이의 전체 파형`}
                          onClick={() => setWaveModal({ type: 'gateway', gw: c.gateway_id, label: c.space })}
                        >
                          <span className={'gw-space' + (c.space && !c.space.endsWith('호') ? ' out' : '')}>{c.space}</span>
                          <code>{c.gateway_id}</code>
                        </button>
                      )
                      : <span className="dim">—</span>}
                  </td>
                  <td>
                    <span
                      className="cell-link"
                      title={`클릭: ${p.doctor} 담당 환자 전체 파형`}
                      onClick={() => setWaveModal({ type: 'cohort', field: 'doctor', value: p.doctor, title: `주치의 ${p.doctor}` })}
                    >
                      {p.doctor}
                    </span>
                  </td>
                  <td>{p.department}</td>
                  <td>
                    <span
                      className="cell-link"
                      title={`클릭: ${p.nurse} 담당 환자 전체 파형`}
                      onClick={() => setWaveModal({ type: 'cohort', field: 'nurse', value: p.nurse, title: `담당 간호사 ${p.nurse}` })}
                    >
                      {p.nurse}
                    </span>
                  </td>
                  <td>{c.last_seq}</td>
                  <td className="groups">{c.groups.join(', ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        )}
      </section>

      {layout.eventsPosition === 'afterChannels' && eventsSection}
      </>}

      {waveModal?.type === 'patient' && (
        <PatientWaveModal ch={waveModal.ch} channels={channels} onClose={() => setWaveModal(null)} />
      )}
      {waveModal?.type === 'gateway' && (
        <GatewayWaveModal
          gw={waveModal.gw}
          label={waveModal.label || waveModal.gw}
          channels={channels}
          onClose={() => setWaveModal(null)}
        />
      )}
      {waveModal?.type === 'cohort' && (
        <CohortWaveModal
          title={waveModal.title}
          channelIds={channels
            .filter((c) => c.patient?.[waveModal.field] === waveModal.value)
            .map((c) => c.channel_id)}
          channels={channels}
          onClose={() => setWaveModal(null)}
        />
      )}

      {transferCh && (
        <TransferModal
          ch={transferCh}
          emuApi={EMU_API}
          channels={channels}
          hospital={hospital}
          onClose={() => setTransferCh(null)}
          onDone={(msg) => {
            setTransferCh(null)
            setNotice(msg)
            setTimeout(() => setNotice(''), 5000)
            refresh()
          }}
        />
      )}
    </div>
  )
}
