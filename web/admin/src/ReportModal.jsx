import React, { useEffect, useMemo, useRef, useState } from 'react'
import { API, DB_API } from './endpoints.js'

// 환자 리포트 모달 — 파형(실시간 모달의 미니 파형) 클릭 시 열린다.
// 얼굴(프로필 번호 → faces/<n>.png), 인적 사항, 병변, 치료 히스토리(예약 DB),
// 라우터가 저장한 파형(8시간 롤링)의 뷰어(개요 스트립 + 상세 창)로 구성.

const fmtClock = (ms) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
const fmtDT = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${fmtClock(ms)}`
}
const ageOf = (birth) => {
  if (!birth) return null
  const b = new Date(birth)
  const now = new Date()
  let a = now.getFullYear() - b.getFullYear()
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) a -= 1
  return a
}

// ---------- 전문 파형 분석 뷰어 (ECG 모눈/그래프 페이퍼) ----------
const PAPER = {
  bg: '#FFFDF8',        // 종이 바탕
  minor: '#F5DCD2',     // 잔눈금
  major: '#E8B7A6',     // 굵은 눈금
  trace: '#16324A',     // 파형 잉크
  band: 'rgba(22, 80, 120, 0.55)', // 장구간 min/max 밴드
  sel: 'rgba(13, 148, 136, 0.18)', // 선택 블록
  selEdge: '#0d9488',
}

// 구간 길이에 맞는 눈금 간격: 굵은 눈금 5~15개가 보이도록 선택
const gridStepOf = (durMs) => {
  for (const s of [200, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 300000, 900000, 1800000, 3600000]) {
    if (durMs / s <= 15) return s
  }
  return 7200000
}

// 모눈 배경 + 시간 정렬 세로 눈금 (재사용)
function PaperGrid({ W, H, fromMs, toMs }) {
  const dur = Math.max(toMs - fromMs, 1)
  const major = gridStepOf(dur)
  const minor = major / 5
  const xs = (t) => ((t - fromMs) / dur) * W
  const vlines = []
  for (let t = Math.ceil(fromMs / minor) * minor; t <= toMs; t += minor) {
    const isMajor = Math.round(t / minor) % 5 === 0
    vlines.push(
      <line key={'v' + t} x1={xs(t)} y1="0" x2={xs(t)} y2={H}
        stroke={isMajor ? PAPER.major : PAPER.minor} strokeWidth={isMajor ? 1.1 : 0.6} />)
  }
  const hlines = []
  for (let y = 10, i = 1; y < H; y += 10, i++) {
    hlines.push(
      <line key={'h' + y} x1="0" y1={y} x2={W} y2={y}
        stroke={i % 5 === 0 ? PAPER.major : PAPER.minor} strokeWidth={i % 5 === 0 ? 1.1 : 0.6} />)
  }
  return (
    <g>
      <rect x="0" y="0" width={W} height={H} fill={PAPER.bg} />
      {vlines}
      {hlines}
    </g>
  )
}

// 개요 스트립 (전체 저장 구간): 클릭 → 15초 상세, 드래그 블록 → 구간 전체 상세
function EcgOverview({ buckets, fromMs, toMs, sel, onSelect }) {
  const W = 760, H = 72
  const drag = useRef(null)
  const dur = Math.max(toMs - fromMs, 1)
  const xs = (t) => ((t - fromMs) / dur) * W
  const tOf = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return fromMs + ((e.clientX - r.left) / r.width) * dur
  }
  const [tempSel, setTempSel] = useState(null)

  const lo = buckets.length ? Math.min(...buckets.map((b) => b[1])) : 0
  const hi = buckets.length ? Math.max(...buckets.map((b) => b[2])) : 1
  const span = Math.max(hi - lo, 0.1)
  const ys = (v) => H - 8 - ((v - lo) / span) * (H - 22)

  const down = (e) => {
    drag.current = tOf(e)
    setTempSel(null)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e) => {
    if (drag.current == null) return
    const t = tOf(e)
    if (Math.abs(xs(t) - xs(drag.current)) > 4) {
      setTempSel([Math.min(drag.current, t), Math.max(drag.current, t)])
    }
  }
  const up = (e) => {
    if (drag.current == null) return
    const t = tOf(e)
    const moved = Math.abs(xs(t) - xs(drag.current)) > 4
    if (moved) {
      onSelect(Math.min(drag.current, t), Math.max(drag.current, t)) // 블록 선택
    } else {
      onSelect(t, t + 15000) // 클릭: 해당 시점 15초
    }
    drag.current = null
    setTempSel(null)
  }

  const shown = tempSel || sel
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rp-overview paper"
      onPointerDown={down} onPointerMove={move} onPointerUp={up}>
      <PaperGrid W={W} H={H} fromMs={fromMs} toMs={toMs} />
      {buckets.map((b, i) => (
        <line key={i} x1={xs(b[0])} y1={ys(b[1])} x2={xs(b[0])} y2={ys(b[2])}
          stroke={PAPER.band} strokeWidth={Math.max(W / Math.max(buckets.length, 1) - 0.3, 0.7)} />
      ))}
      {shown && (
        <g>
          <rect x={xs(shown[0])} y="0" width={Math.max(xs(shown[1]) - xs(shown[0]), 2)} height={H}
            fill={PAPER.sel} stroke={PAPER.selEdge} strokeWidth="1.2" />
        </g>
      )}
      <text x="6" y="12" className="rp-axis">{fmtDT(fromMs)}</text>
      <text x={W - 6} y="12" textAnchor="end" className="rp-axis">{fmtDT(toMs)}</text>
    </svg>
  )
}

// 상세 파형: 모눈 위 실선 트레이스, 좌우 드래그 팬. 120초 초과 블록은 min/max 요약
function EcgDetail({ data, selStart, selEnd, onPan }) {
  const W = 760, H = 170
  const dur = Math.max(selEnd - selStart, 1)
  const xs = (t) => ((t - selStart) / dur) * W
  const panRef = useRef(null)

  // 진폭 자동 스케일 (표시 구간 기준)
  let lo = 0, hi = 1
  const segs = data?.segments || []
  const env = data?.envelope || []
  const values = segs.length ? segs.flatMap((s) => s.samples) : env.flatMap((b) => [b[1], b[2]])
  if (values.length) {
    lo = Math.min(...values)
    hi = Math.max(...values)
  }
  const span = Math.max(hi - lo, 0.2)
  const ys = (v) => H - 14 - ((v - lo) / span) * (H - 34)

  const down = (e) => {
    panRef.current = { x: e.clientX, w: e.currentTarget.getBoundingClientRect().width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e) => {
    if (!panRef.current) return
    const dx = e.clientX - panRef.current.x
    if (Math.abs(dx) < 3) return
    panRef.current.x = e.clientX
    onPan(-dx / panRef.current.w * dur) // 왼쪽 드래그 = 과거로
  }
  const up = () => { panRef.current = null }

  const grid = gridStepOf(dur)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="rp-raw paper"
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up}>
      <PaperGrid W={W} H={H} fromMs={selStart} toMs={selEnd} />
      {segs.map((s, i) => {
        const sr = s.sample_rate || 250
        const step = Math.max(1, Math.floor(s.samples.length / 4000))
        const pts = []
        for (let k = 0; k < s.samples.length; k += step) {
          pts.push(`${xs(s.t0 + (k * 1000) / sr).toFixed(1)},${ys(s.samples[k]).toFixed(1)}`)
        }
        return <polyline key={i} points={pts.join(' ')} fill="none"
          stroke={PAPER.trace} strokeWidth="1.3" strokeLinejoin="round" />
      })}
      {env.map((b, i) => (
        <line key={i} x1={xs(b[0])} y1={ys(b[1])} x2={xs(b[0])} y2={ys(b[2])}
          stroke={PAPER.band} strokeWidth={Math.max(W / Math.max(env.length, 1) - 0.3, 0.7)} />
      ))}
      {!values.length && (
        <text x={W / 2} y={H / 2} textAnchor="middle" className="rp-axis big">
          이 구간에는 저장된 파형이 없습니다 — 드래그로 이동하거나 개요에서 선택
        </text>
      )}
      {/* 시간축 라벨 */}
      <text x="6" y={H - 3} className="rp-axis">{fmtDT(selStart)}</text>
      <text x={W / 2} y={H - 3} textAnchor="middle" className="rp-axis">
        {fmtDT(selStart + dur / 2)}
      </text>
      <text x={W - 6} y={H - 3} textAnchor="end" className="rp-axis">{fmtDT(selEnd)}</text>
      <text x={W - 6} y="14" textAnchor="end" className="rp-axis">
        굵은 눈금 {grid >= 1000 ? `${grid / 1000}초` : `${grid}ms`}
        {env.length ? ' · 장구간 min/max 요약' : ''}
      </text>
    </svg>
  )
}

export default function ReportModal({ channelId, onClose }) {
  const [ch, setCh] = useState(null)
  const [appts, setAppts] = useState([])
  const [waveInfo, setWaveInfo] = useState(null)
  const [overview, setOverview] = useState(null)
  const [detail, setDetail] = useState(null)      // {segments} 또는 {envelope}
  const [sel, setSel] = useState(null)            // [start_ms, end_ms] 상세 표시 구간
  const [faceOk, setFaceOk] = useState(true)
  const fetchThrottle = useRef({ t: 0, timer: null })

  // 채널/환자 정보
  useEffect(() => {
    fetch(`${API}/api/channels`).then((r) => r.json())
      .then((list) => setCh(list.find((c) => c.channel_id === channelId) || null))
      .catch(() => {})
  }, [channelId])

  const p = ch?.patient || {}

  // 치료 히스토리 (예약 DB — 검사/진료 이력)
  useEffect(() => {
    fetch(`${DB_API}/appointments`).then((r) => r.json())
      .then((j) => setAppts((j.appointments || [])
        .filter((a) => a.channel_id === channelId)
        .slice(0, 8)))
      .catch(() => {})
  }, [channelId])

  // 상세 구간 데이터 로드: 120초 이하는 원본 샘플, 초과 블록은 min/max 요약
  const fetchDetail = (start, end) => {
    const s = Math.round(start), e = Math.round(end)
    if (e - s <= 120500) {
      fetch(`${API}/api/wave/${channelId}?mode=raw&from_ms=${s}&to_ms=${e}`)
        .then((r) => r.json())
        .then((j) => setDetail({ segments: j.segments || [] }))
        .catch(() => {})
    } else {
      fetch(`${API}/api/wave/${channelId}?mode=overview&from_ms=${s}&to_ms=${e}&buckets=760`)
        .then((r) => r.json())
        .then((j) => setDetail({ envelope: j.buckets || [] }))
        .catch(() => {})
    }
  }

  // 구간 선택 (개요 클릭/블록, 이동 버튼) — 저장 범위로 클램프
  const selectRange = (start, end) => {
    if (!waveInfo) return
    const dur = Math.max(end - start, 1000)
    let s = Math.max(start, waveInfo.from_ms)
    let e = Math.min(s + dur, waveInfo.to_ms)
    s = Math.max(e - dur, waveInfo.from_ms)
    setSel([s, e])
    // 팬 드래그 중 과도한 요청 방지 (120ms 스로틀 + 마지막 위치 보정)
    const th = fetchThrottle.current
    const now = Date.now()
    clearTimeout(th.timer)
    if (now - th.t > 120) {
      th.t = now
      fetchDetail(s, e)
    } else {
      th.timer = setTimeout(() => { th.t = Date.now(); fetchDetail(s, e) }, 130)
    }
  }

  // 저장 파형: 가용 범위 → 개요 스트립 → 상세(기본 최근 15초)
  useEffect(() => {
    fetch(`${API}/api/wave/${channelId}/info`).then((r) => (r.ok ? r.json() : null))
      .then((info) => {
        setWaveInfo(info)
        if (!info) return
        fetch(`${API}/api/wave/${channelId}?mode=overview&from_ms=${info.from_ms}&to_ms=${info.to_ms}&buckets=760`)
          .then((r) => r.json()).then(setOverview).catch(() => {})
        const s = info.to_ms - 15000
        setSel([s, info.to_ms])
        fetchDetail(s, info.to_ms)
      })
      .catch(() => setWaveInfo(null))
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const age = ageOf(p.birth)
  const conditions = p.conditions || []
  const APPT_ST = { reserved: '예약됨', in_progress: '진행 중', done: '완료', cancelled: '취소' }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal rp-modal">
        <div className="modal-head">
          <h3>환자 리포트</h3>
          <span className="modal-sub">{p.name} ({p.id} · {channelId})</span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="rp-top">
          {p.profile_no && faceOk ? (
            <img
              className="rp-face"
              src={`/faces/${p.profile_no}.png`}
              alt={`${p.name} 얼굴`}
              onError={() => setFaceOk(false)}
            />
          ) : (
            <div className="rp-face rp-face-fallback">{(p.name || '?').slice(0, 1)}</div>
          )}
          <div className="rp-id">
            <h4>{p.name || '—'}</h4>
            <div className="rp-grid">
              <span>환자 ID</span><b>{p.id || '—'}</b>
              <span>성별/나이</span><b>{p.sex === 'F' ? '여' : p.sex === 'M' ? '남' : '—'}{age != null ? ` · ${age}세` : ''}</b>
              <span>생년월일</span><b>{p.birth || '—'}</b>
              <span>혈액형</span><b>{p.blood || '—'}</b>
              <span>병실</span><b>{p.building}동 {p.floor}층 {p.room}호 ({p.ward}/{p.zone})</b>
              <span>주치의</span><b>{p.doctor} · {p.department}</b>
              <span>담당 간호사</span><b>{p.nurse}</b>
              <span>패치(채널)</span><b>{channelId} · {ch?.gateway_id || '—'}</b>
            </div>
          </div>
          <div className="rp-cond">
            <h5>병변 · 기저질환</h5>
            {conditions.length
              ? conditions.map((c) => <span key={c} className="rp-cond-chip">{c}</span>)
              : <span className="dim">기록 없음</span>}
            <h5 style={{ marginTop: 12 }}>치료 히스토리</h5>
            <div className="rp-hist">
              {appts.length === 0 && <span className="dim">검사/진료 이력 없음</span>}
              {appts.map((a) => (
                <div key={a.id} className="rp-hist-row">
                  <small>{fmtDT(a.scheduled_ms)}</small>
                  <b>{a.title}</b>
                  <span className={'appt-chip ' + (a.status === 'done' ? 'done' : a.status === 'in_progress' ? 'prog' : a.status === 'cancelled' ? 'cxl' : 'rsv')}>
                    {APPT_ST[a.status] || a.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rp-wave">
          <div className="rp-wave-head">
            <h5>저장된 파형 (라우터 8시간 세그먼트 보관 · 삭제 없음)</h5>
            <span className="dim">
              {waveInfo
                ? `${fmtDT(waveInfo.from_ms)} ~ ${fmtDT(waveInfo.to_ms)} · ${(waveInfo.bytes / 1048576).toFixed(1)}MB`
                : '저장된 파형 없음'}
            </span>
          </div>
          {overview && waveInfo && (
            <>
              <div className="rp-hint">
                개요 클릭 = 해당 시점 15초 · 드래그 블록 = 구간 전체 표시 (120초 초과는 min/max 요약)
              </div>
              <EcgOverview
                buckets={overview.buckets}
                fromMs={overview.from_ms}
                toMs={overview.to_ms}
                sel={sel}
                onSelect={selectRange}
              />
            </>
          )}
          {sel && waveInfo && (
            <>
              <div className="rp-detail-bar">
                <button className="mv-locate" onClick={() => selectRange(sel[0] - (sel[1] - sel[0]), sel[0])}>
                  ◀ 이전
                </button>
                <button className="mv-locate" onClick={() => selectRange(sel[1], sel[1] + (sel[1] - sel[0]))}>
                  다음 ▶
                </button>
                <span className="rp-raw-label">
                  {fmtDT(sel[0])} ~ {fmtDT(sel[1])} · {((sel[1] - sel[0]) / 1000).toFixed(0)}초
                  · 파형 좌우 드래그로 이동
                </span>
                <span className="spacer" />
                <button className="mv-locate" onClick={() => selectRange(waveInfo.to_ms - 15000, waveInfo.to_ms)}>
                  최근 15초
                </button>
              </div>
              <EcgDetail
                data={detail}
                selStart={sel[0]}
                selEnd={sel[1]}
                onPan={(dms) => selectRange(sel[0] + dms, sel[1] + dms)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
