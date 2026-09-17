import React, { useEffect, useState } from 'react'
import { DB_API } from './endpoints.js'

// 예약 목록 (중앙관제 > 예약 목록).
// 예약은 ECG 채널 에뮬레이터가 랜덤 생성 → 라우터가 DB API 로 중계 →
// SQLite(appointments)에 영속화된다. 이 페이지는 DB 를 조회만 한다.

const STATUS = {
  reserved: { label: '예약됨', cls: 'rsv' },
  in_progress: { label: '진행 중', cls: 'prog' },
  done: { label: '완료', cls: 'done' },
  cancelled: { label: '취소', cls: 'cxl' },
}
const STATUS_ORDER = { in_progress: 0, reserved: 1, done: 2, cancelled: 3 }

const fmtT = (ms) => {
  if (!ms) return null
  const d = new Date(ms)
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? hh : `${d.getMonth() + 1}/${d.getDate()} ${hh}`
}

export default function AppointmentsPage() {
  const [rows, setRows] = useState([])
  const [error, setError] = useState('')
  const [sortKey, setSortKey] = useState('scheduled_ms')
  const [sortDir, setSortDir] = useState(-1)

  const load = () =>
    fetch(`${DB_API}/appointments`)
      .then((r) => r.json())
      .then((j) => { setRows(j.appointments || []); setError('') })
      .catch(() => setError('DB API(:7600)에 연결할 수 없습니다'))

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  const toggle = (k) => {
    if (sortKey === k) setSortDir(-sortDir)
    else { setSortKey(k); setSortDir(1) }
  }
  const Th = ({ k, children }) => (
    <th className="sortable" onClick={() => toggle(k)}>
      {children}
      <span className="arrow">{sortKey === k ? (sortDir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )

  const val = (a) => {
    switch (sortKey) {
      case 'status': return STATUS_ORDER[a.status] ?? 9
      case 'patient': return a.patient_name || ''
      case 'kind': return `${a.kind}|${a.title}`
      case 'place': return a.place || ''
      case 'duration_s': return a.duration_s || 0
      case 'eta_return_ms': return a.eta_return_ms || 0
      case 'returned_ms': return a.returned_ms || 0
      default: return a.scheduled_ms || 0
    }
  }
  const shown = [...rows].sort((a, b) => {
    const va = val(a), vb = val(b)
    let cmp = typeof va === 'number' && typeof vb === 'number'
      ? va - vb : String(va).localeCompare(String(vb), 'ko')
    cmp *= sortDir
    if (cmp === 0) cmp = (b.scheduled_ms || 0) - (a.scheduled_ms || 0)
    return cmp
  })

  const count = (s) => rows.filter((a) => a.status === s).length

  return (
    <div>
      {error && <div className="error">{error}</div>}
      <section>
        <div className="section-head">
          <h2>예약 목록 ({rows.length})</h2>
          <span className="map-count">
            예약됨 {count('reserved')} · 진행 중 {count('in_progress')} · 완료 {count('done')}
            {' '}· 5초 자동 갱신 · 에뮬레이터 생성 → 라우터 중계 → SQLite
          </span>
        </div>
        <table className="ch-table">
          <thead>
            <tr>
              <Th k="status">상태</Th>
              <Th k="scheduled_ms">예약 시간</Th>
              <Th k="patient">환자</Th>
              <Th k="kind">구분 · 항목</Th>
              <Th k="place">장소</Th>
              <Th k="duration_s">예상 소요</Th>
              <Th k="eta_return_ms">복귀 예상</Th>
              <Th k="returned_ms">복귀 시각</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((a) => {
              const st = STATUS[a.status] || { label: a.status, cls: '' }
              return (
                <tr key={a.id}>
                  <td><span className={'appt-chip ' + st.cls}>{st.label}</span></td>
                  <td>{fmtT(a.scheduled_ms)}</td>
                  <td><b>{a.patient_name}</b> <small>({a.patient_id}·{a.channel_id})</small></td>
                  <td><span className="appt-kind">{a.kind}</span> {a.title}</td>
                  <td>{a.place}</td>
                  <td>{Math.round((a.duration_s || 0) / 60)}분</td>
                  <td>{fmtT(a.eta_return_ms) || <span className="dim">—</span>}</td>
                  <td>{fmtT(a.returned_ms) || <span className="dim">—</span>}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan="8" className="dim">
                아직 예약이 없습니다 — 에뮬레이터가 평균 12초에 한 건씩 랜덤 생성합니다.
              </td></tr>
            )}
          </tbody>
        </table>
        <p className="hint">
          예약 시간이 되면 환자가 검사실로 이동하는 시나리오가 실행되고,
          예약 기반 이동은 소요 시간이 정해져 있어 복귀 예상 시각이 함께 기록됩니다.
        </p>
      </section>
    </div>
  )
}
