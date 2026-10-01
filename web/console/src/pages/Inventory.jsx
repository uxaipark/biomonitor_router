import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api, usePoll } from '../api.js'
import { can, useMe } from '../auth.js'
import { parseGS1 } from '../reports/gs1.js'
import './Inventory.css'

/**
 * 패치 재고 — 공급사(리셀러·영업)가 병원 재고를 대신 관리하는 VMI·위탁 절차.
 *  1. 계약·보충 설정(공급사): 운영 방식(위탁=쓴 만큼 청구 / 구매=납품 때 청구), 병원 단가, 배송 기간(주문→병동), 점검 주기, 품절 방지 수준, 자동 발주 요청.
 *  2. 발주: 공급사 요청 → 병원 승인(병원 발주번호) → 공급사 출고(로트·유효기간 줄, 송장) → 병원 수령 확인(줄별 수량, 차이 기록).
 *  3. 사용: 이 라우터 병원은 패치 부착마다 자동 차감(유효기간 빠른 로트부터). 기록보다 더 쓰면 '기록 밖 사용' 경고 → 방문 점검.
 *  4. 방문 점검: 로트별로 세서 차이를 사유와 함께 남기고, 만료분은 폐기·반품, 병원 확인자 이름을 남긴다(확인서 인쇄).
 *  5. 월 사용 명세(청구 근거), 병원 간 이동(유효기간 임박분), 로트 추적(리콜).
 * 바코드: GS1 라벨을 스캔하면 로트·유효기간이 채워진다(키보드식 스캐너).
 */
const PO_LABEL = { draft: '요청', submitted: '요청', confirmed: '병원 승인', shipped: '출고', received: '수령', cancelled: '취소' }
const STEPS = [['submitted', '요청'], ['confirmed', '병원 승인'], ['shipped', '출고'], ['received', '수령 확인']]
const REASON_LABEL = { damaged: '파손', expired: '유효기간 만료(폐기)', returned: '반품', lost: '분실', count: '점검 차이', other: '기타', shortage: '기록 밖 사용', transfer_out: '다른 병원으로 이동', transfer_in: '다른 병원에서 이동', receive_diff: '수령 수량 차이', manual: '수동 사용', patch_attach: '패치 부착' }
const KIND_LABEL = { receive: '입고', use: '사용', adjust: '조정', count: '점검' }
const fmtD = (ms) => (ms ? new Date(ms).toLocaleDateString('ko-KR') : '—')
const money = (x) => (x ? `${Math.round(x).toLocaleString('ko-KR')}원` : '—')
const mmdd = (d) => (d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : '')
const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
const addDays = (n) => ymd(new Date(Date.now() + n * 86400000))
const daysLeft = (r) => (r.stockout_date ? Math.max(0, Math.round((new Date(r.stockout_date) - new Date(new Date().toDateString())) / 86400000)) : null)
const daysSince = (ms) => (ms ? Math.floor((Date.now() - ms) / 86400000) : null)
const openCount = (r) => Object.values(r.po_open || {}).reduce((a, n) => a + n, 0)
const SUPPLIER = ['super_admin', 'system_admin', 'reseller', 'sales_crm']
const HOSPITAL = ['super_admin', 'system_admin', 'hospital_it', 'nurse', 'staff']

/** 카드의 '지금 할 일' — 상태를 쉬운 문장 하나로 */
function nextStep(r, sup, hos) {
  const o = r.po_open || {}
  const req = (o.submitted || 0) + (o.draft || 0)
  if (!r.started) return { tone: 'idle', title: '재고 관리 시작 전', text: '처음 납품한 수량을 입고로 등록하면 남은 양과 품절 시점을 계산합니다.', action: 'receive', label: '첫 입고 등록', who: true }
  if (r.unrecorded_use > 0) return { tone: 'warn', title: '기록보다 많이 사용', text: `재고 기록이 없을 때 ${r.unrecorded_use.toLocaleString()}개가 부착됐습니다. 현장에서 세어 맞춰 주세요.`, action: 'visit', label: '방문 점검', who: true }
  if (o.shipped) return { tone: 'info', title: '배송 중', text: `출고된 발주 ${o.shipped}건 — 도착하면 받은 수량을 확인하세요.`, action: 'tab-po', label: '수령 확인', who: true }
  if (o.confirmed) return { tone: 'info', title: '승인됨 · 출고 대기', text: sup ? '병원이 승인했습니다. 로트를 지정해 출고하세요.' : '공급사 출고를 기다리는 중입니다.', action: 'tab-po', label: sup ? '출고하기' : '보기', who: true }
  if (req) return { tone: hos ? 'warn' : 'info', title: '병원 승인 대기', text: hos ? `공급사 발주 요청 ${req}건 — 병원 발주번호를 넣고 승인하세요.` : `발주 요청 ${req}건이 병원 승인을 기다립니다.`, action: 'tab-po', label: hos ? '승인하기' : '보기', who: true }
  if (r.suggest_boxes > 0 && (r.on_hand <= 0 || r.on_hand + r.on_order <= r.reorder_point)) {
    const d = daysLeft(r)
    return { tone: r.on_hand <= 0 || (d != null && d <= r.lead_days) ? 'err' : 'warn', title: r.on_hand <= 0 ? '재고 없음 · 지금 발주' : d != null && d <= r.lead_days ? '배송 기간 안에 떨어짐' : `${mmdd(r.order_by)}까지 발주`, text: `권장 ${r.suggest_boxes}상자 (${r.suggest_units.toLocaleString()}개) — 목표 재고까지 채우는 양`, action: 'po', label: `${r.suggest_boxes}상자 발주 요청`, who: sup }
  }
  const since = daysSince(r.last_count_ms)
  if (since == null || since > r.count_days) return { tone: 'info', title: since == null ? '점검 기록 없음' : `점검 ${since}일 지남`, text: `점검 주기 ${r.count_days}일 — 현장 재고를 세어 기록과 맞춰 주세요.`, action: 'visit', label: '방문 점검', who: true }
  return { tone: 'ok', title: '재고 충분', text: r.order_by ? `${mmdd(r.order_by)}쯤 다음 발주 (배송 ${r.lead_days}일 감안, ${mmdd(r.stockout_date)} 품절 예상)` : '앞으로 90일 넘게 버팁니다.', action: null }
}
const urgency = (r) => ({ err: 0, warn: 1, info: 2, ok: 3, idle: 4 })[nextStep(r, true, true).tone] * 1000 + (daysLeft(r) ?? 999)

export default function Inventory() {
  const me = useMe()
  const role = me?.user?.role
  const edit = can(me, 'page.inventory', 2)
  const sup = edit && SUPPLIER.includes(role), hos = edit && HOSPITAL.includes(role)
  const [sum, , refresh] = usePoll(api.inventory.summary, 15000)
  const [sel, setSel] = useState(null)
  const [tab, setTab] = useState('forecast')
  const rowsAll = sum?.rows || []
  const selRow = rowsAll.find((r) => `${r.tenant}|${r.sku}` === sel)
  const [det, , refreshDet] = usePoll(() => (selRow ? api.inventory.detail(selRow.tenant) : Promise.resolve(null)), 15000, [selRow?.tenant])
  const [modal, setModal] = useState(null)
  const [msg, setMsg] = useState('')
  const [q, setQ] = useState('')
  const [only, setOnly] = useState('all')
  const rows = useMemo(() => rowsAll
    .filter((r) => { const t = nextStep(r, sup, hos).tone; return only === 'all' || (only === 'need' ? t === 'err' || t === 'warn' : only === 'exp' ? r.expiring_60d > 0 || r.expired > 0 : only === 'po' ? openCount(r) > 0 : true) })
    .filter((r) => !q || `${r.tenant} ${r.tenant_name} ${r.sku} ${r.sku_name}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => urgency(a) - urgency(b)), [sum, q, only, sup, hos])
  useEffect(() => { if (!sel && rows.length) setSel(`${rows[0].tenant}|${rows[0].sku}`) }, [rows, sel])
  const k = useMemo(() => ({
    act: rowsAll.filter((x) => ['err', 'warn'].includes(nextStep(x, sup, hos).tone)).length,
    soon: rowsAll.filter((x) => { const d = daysLeft(x); return x.started && d != null && d <= 14 }).length,
    po: rowsAll.reduce((a, x) => a + openCount(x), 0),
    visit: rowsAll.filter((x) => x.started && (daysSince(x.last_count_ms) == null || daysSince(x.last_count_ms) > x.count_days)).length,
    exp: rowsAll.reduce((a, x) => a + x.expiring_60d + x.expired, 0),
  }), [sum, sup, hos])
  const done = (m) => { setMsg(m); setModal(null); refresh(); refreshDet() }
  const run = async (f, m) => { try { const r = await f(); done(typeof m === 'function' ? m(r) : m); return r } catch (e) { setMsg(e.message); throw e } }
  const act = (r, a) => { setSel(`${r.tenant}|${r.sku}`); if (a === 'tab-po') setTab('po'); else if (a) setModal({ kind: a, row: r }) }
  const Kpi = ({ id, label, val, sub, tone }) => <button className={`inv-kpi${val ? ` ${tone}` : ''}${only === id ? ' on' : ''}`} onClick={() => setOnly(only === id ? 'all' : id)}><small>{label}</small><b>{val}</b><span>{sub}</span></button>

  return (
    <div className="page inv">
      <div className="inv-head">
        <div><h2 className="h">패치 재고</h2><span className="muted small">병원마다 남은 패치와 품절 시점을 보고, 떨어지기 전에 채워 넣습니다.</span></div>
        <span className="spacer" />
        {msg && <span className="inv-msg">{msg}</span>}
        <button onClick={() => setModal({ kind: 'trace' })}>로트 추적</button>
        {sup && <button onClick={() => setModal({ kind: 'sku' })}>품목</button>}
      </div>
      <div className="inv-kpis">
        <Kpi id="need" label="지금 조치할 곳" val={k.act} sub={k.act ? '빨강·노랑 카드' : '모두 정상'} tone="err" />
        <div className={'inv-kpi' + (k.soon ? ' warn' : '')}><small>2주 안에 떨어질 곳</small><b>{k.soon}</b><span>소비 추이 예측 기준</span></div>
        <Kpi id="po" label="진행 중 발주" val={k.po} sub="요청 · 승인 · 배송" tone="info" />
        <div className={'inv-kpi' + (k.visit ? ' info' : '')}><small>점검할 곳</small><b>{k.visit}</b><span>점검 주기 지남</span></div>
        <Kpi id="exp" label="유효기간 주의" val={k.exp.toLocaleString()} sub="60일 안 만료 · 만료 (개)" tone="warn" />
      </div>
      <div className="inv-body">
        <div className="inv-left">
          <div className="toolbar">
            <input type="search" placeholder="병원 · 품목 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="seg">{[['all', '전체'], ['need', '조치 필요'], ['po', '발주 진행'], ['exp', '유효기간']].map(([id, l]) => <button key={id} className={only === id ? 'active' : ''} onClick={() => setOnly(id)}>{l}</button>)}</span>
            <span className="spacer" /><span className="muted small">급한 순</span>
          </div>
          <div className="inv-cards">
            {rows.map((r) => <StockCard key={r.tenant + r.sku} r={r} st={nextStep(r, sup, hos)} on={sel === `${r.tenant}|${r.sku}`} site={sum?.site} onSel={() => setSel(`${r.tenant}|${r.sku}`)} onAct={(a) => act(r, a)} />)}
            {!rows.length && <div className="inv-empty">표시할 병원이 없습니다.</div>}
          </div>
        </div>
        {selRow && (
          <aside className="inv-panel">
            <div className="inv-ph"><div><b>{selRow.tenant_name || selRow.tenant}</b><span className="muted small"> {selRow.tenant} · {selRow.sku_name} · {selRow.model === 'purchase' ? '구매(납품 때 청구)' : '위탁(쓴 만큼 청구)'}</span></div>
              {edit && <div className="inv-pact">
                <button className="primary" onClick={() => setModal({ kind: 'visit', row: selRow })}>방문 점검</button>
                {sup && <button onClick={() => setModal({ kind: 'po', row: selRow })}>발주 요청</button>}
                <button onClick={() => setModal({ kind: 'receive', row: selRow })}>발주 없이 입고</button>
                <button onClick={() => setModal({ kind: 'adjust', row: selRow })}>사용·파손·분실</button>
                {sup && <button onClick={() => setModal({ kind: 'transfer', row: selRow })}>다른 병원으로 이동</button>}
                {sup && <button className="ghost" onClick={() => setModal({ kind: 'contract', row: selRow })}>계약·보충 설정</button>}
              </div>}
            </div>
            <div className="seg inv-tabs">{[['forecast', '수요 예측'], ['po', `발주${openCount(selRow) ? ` ${openCount(selRow)}` : ''}`], ['lots', '로트'], ['statement', '월 명세'], ['ledger', '기록']].map(([id, l]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{l}</button>)}</div>
            {tab === 'forecast' && <><ForecastCard r={selRow} compact /><Basis r={selRow} /></>}
            {tab === 'po' && <PoList det={det} r={selRow} sup={sup} hos={hos} setModal={setModal} run={run} />}
            {tab === 'lots' && <LotList det={det} r={selRow} />}
            {tab === 'statement' && <Statement r={selRow} />}
            {tab === 'ledger' && <Ledger det={det} sku={selRow.sku} />}
          </aside>
        )}
      </div>
      {modal && <InvModal m={modal} rows={rowsAll} skus={sum?.skus || []} det={det} onClose={() => setModal(null)} run={run} />}
    </div>
  )
}

export function StockCard({ r, st, on, site, onSel, onAct }) {
  const d = daysLeft(r)
  const scale = Math.max(1, r.par * 1.25, r.on_hand + r.on_order)
  const pct = (v) => `${Math.min(100, (v / scale) * 100)}%`
  return (
    <div className={`inv-card2 t-${st.tone}${on ? ' on' : ''}`} onClick={onSel}>
      <div className="ic-top">
        <div className="ic-name"><b>{r.tenant_name || r.tenant}</b><span>{r.tenant}{r.tenant === site ? ' · 이 라우터' : ''} · {r.sku_name}</span></div>
        <span className={`ic-badge t-${st.tone}`}>{st.title}</span>
      </div>
      {r.started ? <>
        <div className="ic-big">
          <div><small>남은 재고</small><b>{r.on_hand.toLocaleString()}</b><span>개{r.on_order ? ` · 오는 중 ${r.on_order.toLocaleString()}` : ''}</span></div>
          <div><small>버티는 기간</small><b className={d != null && d <= r.lead_days ? 'err' : d != null && d <= 14 ? 'warnv' : ''}>{d == null ? '90+' : d}</b><span>일{r.stockout_date ? ` · ${mmdd(r.stockout_date)} 품절` : ''}</span></div>
          <div><small>앞으로 30일 필요</small><b>{(r.forecast?.next30 || 0).toLocaleString()}</b><span>개</span></div>
        </div>
        <div className="ic-gauge" title={`남은 재고 ${r.on_hand} · 오는 중 ${r.on_order} · 발주 시점 ${r.reorder_point} · 목표 ${r.par}`}>
          <i className="fill" style={{ width: pct(r.on_hand) }} />
          {r.on_order > 0 && <i className="ord" style={{ left: pct(r.on_hand), width: pct(r.on_order) }} />}
          <em className="rop" style={{ left: pct(r.reorder_point) }}><span>발주 시점</span></em>
          <em className="par" style={{ left: pct(r.par) }}><span>목표</span></em>
        </div>
      </> : <div className="ic-idle">앞으로 30일 예상 사용 <b>{(r.forecast?.next30 || 0).toLocaleString()}개</b>{r.census ? ` (착용 ${r.census.toLocaleString()}명 기준)` : ''}</div>}
      <div className="ic-foot">
        <span className="ic-text">{st.text}</span>
        {st.action && st.who && <button className={st.tone === 'err' || st.tone === 'warn' ? 'primary' : ''} onClick={(e) => { e.stopPropagation(); onAct(st.action) }}>{st.label}</button>}
      </div>
      {(r.expired > 0 || r.expiring_60d > 0) && <div className="ic-exp">{r.expired > 0 ? `유효기간 지난 ${r.expired}개 — 방문 점검에서 폐기·반품` : `60일 안 만료 ${r.expiring_60d}개 — 먼저 쓰거나 다른 병원으로 이동`}</div>}
    </div>
  )
}

export function Basis({ r }) {
  return (
    <details className="inv-basis"><summary>계산 근거 보기</summary>
      <ul>
        <li><b>발주 시점 {r.reorder_point.toLocaleString()}개</b> — 남은 재고 + 오는 중이 이만큼 이하가 되면 발주합니다. 배송 기간({r.lead_days}일) 동안 쓸 양 + 안전 여유 {r.safety_stock}개.</li>
        <li><b>목표 재고 {r.par.toLocaleString()}개</b> — 채울 때 맞추는 양. 배송 기간 + 다음 점검까지({r.review_days}일) 쓸 양 + 안전 여유.</li>
        <li><b>권장 발주 {r.suggest_boxes}상자</b> — 목표 재고 − (남은 재고 {r.on_hand} + 오는 중 {r.on_order}), {r.per_box}개 상자 단위로 올림.</li>
        <li><b>안전 여유</b> — 사용이 예측보다 많을 때를 대비한 양. 품절 방지 수준 {Math.round(r.service * 100)}%.</li>
      </ul>
    </details>
  )
}

function PoList({ det, r, sup, hos, setModal, run }) {
  const pos = (det?.pos || []).filter((p) => p.sku === r.sku)
  const open = pos.filter((p) => !['received', 'cancelled'].includes(p.status))
  const past = pos.filter((p) => ['received', 'cancelled'].includes(p.status)).slice(0, 10)
  return (<div className="inv-po">
    <div className="toolbar"><span className="muted small">요청(공급사) → 병원 승인 → 출고(공급사) → 수령 확인(병원)</span><span className="spacer" />{sup && <button className="primary" onClick={() => setModal({ kind: 'po', row: r })}>발주 요청{r.suggest_boxes ? ` (권장 ${r.suggest_boxes}상자)` : ''}</button>}</div>
    {!open.length && <div className="inv-empty small">진행 중인 발주가 없습니다.</div>}
    {open.map((p) => { const st = p.status === 'draft' ? 'submitted' : p.status; const i = STEPS.findIndex((x) => x[0] === st); return (
      <div key={p.id} className="po-card">
        <div className="po-h"><b className="mono">PO-{p.id}</b><span><b>{p.boxes.toLocaleString()}상자</b> · {(p.boxes * r.per_box).toLocaleString()}개</span><span className="muted small">{fmtD(p.created_ms)} · {p.by === 'auto' ? '자동 요청' : p.by}</span></div>
        <div className="po-steps">{STEPS.map(([s, l], k) => <span key={s} className={k < i ? 'done' : k === i ? 'cur' : ''}>{l}</span>)}</div>
        <div className="small muted">{[p.hospital_po && `병원 발주번호 ${p.hospital_po}`, p.approved_by && `승인 ${p.approved_by}`, p.tracking && `송장 ${p.tracking}`, p.eta && `도착 예정 ${p.eta}`].filter(Boolean).join(' · ') || (st === 'submitted' ? '병원 승인을 기다립니다.' : '')}</div>
        {p.lines?.length > 0 && <div className="small">{p.lines.map((l) => <span key={l.id} className="po-line mono">{l.lot} · {l.expiry || '—'} · {l.qty}개</span>)}</div>}
        <div className="po-a">
          {st === 'submitted' && hos && <button className="primary" onClick={() => setModal({ kind: 'approve', po: p, row: r })}>승인 (병원 발주번호)</button>}
          {st === 'confirmed' && sup && <button className="primary" onClick={() => setModal({ kind: 'ship', po: p, row: r })}>출고 (로트 지정)</button>}
          {st === 'shipped' && <button className="primary" onClick={() => setModal({ kind: 'recv', po: p, row: r })}>수령 확인</button>}
          {st === 'submitted' && (sup || hos) && <button className="ghost" onClick={() => window.confirm(`PO-${p.id} 요청을 지울까요?`) && run(() => api.inventory.poDelete(r.tenant, p.id), `PO-${p.id} 삭제`)}>지우기</button>}
          {st !== 'submitted' && (sup || hos) && <button className="ghost danger" onClick={() => window.confirm(`PO-${p.id} 를 취소할까요?`) && run(() => api.inventory.poUpdate(r.tenant, p.id, { status: 'cancelled' }), `PO-${p.id} 취소`)}>취소</button>}
        </div>
      </div>) })}
    {past.length > 0 && <><h4>지난 발주</h4><table className="tbl"><tbody>{past.map((p) => <tr key={p.id}><td className="mono">PO-{p.id}</td><td className="num">{p.boxes}상자</td><td><span className={'lk-pill ' + (p.status === 'received' ? 'ok' : 'off')}>{PO_LABEL[p.status]}</span></td><td className="small muted">{fmtD(p.updated_ms)}{p.received_by ? ` · ${p.received_by}` : ''}</td></tr>)}</tbody></table></>}
  </div>)
}

function LotList({ det, r }) {
  const lots = (det?.lots || []).filter((l) => l.sku === r.sku)
  const today = ymd(new Date())
  const counts = (det?.counts || []).filter((c) => c.sku === r.sku).slice(0, 5)
  return (<div><p className="muted small">위에서부터 먼저 씁니다 (유효기간 빠른 순).</p>
    <table className="tbl"><thead><tr><th>로트</th><th>유효기간</th><th className="num">수량</th><th>입고</th></tr></thead>
      <tbody>{lots.map((l) => { const exp = l.expiry && l.expiry < today; const soon = l.expiry && !exp && (new Date(l.expiry) - Date.now()) / 86400000 < 60; return (
        <tr key={l.id}><td className="mono">{l.lot}</td><td className={exp ? 'err' : soon ? 'warnv' : ''}>{l.expiry || '—'}{exp ? ' · 만료' : soon ? ' · 임박' : ''}</td><td className="num">{l.qty}</td><td className="small muted">{fmtD(l.received_ms)}{l.po ? ` · PO-${l.po}` : ''}</td></tr>) })}
        {!lots.length && <tr><td colSpan="4" className="muted">남은 로트가 없습니다.</td></tr>}</tbody></table>
    <h4>최근 방문 점검</h4>
    <table className="tbl"><tbody>{counts.map((c, i) => <tr key={i}><td className="small">{fmtD(c.ms)}</td><td className="small">{c.by}</td><td className="num">기록 {c.book} → 실제 {c.counted}</td><td className={'num ' + (c.counted - c.book ? 'warnv' : 'okv')}>{c.counted - c.book > 0 ? '+' : ''}{c.counted - c.book}</td><td className="small muted">{c.note}</td></tr>)}
      {!counts.length && <tr><td className="muted">점검 기록이 없습니다.</td></tr>}</tbody></table></div>)
}

function Statement({ r }) {
  const [month, setMonth] = useState(() => ymd(new Date()).slice(0, 7))
  const [st, setSt] = useState(null)
  useEffect(() => { let ok = true; api.inventory.statement(r.tenant, month).then((d) => ok && setSt(d)).catch(() => ok && setSt(null)); return () => { ok = false } }, [r.tenant, month])
  const lines = (st?.lines || []).filter((l) => l.sku === r.sku)
  return (<div className="inv-stmt">
    <div className="toolbar"><label className="muted small">월 <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label><span className="spacer" /><button onClick={() => printStatement(r, month, lines)}>인쇄 · PDF</button></div>
    {!lines.length && <div className="inv-empty small">이 달 사용·입고 기록이 없습니다.</div>}
    {lines.map((l) => <div key={l.sku}>
      <table className="tbl"><tbody>
        <tr><th>운영 방식</th><td>{l.model === 'purchase' ? '구매 — 납품(입고) 수량 청구' : '위탁 — 사용 수량 청구'}</td></tr>
        <tr><th>사용</th><td className="num">{l.used.toLocaleString()}개</td></tr><tr><th>입고</th><td className="num">{l.received.toLocaleString()}개</td></tr>
        <tr><th>청구 수량 × 단가</th><td className="num">{l.billable.toLocaleString()} × {money(l.unit_price)}</td></tr><tr><th>청구 금액</th><td className="num"><b>{money(l.amount)}</b></td></tr>
      </tbody></table>
      <h4>날짜별 사용</h4><div className="stmt-days">{Object.entries(l.days).map(([d, n]) => <span key={d}><small>{mmdd(d)}</small><b>{n}</b></span>)}</div>
    </div>)}
  </div>)
}
function printStatement(r, month, lines) {
  const w = window.open('', '_blank'); if (!w) return
  const rows = lines.map((l) => `<h3>${r.sku_name} (${l.sku})</h3><p>${l.model === 'purchase' ? '구매 — 납품 수량 청구' : '위탁 — 사용 수량 청구'}</p><table><tr><th>사용</th><td>${l.used}</td></tr><tr><th>입고</th><td>${l.received}</td></tr><tr><th>청구 수량</th><td>${l.billable}</td></tr><tr><th>단가</th><td>${money(l.unit_price)}</td></tr><tr><th>청구 금액</th><td><b>${money(l.amount)}</b></td></tr></table><h4>날짜별 사용</h4><table><tr>${Object.keys(l.days).map((d) => `<th>${d.slice(5)}</th>`).join('')}</tr><tr>${Object.values(l.days).map((n) => `<td>${n}</td>`).join('')}</tr></table>`).join('')
  w.document.write(`<!doctype html><meta charset="utf-8"><title>사용 명세 ${r.tenant} ${month}</title><style>body{font-family:system-ui,sans-serif;padding:24px;color:#111}table{border-collapse:collapse;margin:6px 0}th,td{border:1px solid #999;padding:4px 8px;font-size:12px}th{background:#eef}.sig{margin-top:40px;display:flex;gap:60px}</style><h2>월 사용 명세서 — ${month}</h2><p><b>${r.tenant_name || r.tenant}</b> (${r.tenant})</p>${rows || '<p>기록 없음</p>'}<div class="sig"><span>공급사 확인: ______________</span><span>병원 확인: ______________</span></div><script>print()</script>`)
  w.document.close()
}

function Ledger({ det, sku }) {
  const rows = (det?.ledger || []).filter((l) => l.sku === sku)
  const out = []
  for (const l of rows) {
    const day = new Date(l.ms).toLocaleDateString('ko-KR')
    const grp = l.reason === 'patch_attach' || l.reason === 'shortage'
    const last = out[out.length - 1]
    if (grp && last && last.grp === l.reason && last.day === day) { last.qty += l.qty; last.n++ } else out.push({ ...l, day, grp: grp ? l.reason : null, n: 1 })
  }
  return (<div className="tbl-wrap inv-ledger"><table className="tbl"><thead><tr><th>일시</th><th>내용</th><th className="num">수량</th><th>처리자</th></tr></thead>
    <tbody>{out.slice(0, 150).map((l, i) => <tr key={i}><td className="small">{l.grp ? l.day : new Date(l.ms).toLocaleString('ko-KR', { hour12: false })}</td>
      <td>{l.grp === 'patch_attach' ? `패치 부착 ${l.n}건 (자동 차감)` : l.grp === 'shortage' ? `재고 기록 없을 때 부착 ${l.n}건` : KIND_LABEL[l.kind] || l.kind}{!l.grp && REASON_LABEL[l.reason] ? <span className="muted small"> · {REASON_LABEL[l.reason]}</span> : null}{l.lot ? <span className="muted small mono"> · {l.lot}</span> : null}{l.ref && !l.grp ? <span className="muted small"> · {l.ref}</span> : null}</td>
      <td className={'num ' + (l.qty < 0 ? 'err' : l.qty > 0 ? 'okv' : '')}>{l.qty > 0 ? `+${l.qty}` : l.qty || '—'}</td><td className="small muted">{l.by}</td></tr>)}
      {!out.length && <tr><td colSpan="4" className="muted">기록이 없습니다.</td></tr>}</tbody></table></div>)
}

/** 바코드 입력칸: 스캐너(키보드식)로 찍거나 붙여넣으면 GS1 을 해석해 onScan({lot, expiry}) */
function ScanBox({ onScan, ph }) {
  const [v, setV] = useState('')
  const ref = useRef(null)
  useEffect(() => { ref.current?.focus() }, [])
  const go = () => { const g = parseGS1(v); if (g && (g.lot || g.expiry)) onScan(g); else if (v.trim()) onScan({ lot: v.trim(), expiry: '' }); setV('') }
  return <div className="scanbox"><span>▦</span><input ref={ref} value={v} placeholder={ph || '상자 바코드를 스캔하세요 (GS1) — 또는 로트 번호 입력 후 Enter'} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }} /></div>
}

function Modal({ title, sub, onClose, children, foot, wide }) {
  return (<div className="modal-bg" onClick={onClose}><div className={'modal inv-modal' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
    <div className="modal-head"><h2>{title} {sub && <small>{sub}</small>}</h2><span className="spacer" /><button className="icon" onClick={onClose}>✕</button></div>
    <div className="inv-form">{children}</div>
    {foot && <div className="toolbar inv-foot"><span className="spacer" />{foot}</div>}
  </div></div>)
}

export function InvModal({ m, rows, skus, det, onClose, run }) {
  const r = m.row || {}
  const t = r.tenant
  const sub = r.tenant_name ? `${r.tenant_name} · ${r.sku_name}` : ''
  const [busy, setBusy] = useState(false)
  const go = async (f, msg) => { setBusy(true); try { await run(f, msg) } catch { /* 메시지는 상단 */ } finally { setBusy(false) } }
  const Save = ({ label = '저장', dis, on }) => <><button onClick={onClose}>닫기</button><button className="primary" disabled={busy || dis} onClick={on}>{label}</button></>

  if (m.kind === 'po') return <PoModal r={r} sub={sub} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'approve') return <ApproveModal r={r} p={m.po} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'ship') return <ShipModal r={r} p={m.po} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'recv') return <RecvModal r={r} p={m.po} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'receive') return <ManualReceive r={r} sub={sub} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'visit') return <VisitModal r={r} sub={sub} det={det} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'adjust') return <AdjustModal r={r} sub={sub} det={det} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'transfer') return <TransferModal r={r} sub={sub} det={det} rows={rows} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'contract') return <ContractModal r={r} sub={sub} onClose={onClose} Save={Save} go={go} />
  if (m.kind === 'trace') return <TraceModal onClose={onClose} />
  if (m.kind === 'sku') return <SkuModal skus={skus} onClose={onClose} Save={Save} go={go} />
  return <Modal title="?" onClose={onClose}>{t}</Modal>
}

function PoModal({ r, sub, onClose, Save, go }) {
  const [boxes, setBoxes] = useState(r.suggest_boxes || 1)
  const [note, setNote] = useState('')
  const n = Number(boxes) || 0
  const big = r.suggest_boxes ? n > r.suggest_boxes * 3 : n > 100
  return (<Modal title="발주 요청" sub={sub} onClose={onClose} foot={<Save label="병원에 요청" dis={n < 1} on={() => go(() => api.inventory.poCreate(r.tenant, { sku: r.sku, boxes: n, note }), `${r.tenant} 발주 요청 ${n}상자`)} />}>
    <div className="po-qty"><label>상자 수<input type="number" min="1" value={boxes} onChange={(e) => setBoxes(e.target.value)} /></label><div className="po-eq">= <b>{(n * r.per_box).toLocaleString()}개</b><span>상자당 {r.per_box}개</span></div></div>
    {r.suggest_boxes > 0 && <p className="muted small">권장 {r.suggest_boxes}상자: 목표 재고 {r.par.toLocaleString()} − (남은 재고 {r.on_hand.toLocaleString()} + 오는 중 {r.on_order.toLocaleString()}) 를 상자 단위로 올림. <button className="link" onClick={() => setBoxes(r.suggest_boxes)}>권장값 넣기</button></p>}
    {big && <p className="warn-box">입력값이 {r.suggest_boxes ? `권장의 ${(n / r.suggest_boxes).toFixed(1)}배` : '매우 큽니다'}. 개수(개)를 상자 칸에 넣지 않았는지 확인하세요.</p>}
    {r.unit_price > 0 && <p className="muted small">예상 금액 {money(n * r.per_box * r.unit_price)}</p>}
    <label>메모 (병원에 보임)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="예: 다음 주 화요일 오전 배송 희망" /></label>
    <p className="muted small">요청 후 병원 담당자가 병원 발주번호를 넣어 승인하면 출고할 수 있습니다.</p>
  </Modal>)
}

function ApproveModal({ r, p, onClose, Save, go }) {
  const [po, setPo] = useState('')
  return (<Modal title={`PO-${p.id} 승인`} sub={`${p.boxes}상자 · ${(p.boxes * r.per_box).toLocaleString()}개`} onClose={onClose} foot={<Save label="승인" on={() => go(() => api.inventory.poApprove(r.tenant, p.id, { hospital_po: po }), `PO-${p.id} 승인`)} />}>
    {p.note && <p className="muted small">공급사 메모: {p.note}</p>}
    <label>병원 발주번호 (구매 시스템 번호 · 없으면 비워 두기)<input value={po} onChange={(e) => setPo(e.target.value)} autoFocus /></label>
    <p className="muted small">승인하면 공급사가 출고합니다. 수량이 다르면 승인하지 말고 공급사에 연락하세요.</p>
  </Modal>)
}

function ShipModal({ r, p, onClose, Save, go }) {
  const total = p.boxes * r.per_box
  const [lines, setLines] = useState([{ lot: '', expiry: '', qty: total }])
  const [tracking, setTracking] = useState('')
  const [eta, setEta] = useState(addDays(Math.ceil(r.lead_days || 3)))
  const sum = lines.reduce((a, l) => a + (Number(l.qty) || 0), 0)
  const upd = (i, k, v) => setLines(lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)))
  const onScan = (g) => {
    const i = lines.findIndex((l) => l.lot === g.lot)
    if (i >= 0) return upd(i, 'qty', (Number(lines[i].qty) || 0) + r.per_box)
    const empty = lines.findIndex((l) => !l.lot)
    if (empty >= 0) return setLines(lines.map((l, j) => (j === empty ? { ...l, lot: g.lot, expiry: g.expiry || l.expiry } : l)))
    setLines([...lines, { lot: g.lot, expiry: g.expiry, qty: r.per_box }])
  }
  const ok = lines.every((l) => l.lot.trim() && Number(l.qty) > 0)
  return (<Modal wide title={`PO-${p.id} 출고`} sub={`${p.boxes}상자 = ${total.toLocaleString()}개${p.hospital_po ? ` · 병원 발주번호 ${p.hospital_po}` : ''}`} onClose={onClose}
    foot={<Save label="출고 완료" dis={!ok} on={() => go(() => api.inventory.poShip(r.tenant, p.id, { lines: lines.map((l) => ({ ...l, qty: Number(l.qty) })), tracking, eta }), `PO-${p.id} 출고`)} />}>
    <ScanBox onScan={onScan} />
    <p className="muted small">보내는 상자의 로트를 스캔하세요. 같은 로트를 다시 찍으면 한 상자({r.per_box}개)씩 늘어납니다. 로트가 여러 개면 줄이 추가됩니다.</p>
    <table className="tbl"><thead><tr><th>로트</th><th>유효기간</th><th className="num">수량(개)</th><th /></tr></thead>
      <tbody>{lines.map((l, i) => <tr key={i}><td><input value={l.lot} onChange={(e) => upd(i, 'lot', e.target.value)} placeholder="LOT" /></td><td><input type="date" value={l.expiry} onChange={(e) => upd(i, 'expiry', e.target.value)} /></td><td><input type="number" className="num" value={l.qty} onChange={(e) => upd(i, 'qty', e.target.value)} /></td><td>{lines.length > 1 && <button className="icon" onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>}</td></tr>)}</tbody>
      <tfoot><tr><td colSpan="2"><button className="link" onClick={() => setLines([...lines, { lot: '', expiry: '', qty: r.per_box }])}>+ 로트 줄 추가</button></td><td className={'num ' + (sum !== total ? 'warnv' : '')}>{sum.toLocaleString()} / {total.toLocaleString()}</td><td /></tr></tfoot></table>
    {sum !== total && <p className="warn-box">출고 합계가 발주 수량과 다릅니다. 부분 출고면 그대로 진행해도 됩니다.</p>}
    <div className="inv-row2"><label>송장 번호<input value={tracking} onChange={(e) => setTracking(e.target.value)} /></label><label>도착 예정<input type="date" value={eta} onChange={(e) => setEta(e.target.value)} /></label></div>
  </Modal>)
}

function RecvModal({ r, p, onClose, Save, go }) {
  const [got, setGot] = useState(() => Object.fromEntries((p.lines || []).map((l) => [l.id, l.qty])))
  const diff = (p.lines || []).some((l) => Number(got[l.id]) !== l.qty)
  return (<Modal title={`PO-${p.id} 수령 확인`} sub={p.tracking ? `송장 ${p.tracking}` : ''} onClose={onClose}
    foot={<Save label={diff ? '차이 기록하고 수령' : '모두 받음'} on={() => go(() => api.inventory.poReceive(r.tenant, p.id, { lines: Object.fromEntries(Object.entries(got).map(([k, v]) => [k, Number(v) || 0])) }), (n) => `PO-${p.id} 수령 ${n?.result ?? ''}개`)} />}>
    <p className="muted small">상자를 열어 로트별로 받은 수량을 확인하세요. 다르면 실제로 받은 수량으로 고칩니다.</p>
    <table className="tbl"><thead><tr><th>로트</th><th>유효기간</th><th className="num">보낸 수량</th><th className="num">받은 수량</th></tr></thead>
      <tbody>{(p.lines || []).map((l) => <tr key={l.id}><td className="mono">{l.lot}</td><td>{l.expiry || '—'}</td><td className="num">{l.qty}</td><td><input type="number" className="num" value={got[l.id]} onChange={(e) => setGot({ ...got, [l.id]: e.target.value })} /></td></tr>)}</tbody></table>
    {diff && <p className="warn-box">보낸 수량과 다릅니다 — 차이가 기록에 남고 공급사가 확인합니다.</p>}
  </Modal>)
}

function ManualReceive({ r, sub, onClose, Save, go }) {
  const [f, setF] = useState({ lot: '', expiry: '', qty: r.per_box || 10 })
  return (<Modal title={r.started ? '발주 없이 입고' : '첫 입고 등록'} sub={sub} onClose={onClose} foot={<Save label="입고" dis={!f.lot.trim() || Number(f.qty) < 1} on={() => go(() => api.inventory.receive(r.tenant, { sku: r.sku, lot: f.lot, expiry: f.expiry, qty: Number(f.qty) }), `${r.tenant} 입고 ${f.qty}개`)} />}>
    {!r.started && <p className="muted small">지금 병원에 있는 패치를 로트별로 등록하세요. 이후 사용은 자동으로 빠집니다.</p>}
    <ScanBox onScan={(g) => setF({ ...f, lot: g.lot || f.lot, expiry: g.expiry || f.expiry })} />
    <div className="inv-row2"><label>로트 번호<input value={f.lot} onChange={(e) => setF({ ...f, lot: e.target.value })} /></label><label>유효기간<input type="date" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} /></label></div>
    <div className="po-qty"><label>수량(개)<input type="number" min="1" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} /></label><div className="po-eq">= <b>{(Number(f.qty) / (r.per_box || 1)).toFixed(1)}상자</b></div></div>
  </Modal>)
}

function VisitModal({ r, sub, det, onClose, Save, go }) {
  const lots = (det?.lots || []).filter((l) => l.sku === r.sku)
  const today = ymd(new Date())
  const [c, setC] = useState(() => Object.fromEntries(lots.map((l) => [l.id, { counted: l.qty, action: l.expiry && l.expiry < today ? 'discard' : '' }])))
  const [extra, setExtra] = useState(0)
  const [who, setWho] = useState('')
  const [note, setNote] = useState('')
  const [hit, setHit] = useState(null)
  const book = lots.reduce((a, l) => a + l.qty, 0)
  const counted = lots.reduce((a, l) => a + (Number(c[l.id]?.counted) || 0), 0) + (Number(extra) || 0)
  const set = (id, k, v) => setC({ ...c, [id]: { ...c[id], [k]: v } })
  const onScan = (g) => { const l = lots.find((x) => x.lot === g.lot); if (l) { setHit(l.id); document.getElementById(`vc-${l.id}`)?.focus() } else setHit('none') }
  return (<Modal wide title="방문 점검" sub={sub} onClose={onClose}
    foot={<Save label="점검 저장" dis={!who.trim()} on={() => go(() => api.inventory.count(r.tenant, { sku: r.sku, counts: lots.map((l) => ({ lot_id: l.id, counted: Number(c[l.id]?.counted) || 0, action: c[l.id]?.action || '' })), extra_found: Number(extra) || 0, note: `병원 확인: ${who}${note ? ` · ${note}` : ''}` }), (res) => `점검 저장 — 기록 ${res?.result?.book} → 실제 ${res?.result?.counted}`)} />}>
    <ol className="visit-steps"><li>보관 장소의 상자를 로트별로 셉니다 (스캔하면 그 줄로 이동).</li><li>센 수량을 넣습니다. 기본값은 기록 수량입니다.</li><li>유효기간 지난 로트는 폐기 또는 반품을 고릅니다.</li><li>함께 확인한 병원 담당자 이름을 넣고 저장합니다.</li></ol>
    <ScanBox onScan={onScan} ph="로트 바코드 스캔 → 그 줄로 이동" />
    {hit === 'none' && <p className="warn-box">기록에 없는 로트입니다. 아래 '기록에 없는 재고'에 수량을 넣으세요.</p>}
    {r.unrecorded_use > 0 && <p className="warn-box">재고 기록이 없을 때 {r.unrecorded_use}개가 부착됐습니다. 실제로 센 수량으로 맞추면 해소됩니다.</p>}
    <table className="tbl"><thead><tr><th>로트</th><th>유효기간</th><th className="num">기록</th><th className="num">실제로 센 수량</th><th>조치</th></tr></thead>
      <tbody>{lots.map((l) => { const exp = l.expiry && l.expiry < today; const d = (Number(c[l.id]?.counted) || 0) - l.qty; return (
        <tr key={l.id} className={hit === l.id ? 'selected' : ''}><td className="mono">{l.lot}</td><td className={exp ? 'err' : ''}>{l.expiry || '—'}{exp ? ' · 만료' : ''}</td><td className="num">{l.qty}</td>
          <td><input id={`vc-${l.id}`} type="number" min="0" className="num" value={c[l.id]?.counted ?? ''} onChange={(e) => set(l.id, 'counted', e.target.value)} />{d !== 0 && <span className={'vd ' + (d < 0 ? 'err' : 'okv')}>{d > 0 ? '+' : ''}{d}</span>}</td>
          <td><select value={c[l.id]?.action || ''} onChange={(e) => set(l.id, 'action', e.target.value)}><option value="">그대로 둠</option><option value="discard">폐기 (만료·파손)</option><option value="return">반품</option></select></td></tr>) })}
        {!lots.length && <tr><td colSpan="5" className="muted">기록된 로트가 없습니다.</td></tr>}
        <tr><td colSpan="3">기록에 없는 재고 (발견)</td><td><input type="number" min="0" className="num" value={extra} onChange={(e) => setExtra(e.target.value)} /></td><td /></tr></tbody>
      <tfoot><tr><th colSpan="2">합계</th><th className="num">{book}</th><th className={'num ' + (counted !== book ? 'warnv' : '')}>{counted} ({counted - book > 0 ? '+' : ''}{counted - book})</th><th /></tr></tfoot></table>
    <div className="inv-row2"><label>병원 확인자 (필수)<input value={who} onChange={(e) => setWho(e.target.value)} placeholder="예: 7병동 수간호사 김OO" /></label><label>메모<input value={note} onChange={(e) => setNote(e.target.value)} /></label></div>
  </Modal>)
}

function AdjustModal({ r, sub, det, onClose, Save, go }) {
  const lots = (det?.lots || []).filter((l) => l.sku === r.sku)
  const [kind, setKind] = useState('use')
  const [qty, setQty] = useState(1)
  const [lot, setLot] = useState('')
  const K = [['use', '사용 (수동)', '자동 차감이 안 되는 사용'], ['damaged', '파손', '뜯김·불량'], ['lost', '분실', '찾을 수 없음'], ['found', '발견', '기록 없는 재고를 찾음']]
  const body = kind === 'use' ? { kind: 'use', qty: Number(qty) } : { kind: 'adjust', qty: kind === 'found' ? Math.abs(Number(qty)) : -Math.abs(Number(qty)), reason: kind === 'found' ? 'other' : kind, lot: lot ? Number(lot) : undefined }
  return (<Modal title="사용 · 파손 · 분실" sub={sub} onClose={onClose} foot={<Save dis={Number(qty) < 1} on={() => go(() => api.inventory.adjust(r.tenant, { sku: r.sku, ...body }), `${r.tenant} ${K.find((x) => x[0] === kind)[1]} ${qty}개`)} />}>
    <div className="adj-kinds">{K.map(([id, l, d]) => <button key={id} className={kind === id ? 'active' : ''} onClick={() => setKind(id)}><b>{l}</b><small>{d}</small></button>)}</div>
    <label>수량(개)<input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
    {(kind === 'damaged' || kind === 'lost') && <label>로트 (모르면 비워 두기 — 유효기간 빠른 것부터)<select value={lot} onChange={(e) => setLot(e.target.value)}><option value="">자동</option>{lots.map((l) => <option key={l.id} value={l.id}>{l.lot} · {l.expiry || '—'} · {l.qty}개</option>)}</select></label>}
    {kind === 'use' && r.tenant && <p className="muted small">이 라우터 병원의 패치 부착은 자동으로 빠집니다. 수동 사용은 다른 병원이나 예외에만 쓰세요.</p>}
  </Modal>)
}

function TransferModal({ r, sub, det, rows, onClose, Save, go }) {
  const lots = (det?.lots || []).filter((l) => l.sku === r.sku && l.qty > 0)
  const today = ymd(new Date())
  const soonFirst = [...lots].sort((a, b) => (a.expiry || '9999').localeCompare(b.expiry || '9999'))
  const targets = rows.filter((x) => x.sku === r.sku && x.tenant !== r.tenant).sort((a, b) => (daysLeft(a) ?? 999) - (daysLeft(b) ?? 999))
  const [lot, setLot] = useState(soonFirst[0]?.id || '')
  const [to, setTo] = useState(targets[0]?.tenant || '')
  const [qty, setQty] = useState(r.per_box || 10)
  return (<Modal title="다른 병원으로 이동" sub={sub} onClose={onClose} foot={<Save label="이동" dis={!lot || !to || Number(qty) < 1} on={() => go(() => api.inventory.transfer({ from: r.tenant, to, lot_id: Number(lot), qty: Number(qty) }), `${r.tenant} → ${to} ${qty}개 이동`)} />}>
    <p className="muted small">유효기간이 가까운 로트를 더 빨리 쓰는 병원으로 옮겨 폐기를 줄입니다. 같은 로트·유효기간으로 옮겨집니다.</p>
    <label>보낼 로트<select value={lot} onChange={(e) => setLot(e.target.value)}>{soonFirst.map((l) => <option key={l.id} value={l.id}>{l.lot} · {l.expiry || '—'}{l.expiry && l.expiry < today ? ' (만료)' : ''} · {l.qty}개</option>)}</select></label>
    <label>받을 병원 (품절이 빠른 순)<select value={to} onChange={(e) => setTo(e.target.value)}>{targets.map((x) => <option key={x.tenant} value={x.tenant}>{x.tenant_name || x.tenant} · 남은 {x.on_hand}개 · {daysLeft(x) == null ? '90일+' : `${daysLeft(x)}일분`}</option>)}</select></label>
    <label>수량(개)<input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
  </Modal>)
}

function ContractModal({ r, sub, onClose, Save, go }) {
  const [f, setF] = useState({ model: r.model || 'consign', price: r.unit_price || '', contract_end: r.contract_end || '', committed: r.committed || 0, lead_days: r.lead_days ?? 7, review_days: r.review_days ?? 7, count_days: r.count_days ?? 30, service: r.service ?? 0.95, min_boxes: r.min_boxes ?? 1, auto_request: !!r.auto_request })
  const s = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const body = { sku: r.sku, model: f.model, price: f.price === '' ? null : Number(f.price), contract_end: f.contract_end, committed: Number(f.committed) || 0, lead_days: Number(f.lead_days), review_days: Number(f.review_days), count_days: Number(f.count_days), service: Number(f.service), min_boxes: Number(f.min_boxes) || 0, auto_request: f.auto_request }
  return (<Modal wide title="계약 · 보충 설정" sub={sub} onClose={onClose} foot={<Save on={() => go(() => api.inventory.contract(r.tenant, body), `${r.tenant} 계약·보충 설정 저장`)} />}>
    <h4>계약</h4>
    <div className="model-pick">{[['consign', '위탁', '공급사 소유 · 쓴 만큼 매달 청구'], ['purchase', '구매', '병원 소유 · 납품(입고) 때 청구']].map(([id, l, d]) => <button key={id} className={f.model === id ? 'active' : ''} onClick={() => setF({ ...f, model: id })}><b>{l}</b><small>{d}</small></button>)}</div>
    <div className="inv-row3"><label>병원 단가 (원 · 비우면 품목 기본가)<input type="number" min="0" value={f.price} onChange={s('price')} /></label><label>약정 수량 (월, 개)<input type="number" min="0" value={f.committed} onChange={s('committed')} /></label><label>계약 종료일<input type="date" value={f.contract_end} onChange={s('contract_end')} /></label></div>
    <h4>보충</h4>
    <div className="inv-row3">
      <label>배송 기간 (일) <small>주문부터 병동 도착까지 — 병원 창고 이동 포함</small><input type="number" min="0" step="0.5" value={f.lead_days} onChange={s('lead_days')} /></label>
      <label>재고 확인 주기 (일) <small>다음 발주 판단까지 걸리는 기간</small><input type="number" min="1" value={f.review_days} onChange={s('review_days')} /></label>
      <label>방문 점검 주기 (일) <small>현장에서 세는 간격</small><input type="number" min="1" value={f.count_days} onChange={s('count_days')} /></label>
    </div>
    <div className="inv-row3">
      <label>품절 방지 수준<select value={f.service} onChange={s('service')}><option value={0.9}>보통 (90%) — 재고 적게</option><option value={0.95}>권장 (95%)</option><option value={0.99}>높음 (99%) — 재고 많이</option></select></label>
      <label>최소 발주 (상자)<input type="number" min="0" value={f.min_boxes} onChange={s('min_boxes')} /></label>
      <label className="ck"><input type="checkbox" checked={f.auto_request} onChange={s('auto_request')} /><span>자동 발주 요청<small>발주 시점에 닿으면 권장 수량으로 요청을 만들어 병원 승인을 기다립니다</small></span></label>
    </div>
    <p className="muted small">지금 기준: 발주 시점 {r.reorder_point.toLocaleString()}개 · 목표 재고 {r.par.toLocaleString()}개 (하루 약 {Math.round((r.forecast?.next30 || 0) / 30)}개 사용 예측)</p>
  </Modal>)
}

function TraceModal({ onClose }) {
  const [lot, setLot] = useState('')
  const [res, setRes] = useState(null)
  const find = (l) => { setLot(l); if (l.trim()) api.inventory.trace(l.trim()).then(setRes).catch(() => setRes({ rows: [] })) }
  return (<Modal title="로트 추적" sub="리콜 · 품질 문의" onClose={onClose} foot={<button onClick={onClose}>닫기</button>}>
    <ScanBox onScan={(g) => find(g.lot)} ph="로트 바코드 스캔 또는 로트 번호 입력 후 Enter" />
    {res && <><p className="small">로트 <b className="mono">{lot}</b> — {res.rows.length ? `${new Set(res.rows.map((x) => x.tenant)).size}개 병원, 남은 수량 ${res.rows.reduce((a, x) => a + x.qty, 0).toLocaleString()}개` : '맡은 병원에서 찾지 못했습니다'}</p>
      <table className="tbl"><thead><tr><th>병원</th><th>유효기간</th><th className="num">남은 수량</th><th>입고</th></tr></thead><tbody>{res.rows.map((x) => <tr key={x.id}><td>{x.tenant}</td><td>{x.expiry || '—'}</td><td className="num">{x.qty}</td><td className="small muted">{fmtD(x.received_ms)}{x.po ? ` · PO-${x.po}` : ''}</td></tr>)}</tbody></table></>}
  </Modal>)
}

function SkuModal({ skus, onClose, Save, go }) {
  const [f, setF] = useState({ id: '', name: '', per_box: 10, unit_price: 0, wear_days: 14 })
  return (<Modal title="품목" onClose={onClose} foot={<Save dis={!f.id.trim()} on={() => go(() => api.inventory.sku({ ...f, per_box: Number(f.per_box), unit_price: Number(f.unit_price), wear_days: Number(f.wear_days) }), `품목 ${f.id} 저장`)} />}>
    <table className="tbl"><thead><tr><th>코드</th><th>이름</th><th className="num">개/상자</th><th className="num">기본 단가</th><th className="num">착용 일수</th></tr></thead><tbody>{skus.map((s) => <tr key={s.id} className="clickable" onClick={() => setF({ ...s })}><td className="mono">{s.id}</td><td>{s.name}</td><td className="num">{s.per_box}</td><td className="num">{money(s.unit_price)}</td><td className="num">{s.wear_days}</td></tr>)}</tbody></table>
    <p className="muted small">줄을 누르면 고칠 수 있습니다. 새 코드를 넣으면 추가됩니다.</p>
    <div className="inv-row3"><label>코드<input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} /></label><label>이름<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label><label>상자당 수량<input type="number" min="1" value={f.per_box} onChange={(e) => setF({ ...f, per_box: e.target.value })} /></label></div>
    <div className="inv-row3"><label>기본 단가(원)<input type="number" min="0" value={f.unit_price} onChange={(e) => setF({ ...f, unit_price: e.target.value })} /></label><label>착용 일수<input type="number" min="1" value={f.wear_days} onChange={(e) => setF({ ...f, wear_days: e.target.value })} /></label></div>
  </Modal>)
}

const METHOD = { holt_winters: '최근 추세와 요일별 패턴', holt_damped: '최근 추세', mean: '최근 평균', none: '이력 없음' }
const dayLabel = (i) => { const d = new Date(Date.now() + i * 86400000); return `${d.getMonth() + 1}/${d.getDate()}` }
const niceMax = (v) => { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p }

/** 수요 예측 카드: ① 재고 전망(언제 바닥나나) ② 하루 사용량(실제 vs 예측) ③ 필요량 숫자 — 그래프마다 결론 문장 + 범례 */
export function ForecastCard({ r, compact }) {
  const f = r.forecast
  const [h, setH] = useState(30)
  if (!f) return null
  const d = daysLeft(r)
  const avg = f.next30 / 30
  const W = compact ? 560 : 1000, L = 44, R = 10
  // ① 재고 전망
  const proj = [r.on_hand, ...(r.projection || []).slice(0, h)]
  const pMax = niceMax(Math.max(r.par, r.on_hand + r.on_order, ...proj, 1) * 1.08)
  const H1 = 190, T1 = 22, B1 = 22
  const px = (i) => L + (i / h) * (W - L - R)
  const py = (v) => H1 - B1 - (Math.max(0, v) / pMax) * (H1 - B1 - T1)
  const line = proj.map((v, i) => `${px(i)},${py(v)}`).join(' ')
  const area = `${px(0)},${py(0)} ${line} ${px(proj.length - 1)},${py(0)}`
  const soIdx = d != null && d <= h ? d : null
  const obIdx = r.order_by ? Math.max(0, Math.round((new Date(r.order_by) - new Date(new Date().toDateString())) / 86400000)) : null
  const tickStep = h <= 30 ? 7 : h <= 60 ? 14 : 21
  const xticks = Array.from({ length: Math.floor(h / tickStep) + 1 }, (_, k) => k * tickStep)
  // ② 하루 사용량
  const hist = (r.history || []).slice(compact ? -28 : -42)
  const fut = f.daily.slice(0, h)
  const n = hist.length + fut.length
  const H2 = 160, T2 = 20, B2 = 22
  const uMax = niceMax(Math.max(1, ...hist, ...f.hi.slice(0, h)) * 1.1)
  const ux = (i) => L + ((i + 0.5) / Math.max(1, n)) * (W - L - R)
  const uy = (v) => H2 - B2 - (v / uMax) * (H2 - B2 - T2)
  const bw = Math.max(1.5, (W - L - R) / Math.max(1, n) - 1.5)
  const off = hist.length
  const band = fut.map((_, i) => `${ux(off + i)},${uy(f.hi[i])}`).join(' ') + ' ' + fut.map((_, i) => `${ux(off + fut.length - 1 - i)},${uy(f.lo[fut.length - 1 - i])}`).join(' ')
  const fline = fut.map((v, i) => `${ux(off + i)},${uy(v)}`).join(' ')
  const uticks = [...Array.from({ length: Math.ceil(hist.length / 7) }, (_, k) => off - 7 - k * 7).filter((i) => i >= 0), ...Array.from({ length: Math.floor((fut.length - 1) / 7) + 1 }, (_, k) => off + k * 7)]
  const shortHist = f.history_days < 28 && f.prior != null
  return (
    <section className={'inv-card inv-fc' + (compact ? ' compact' : '')}>
      <div className="inv-fc-top">
        <span className="muted small">보기 범위</span>
        <span className="seg">{[30, 60, 90].map((k) => <button key={k} className={h === k ? 'active' : ''} onClick={() => setH(k)}>{k}일</button>)}</span>
      </div>

      <h4 className="fc-h">① 재고 전망 — 지금 재고로 언제까지 버티나</h4>
      <p className="fc-say">{!r.started ? '입고를 등록하면 재고 전망을 그립니다.' : d == null
        ? <>지금 재고 <b>{r.on_hand.toLocaleString()}개</b>{r.on_order ? ` + 오는 중 ${r.on_order.toLocaleString()}개` : ''}로 <b>90일 넘게</b> 버팁니다.</>
        : <>지금 재고 <b>{r.on_hand.toLocaleString()}개</b>{r.on_order ? ` + 오는 중 ${r.on_order.toLocaleString()}개` : ''}로 <b className="err">{mmdd(r.stockout_date)}까지 ({d}일)</b> 버팁니다. {r.order_by && <>배송에 {r.lead_days}일 걸리니 <b>{mmdd(r.order_by)}까지 발주</b>해야 끊기지 않습니다.</>}</>}</p>
      {r.started && <svg className="inv-fc-svg" viewBox={`0 0 ${W} ${H1}`}>
        {[0, pMax / 2, pMax].map((t) => <g key={t}><line x1={L} x2={W - R} y1={py(t)} y2={py(t)} className="g" /><text x={L - 5} y={py(t) + 3} textAnchor="end">{Math.round(t).toLocaleString()}</text></g>)}
        <text x={L} y={11} className="unit">(개)</text>
        {soIdx != null && <rect x={px(soIdx)} y={T1} width={Math.max(0, px(h) - px(soIdx))} height={H1 - B1 - T1} className="shortz" />}
        <polygon points={area} className="stk-a" /><polyline points={line} className="stk" />
        <line x1={L} x2={W - R} y1={py(r.reorder_point)} y2={py(r.reorder_point)} className="ropl" /><text x={W - R - 2} y={py(r.reorder_point) - 4} textAnchor="end" className="lbl rop">발주 시점 {r.reorder_point.toLocaleString()}개</text>
        <line x1={L} x2={W - R} y1={py(r.par)} y2={py(r.par)} className="parl" /><text x={W - R - 2} y={py(r.par) - 4} textAnchor="end" className="lbl par">목표 {r.par.toLocaleString()}개</text>
        {(r.arrivals || []).filter(([i]) => i <= h).map(([i, u], k) => <g key={k}><line x1={px(i)} x2={px(i)} y1={T1} y2={H1 - B1} className="arr" /><text x={px(i) + 3} y={T1 + 22} className="lbl arr">입고 +{Math.round(u).toLocaleString()}</text></g>)}
        {obIdx != null && obIdx <= h && <g><line x1={px(obIdx)} x2={px(obIdx)} y1={T1} y2={H1 - B1} className="obl" /><text x={px(obIdx) + 3} y={T1 + 9} className="lbl ob">발주 기한 {mmdd(r.order_by)}</text></g>}
        {soIdx != null && <text x={px(soIdx) + 3} y={H1 - B1 - 6} className="lbl so">품절 {mmdd(r.stockout_date)}</text>}
        {xticks.map((i) => <text key={i} x={px(i)} y={H1 - 6} textAnchor="middle" className={i === 0 ? 'lbl' : ''}>{i === 0 ? '오늘' : dayLabel(i)}</text>)}
      </svg>}
      {r.started && <div className="fc-leg"><span><i className="k-stk" />남은 재고(예상)</span><span><i className="k-rop" />발주 시점 — 이 아래로 내려가면 발주</span><span><i className="k-par" />목표 재고 — 채울 때 맞추는 양</span>{soIdx != null && <span><i className="k-short" />품절 구간</span>}</div>}

      <h4 className="fc-h">② 하루 사용량 — 지금까지 실제와 앞으로 예측</h4>
      <p className="fc-say">앞으로 하루 평균 <b>약 {Math.round(avg).toLocaleString()}개</b>를 쓸 것으로 예측합니다{f.trend_pct != null ? <> (최근 4주보다 <b className={f.trend_pct > 5 ? 'warnv' : ''}>{f.trend_pct > 0 ? '▲' : '▼'} {Math.abs(f.trend_pct)}%</b>)</> : ''}.
        {shortHist ? ` 사용 기록이 ${f.history_days}일뿐이라 현재 착용 인원(${(r.census || 0).toLocaleString()}명 ÷ 착용 ${Math.round((r.census || 0) / Math.max(0.1, f.prior))}일 = 하루 ${Math.round(f.prior)}개)을 주로 썼습니다.` : ` ${METHOD[f.method] || ''}을 반영했습니다.`}</p>
      <svg className="inv-fc-svg" viewBox={`0 0 ${W} ${H2}`}>
        {[0, uMax / 2, uMax].map((t) => <g key={t}><line x1={L} x2={W - R} y1={uy(t)} y2={uy(t)} className="g" /><text x={L - 5} y={uy(t) + 3} textAnchor="end">{Math.round(t).toLocaleString()}</text></g>)}
        <text x={L} y={11} className="unit">(개/일)</text>
        {hist.map((v, i) => <rect key={i} x={ux(i) - bw / 2} y={uy(v)} width={bw} height={Math.max(0.5, uy(0) - uy(v))} className="hb"><title>{`${dayLabel(i - off)} · ${v}개`}</title></rect>)}
        <polygon points={band} className="band" /><polyline points={fline} className="fc" />
        <line x1={ux(off) - bw} x2={ux(off) - bw} y1={T2} y2={H2 - B2} className="today" />
        {uticks.map((i) => <text key={i} x={ux(i)} y={H2 - 6} textAnchor="middle" className={i === off ? 'lbl' : ''}>{i === off ? '오늘' : dayLabel(i - off)}</text>)}
      </svg>
      <div className="fc-leg"><span><i className="k-hb" />실제 사용(하루)</span><span><i className="k-fc" />예측</span><span><i className="k-band" />예측 범위 — 10번 중 8번은 이 안</span>{f.wape != null && <span className="muted">최근 7일 예측 오차 {f.wape}%</span>}</div>

      <h4 className="fc-h">③ 앞으로 필요한 양</h4>
      <table className="tbl fc-need"><thead><tr><th>기간</th><th className="num">예상 사용</th><th className="num">더 필요한 양</th><th className="num">상자</th></tr></thead>
        <tbody>{[[30, f.next30, r.need_more_30], [60, f.next60, r.need_more_60], [90, f.next90, r.need_more_90]].map(([k, use, more]) => <tr key={k}><td>앞으로 {k}일</td><td className="num">{Math.round(use).toLocaleString()}개</td><td className={'num' + (more ? ' warnv' : '')}>{more ? `${more.toLocaleString()}개` : '충분'}</td><td className="num">{more ? `${Math.ceil(more / r.per_box)}상자${r.unit_price ? ` · ${money(more * r.unit_price)}` : ''}` : '—'}</td></tr>)}</tbody></table>
      <p className="muted small">더 필요한 양 = 예상 사용 − (남은 재고 {r.on_hand.toLocaleString()} + 오는 중 {r.on_order.toLocaleString()})</p>
    </section>
  )
}
