import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import { can, useMe } from '../auth.js'
import './Inventory.css'

/**
 * 패치 재고 — 병원별 위탁 재고와 보충 권장 (리셀러·CRM 영업·병원 IT).
 * 보충: 일평균 사용 d(최근 30일)·표준편차 σ·리드타임 L·검토주기 R·서비스수준 z →
 *   안전재고 SS = z·σ·√L · 재주문점 ROP = d·L + SS · 목표재고(Par) = d·(L+R) + SS · 권장 발주 = Par − (현재고 + 입고 예정), 상자 단위 올림.
 * 사용은 유효기간이 먼저인 로트부터(FEFO). 이 라우터 병원은 패치 부착마다 자동 차감.
 */
const STATUS = { stockout: ['재고 없음', 'err'], reorder: ['발주 필요', 'warn'], on_order: ['입고 예정', 'low'], ok: ['정상', 'ok'] }
const PO_LABEL = { draft: '작성', submitted: '제출', confirmed: '확인', shipped: '출고', received: '입고', cancelled: '취소' }
const PO_NEXT = { draft: 'submitted', submitted: 'confirmed', confirmed: 'shipped' }
const REASON_LABEL = { damaged: '파손', expired: '유효기간 만료', returned: '반품', lost: '분실', count: '실사 차이', other: '기타' }
const KIND_LABEL = { receive: '입고', use: '사용', adjust: '조정', count: '실사' }
const fmtD = (ms) => (ms ? new Date(ms).toLocaleDateString('ko-KR') : '—')
const stockCls = (d) => { if (!d) return ''; const n = (new Date(d) - Date.now()) / 86400000; return n <= 7 ? 'err' : n <= 21 ? 'warnv' : '' }
const money = (x) => (x ? Math.round(x).toLocaleString('ko-KR') : '—')

export default function Inventory() {
  const me = useMe()
  const edit = can(me, 'page.inventory', 2)
  const canSku = ['super_admin', 'system_admin', 'reseller', 'sales_crm'].includes(me?.user?.role)
  const [sum, , refresh] = usePoll(api.inventory.summary, 15000)
  const [sel, setSel] = useState(null) // tenant
  const [selSku, setSelSku] = useState(null)
  const [det, , refreshDet] = usePoll(() => (sel ? api.inventory.detail(sel) : Promise.resolve(null)), 15000, [sel])
  const [modal, setModal] = useState(null) // {kind, row}
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [only, setOnly] = useState('all')
  const rows = useMemo(() => (sum?.rows || []).filter((r) => (only === 'all' || (only === 'need' ? r.status === 'reorder' || r.status === 'stockout' : only === 'exp' ? r.expiring_60d > 0 || r.expired > 0 : true)) && (!q || `${r.tenant} ${r.tenant_name} ${r.sku} ${r.sku_name}`.toLowerCase().includes(q.toLowerCase()))), [sum, q, only])
  useEffect(() => { if (!sel && sum?.rows?.length) setSel(sum.site && sum.rows.some((r) => r.tenant === sum.site) ? sum.site : sum.rows[0].tenant) }, [sum, sel])
  const totals = useMemo(() => {
    const r = sum?.rows || []
    return { fc30: r.reduce((a, x) => a + (x.forecast?.next30 || 0), 0), soon: r.filter((x) => x.stockout_date && (new Date(x.stockout_date) - Date.now()) / 86400000 <= 14).length, need: r.filter((x) => x.status === 'reorder' || x.status === 'stockout').length, boxes: r.reduce((a, x) => a + x.suggest_boxes, 0), amount: r.reduce((a, x) => a + x.suggest_amount, 0), exp: r.reduce((a, x) => a + x.expiring_60d, 0), expired: r.reduce((a, x) => a + x.expired, 0), onHand: r.reduce((a, x) => a + x.on_hand, 0) }
  }, [sum])
  const fr = (sum?.rows || []).find((r) => r.tenant === sel && (!selSku || r.sku === selSku))
  const done = (m) => { setMsg(m); setModal(null); refresh(); refreshDet() }
  const run = async (f, m) => { try { await f(); done(m) } catch (e) { setMsg(e.message) } }

  return (
    <div className="page inv">
      <div className="inv-head">
        <h2 className="h">패치 재고</h2>
        <span className="muted small">병원별 위탁 재고 · 유효기간 선입선출(FEFO) · 사용량 기반 보충 권장</span>
        <span className="spacer" />
        {msg && <span className="muted small">{msg}</span>}
        {canSku && <button onClick={() => setModal({ kind: 'sku' })}>품목 관리</button>}
      </div>
      <div className="inv-kpis">
        <div><small>현재고 합계</small><b>{totals.onHand.toLocaleString()}</b><span>개</span></div>
        <div className={totals.need ? 'warn' : ''}><small>발주 필요 품목</small><b>{totals.need}</b><span>병원·품목</span></div>
        <div><small>권장 발주</small><b>{totals.boxes.toLocaleString()}</b><span>상자 · {money(totals.amount)}</span></div>
        <div><small>30일 예측 수요</small><b>{Math.round(totals.fc30).toLocaleString()}</b><span>개 · 소비 추이 기반</span></div>
        <div className={totals.soon ? 'err' : ''}><small>14일 안 품절 예상</small><b>{totals.soon}</b><span>병원·품목</span></div>
        <div className={totals.exp ? 'warn' : ''}><small>유효기간 60일 이내</small><b>{totals.exp.toLocaleString()}</b><span>개</span></div>
        <div className={totals.expired ? 'err' : ''}><small>유효기간 지남</small><b>{totals.expired.toLocaleString()}</b><span>개 · 폐기 조정 권장</span></div>
      </div>
      <div className="toolbar">
        <input type="search" placeholder="병원 · 품목 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="seg">{[['all', '전체'], ['need', '발주 필요'], ['exp', '유효기간 주의']].map(([k, l]) => <button key={k} className={only === k ? 'active' : ''} onClick={() => setOnly(k)}>{l}</button>)}</span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl inv-tbl">
          <thead><tr><th>상태</th><th>병원</th><th>품목</th><th className="num">현재고</th><th className="num">재고 일수</th><th className="num">30일 예측</th><th>품절 예상</th><th className="num">재주문점</th><th className="num">목표재고</th><th className="num">입고 예정</th><th className="num">유효기간 임박</th><th className="num">권장 발주</th><th></th></tr></thead>
          <tbody>{rows.map((r) => { const [sl, st] = STATUS[r.status]; return (
            <tr key={r.tenant + r.sku} className={'clickable' + (sel === r.tenant && (!selSku || selSku === r.sku) ? ' selected' : '')} onClick={() => { setSel(r.tenant); setSelSku(r.sku) }}>
              <td><span className={`lk-pill ${st}`}>{sl}</span></td>
              <td><b>{r.tenant}</b> <span className="muted small">{r.tenant_name}</span>{r.tenant === sum?.site && <span className="muted small"> · 이 라우터</span>}</td>
              <td>{r.sku_name}<div className="muted small mono">{r.sku} · {r.per_box}개/상자</div></td>
              <td className="num"><b>{r.on_hand}</b>{r.expired > 0 && <div className="err small">만료 {r.expired}</div>}</td>
              <td className={'num' + (r.dos != null && r.dos < r.lead_days ? ' warnv' : '')}>{r.dos != null ? `${r.dos}일` : '—'}</td>
              <td className="num"><b>{r.forecast?.next30 ?? '—'}</b><div className="muted small">일 {r.avg_daily}{r.forecast?.trend_pct != null ? ` · ${r.forecast.trend_pct > 0 ? '▲' : r.forecast.trend_pct < 0 ? '▼' : ''}${Math.abs(r.forecast.trend_pct)}%` : ''}</div></td>
              <td className={stockCls(r.stockout_date)}>{r.stockout_date || '90일 이상'}{r.order_by && <div className="muted small">발주 기한 {r.order_by}</div>}</td>
              <td className="num">{r.reorder_point}<div className="muted small">안전 {r.safety_stock}</div></td>
              <td className="num">{r.par}<div className="muted small">L {r.lead_days} · R {r.review_days}일</div></td>
              <td className="num">{r.on_order || '—'}</td>
              <td className={'num' + (r.expiring_60d ? ' warnv' : '')}>{r.expiring_60d || '—'}</td>
              <td className="num">{r.suggest_boxes ? <><b>{r.suggest_boxes}상자</b><div className="muted small">{r.suggest_units}개 · {money(r.suggest_amount)}</div></> : '—'}</td>
              <td className="acts" onClick={(e) => e.stopPropagation()}>
                {edit && <button className="primary" disabled={!r.suggest_boxes && false} onClick={() => setModal({ kind: 'po', row: r })}>발주</button>}
                {edit && <button onClick={() => setModal({ kind: 'receive', row: r })}>입고</button>}
                {edit && <button className="ghost" onClick={() => setModal({ kind: 'adjust', row: r })}>사용·조정</button>}
                {edit && <button className="ghost" onClick={() => setModal({ kind: 'count', row: r })}>실사</button>}
                {edit && <button className="ghost" onClick={() => setModal({ kind: 'policy', row: r })}>기준</button>}
              </td>
            </tr>) })}
            {!rows.length && <tr><td colSpan="13" className="muted">표시할 재고가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {sel && det && (
        <div className="inv-detail">
          {fr && <ForecastCard r={fr} />}
          <section className="inv-card">
            <h3>로트 <small>유효기간 순 (먼저 쓰는 순서)</small></h3>
            <table className="tbl"><thead><tr><th>품목</th><th>로트</th><th>유효기간</th><th className="num">수량</th><th>입고</th></tr></thead>
              <tbody>{(det.lots || []).map((l) => { const exp = l.expiry && l.expiry < new Date().toISOString().slice(0, 10); const soon = l.expiry && !exp && (new Date(l.expiry) - Date.now()) / 86400000 < 60; return (
                <tr key={l.id}><td className="mono small">{l.sku}</td><td className="mono">{l.lot}</td><td className={exp ? 'err' : soon ? 'warnv' : ''}>{l.expiry || '—'}{exp ? ' · 만료' : soon ? ' · 임박' : ''}</td><td className="num">{l.qty}</td><td className="small muted">{fmtD(l.received_ms)}{l.po ? ` · PO-${l.po}` : ''}</td></tr>) })}
                {!(det.lots || []).length && <tr><td colSpan="5" className="muted">재고 로트 없음</td></tr>}</tbody></table>
          </section>
          <section className="inv-card">
            <h3>발주 <small>작성 → 제출 → 확인 → 출고 → 입고</small></h3>
            <table className="tbl"><thead><tr><th>번호</th><th>품목</th><th className="num">상자</th><th>상태</th><th>송장 · 도착 예정</th><th>작성</th><th></th></tr></thead>
              <tbody>{(det.pos || []).map((p) => (
                <tr key={p.id}><td className="mono">PO-{p.id}</td><td className="mono small">{p.sku}</td><td className="num">{p.boxes}</td>
                  <td><span className={'lk-pill ' + (p.status === 'received' ? 'ok' : p.status === 'cancelled' ? 'off' : 'low')}>{PO_LABEL[p.status]}</span></td>
                  <td className="small">{p.tracking || '—'}{p.eta ? ` · ${p.eta}` : ''}</td><td className="small muted">{fmtD(p.created_ms)} · {p.by}</td>
                  <td className="acts">{edit && PO_NEXT[p.status] && <button onClick={() => (PO_NEXT[p.status] === 'shipped' ? setModal({ kind: 'ship', po: p }) : run(() => api.inventory.poUpdate(sel, p.id, { status: PO_NEXT[p.status] }), `PO-${p.id} ${PO_LABEL[PO_NEXT[p.status]]}`))}>{PO_LABEL[PO_NEXT[p.status]]}</button>}
                    {edit && p.status === 'shipped' && <button className="primary" onClick={() => setModal({ kind: 'receive', row: (sum.rows || []).find((r) => r.tenant === sel && r.sku === p.sku), po: p })}>입고 처리</button>}
                    {edit && !['received', 'cancelled'].includes(p.status) && <button className="ghost danger" onClick={() => window.confirm(`PO-${p.id} 를 취소할까요?`) && run(() => api.inventory.poUpdate(sel, p.id, { status: 'cancelled' }), `PO-${p.id} 취소`)}>취소</button>}</td></tr>))}
                {!(det.pos || []).length && <tr><td colSpan="7" className="muted">발주 없음</td></tr>}</tbody></table>
          </section>
          <section className="inv-card wide">
            <h3>재고 원장 <small>최근 300건 · 모든 수량 변화</small></h3>
            <div className="tbl-wrap inv-ledger"><table className="tbl"><thead><tr><th>시각</th><th>구분</th><th>품목</th><th>로트</th><th className="num">수량</th><th>사유</th><th>참조</th><th>처리자</th></tr></thead>
              <tbody>{(det.ledger || []).map((l, i) => (
                <tr key={i}><td className="small">{new Date(l.ms).toLocaleString('ko-KR', { hour12: false })}</td><td>{KIND_LABEL[l.kind] || l.kind}</td><td className="mono small">{l.sku}</td><td className="mono small">{l.lot || '—'}</td><td className={'num ' + (l.qty < 0 ? 'err' : 'okv')}>{l.qty > 0 ? `+${l.qty}` : l.qty}</td><td className="small">{REASON_LABEL[l.reason] || (l.reason === 'patch_attach' ? '패치 부착(자동)' : l.reason === 'shortage' ? '재고 부족' : l.reason === 'manual' ? '수동 사용' : l.reason)}</td><td className="mono small">{l.ref}</td><td className="small muted">{l.by}</td></tr>))}</tbody></table></div>
          </section>
        </div>
      )}
      {modal && <InvModal m={modal} skus={sum?.skus || []} tenant={modal.row?.tenant || sel} onClose={() => setModal(null)} onRun={run} />}
    </div>
  )
}

function InvModal({ m, skus, tenant, onClose, onRun }) {
  const r = m.row || {}
  const today = new Date()
  const [f, setF] = useState(() => ({
    sku: r.sku || m.po?.sku || skus[0]?.id || '', boxes: r.suggest_boxes || 1, note: '', lot: '', expiry: new Date(today.getFullYear() + 1, today.getMonth(), today.getDate()).toISOString().slice(0, 10),
    qty: m.po ? m.po.boxes * (r.per_box || 10) : (r.per_box || 10), kind: m.kind === 'count' ? 'count' : 'use', reason: 'damaged', counted: r.on_hand ?? 0,
    lead: r.lead_days ?? 7, review: r.review_days ?? 7, service: r.service ?? 0.95, min_boxes: r.min_boxes ?? 1, tracking: '', eta: '',
    id: '', name: '', per_box: 10, unit_price: 0, wear_days: 14,
  }))
  const set = (k, v) => setF({ ...f, [k]: v })
  const title = { po: '발주 작성', receive: '입고', adjust: '사용 · 조정', count: '실사', policy: '보충 기준', ship: '출고 처리', sku: '품목 관리' }[m.kind]
  const submit = () => {
    if (m.kind === 'po') return onRun(() => api.inventory.poCreate(tenant, { sku: f.sku, boxes: Number(f.boxes), note: f.note }), `${tenant} 발주 작성 ${f.boxes}상자`)
    if (m.kind === 'receive') return onRun(() => api.inventory.receive(tenant, { sku: f.sku, lot: f.lot, expiry: f.expiry, qty: Number(f.qty), po: m.po?.id }), `${tenant} 입고 ${f.qty}개 (${f.lot})`)
    if (m.kind === 'adjust') return onRun(() => api.inventory.adjust(tenant, { sku: f.sku, kind: f.kind === 'use' ? 'use' : 'adjust', qty: f.kind === 'use' ? Number(f.qty) : (f.kind === 'minus' ? -Math.abs(Number(f.qty)) : Math.abs(Number(f.qty))), reason: f.reason }), `${tenant} ${f.kind === 'use' ? '사용' : '조정'} 반영`)
    if (m.kind === 'count') return onRun(() => api.inventory.adjust(tenant, { sku: f.sku, kind: 'count', qty: Number(f.counted) }), `${tenant} 실사 ${f.counted}개 반영`)
    if (m.kind === 'policy') return onRun(() => api.inventory.policy(tenant, { sku: f.sku, lead_days: Number(f.lead), review_days: Number(f.review), service: Number(f.service), min_boxes: Number(f.min_boxes) }), `${tenant} 보충 기준 저장`)
    if (m.kind === 'ship') return onRun(() => api.inventory.poUpdate(tenant, m.po.id, { status: 'shipped', tracking: f.tracking, eta: f.eta }), `PO-${m.po.id} 출고`)
    if (m.kind === 'sku') return onRun(() => api.inventory.sku({ id: f.id, name: f.name, per_box: Number(f.per_box), unit_price: Number(f.unit_price), wear_days: Number(f.wear_days) }), `품목 ${f.id} 저장`)
  }
  const skuSel = <label>품목<select value={f.sku} onChange={(e) => set('sku', e.target.value)}>{skus.map((s) => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}</select></label>
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal inv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{title} <small>{m.kind !== 'sku' ? tenant : ''}</small></h2><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
        <div className="inv-form">
          {m.kind === 'po' && <>{skuSel}<label>상자 수<input type="number" min="1" value={f.boxes} onChange={(e) => set('boxes', e.target.value)} /></label>
            {r.suggest_boxes > 0 && <p className="muted small">권장 {r.suggest_boxes}상자 = 목표재고 {r.par} − (현재고 {r.on_hand} + 입고 예정 {r.on_order}), 상자당 {r.per_box}개로 올림</p>}
            <label>메모<input value={f.note} onChange={(e) => set('note', e.target.value)} placeholder="납품 요청 사항" /></label></>}
          {m.kind === 'receive' && <>{skuSel}<label>로트 번호<input value={f.lot} onChange={(e) => set('lot', e.target.value)} placeholder="LOT" /></label><label>유효기간<input type="date" value={f.expiry} onChange={(e) => set('expiry', e.target.value)} /></label><label>수량(개)<input type="number" min="1" value={f.qty} onChange={(e) => set('qty', e.target.value)} /></label>{m.po && <p className="muted small">PO-{m.po.id} ({m.po.boxes}상자) 입고로 처리되어 발주가 '입고' 상태가 됩니다.</p>}</>}
          {m.kind === 'adjust' && <>{skuSel}<label>구분<span className="seg">{[['use', '사용(수동)'], ['minus', '감소 조정'], ['plus', '증가 조정']].map(([k, l]) => <button key={k} type="button" className={f.kind === k ? 'active' : ''} onClick={() => set('kind', k)}>{l}</button>)}</span></label>
            <label>수량(개)<input type="number" min="1" value={f.qty} onChange={(e) => set('qty', e.target.value)} /></label>
            {f.kind !== 'use' && <label>사유<select value={f.reason} onChange={(e) => set('reason', e.target.value)}>{Object.entries(REASON_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>}
            <p className="muted small">감소는 유효기간이 먼저인 로트부터 뺍니다. 이 라우터 병원의 패치 부착은 자동 차감되므로 수동 사용은 다른 병원·예외에만 쓰세요.</p></>}
          {m.kind === 'count' && <>{skuSel}<label>실제로 센 수량(개)<input type="number" min="0" value={f.counted} onChange={(e) => set('counted', e.target.value)} /></label><p className="muted small">시스템 현재고 {r.on_hand}개 — 차이는 '실사 차이' 조정으로 원장에 남습니다.</p></>}
          {m.kind === 'policy' && <>{skuSel}<label>리드타임(일)<input type="number" min="0" step="0.5" value={f.lead} onChange={(e) => set('lead', e.target.value)} /></label><label>검토 주기(일)<input type="number" min="0" step="0.5" value={f.review} onChange={(e) => set('review', e.target.value)} /></label>
            <label>서비스 수준<select value={f.service} onChange={(e) => set('service', e.target.value)}>{[[0.9, '90%'], [0.95, '95% (권장)'], [0.975, '97.5%'], [0.99, '99%']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label><label>최소 발주(상자)<input type="number" min="0" value={f.min_boxes} onChange={(e) => set('min_boxes', e.target.value)} /></label>
            <p className="muted small">안전재고 = z·σ·√리드타임, 재주문점 = 일평균×리드타임 + 안전재고, 목표재고 = 일평균×(리드타임+검토 주기) + 안전재고.</p></>}
          {m.kind === 'ship' && <><label>송장 번호<input value={f.tracking} onChange={(e) => set('tracking', e.target.value)} /></label><label>도착 예정<input type="date" value={f.eta} onChange={(e) => set('eta', e.target.value)} /></label></>}
          {m.kind === 'sku' && <><table className="tbl"><thead><tr><th>코드</th><th>이름</th><th className="num">개/상자</th><th className="num">단가</th></tr></thead><tbody>{skus.map((s) => <tr key={s.id} className="clickable" onClick={() => setF({ ...f, id: s.id, name: s.name, per_box: s.per_box, unit_price: s.unit_price, wear_days: s.wear_days })}><td className="mono">{s.id}</td><td>{s.name}</td><td className="num">{s.per_box}</td><td className="num">{money(s.unit_price)}</td></tr>)}</tbody></table>
            <label>코드<input value={f.id} onChange={(e) => set('id', e.target.value)} /></label><label>이름<input value={f.name} onChange={(e) => set('name', e.target.value)} /></label><label>상자당 수량<input type="number" min="1" value={f.per_box} onChange={(e) => set('per_box', e.target.value)} /></label><label>단가<input type="number" min="0" value={f.unit_price} onChange={(e) => set('unit_price', e.target.value)} /></label><label>착용 일수<input type="number" min="1" value={f.wear_days} onChange={(e) => set('wear_days', e.target.value)} /></label></>}
        </div>
        <div className="toolbar" style={{ marginTop: 10 }}><span className="spacer" /><button onClick={onClose}>취소</button><button className="primary" onClick={submit}>저장</button></div>
      </div>
    </div>
  )
}

const METHOD = { holt_winters: '추세 + 요일 계절성 (Holt-Winters)', holt_damped: '감쇠 추세 (Holt)', mean: '평균', none: '이력 없음' }

/** 소비 추이와 수요 예측: 지난 사용(막대) + 앞으로 90일 예측(선) + 80% 구간(띠), 오늘·품절 예상 표시 */
export function ForecastCard({ r }) {
  const f = r.forecast
  const [h, setH] = useState(30)
  if (!f) return null
  const hist = r.history || []
  const past = hist.slice(-60)
  const fut = f.daily.slice(0, h)
  const n = past.length + fut.length
  const W = 1100, H = 210, L = 38, B = 20, T = 8
  const mx = Math.max(1, ...past, ...f.hi.slice(0, h)) * 1.1
  const x = (i) => L + (i / Math.max(1, n - 1)) * (W - L - 6)
  const y = (v) => H - B - (v / mx) * (H - B - T)
  const bw = Math.max(1, (W - L) / n - 1)
  const off = past.length
  const band = fut.map((_, i) => `${x(off + i)},${y(f.hi[i])}`).join(' ') + ' ' + fut.map((_, i) => `${x(off + fut.length - 1 - i)},${y(f.lo[fut.length - 1 - i])}`).join(' ')
  const line = fut.map((v, i) => `${x(off + i)},${y(v)}`).join(' ')
  const so = r.stockout_date ? Math.round((new Date(r.stockout_date) - new Date(new Date().toDateString())) / 86400000) : null
  const ticks = [0, Math.round(mx / 2), Math.round(mx)]
  return (
    <section className="inv-card inv-fc">
      <h3>{r.tenant} · {r.sku_name} <small>소비 추이 · 수요 예측</small></h3>
      <div className="inv-fc-top">
        <span className="seg">{[30, 60, 90].map((k) => <button key={k} className={h === k ? 'active' : ''} onClick={() => setH(k)}>{k}일</button>)}</span>
        <span className="muted small">{METHOD[f.method] || f.method} · 이력 {f.history_days}일{f.prior != null ? ` · 착용 기준선 ${f.prior}/일 (착용 ${r.census}명 ÷ 착용 일수, 비중 ${Math.round((1 - f.weight_hist) * 100)}%)` : ''}{f.wape != null ? ` · 최근 7일 오차 ${f.wape}%` : ''}</span>
      </div>
      <svg className="inv-fc-svg" viewBox={`0 0 ${W} ${H}`}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W} y1={y(t)} y2={y(t)} className="g" /><text x={L - 4} y={y(t) + 3} textAnchor="end">{t}</text></g>)}
        {past.map((v, i) => <rect key={i} x={x(i) - bw / 2} y={y(v)} width={bw} height={Math.max(0.5, y(0) - y(v))} className="hb"><title>{`${past.length - i}일 전 · ${v}개`}</title></rect>)}
        <polygon points={band} className="band" />
        <polyline points={line} className="fc" />
        <line x1={x(off) - bw} x2={x(off) - bw} y1={T} y2={H - B} className="today" /><text x={x(off) - bw + 3} y={T + 9} className="lbl">오늘</text>
        {so != null && so < h && <><line x1={x(off + so)} x2={x(off + so)} y1={T} y2={H - B} className="so" /><text x={x(off + so) + 4} y={T + 26} className="lbl so">품절 예상 {r.stockout_date}</text></>}
        <text x={L} y={H - 4} className="lbl">{past.length ? `${past.length}일 전` : ''}</text><text x={W - 6} y={H - 4} textAnchor="end" className="lbl">+{h}일</text>
      </svg>
      <div className="inv-fc-grid">
        <div><small>7일 예측</small><b>{f.next7}</b></div>
        <div><small>30일 예측</small><b>{f.next30}</b>{f.trend_pct != null && <span className={f.trend_pct > 5 ? 'warnv' : f.trend_pct < -5 ? 'okv' : ''}>{f.trend_pct > 0 ? '▲' : f.trend_pct < 0 ? '▼' : ''} {Math.abs(f.trend_pct)}% (최근 4주 대비)</span>}</div>
        <div><small>60일 · 90일</small><b>{f.next60} · {f.next90}</b></div>
        <div><small>현재고 + 입고 예정</small><b>{r.on_hand + r.on_order}</b><span>{r.dos != null ? `약 ${r.dos}일분` : ''}</span></div>
        <div className={r.need_more_30 ? 'warn' : ''}><small>30일 추가 필요</small><b>{r.need_more_30}</b><span>{Math.ceil(r.need_more_30 / r.per_box)}상자</span></div>
        <div className={r.need_more_60 ? 'warn' : ''}><small>60일 추가 필요</small><b>{r.need_more_60}</b><span>{Math.ceil(r.need_more_60 / r.per_box)}상자</span></div>
        <div><small>90일 추가 필요</small><b>{r.need_more_90}</b><span>{Math.ceil(r.need_more_90 / r.per_box)}상자{r.unit_price ? ` · ${money(r.need_more_90 * r.unit_price)}` : ''}</span></div>
        <div className={so != null && so <= r.lead_days ? 'err' : ''}><small>품절 예상 · 발주 기한</small><b className="sm">{r.stockout_date || '90일 이상'}</b><span>{r.order_by ? `늦어도 ${r.order_by} 발주 (리드타임 ${r.lead_days}일)` : '여유'}</span></div>
      </div>
    </section>
  )
}
