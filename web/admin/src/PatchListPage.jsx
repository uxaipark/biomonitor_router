import React, { useEffect, useState } from 'react'
import { DB_API } from './endpoints.js'

// 패치 관리 페이지 (중앙관제 > 패치 관리).
// SQLite(DB API)의 패치 재고/사용 내역을 표시한다.
//  - 통계: 사용 전(in_stock) / 사용 중(in_use) / 사용됨(retired)
//  - 사용 내역 탭: in_use + retired, 최신 사용건이 위 (updated_ts 내림차순)
//  - 미사용 재고 탭: in_stock 별도 화면 + 패치 추가(+100)
const STATUS = {
  in_use: { label: '사용 중', cls: 'ok' },
  retired: { label: '사용됨', cls: 'off' },
  in_stock: { label: '사용 전', cls: 'stock' },
}

const fmtTs = (ts) =>
  ts ? new Date(ts).toLocaleString('ko-KR', { hour12: false }) : '—'

export default function PatchListPage() {
  const [patches, setPatches] = useState([])
  const [patientNames, setPatientNames] = useState({})
  const [tab, setTab] = useState('history') // history | stock
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = () => {
    fetch(`${DB_API}/patches`)
      .then((r) => r.json())
      .then((j) => { setPatches(j.patches || []); setError('') })
      .catch(() => setError('DB API(:7600)에 연결할 수 없습니다'))
    fetch(`${DB_API}/patients`)
      .then((r) => r.json())
      .then((j) => {
        const m = {}
        for (const p of j.patients || []) m[p.patient_id] = p.name
        setPatientNames(m)
      })
      .catch(() => {})
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])

  const restock = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await fetch(`${DB_API}/patches/restock?count=100`, { method: 'POST' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = await r.json()
      setNotice(`패치 100개 입고: ${j.restocked[0]} ~ ${j.restocked[j.restocked.length - 1]}`)
      setTimeout(() => setNotice(''), 5000)
      load()
    } catch (e) {
      setError(`입고 실패: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const counts = { in_stock: 0, in_use: 0, retired: 0 }
  patches.forEach((p) => { counts[p.status] = (counts[p.status] || 0) + 1 })

  // 컬럼 정렬 (탭별 독립, 양방향 토글)
  const [histSort, setHistSort] = useState({ key: 'updated_ts', dir: -1 }) // 기본: 최신 사용건 위
  const [stockSort, setStockSort] = useState({ key: 'patch_id', dir: 1 })

  const sortVal = (p, key) => {
    switch (key) {
      case 'patch_id': return p.patch_id
      case 'status': return p.status === 'in_use' ? 0 : p.status === 'retired' ? 1 : 2
      case 'patient': return p.patient_id ? (patientNames[p.patient_id] || p.patient_id) : ''
      case 'updated_ts': return p.updated_ts || 0
      default: return p.patch_id
    }
  }

  const sortBy = (list, { key, dir }) =>
    [...list].sort((a, b) => {
      const va = sortVal(a, key)
      const vb = sortVal(b, key)
      let cmp = typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'ko')
      cmp *= dir
      if (cmp === 0) cmp = a.patch_id.localeCompare(b.patch_id)
      return cmp
    })

  const toggle = (sort, setSort) => (key) =>
    setSort(sort.key === key ? { key, dir: -sort.dir } : { key, dir: 1 })

  const Th = ({ sort, onToggle, k, children }) => (
    <th className="sortable" onClick={() => onToggle(k)}>
      {children}
      <span className="arrow">{sort.key === k ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )

  const history = sortBy(patches.filter((p) => p.status !== 'in_stock'), histSort)
  const stock = sortBy(patches.filter((p) => p.status === 'in_stock'), stockSort)

  return (
    <div>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}

      {/* 상태별 통계 */}
      <div className="stats-bar">
        <div className="stat">
          <span className="stat-label">전체 패치</span>
          <span className="stat-value">{patches.length.toLocaleString()}</span>
          <span className="stat-sub">SQLite (db-api/hospital.db)</span>
        </div>
        <div className="stat">
          <span className="stat-label">사용 중</span>
          <span className="stat-value">{counts.in_use.toLocaleString()}</span>
          <span className="stat-sub">환자 연결 · 전송 중</span>
        </div>
        <div className="stat">
          <span className="stat-label">사용됨</span>
          <span className="stat-value">{counts.retired.toLocaleString()}</span>
          <span className="stat-sub">퇴원/교체/삭제로 폐기</span>
        </div>
        <div className="stat">
          <span className="stat-label">사용 전 (재고)</span>
          <span className="stat-value">{counts.in_stock.toLocaleString()}</span>
          <span className="stat-sub">교체 시 선택 가능</span>
        </div>
      </div>

      <section>
        <div className="section-head">
          <div className="bld-tabs">
            <button className={tab === 'history' ? 'primary' : ''} onClick={() => setTab('history')}>
              사용 내역 ({history.length})
            </button>
            <button className={tab === 'stock' ? 'primary' : ''} onClick={() => setTab('stock')}>
              미사용 재고 ({stock.length})
            </button>
          </div>
          <h2 className="map-title" />
          <button className="primary" disabled={busy} onClick={restock}>
            ＋ 패치 추가 (+100)
          </button>
        </div>

        {tab === 'history' ? (
          <table>
            <thead>
              <tr>
                <Th sort={histSort} onToggle={toggle(histSort, setHistSort)} k="patch_id">패치 ID</Th>
                <Th sort={histSort} onToggle={toggle(histSort, setHistSort)} k="status">상태</Th>
                <Th sort={histSort} onToggle={toggle(histSort, setHistSort)} k="patient">환자</Th>
                <Th sort={histSort} onToggle={toggle(histSort, setHistSort)} k="updated_ts">최근 갱신 (사용/폐기 시각)</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.patch_id} className={p.status === 'retired' ? 'off' : ''}>
                  <td><code>{p.patch_id}</code></td>
                  <td>
                    <span className={'patch-badge ' + STATUS[p.status].cls}>
                      {STATUS[p.status].label}
                    </span>
                  </td>
                  <td>
                    {p.patient_id
                      ? <>{patientNames[p.patient_id] || ''} <small>({p.patient_id})</small></>
                      : <span className="dim">—</span>}
                  </td>
                  <td className="ts">{fmtTs(p.updated_ts)}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr><td colSpan="4" className="dim">사용 내역이 없습니다</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <Th sort={stockSort} onToggle={toggle(stockSort, setStockSort)} k="patch_id">패치 ID</Th>
                <th>상태</th>
                <Th sort={stockSort} onToggle={toggle(stockSort, setStockSort)} k="updated_ts">입고 시각</Th>
              </tr>
            </thead>
            <tbody>
              {stock.map((p) => (
                <tr key={p.patch_id}>
                  <td><code>{p.patch_id}</code></td>
                  <td><span className="patch-badge stock">사용 전</span></td>
                  <td className="ts">{fmtTs(p.updated_ts)}</td>
                </tr>
              ))}
              {stock.length === 0 && (
                <tr><td colSpan="3" className="dim">재고가 없습니다 — 패치 추가(+100)로 입고하세요</td></tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
