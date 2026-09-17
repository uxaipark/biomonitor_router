import React, { useMemo, useState } from 'react'
import { DB_API } from './endpoints.js'

const FIELDS = [
  ['building', '건물'], ['floor', '층'], ['ward', '병동'], ['zone', '구역'],
  ['room', '병실'], ['department', '진료과목'], ['doctor', '주치의'], ['nurse', '간호사'],
]

const fmt = (s, b, f) =>
  s == null ? s : String(s).split('{b}').join(b).split('{f}').join(String(f))

// 잔여 병상이 있는 병실 목록 계산 (트랜스퍼 모달 + 벌크 시나리오 공용).
// 구역/병동 파생 규칙은 에뮬레이터와 동일.
export function computeAvailableRooms(hospital, channels) {
  if (!hospital) return []
  const beds = hospital.bedsPerRoom || 6
  const occ = {}
  for (const c of channels) {
    const cp = c.patient
    if (!cp) continue
    const k = `${cp.building}|${cp.floor}|${cp.room}`
    occ[k] = (occ[k] || 0) + 1
  }
  const usedFloors = [...new Set(
    channels.map((c) => Number(c.patient?.floor)).filter((f) => f && f !== 1),
  )].sort((a, b) => a - b)
  const allWardFloors = hospital.floors.filter((f) => f !== 1).sort((a, b) => a - b)
  const roomSpaces = hospital.plans.default.spaces
    .filter((s) => s.type === 'room' && s.match?.room)
  const half = roomSpaces.length / 2
  const out = []
  for (const b of hospital.buildings) {
    for (const f of usedFloors) {
      roomSpaces.forEach((s, i) => {
        const room = fmt(s.match.room, b, f)
        const used = occ[`${b}|${f}|${room}`] || 0
        const free = beds - used
        if (free <= 0) return
        const r = i + 1
        const zone = (r - 1) % half < half / 2 ? 'Z1' : 'Z2'
        const band = Math.floor((allWardFloors.indexOf(f) * 3) / allWardFloors.length)
        const ward = ['W1', 'W2', 'W3'][band] || 'W1'
        out.push({ key: `${b}-${f}-${room}`, b, f, room, zone, ward, free })
      })
    }
  }
  return out
}

// 환자 트랜스퍼 모달.
// - 필드 수정 후 "변경 적용": 병실 이동 / 진료과 이동 / 주치의·간호사 변경 등
//   (에뮬레이터가 meta 를 즉시 재전송 → 라우터 그룹/게이트웨이 자동 갱신)
// - 패치 교체: 같은 환자로 새 채널 생성 (기존 채널은 정상 종료)
// - 퇴원: 채널 종료 및 라우터에서 완전 제거
export default function TransferModal({ ch, emuApi, channels = [], hospital, onClose, onDone }) {
  const p = ch.patient || {}
  const [form, setForm] = useState(() => {
    const init = {}
    for (const [key] of FIELDS) init[key] = p[key] || ''
    return init
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // 잔여 병상이 있는 병실 목록 (병원 구조 + 현재 점유 기준)
  const availableRooms = useMemo(
    () => computeAvailableRooms(hospital, channels),
    [channels, hospital],
  )

  const pickRoom = (key) => {
    const o = availableRooms.find((x) => x.key === key)
    if (!o) return
    setForm({
      ...form,
      building: o.b, floor: String(o.f), ward: o.ward, zone: o.zone, room: o.room,
    })
  }

  const post = async (path) => {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${emuApi}${path}?id=${encodeURIComponent(ch.channel_id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (e) {
      setError(`요청 실패: ${e.message} — 에뮬레이터(:7500) 상태를 확인하세요`)
      return null
    } finally {
      setBusy(false)
    }
  }

  const apply = async () => {
    const r = await post('/channel/patient')
    if (r?.updated) onDone(`${p.name} 환자 정보 변경 적용됨`)
  }

  // 패치 교체: 재고 목록 선택 또는 수동 입력
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [stock, setStock] = useState([])
  const [stockSel, setStockSel] = useState('')
  const [manualId, setManualId] = useState('')

  const openReplace = async () => {
    setReplaceOpen(true)
    setError('')
    // 패치 재고의 단일 소스는 SQLite (DB API). 라우터가 실시간 push 로 갱신한다.
    try {
      const r = await fetch(`${DB_API}/patches?status=in_stock`)
      const j = await r.json()
      setStock((j.patches || []).map((x) => x.patch_id))
    } catch {
      // DB API 미기동 시 에뮬레이터 임시 목록으로 폴백
      try {
        const r = await fetch(`${emuApi}/patches`)
        const j = await r.json()
        setStock(j.available || [])
        setError('DB API(:7600) 미연결 — 임시 재고 목록 사용 중')
      } catch {
        setStock([])
      }
    }
  }

  const doReplace = async () => {
    const chosen = (manualId.trim() || stockSel).toUpperCase()
    if (!chosen) {
      setError('교체할 새 패치를 재고에서 선택하거나 직접 입력하세요')
      return
    }
    if (!confirm(`${p.name} 환자의 패치를 ${ch.channel_id} → ${chosen}(으)로 교체할까요?`)) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(
        `${emuApi}/channel/replace?id=${encodeURIComponent(ch.channel_id)}&new=${encodeURIComponent(chosen)}`,
        { method: 'POST' },
      )
      const j = await res.json()
      if (j.new) onDone(`패치 교체 완료: ${ch.channel_id} → ${j.new} (${p.name})`)
      else setError(`교체 실패: ${j.error || res.status}`)
    } catch (e) {
      setError(`교체 실패: ${e.message}`)
    } finally {
      setBusy(false)
    }
  }

  const discharge = async () => {
    if (!confirm(`${p.name} 환자를 퇴원 처리할까요?\n(채널 ${ch.channel_id} 이 종료되고 모니터링에서 제거됩니다)`)) return
    const r = await post('/channel/discharge')
    if (r?.discharged) onDone(`퇴원 처리 완료: ${p.name} (${ch.channel_id})`)
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal">
        <div className="modal-head">
          <h3>환자 트랜스퍼</h3>
          <span className="modal-sub">
            {p.name} <small>({p.id})</small> · <code>{ch.channel_id}</code>
            {ch.gateway_id && <> · 게이트웨이 <code>{ch.gateway_id}</code></>}
          </span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        {error && <div className="error">{error}</div>}

        {/* 잔여 병상이 있는 병실 드롭다운 — 선택하면 위치 필드 자동 입력 */}
        <label className="modal-field room-pick">
          <span>병실 이동</span>
          <select value="" onChange={(e) => pickRoom(e.target.value)}>
            <option value="">
              — 잔여 병상 있는 병실 선택 ({availableRooms.length}곳, 선택 시 자동 입력) —
            </option>
            {availableRooms.map((o) => (
              <option key={o.key} value={o.key}>
                {o.b}동 {o.f}층 {o.room}호 · {o.ward}/{o.zone} · 잔여 {o.free}병상
              </option>
            ))}
          </select>
        </label>

        <div className="modal-grid">
          {FIELDS.map(([key, label]) => (
            <label className="modal-field" key={key}>
              <span>{label}</span>
              <input
                value={form[key]}
                onChange={(e) => setForm({ ...form, [key]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <p className="hint">
          병실/병동/구역을 바꾸면 게이트웨이가 새 공간으로 자동 재매핑되고,
          그룹 멤버십도 즉시 재계산되어 뷰어에 반영됩니다.
        </p>

        {replaceOpen && (
          <div className="replace-box">
            <div className="pm-title">패치 교체 — 새 패치 선택</div>
            <div className="replace-row">
              <select
                value={stockSel}
                onChange={(e) => { setStockSel(e.target.value); setManualId('') }}
              >
                <option value="">— 재고 패치 선택 ({stock.length}개) —</option>
                {stock.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <span className="or">또는 수동 입력</span>
              <input
                value={manualId}
                onChange={(e) => { setManualId(e.target.value); setStockSel('') }}
                placeholder="예: CH0999"
                maxLength={16}
              />
              <button className="primary" disabled={busy || (!stockSel && !manualId.trim())} onClick={doReplace}>
                교체 실행
              </button>
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="primary" disabled={busy} onClick={apply}>변경 적용</button>
          <button
            className={replaceOpen ? 'primary' : ''}
            disabled={busy}
            onClick={() => (replaceOpen ? setReplaceOpen(false) : openReplace())}
          >
            패치 교체 {replaceOpen ? '▴' : '▾'}
          </button>
          <button className="danger" disabled={busy} onClick={discharge}>퇴원</button>
          <div className="spacer" />
          <button disabled={busy} onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  )
}
