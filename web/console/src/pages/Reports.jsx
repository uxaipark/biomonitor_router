import React, { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api.js'
import { getLang } from '../i18n/index.js'
import { rname, suggestDx, KR_CLASS, KR_COPAY, krLines, US_PAYERS, US_POS, usLines, jpLines } from '../reports/billing.js'
import './Reports.css'

/**
 * ECG 리포트 · 보험 청구서 (의사·간호사·스태프).
 *  - 일일 리포트: 병원 현지 자정 기준 하루 — 기록/분석 가능 시간, 심박수 평균·최저·최고(시각), 시간대별 추이, 리듬 부담률,
 *    에피소드, 기외수축, 최장 휴지, 대표 파형(25 mm/s · 10 mm/mV). 인쇄 → PDF 저장.
 *  - 중간 분석 보고서: 착용 시작 ~ 선택한 날까지 누적 + 일자별 표 + 잠정 청구 산정(최종 청구 아님).
 *  - 청구서 초안: 한국 요양급여비용 명세서 · 미국 CMS-1500 · 일본 診療報酬明細書. 기관 정보는 계정 설정(DB)에 저장.
 * 문서 안 글자는 문서 언어(한/영/일)로 직접 쓰고 화면 번역기에서 뺀다(data-no-i18n) — 청구서는 그 나라 언어 고정.
 */
const D = {
  ko: { title: '일일 심전도 리포트', interim: '심전도 중간 분석 보고서', hosp: '의료기관', patient: '환자', mrn: '등록번호', sexAge: '성별/나이', dept: '진료과', ward: '병동/병상', dx: '진단', period: '기록 구간', rec: '기록 시간', ana: '분석 가능', leadoff: '전극 탈락', hr: '심박수', avg: '평균', min: '최저', max: '최고', beats: '총 박동(추정)', rhythm: '리듬 부담률', episodes: '주요 에피소드', ectopy: '기외수축', vbeats: '심실성(V)', sbeats: '상심실성(S)', pause: '최장 휴지', none: '없음', strips: '대표 파형', hourly: '시간대별 심박수', interp: '판독 소견', concl: '결론', reader: '판독의', sign: '서명', date: '일자', gen: '생성', engine: '분석 엔진', start: '시작', end: '종료', dur: '지속', count: '횟수', day: '일자', cum: '누적', cumPeriod: '누적 구간', wearStart: '착용 시작', provisional: '잠정 청구 산정 (중간 — 최종 청구 아님)', note: '자동 분석 결과이며 의사의 판독·확인이 필요합니다.', scale: '25 mm/s · 10 mm/mV', maxhr: '최고 심박', minhr: '최저 심박', ep: '에피소드', exNote: '휴지·무수축은 원인(전극 탈락·접촉 불량·움직임·수신 끊김 포함)을 확인할 수 없어 이 리포트에 넣지 않았습니다. 필요하면 원 파형을 직접 확인하세요.', noBeatTruth: '판정 출처가 에뮬레이터 정답지라 박동 단위 기외수축 개수는 표시하지 않습니다.', noBeatTruthShort: '정답지 모드 — 표시 안 함', srcTruth: '리듬 판정: 에뮬레이터 정답지(데모)', baseR: '기저 리듬(정답지)', noBase: '이 환자의 기저 리듬 정답이 없어 기저 리듬 비율은 넣지 않았습니다. 아래는 정답지에 있는 에피소드만입니다.', baseStrip: '주된 리듬' },
  en: { title: 'Daily ECG Report', interim: 'ECG Interim Analysis Report', hosp: 'Facility', patient: 'Patient', mrn: 'MRN', sexAge: 'Sex/Age', dept: 'Department', ward: 'Ward/Bed', dx: 'Diagnosis', period: 'Recording window', rec: 'Recorded', ana: 'Analyzable', leadoff: 'Lead off', hr: 'Heart rate', avg: 'Mean', min: 'Min', max: 'Max', beats: 'Total beats (est.)', rhythm: 'Rhythm burden', episodes: 'Significant episodes', ectopy: 'Ectopy', vbeats: 'Ventricular (V)', sbeats: 'Supraventricular (S)', pause: 'Longest pause', none: 'None', strips: 'Representative strips', hourly: 'Hourly heart rate', interp: 'Interpretation', concl: 'Conclusion', reader: 'Interpreting physician', sign: 'Signature', date: 'Date', gen: 'Generated', engine: 'Analysis engine', start: 'Start', end: 'End', dur: 'Duration', count: 'Count', day: 'Date', cum: 'Cumulative', cumPeriod: 'Cumulative window', wearStart: 'Monitoring start', provisional: 'Provisional billing determination (interim — not a final claim)', note: 'Automated analysis; requires physician review and confirmation.', scale: '25 mm/s · 10 mm/mV', maxhr: 'Max HR', minhr: 'Min HR', ep: 'Episode', exNote: 'Pauses and asystole are not included in this report because their cause (including lead-off, poor contact, motion or data loss) cannot be determined. Review the raw waveform if needed.', noBeatTruth: 'Rhythm source is the emulator answer key, which has no beat-level truth, so ectopic beat counts are not shown.', noBeatTruthShort: 'answer-key mode — not shown', srcTruth: 'Rhythm source: emulator answer key (demo)', baseR: 'Underlying rhythm (answer key)', noBase: 'No answer-key underlying rhythm for this patient, so its share is omitted. Only answer-key episodes are listed.', baseStrip: 'Predominant rhythm' },
  ja: { title: '日次心電図レポート', interim: '心電図 中間解析報告書', hosp: '医療機関', patient: '患者', mrn: '患者ID', sexAge: '性別/年齢', dept: '診療科', ward: '病棟/病床', dx: '診断', period: '記録区間', rec: '記録時間', ana: '解析可能', leadoff: '電極外れ', hr: '心拍数', avg: '平均', min: '最小', max: '最大', beats: '総心拍数(推定)', rhythm: '調律の負荷率', episodes: '主なエピソード', ectopy: '期外収縮', vbeats: '心室性(V)', sbeats: '上室性(S)', pause: '最長ポーズ', none: 'なし', strips: '代表波形', hourly: '時間帯別心拍数', interp: '所見', concl: '結論', reader: '判読医', sign: '署名', date: '日付', gen: '作成', engine: '解析エンジン', start: '開始', end: '終了', dur: '持続', count: '回数', day: '日付', cum: '累積', cumPeriod: '累積区間', wearStart: '装着開始', provisional: '暫定算定（中間・確定請求ではありません）', note: '自動解析結果です。医師の判読・確認が必要です。', scale: '25 mm/s · 10 mm/mV', maxhr: '最大心拍', minhr: '最小心拍', ep: 'エピソード', exNote: 'ポーズ・心停止は原因（電極外れ・接触不良・体動・受信断を含む）を確認できないため、本レポートには含めていません。必要に応じて元波形を確認してください。', noBeatTruth: '判定元がエミュレーター正解データのため、拍単位の期外収縮数は表示しません。', noBeatTruthShort: '正解データモード — 非表示', srcTruth: '調律判定: エミュレーター正解データ（デモ）', baseR: '基本調律（正解データ）', noBase: 'この患者の基本調律の正解がないため、その比率は含めていません。正解データのエピソードのみ表示します。', baseStrip: '主な調律' },
}
const LOC = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP' }
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hm = (ms) => { if (!ms) return '—'; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const dt = (ms, lang) => (ms ? new Date(ms).toLocaleString(LOC[lang], { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—')
const hrs = (ms) => (ms / 3600000).toFixed(1)
const dur = (ms) => { const s = Math.round(ms / 1000); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${pad(s % 60)}s`; return `${Math.floor(m / 60)}h ${pad(m % 60)}m` }
const COUNTRY_DOC = { KR: 'ko', US: 'en', JP: 'ja' }
const SEXL = { ko: { M: '남', F: '여' }, en: { M: 'M', F: 'F' }, ja: { M: '男', F: '女' } }
const BILL_DEFAULT = { kr_code: '', kr_class: 'general', us_npi: '', us_tax: '', us_billing: '', us_facility: '', us_payer: 'MCR', jp_pref: '13', jp_code: '', jp_ratio: 3, physician: '', license: '', us_d212: false }

const DOCS = [
  ['daily', '일일 리포트', '자정 기준 하루 요약 · 대표 파형', '▤'],
  ['interim', '중간 분석 보고서', '착용 시작부터 누적 · 잠정 산정', '▥'],
  ['claim', '보험 청구서', '한국 · 미국 · 일본 청구 초안', '₩'],
]
const WD = { ko: ['일', '월', '화', '수', '목', '금', '토'] }
const MODEL_LABEL = (p) => (p?.mode && p.mode !== 'inpatient' ? 'MCOT' : '입원')

export default function Reports() {
  const [chs, setChs] = useState([])
  const [q, setQ] = useState('')
  const [kind, setKind] = useState('all')
  const [patch, setPatch] = useState(() => new URLSearchParams(location.hash.split('?')[1] || '').get('patch') || '')
  const [days, setDays] = useState([])
  const [date, setDate] = useState(() => ymd(new Date(Date.now() - 86400000)))
  const [doc, setDoc] = useState('daily')
  const [lang, setLangDoc] = useState(() => getLang())
  const [country, setCountry] = useState('')
  const [rep, setRep] = useState(null)
  const [series, setSeries] = useState(null)
  const [emr, setEmr] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [bill, setBill] = useState(BILL_DEFAULT)
  const [interp, setInterp] = useState('')
  const [signAt, setSignAt] = useState('')
  useEffect(() => { api.reports.patients().then((d) => setChs(Array.isArray(d) ? d : [])).catch(() => {}) }, [])
  useEffect(() => { api.auth.prefs().then((p) => p?.['reports.billing'] && setBill({ ...BILL_DEFAULT, ...p['reports.billing'] })).catch(() => {}) }, [])
  const [daysFor, setDaysFor] = useState('') // 날짜 목록을 받은 패치 — 받기 전에는 리포트를 요청하지 않는다
  useEffect(() => {
    if (!patch) return
    let ok = true
    setDays([]); setDaysFor(''); setRep(null); setErr('')
    api.reports.days(patch).then((d) => {
      if (!ok) return
      const list = d || []
      setDays(list)
      // 어제 기록이 있으면 어제, 없으면 기록이 있는 가장 최근 날
      const y = ymd(new Date(Date.now() - 86400000))
      if (list.length) setDate((cur) => (list.includes(cur) ? cur : list.includes(y) ? y : list[0]))
      else setErr('이 패치에는 저장된 기록이 없습니다')
      setDaysFor(patch)
    }).catch((e) => { if (ok) { setDays([]); setErr(e.message); setDaysFor(patch) } })
    return () => { ok = false }
  }, [patch])
  const row = chs.find((c) => c.channel_id === patch)
  const pid = row?.profile_id || row?.patient?.profile_no || rep?.patient?.profile_no
  useEffect(() => { setEmr(null); if (pid) api.emu.patient(pid).then(setEmr).catch(() => {}) }, [pid])
  useEffect(() => {
    if (!patch || !date || daysFor !== patch || !days.includes(date)) return
    let ok = true
    setBusy(true); setErr(''); setRep(null); setSeries(null); setInterp(''); setSignAt('')
    api.reports.daily(patch, date).then((r) => { if (!ok) return; setRep(r); if (!country) setCountry(r.site_country || 'KR') }).catch((e) => ok && setErr(e.message)).finally(() => ok && setBusy(false))
    return () => { ok = false }
  }, [patch, date, daysFor])
  useEffect(() => {
    if (!rep || doc === 'daily' || series) return
    let ok = true
    const upto = days.filter((d) => d <= date).slice(0, 30).reverse()
    const start = rep.monitor_start_ms ? ymd(new Date(rep.monitor_start_ms)) : upto[0]
    const want = upto.filter((d) => !start || d >= start)
    ;(async () => {
      // 하루씩 차례로 받으면 일수만큼 느려져서 3개씩 동시에
      const out = new Array(want.length)
      let i = 0
      const worker = async () => { while (ok && i < want.length) { const k = i++; const d = want[k]; try { out[k] = d === date ? rep : await api.reports.daily(patch, d) } catch { /* 그날 없음 */ } } }
      await Promise.all([worker(), worker(), worker()])
      if (ok) setSeries(out.filter(Boolean))
    })()
    return () => { ok = false }
  }, [rep, doc, days])
  const saveBill = (b) => { setBill(b); api.auth.setPrefs({ 'reports.billing': b }).catch(() => {}) }
  const list = useMemo(() => chs.filter((c) => c.patient && (kind === 'all' || (kind === 'mcot') === (MODEL_LABEL(c.patient) === 'MCOT')) && (!q || `${c.channel_id} ${c.patient?.name} ${c.patient?.room} ${c.patient?.department} ${c.patient?.id}`.toLowerCase().includes(q.toLowerCase())))
    .sort((a, b) => (a.patient.name || '').localeCompare(b.patient.name || '', 'ko')), [chs, q, kind])
  const ctry = country || 'KR'
  const docLang = doc === 'claim' ? COUNTRY_DOC[ctry] || 'en' : lang
  const sign = { name: bill.physician, license: bill.license, at: signAt }
  const ctx = { rep, emr, row, lang: docLang, bill, setBill: saveBill, series, interp, setInterp, country: ctry, sign }
  const p = rep?.patient || row?.patient
  const di = days.indexOf(date)
  const go = (d) => d && setDate(d)

  return (
    <div className="page rp">
      <aside className="rp-side no-print">
        <div className="rp-side-h"><h2 className="h">ECG 리포트</h2><span className="muted small">{list.length.toLocaleString()}명</span></div>
        <input type="search" placeholder="환자 · 병실 · 패치 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="rp-kind">{[['all', '전체'], ['in', '입원'], ['mcot', 'MCOT']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{l}</button>)}</div>
        <div className="rp-list">
          {list.slice(0, 500).map((c) => (
            <button key={c.channel_id} className={'rp-pt' + (patch === c.channel_id ? ' on' : '')} onClick={() => setPatch(c.channel_id)}>
              <b>{c.patient.name}</b><small className="mono">{c.channel_id}</small>
              <span>{MODEL_LABEL(c.patient) === 'MCOT' ? <i className="rp-mc">MCOT</i> : null}{c.patient.room || c.patient.home_region || ''} · {c.patient.department || ''}</span>
            </button>))}
          {list.length > 500 && <p className="muted small rp-more">앞 500명만 표시 — 검색으로 좁혀 주세요.</p>}
          {!list.length && <p className="muted small">환자가 없습니다.</p>}
        </div>
      </aside>

      <main className="rp-main">
        {!patch ? <Welcome /> : <>
          <header className="rp-head no-print">
            <div className="rp-who">
              <div className="rp-name"><b>{emr?.name || p?.name || '환자 정보 없음'}</b>{!p && <span>이 패치에 연결된 환자 기록이 없습니다 — 파형 기록만 표시합니다</span>}{p && rep?.patient_from_snapshot && <span className="rp-snap">퇴원·패치 교체 전 마지막 환자 정보</span>}{emr && <span>{emr.sex === 'F' ? '여' : '남'} · {emr.age}세</span>}{p && <i className={'rp-chip ' + (MODEL_LABEL(p) === 'MCOT' ? 'mc' : 'in')}>{MODEL_LABEL(p)}</i>}</div>
              <div className="rp-meta">
                <span><small>등록번호</small>{emr?.mrn || p?.emr?.mrn || '—'}</span>
                <span><small>진료과</small>{p?.department || '—'}</span>
                <span><small>{MODEL_LABEL(p) === 'MCOT' ? '지역' : '병상'}</small>{MODEL_LABEL(p) === 'MCOT' ? p?.home_region || '—' : `${p?.ward || ''} ${p?.bed || ''}`.trim() || '—'}</span>
                <span><small>진단</small>{emr?.disease || p?.diagnosis || '—'}{emr?.icd10 ? ` (${emr.icd10})` : ''}</span>
                <span><small>착용 시작</small>{rep?.monitor_start_ms ? `${dt(rep.monitor_start_ms, 'ko')} · ${Math.max(1, Math.ceil((Date.now() - rep.monitor_start_ms) / 86400000))}일째` : '—'}</span>
                <span><small>패치</small><span className="mono">{patch}</span></span>
              </div>
            </div>
          </header>

          <div className="rp-tabs no-print">{DOCS.map(([k, l, d, ic]) => <button key={k} className={'rp-tab' + (doc === k ? ' on' : '')} onClick={() => setDoc(k)}><i>{ic}</i><span><b>{l}</b><small>{d}</small></span></button>)}</div>

          <div className="rp-dates no-print">
            <button className="icon" disabled={di < 0 || di >= days.length - 1} onClick={() => go(days[di + 1])} title="이전 날">◀</button>
            <div className="rp-dstrip">{[...days].reverse().map((d) => { const w = new Date(d + 'T00:00').getDay(); return (
              <button key={d} className={'rp-day' + (d === date ? ' on' : '') + (d === ymd(new Date()) ? ' today' : '') + (w === 0 ? ' sun' : w === 6 ? ' sat' : '')} onClick={() => setDate(d)}>
                <small>{d.slice(5, 7)}월 · {WD.ko[w]}</small><b>{Number(d.slice(8))}</b>{d === ymd(new Date()) && <em>오늘 · 진행 중</em>}</button>) })}
              {!days.length && <span className="muted small">기록된 날을 찾는 중…</span>}</div>
            <button className="icon" disabled={di <= 0} onClick={() => go(days[di - 1])} title="다음 날">▶</button>
            <span className="rp-dnote muted small">{doc === 'daily' ? '병원 현지 자정 ~ 자정' : `착용 시작 ~ ${date}`}</span>
          </div>

          <div className="rp-desk">
            {err && <div className="rp-empty"><b>이 날짜의 리포트를 만들 수 없습니다</b><span>{err}</span>{days.length > 0 && days[0] !== date && <button className="primary" onClick={() => setDate(days[0])}>가장 최근 기록({days[0]})으로 이동</button>}</div>}
            {(busy || (patch && daysFor !== patch)) && !rep && !err && <PaperSkeleton />}
            {rep && <Fit>
              {doc === 'daily' && <Paper><DailyDoc {...ctx} /></Paper>}
              {doc === 'interim' && <Paper>{series ? <InterimDoc {...ctx} /> : <Collecting />}</Paper>}
              {doc === 'claim' && <Paper>{!series ? <Collecting /> : ctry === 'US' ? <ClaimUS {...ctx} /> : ctry === 'JP' ? <ClaimJP {...ctx} /> : <ClaimKR {...ctx} />}</Paper>}
            </Fit>}
          </div>
        </>}
      </main>

      {patch && <aside className="rp-tool no-print">
        <ToolPanel ctx={ctx} doc={doc} lang={lang} setLang={setLangDoc} ctry={ctry} setCountry={setCountry} interp={interp} setInterp={setInterp} signAt={signAt} setSignAt={setSignAt} busy={busy} />
      </aside>}
    </div>
  )
}

function Welcome() {
  return (<div className="rp-welcome">
    <h3>ECG 리포트 · 보험 청구</h3>
    <p className="muted">왼쪽에서 환자를 고르면 전날(자정 기준) 리포트를 바로 만듭니다.</p>
    <ol>
      <li><b>환자 선택</b><span>입원·MCOT 필터와 검색으로 찾습니다.</span></li>
      <li><b>날짜 · 문서 고르기</b><span>일일 리포트, 착용 시작부터의 중간 분석 보고서, 보험 청구서 초안.</span></li>
      <li><b>오른쪽에서 작성</b><span>판독 소견과 판독의를 넣고 점검표를 확인합니다.</span></li>
      <li><b>인쇄 · PDF</b><span>A4 한 장 단위로 출력됩니다.</span></li>
    </ol>
  </div>)
}
const Collecting = () => <div className="rp-collect"><span className="spin" />착용 기간의 일자별 기록을 모으는 중…</div>
function PaperSkeleton() { return <div className="rp-paper rp-skel">{[60, 30, 90, 90, 40, 100, 100, 70].map((w, i) => <i key={i} style={{ width: `${w}%` }} />)}</div> }

/** 화면 너비에 맞춰 A4 미리보기를 줄인다 (인쇄는 원래 크기) */
function Fit({ children }) {
  const ref = useRef(null)
  const [z, setZ] = useState(1)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setZ(Math.min(1, (el.clientWidth - 32) / 794)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return <div ref={ref} className="rp-fit" style={{ '--z': z }}>{children}</div>
}

function ToolPanel({ ctx, doc, lang, setLang, ctry, setCountry, interp, setInterp, signAt, setSignAt, busy }) {
  const { rep, series, bill, setBill } = ctx
  const [b, setB] = useState(bill)
  useEffect(() => setB(bill), [bill])
  const f = (k) => (e) => setB({ ...b, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const dirty = JSON.stringify(b) !== JSON.stringify(bill)
  const auto = rep ? autoSummary(rep, doc === 'claim' ? 'ko' : lang) : ''
  const hours = rep ? rep.recorded_ms / 3600000 : 0
  const checks = doc === 'claim'
    ? [[!!series, '착용 기간 기록 모음'], [ctry === 'KR' ? !!bill.kr_code : ctry === 'US' ? !!bill.us_npi : !!bill.jp_code, ctry === 'KR' ? '요양기관기호' : ctry === 'US' ? 'Billing NPI' : '医療機関コード'], [!!bill.physician, '판독의 이름'], [!!bill.license, '면허번호 · NPI']]
    : [[hours >= 20, `기록 ${hours.toFixed(1)}시간 (20시간 이상 권장)`], [(rep?.strips || []).length > 0, `대표 파형 ${(rep?.strips || []).length}개`], [!!interp.trim(), '판독 소견 직접 확인·수정'], [!!bill.physician, '판독의 이름'], [!!signAt, '판독 일시']]
  const ready = checks.filter((c) => c[0]).length
  return (<div className="rp-tp">
    <div className="rp-tp-print">
      <button className="primary big" disabled={!rep || busy} onClick={() => window.print()}>인쇄 · PDF 저장</button>
      <span className="muted small">점검 {ready}/{checks.length}{ready < checks.length ? ' — 빠진 항목이 있어도 인쇄는 됩니다' : ' — 준비 완료'}</span>
    </div>

    {rep && doc !== 'claim' && <section className="rp-sec"><h4>그날 요약</h4>
      <div className="rp-mini">
        <div><small>평균</small><b>{rep.hr.avg ?? '—'}</b><span>bpm</span></div>
        <div><small>최저</small><b>{rep.hr.min?.bpm ?? '—'}</b><span>{hm(rep.hr.min?.at_ms)}</span></div>
        <div><small>최고</small><b>{rep.hr.max?.bpm ?? '—'}</b><span>{hm(rep.hr.max?.at_ms)}</span></div>
        <div><small>기록</small><b>{hours.toFixed(1)}</b><span>시간</span></div>
        <div><small>에피소드</small><b>{Object.values(rep.episode_counts || {}).reduce((a, n) => a + n, 0)}</b><span>건</span></div>
        <div><small>심실 조기</small><b>{rep.ectopy ? rep.ectopy.v_pct ?? 0 : '—'}</b><span>{rep.ectopy ? '% 박동' : '정답지 모드'}</span></div>
      </div></section>}

    <section className="rp-sec"><h4>문서</h4>
      {doc === 'claim'
        ? <label className="rp-f">청구 국가<select value={ctry} onChange={(e) => setCountry(e.target.value)}><option value="KR">한국 · 요양급여비용 명세서</option><option value="US">미국 · CMS-1500</option><option value="JP">일본 · 診療報酬明細書</option></select><small>청구서는 그 나라 언어로 고정됩니다.</small></label>
        : <label className="rp-f">문서 언어<select value={lang} onChange={(e) => setLang(e.target.value)}><option value="ko">한국어</option><option value="en">English</option><option value="ja">日本語</option></select></label>}
    </section>

    {doc !== 'claim' && <section className="rp-sec"><h4>판독 소견 <button className="link" onClick={() => setInterp(auto)}>자동 문장 넣기</button></h4>
      <textarea className="rp-ta" rows={7} value={interp} placeholder={auto} onChange={(e) => setInterp(e.target.value)} />
      <small className="muted">비워 두면 자동 분석 문장이 들어갑니다. 의사가 확인·수정하세요.</small>
    </section>}

    <section className="rp-sec"><h4>판독의 <small className="muted">계정에 저장</small></h4>
      <div className="rp-g2"><label className="rp-f">이름<input value={b.physician} onChange={f('physician')} placeholder="예: 김OO" /></label><label className="rp-f">면허번호 · NPI<input value={b.license} onChange={f('license')} /></label></div>
      {doc !== 'claim' && <label className="rp-f">판독 일시<span className="rp-row"><input type="datetime-local" value={signAt} onChange={(e) => setSignAt(e.target.value)} /><button onClick={() => setSignAt(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16))}>지금</button></span></label>}
    </section>

    {doc === 'claim' && <section className="rp-sec"><h4>기관 청구 정보 <small className="muted">계정에 저장</small></h4>
      {ctry === 'KR' && <><label className="rp-f">요양기관기호<input value={b.kr_code} onChange={f('kr_code')} maxLength={8} placeholder="8자리" /></label><label className="rp-f">종별<select value={b.kr_class} onChange={f('kr_class')}>{KR_CLASS.map((c) => <option key={c[0]} value={c[0]}>{c[1]} · 환산 {c[2]}원 · 가산 {c[3] * 100}%</option>)}</select></label></>}
      {ctry === 'US' && <><label className="rp-f">Payer<select value={b.us_payer} onChange={f('us_payer')}>{US_PAYERS.map((x) => <option key={x[0]} value={x[0]}>{x[1]}</option>)}</select></label><label className="rp-f">Billing provider (name, address)<input value={b.us_billing} onChange={f('us_billing')} /></label><div className="rp-g2"><label className="rp-f">Billing NPI (33a)<input value={b.us_npi} onChange={f('us_npi')} maxLength={10} /></label><label className="rp-f">Federal Tax ID (25)<input value={b.us_tax} onChange={f('us_tax')} /></label></div><label className="rp-f">Service facility (32)<input value={b.us_facility} onChange={f('us_facility')} /></label></>}
      {ctry === 'JP' && <><div className="rp-g2"><label className="rp-f">都道府県番号<input value={b.jp_pref} onChange={f('jp_pref')} maxLength={2} /></label><label className="rp-f">医療機関コード<input value={b.jp_code} onChange={f('jp_code')} maxLength={7} /></label></div><label className="rp-f">負担割合<select value={b.jp_ratio} onChange={f('jp_ratio')}>{[1, 2, 3].map((r) => <option key={r} value={r}>{r}割</option>)}</select></label><label className="rp-ck"><input type="checkbox" checked={!!b.us_d212} onChange={f('us_d212')} />MCOT 外来は D212 リアルタイム解析型で算定</label></>}
    </section>}
    {dirty && <div className="rp-save"><span className="small">바꾼 내용이 있습니다.</span><button className="primary" onClick={() => setBill(b)}>저장</button></div>}

    <section className="rp-sec"><h4>점검표</h4>
      <ul className="rp-check">{checks.map(([ok, l], i) => <li key={i} className={ok ? 'ok' : ''}><i>{ok ? '✓' : '·'}</i>{l}</li>)}</ul>
    </section>
  </div>)
}

const Paper = ({ children }) => <div className="rp-paper" data-no-i18n="">{children}</div>
const In = ({ v, on, w, ph, cls }) => <input className={'rf ' + (cls || '')} style={w ? { width: w } : undefined} value={v ?? ''} placeholder={ph || ''} onChange={(e) => on(e.target.value)} />
function useF(init) { const [f, setF] = useState(init); return [f, (k) => (v) => setF((o) => ({ ...o, [k]: v })), setF] }

function Header({ rep, emr, row, lang, title, sub }) {
  const t = D[lang]; const p = rep.patient || row?.patient || {}
  return (<>
    <div className="rp-dh"><div><h1>{title}</h1><div className="rp-sub">{sub}</div></div><div className="rp-hosp"><b>{rep.hospital?.name || rep.site}</b><span>{rep.hospital?.region}</span></div></div>
    <table className="rp-id"><tbody>
      <tr><th>{t.patient}</th><td><b>{emr?.name || p.name}</b>{emr?.name_kana ? ` (${emr.name_kana})` : ''}</td><th>{t.mrn}</th><td className="mono">{emr?.mrn || p.emr?.mrn || p.id}</td><th>{t.sexAge}</th><td>{emr ? `${SEXL[lang][emr.sex] || emr.sex} / ${emr.age}` : '—'}{emr?.birth_date ? ` · ${emr.birth_date}` : ''}</td></tr>
      <tr><th>{t.dept}</th><td>{p.department || emr?.ward_specialty || '—'}</td><th>{t.ward}</th><td>{p.mode && p.mode !== 'inpatient' ? `MCOT · ${p.home_region || ''}` : `${p.ward || ''} ${p.bed || ''}`}</td><th>{t.dx}</th><td>{emr?.disease || p.diagnosis || '—'}{emr?.icd10 ? ` (${emr.icd10})` : ''}</td></tr>
    </tbody></table>
  </>)
}

export function DailyDoc({ rep, emr, row, lang, interp, sign }) {
  const t = D[lang]
  const burden = Object.entries(rep.burden_pct || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
  const counts = Object.entries(rep.episode_counts || {}).sort((a, b) => b[1] - a[1])
  const auto = autoSummary(rep, lang)
  return (<div className="rp-doc">
    <Header rep={rep} emr={emr} row={row} lang={lang} title={t.title} sub={`${rep.date} 00:00 – 24:00 (UTC${rep.tz}) · ${rep.source === 'truth' ? t.srcTruth : `${t.engine} ${rep.engine || '—'}`}`} />
    <div className="rp-kpi">
      <div><small>{t.hr} {t.avg}</small><b>{rep.hr.avg ?? '—'}</b><span>bpm</span></div>
      <div><small>{t.hr} {t.min}</small><b>{rep.hr.min?.bpm ?? '—'}</b><span>{hm(rep.hr.min?.at_ms)}</span></div>
      <div><small>{t.hr} {t.max}</small><b>{rep.hr.max?.bpm ?? '—'}</b><span>{hm(rep.hr.max?.at_ms)}</span></div>
      <div><small>{t.rec}</small><b>{hrs(rep.recorded_ms)}</b><span>h · {t.ana} {hrs(rep.analyzable_ms)} h</span></div>
      <div><small>{t.beats}</small><b>{Math.round(rep.hr.total_beats).toLocaleString()}</b><span>{rep.ectopy ? `V ${rep.ectopy.v_pct ?? 0}% · S ${rep.ectopy.s_pct ?? 0}%` : ''}</span></div>
    </div>
    <h3>{t.hourly}</h3>
    <HourChart hourly={rep.hourly} />
    <div className="rp-two">
      <section><h3>{t.rhythm}</h3>{rep.source === 'truth' && <p className="rp-note-ex">{rep.truth_base ? `${t.baseR}: ${rname(rep.truth_base, lang)}` : t.noBase}</p>}<table className="rp-t"><tbody>{burden.map(([k, v]) => <tr key={k}><td>{rname(k, lang)}</td><td className="num">{v}%</td><td className="bar"><i style={{ width: `${Math.min(100, v)}%` }} /></td></tr>)}{!burden.length && <tr><td>{t.none}</td></tr>}</tbody></table></section>
      <section><h3>{t.ectopy}</h3><table className="rp-t"><tbody>
        {rep.ectopy ? <><tr><td>{t.vbeats}</td><td className="num">{rep.ectopy.v_beats.toLocaleString()}</td><td className="num">{rep.ectopy.v_pct ?? 0}%</td></tr>
        <tr><td>{t.sbeats}</td><td className="num">{rep.ectopy.s_beats.toLocaleString()}</td><td className="num">{rep.ectopy.s_pct ?? 0}%</td></tr></> : <tr><td colSpan="3" className="small">{t.noBeatTruth}</td></tr>}
        <tr><td>{t.leadoff}</td><td className="num">{dur(rep.lead_off_ms)}</td><td /></tr>
        <tr><td>{t.period}</td><td colSpan="2" className="num">{hm(rep.first_ms)} – {hm(rep.last_ms)}</td></tr>
      </tbody></table></section>
    </div>
    <h3>{t.episodes} {counts.length > 0 && <small>{counts.map(([k, n]) => `${rname(k, lang)} ${n}`).join(' · ')}</small>}</h3>
    <table className="rp-t rp-ep"><thead><tr><th>{t.ep}</th><th>{t.start}</th><th>{t.end}</th><th className="num">{t.dur}</th></tr></thead>
      <tbody>{(rep.episodes || []).slice(0, 25).map((e, i) => <tr key={i}><td>{rname(e.label, lang)}</td><td>{hm(e.start_ms)}</td><td>{hm(e.end_ms)}</td><td className="num">{dur(e.dur_ms)}</td></tr>)}{!(rep.episodes || []).length && <tr><td colSpan="4">{t.none}</td></tr>}</tbody></table>
    <p className="rp-note-ex">{t.exNote}</p>
    <h3 className="rp-pb">{t.strips} <small>{t.scale}</small></h3>
    {(rep.strips || []).map((s, i) => <Strip key={i} s={s} lang={lang} />)}
    <h3>{t.interp}</h3>
    <p className="rp-interp">{interp.trim() || auto}</p>
    <Sign lang={lang} sign={sign} />
    <p className="rp-foot">{t.note} · {t.gen} {dt(rep.generated_ms, lang)}</p>
  </div>)
}

const isPause = (l) => l === 'pause' || l === 'asystole'
function autoSummary(rep, lang) {
  const t = D[lang]
  const top = Object.entries(rep.burden_pct || {}).filter(([k]) => k !== 'leadoff').sort((a, b) => b[1] - a[1])[0]
  const ep = Object.entries(rep.episode_counts || {}).filter(([k]) => !isPause(k)).map(([k, n]) => `${rname(k, lang)} ${n}`).join(', ')
  if (lang === 'en') return `Predominant rhythm: ${top ? rname(top[0], lang) : '—'}. Mean HR ${rep.hr.avg ?? '—'} bpm (min ${rep.hr.min?.bpm ?? '—'} at ${hm(rep.hr.min?.at_ms)}, max ${rep.hr.max?.bpm ?? '—'} at ${hm(rep.hr.max?.at_ms)}). Episodes: ${ep || 'none'}. ${rep.ectopy ? `PVC ${rep.ectopy.v_pct ?? 0}%, PAC ${rep.ectopy.s_pct ?? 0}%.` : ''}`
  if (lang === 'ja') return `基本調律: ${top ? rname(top[0], lang) : '—'}。平均心拍数 ${rep.hr.avg ?? '—'} bpm（最小 ${rep.hr.min?.bpm ?? '—'} ${hm(rep.hr.min?.at_ms)}、最大 ${rep.hr.max?.bpm ?? '—'} ${hm(rep.hr.max?.at_ms)}）。エピソード: ${ep || 'なし'}。${rep.ectopy ? `VPC ${rep.ectopy.v_pct ?? 0}%、SVPC ${rep.ectopy.s_pct ?? 0}%。` : ''}`
  return `기본 리듬: ${top ? rname(top[0], lang) : '—'}. 평균 심박수 ${rep.hr.avg ?? '—'} bpm (최저 ${rep.hr.min?.bpm ?? '—'} ${hm(rep.hr.min?.at_ms)}, 최고 ${rep.hr.max?.bpm ?? '—'} ${hm(rep.hr.max?.at_ms)}). ${t.episodes}: ${ep || '없음'}. ${rep.ectopy ? `심실조기수축 ${rep.ectopy.v_pct ?? 0}%, 상심실성 ${rep.ectopy.s_pct ?? 0}%.` : ''}`
}

function Sign({ lang, sign }) {
  const t = D[lang]
  const at = sign?.at ? new Date(sign.at).toLocaleString(LOC[lang], { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  return <div className="rp-sign"><span>{t.reader}: <b>{sign?.name || '________________'}</b>{sign?.license ? <span className="mono"> ({sign.license})</span> : null}</span><span>{t.sign}: ____________________</span><span>{t.date}: {at || '________________'}</span></div>
}

function HourChart({ hourly }) {
  const W = 720, H = 150, L = 30, B = 18, lo = 30, hi = 180
  const y = (v) => H - B - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (H - B - 6)
  const bw = (W - L) / 24
  return (<svg className="rp-hc" viewBox={`0 0 ${W} ${H}`}>
    {[40, 60, 80, 100, 120, 140, 160].map((v) => <g key={v}><line x1={L} x2={W} y1={y(v)} y2={y(v)} className="g" /><text x={L - 4} y={y(v) + 3} textAnchor="end">{v}</text></g>)}
    {hourly.map((h) => h.n > 0 && <g key={h.h}><rect x={L + h.h * bw + bw * 0.25} width={bw * 0.5} y={y(h.max)} height={Math.max(1, y(h.min) - y(h.max))} className="r" /><line x1={L + h.h * bw + 2} x2={L + (h.h + 1) * bw - 2} y1={y(h.avg)} y2={y(h.avg)} className="a" /></g>)}
    {hourly.map((h) => h.h % 3 === 0 && <text key={'t' + h.h} x={L + h.h * bw + bw / 2} y={H - 4} textAnchor="middle">{pad(h.h)}</text>)}
  </svg>)
}

function Strip({ s, lang }) {
  const t = D[lang]
  const [kind, val] = s.what.split(':')
  const label = kind === 'max_hr' ? `${t.maxhr} ${val} bpm` : kind === 'min_hr' ? `${t.minhr} ${val} bpm` : kind === 'base' ? `${t.baseStrip}: ${rname(val, lang)}` : rname(val, lang)
  const secs = s.mv.length / s.fs, Wmm = secs * 25, Hmm = 30
  const pts = s.mv.map((v, i) => `${((i / s.fs) * 25).toFixed(2)},${(Hmm / 2 - Math.max(-1.45, Math.min(1.45, v)) * 10).toFixed(2)}`).join(' ')
  const minor = [], major = []
  for (let x = 0; x <= Wmm; x += 1) (x % 5 === 0 ? major : minor).push(<line key={'x' + x} x1={x} x2={x} y1={0} y2={Hmm} />)
  for (let yv = 0; yv <= Hmm; yv += 1) (yv % 5 === 0 ? major : minor).push(<line key={'y' + yv} x1={0} x2={Wmm} y1={yv} y2={yv} />)
  return (<div className="rp-strip"><div className="rp-sl"><b>{label}</b><span>{dt(s.t0_ms, lang)}</span></div>
    <svg viewBox={`0 0 ${Wmm} ${Hmm}`} preserveAspectRatio="none"><g className="mi">{minor}</g><g className="ma">{major}</g><polyline points={pts} /></svg></div>)
}

// ───────── 중간 보고서 ─────────
function aggregate(series) {
  const rec = series.reduce((a, r) => a + r.recorded_ms, 0), ana = series.reduce((a, r) => a + r.analyzable_ms, 0)
  const beats = series.reduce((a, r) => a + (r.hr.total_beats || 0), 0)
  const mins = series.filter((r) => r.hr.min).map((r) => r.hr.min).sort((a, b) => a.bpm - b.bpm)
  const maxs = series.filter((r) => r.hr.max).map((r) => r.hr.max).sort((a, b) => b.bpm - a.bpm)
  const avg = rec ? series.reduce((a, r) => a + (r.hr.avg || 0) * r.recorded_ms, 0) / rec : null
  const burden = {}; for (const r of series) for (const [k, v] of Object.entries(r.burden_pct || {}).filter(([k]) => !isPause(k))) burden[k] = (burden[k] || 0) + (v * r.analyzable_ms) / 100
  const counts = {}; for (const r of series) for (const [k, n] of Object.entries(r.episode_counts || {}).filter(([k]) => !isPause(k))) counts[k] = (counts[k] || 0) + n
  const hasEct = series.every((r) => r.ectopy)
  const v = series.reduce((a, r) => a + (r.ectopy?.v_beats || 0), 0), s = series.reduce((a, r) => a + (r.ectopy?.s_beats || 0), 0)
  const first = Math.min(...series.map((r) => r.first_ms || Infinity)), last = Math.max(...series.map((r) => r.last_ms || 0))
  return { hasEct, rec, ana, beats, min: mins[0], max: maxs[0], avg, burden: Object.fromEntries(Object.entries(burden).map(([k, ms]) => [k, ana ? Math.round((ms / ana) * 1000) / 10 : 0])), counts, v, s, first, last }
}
function spanOf(rep, series) {
  const a = aggregate(series)
  const start = rep.monitor_start_ms && rep.monitor_start_ms < a.first ? rep.monitor_start_ms : a.first
  const hours = Math.max(0, (a.last - start) / 3600000)
  return { a, start, hours, days: series.length }
}

export function InterimDoc({ rep, emr, row, lang, series, bill, sign }) {
  const t = D[lang]
  const { a, start, hours } = spanOf(rep, series)
  const mode = rep.patient?.mode === 'inpatient' ? 'inpatient' : 'mcot'
  const burden = Object.entries(a.burden).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1])
  const kr = krLines(mode, hours, series.length, bill.kr_class), us = usLines(mode, hours), jp = jpLines(mode, hours, series.length, series.length, bill.us_d212)
  return (<div className="rp-doc">
    <Header rep={rep} emr={emr} row={row} lang={lang} title={t.interim} sub={`${t.cumPeriod}: ${dt(start, lang)} – ${dt(a.last, lang)} (${(hours / 24).toFixed(1)} d · ${hours.toFixed(1)} h)`} />
    <div className="rp-kpi">
      <div><small>{t.hr} {t.avg}</small><b>{a.avg ? a.avg.toFixed(1) : '—'}</b><span>bpm</span></div>
      <div><small>{t.hr} {t.min}</small><b>{a.min?.bpm ?? '—'}</b><span>{dt(a.min?.at_ms, lang)}</span></div>
      <div><small>{t.hr} {t.max}</small><b>{a.max?.bpm ?? '—'}</b><span>{dt(a.max?.at_ms, lang)}</span></div>
      <div><small>{t.rec}</small><b>{hrs(a.rec)}</b><span>h · {t.ana} {a.rec ? Math.round((a.ana / a.rec) * 100) : 0}%</span></div>
      <div><small>{t.ectopy}</small><b>{a.hasEct ? `${a.beats ? ((a.v / a.beats) * 100).toFixed(1) : 0}%` : '—'}</b><span>{a.hasEct ? `V ${a.v.toLocaleString()} · S ${a.s.toLocaleString()}` : t.noBeatTruthShort}</span></div>
    </div>
    <div className="rp-two">
      <section><h3>{t.rhythm} ({t.cum})</h3><table className="rp-t"><tbody>{burden.map(([k, v]) => <tr key={k}><td>{rname(k, lang)}</td><td className="num">{v}%</td><td className="bar"><i style={{ width: `${Math.min(100, v)}%` }} /></td></tr>)}</tbody></table></section>
      <section><h3>{t.episodes} ({t.cum})</h3><table className="rp-t"><tbody>{Object.entries(a.counts).sort((x, y) => y[1] - x[1]).map(([k, n]) => <tr key={k}><td>{rname(k, lang)}</td><td className="num">{n}</td></tr>)}</tbody></table></section>
    </div>
    <p className="rp-note-ex">{t.exNote}</p>
    <h3>{t.day}</h3>
    <table className="rp-t"><thead><tr><th>{t.day}</th><th className="num">{t.rec} h</th><th className="num">{t.avg}</th><th className="num">{t.min}</th><th className="num">{t.max}</th><th className="num">V%</th><th className="num">S%</th><th>{t.episodes}</th></tr></thead>
      <tbody>{series.map((r) => <tr key={r.date}><td>{r.date}</td><td className="num">{hrs(r.recorded_ms)}</td><td className="num">{r.hr.avg ?? '—'}</td><td className="num">{r.hr.min?.bpm ?? '—'}</td><td className="num">{r.hr.max?.bpm ?? '—'}</td><td className="num">{r.ectopy?.v_pct ?? '—'}</td><td className="num">{r.ectopy?.s_pct ?? '—'}</td><td className="small">{Object.entries(r.episode_counts || {}).map(([k, n]) => `${rname(k, lang)} ${n}`).join(', ') || '—'}</td></tr>)}</tbody></table>
    <h3 className="rp-pb">{t.strips} <small>{rep.date} · {t.scale}</small></h3>
    {(rep.strips || []).slice(0, 4).map((s, i) => <Strip key={i} s={s} lang={lang} />)}
    <h3>{t.provisional}</h3>
    <table className="rp-t"><thead><tr><th>KR (HIRA)</th><th>US (CPT)</th><th>JP (診療報酬)</th></tr></thead><tbody><tr>
      <td>{kr.map((l) => <div key={l.code}><b className="mono">{l.code}</b> {l.name} × {l.days} · ₩{l.amount.toLocaleString()}{l.note ? ` (${l.note})` : ''}</div>)}</td>
      <td>{us.map((l) => <div key={l.code}><b className="mono">{l.code}{l.mod ? `-${l.mod}` : ''}</b> {l.comp} · ${l.fee.toFixed(2)}</div>)}</td>
      <td>{jp.map((l) => <div key={l.code}><b className="mono">{l.code}</b> {l.pts}点 × {l.count}</div>)}</td>
    </tr></tbody></table>
    <p className="small">{lang === 'en' ? 'Code tier follows the continuous recording duration so far; the final code may change at end of monitoring. MCT (93228/93229) is billed once per ≤30-day episode, dated at hook-up.' : lang === 'ja' ? '区分は現時点までの連続記録時間で算定。終了時に確定区分が変わる場合があります。' : '구간은 지금까지의 연속 기록 시간으로 산정했습니다. 착용이 끝나면 최종 구간이 달라질 수 있습니다.'}</p>
    <Sign lang={lang} sign={sign} />
    <p className="rp-foot">{t.note} · {t.gen} {dt(Date.now(), lang)}</p>
  </div>)
}

// ───────── 청구서 공통 ─────────
const Box = ({ n, l, children, w, cls }) => <div className={'bx ' + (cls || '')} style={w ? { gridColumn: `span ${w}` } : undefined}><span className="bn">{n}</span><span className="bl">{l}</span><div className="bv">{children}</div></div>

// ───────── 한국: 요양급여비용 명세서 ─────────
export function ClaimKR({ rep, emr, series, bill }) {
  const { a, start, hours } = spanOf(rep, series)
  const p = rep.patient || {}
  const mode = p.mode === 'inpatient' ? 'inpatient' : 'outpatient'
  const dx = suggestDx(emr?.disease || p.diagnosis, a.counts)
  if (emr?.icd10) dx.splice(0, dx.length, ...dx.filter((d) => d.cm.slice(0, 3) !== emr.icd10.slice(0, 3))); if (emr?.icd10) dx.unshift({ cm: emr.icd10, kcd: emr.icd10, ko: emr.disease, en: emr.disease, ja: emr.disease, from: 'emr' })
  const lines = krLines(mode, hours, series.length, bill.kr_class)
  const [f, set] = useF({ jumin: emr?.birth_date ? `${emr.birth_date.slice(2).replace(/-/g, '')}-${emr.sex === 'F' ? (emr.birth_date < '2000' ? '2' : '4') : emr.birth_date < '2000' ? '1' : '3'}******` : '', jeung: '', insured: '', jinryo: p.department || '' })
  const total = lines.reduce((s, l) => s + l.amount, 0)
  const copay = Math.round(lines.reduce((s, l) => s + l.amount * (l.note ? 0.8 : mode === 'inpatient' ? KR_COPAY.inpatient : KR_COPAY[bill.kr_class] ?? 0.5), 0) / 100) * 100
  const sd = new Date(start), ed = new Date(a.last)
  return (<div className="rp-doc claim kr">
    <div className="cl-title"><h1>요양급여비용 명세서</h1><span>[{mode === 'inpatient' ? '의과입원 (서식 GI02 · 별지 제10호)' : '의과외래 (서식 GI03 · 별지 제11호)'}]</span><span className="cl-draft">초안 · 청구 전 확인 필요</span></div>
    <div className="grid g6">
      <Box n="①" l="요양기관기호" w={2}><b className="mono">{bill.kr_code || '________'}</b></Box>
      <Box n="②" l="요양기관명" w={2}>{rep.hospital?.name || rep.site}</Box>
      <Box n="③" l="종별" w={2}>{KR_CLASS.find((c) => c[0] === bill.kr_class)?.[1]}</Box>
      <Box n="④" l="수진자 성명" w={2}><b>{emr?.name || p.name}</b></Box>
      <Box n="⑤" l="주민등록번호" w={2}><In v={f.jumin} on={set('jumin')} /></Box>
      <Box n="⑥" l="증번호" w={2}><In v={f.jeung} on={set('jeung')} ph="건강보험증 번호" /></Box>
      <Box n="⑦" l="가입자(세대주)" w={2}><In v={f.insured} on={set('insured')} ph={emr?.name || ''} /></Box>
      <Box n="⑧" l="진료과목" w={2}><In v={f.jinryo} on={set('jinryo')} /></Box>
      <Box n="⑨" l={mode === 'inpatient' ? '입원 기간' : '진료(검사) 기간'} w={2}>{ymd(sd)} ~ {ymd(ed)} (기록 보관 {series.length}일)</Box>
    </div>
    <h3>상병내역 <small>KCD-9 (2026-01-01 시행) · ICD-10 체계</small></h3>
    <table className="rp-t"><thead><tr><th>구분</th><th>상병분류기호</th><th>상병명</th><th>근거</th></tr></thead>
      <tbody>{dx.slice(0, 6).map((d, i) => <tr key={d.cm}><td>{i === 0 ? '1 주상병' : '2 부상병'}</td><td className="mono">{d.kcd.replace('.', '')}</td><td>{d.ko}</td><td className="small">{d.from === 'emr' ? 'EMR 진단' : d.from === 'ecg' ? 'ECG 소견' : '기본'}</td></tr>)}</tbody></table>
    <h3>진료내역</h3>
    <table className="rp-t"><thead><tr><th>항</th><th>목</th><th>코드</th><th>명칭</th><th className="num">단가(원)</th><th className="num">1일 횟수</th><th className="num">총 일수</th><th className="num">금액(원)</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.code}><td>{l.hang}</td><td>{l.mok}</td><td className="mono">{l.code}</td><td>{l.name}{l.note ? <div className="small">{l.note}</div> : null}{l.over ? <div className="small">14일 초과 기록: 코드 없음 — 14일까지 산정</div> : null}</td><td className="num">{l.unit.toLocaleString()}</td><td className="num">{l.qty}</td><td className="num">{l.days}</td><td className="num">{l.amount.toLocaleString()}</td></tr>)}</tbody>
      <tfoot><tr><th colSpan="7">요양급여비용 총액</th><th className="num">{total.toLocaleString()}</th></tr><tr><th colSpan="7">본인일부부담금 (추정)</th><th className="num">{copay.toLocaleString()}</th></tr><tr><th colSpan="7">청구액 (추정)</th><th className="num">{(total - copay).toLocaleString()}</th></tr></tfoot></table>
    <p className="small">금액 = 상대가치점수 × 환산지수 × (1 + 종별가산율), 10원 미만 절사 · 2026 환산지수(의원 95.6원 · 병원급 83.8원). 홀터 48시간 초과(E6556·E6557)는 선별급여(본인부담 80%, 항 B · 목 03). 원격심박감시(EX871)는 재료대 포함. 1회용 전극·패치 재료대는 별도 코드 확인.</p>
    <h3>판독소견서 (급여기준 필수 항목)</h3>
    <table className="rp-t"><tbody>
      <tr><th>기록 시작</th><td>{dt(start, 'ko')}</td><th>기록 종료</th><td>{dt(a.last, 'ko')}</td></tr>
      <tr><th>총 기록</th><td>{hours.toFixed(1)} 시간 (분석 가능 {a.rec ? Math.round((a.ana / a.rec) * 100) : 0}%)</td><th>심박수</th><td>평균 {a.avg?.toFixed(0) ?? '—'} · 최저 {a.min?.bpm ?? '—'} · 최고 {a.max?.bpm ?? '—'} bpm</td></tr>
      <tr><th>주요 소견</th><td colSpan="3">{Object.entries(a.counts).filter(([k]) => !isPause(k)).map(([k, n]) => `${rname(k, 'ko')} ${n}회`).join(', ') || '특이 소견 없음'} {a.hasEct ? `· 심실조기수축 ${a.beats ? ((a.v / a.beats) * 100).toFixed(1) : 0}%` : ''}</td></tr>
    </tbody></table>
    <div className="rp-sign"><span>판독 의사: <b>{bill.physician || '________'}</b></span><span>면허번호: <b className="mono">{bill.license || '________'}</b></span><span>판독일시: ____________</span><span>(서명)</span></div>
  </div>)
}

// ───────── 미국: CMS-1500 ─────────
export function ClaimUS({ rep, emr, series, bill }) {
  const { a, start, hours } = spanOf(rep, series)
  const p = rep.patient || {}
  const mode = p.mode === 'inpatient' ? 'inpatient' : (p.mode ? 'mcot' : 'outpatient')
  const dx = suggestDx(emr?.disease || p.diagnosis, a.counts)
  if (emr?.icd10) dx.splice(0, dx.length, ...dx.filter((d) => d.cm.slice(0, 3) !== emr.icd10.slice(0, 3))); if (emr?.icd10) dx.unshift({ cm: emr.icd10, en: emr.disease, from: 'emr' })
  const lines = usLines(mode, hours)
  const payer = US_PAYERS.find((x) => x[0] === bill.us_payer) || US_PAYERS[0]
  const [nm, ...rest] = (emr?.name || p.name || '').split(' ')
  const [f, set] = useF({ member: '', group: '', insured: 'SELF', ordering: '', orderingNpi: '', pa: '', acct: rep.patch, charges: Object.fromEntries(lines.map((l) => [l.code, l.fee.toFixed(2)])) })
  const mdy = (ms) => { const d = new Date(ms); return `${pad(d.getMonth() + 1)} ${pad(d.getDate())} ${String(d.getFullYear()).slice(2)}` }
  const dosFrom = start, dosTo = mode === 'mcot' ? start : a.last
  const total = lines.reduce((s, l) => s + (parseFloat(f.charges[l.code]) || 0), 0)
  const bd = emr?.birth_date ? emr.birth_date.split('-') : null
  return (<div className="rp-doc claim us">
    <div className="cl-title"><h1>HEALTH INSURANCE CLAIM FORM</h1><span>APPROVED BY NATIONAL UNIFORM CLAIM COMMITTEE (NUCC) 02/12 · CMS-1500</span><span className="cl-draft">DRAFT · verify before submission</span></div>
    <div className="cl-payer"><b>{payer[1]}</b><span>{payer[2]}</span></div>
    <div className="grid g6">
      <Box n="1" l="Plan type" w={3}>{['MCR'].includes(bill.us_payer) ? '☒ Medicare ☐ Medicaid ☐ Group Health Plan ☐ Other' : '☐ Medicare ☐ Medicaid ☒ Group Health Plan ☐ Other'}</Box>
      <Box n="1a" l="Insured's ID number" w={3}><In v={f.member} on={set('member')} ph="Member ID" /></Box>
      <Box n="2" l="Patient's name (Last, First, MI)" w={3}>{rest.length ? `${rest.join(' ')}, ${nm}` : nm}</Box>
      <Box n="3" l="Birth date · Sex" w={3}>{bd ? `${bd[1]} ${bd[2]} ${bd[0]}` : '—'} · {emr?.sex === 'F' ? 'M ☐ F ☒' : 'M ☒ F ☐'}</Box>
      <Box n="5" l="Patient's address" w={3}>{emr?.address?.label || p.home_address || '—'}</Box>
      <Box n="6" l="Relationship to insured" w={1}><In v={f.insured} on={set('insured')} /></Box>
      <Box n="11" l="Insured's group number" w={2}><In v={f.group} on={set('group')} ph={bill.us_payer === 'MCR' ? 'NONE' : ''} /></Box>
      <Box n="12" l="Patient signature" w={1}>SOF</Box><Box n="13" l="Insured signature" w={1}>SOF</Box>
      <Box n="17" l="Ordering provider (DK)" w={2}><In v={f.ordering} on={set('ordering')} ph="DK  Name" /></Box>
      <Box n="17b" l="NPI" w={1}><In v={f.orderingNpi} on={set('orderingNpi')} /></Box>
      <Box n="18" l="Hospitalization dates" w={2}>{mode === 'inpatient' ? `${mdy(start)} – ${mdy(a.last)}` : ''}</Box>
      <Box n="19" l="Additional claim information" w={4}>{`Single-lead ECG patch, continuous ${hours.toFixed(1)} h (${(hours / 24).toFixed(1)} d), analyzable ${a.rec ? Math.round((a.ana / a.rec) * 100) : 0}%`}</Box>
      <Box n="21" l="Diagnosis (ICD Ind. 0)" w={6}><div className="dxg">{dx.slice(0, 12).map((d, i) => <span key={d.cm}><b>{'ABCDEFGHIJKL'[i]}.</b> <span className="mono">{d.cm.replace('.', '')}</span> <small>{d.en}</small></span>)}</div></Box>
      <Box n="22" l="Resubmission code" w={2} /><Box n="23" l="Prior authorization number" w={4}><In v={f.pa} on={set('pa')} /></Box>
    </div>
    <table className="rp-t cl24"><thead><tr><th>24A DOS From</th><th>To</th><th>B POS</th><th>D CPT/HCPCS</th><th>Mod</th><th>E Dx ptr</th><th className="num">F $Charges</th><th>G Units</th><th>J Rendering NPI</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.code}><td>{mdy(dosFrom)}</td><td>{mdy(l.code === '93228' || l.code === '93229' ? dosFrom : dosTo)}</td><td>{US_POS[mode]}</td><td className="mono"><b>{l.code}</b><div className="small">{l.desc}</div></td><td>{l.mod}</td><td>{dx.slice(0, 4).map((_, i) => 'ABCD'[i]).join('')}</td><td className="num"><In v={f.charges[l.code]} on={(v) => set('charges')({ ...f.charges, [l.code]: v })} w="70px" cls="num" /></td><td>{l.units}</td><td className="mono">{bill.license}</td></tr>)}</tbody></table>
    <div className="grid g6">
      <Box n="25" l="Federal tax I.D." w={2}>{bill.us_tax || '—'}</Box><Box n="26" l="Patient's account no." w={2}><In v={f.acct} on={set('acct')} /></Box><Box n="27" l="Accept assignment" w={1}>☒ YES</Box><Box n="28" l="Total charge" w={1}>${total.toFixed(2)}</Box>
      <Box n="31" l="Signature of physician" w={2}>{bill.physician || '—'}<br />{new Date().toLocaleDateString('en-US')}</Box><Box n="32" l="Service facility" w={2}>{bill.us_facility || rep.hospital?.name}</Box><Box n="33" l="Billing provider · 33a NPI" w={2}>{bill.us_billing || rep.hospital?.name}<br /><span className="mono">{bill.us_npi}</span></Box>
    </div>
    <p className="small">Code tier by continuous recording: ≤48 h 93224 · &gt;48 h–7 d 93241 · &gt;7–15 d 93245 · &gt;15–30 d 0937T (global); inpatient = professional component only (93227/93244/93248), POS 21, technical bundled in DRG; MCOT 93228 (physician) + 93229 (monitoring center), 1 unit per ≤30-day episode, DOS = hook-up date. Never append -26/-TC; Holter &lt;12 h takes -52. Charges default to the 2026 Medicare national amounts (CF $33.4009). Electronic equivalent: ANSI X12 837P.</p>
  </div>)
}

// ───────── 일본: 診療報酬明細書 ─────────
export function ClaimJP({ rep, emr, series, bill }) {
  const { a, start, hours } = spanOf(rep, series)
  const p = rep.patient || {}
  const mode = p.mode === 'inpatient' ? 'inpatient' : 'mcot'
  const dx = suggestDx(emr?.disease || p.diagnosis, a.counts)
  if (emr?.icd10) dx.splice(0, dx.length, ...dx.filter((d) => d.cm.slice(0, 3) !== emr.icd10.slice(0, 3))); if (emr?.icd10) dx.unshift({ cm: emr.icd10, ja: emr.disease, from: 'emr' })
  const sd = new Date(start)
  const dayIndex = Math.max(1, Math.floor((new Date(rep.from_ms) - new Date(sd.getFullYear(), sd.getMonth(), sd.getDate())) / 86400000) + 1)
  const lines = jpLines(mode, hours, dayIndex, series.length, bill.us_d212)
  const pts = lines.reduce((s, l) => s + l.pts * l.count, 0)
  const [f, set] = useF({ hokensha: '', kigo: '', bango: '', eda: '00' })
  const wareki = (d) => `令和${d.getFullYear() - 2018}年${d.getMonth() + 1}月${d.getDate()}日`
  const ed = new Date(a.last)
  return (<div className="rp-doc claim jp">
    <div className="cl-title"><h1>診療報酬明細書</h1><span>{mode === 'inpatient' ? '（医科入院）様式第2(1)' : '（医科入院外）様式第2(2)'} · 令和{ed.getFullYear() - 2018}年{ed.getMonth() + 1}月分</span><span className="cl-draft">下書き・請求前に確認</span></div>
    <div className="grid g6">
      <Box n="" l="都道府県番号" w={1} cls="mono">{bill.jp_pref}</Box><Box n="" l="点数表" w={1}>1 医科</Box><Box n="" l="医療機関コード" w={2}><span className="mono">{bill.jp_code || '_______'}</span></Box><Box n="" l="保険種別" w={2}>1 社・国 · 1 単独 · {mode === 'inpatient' ? '本入' : '本外'}</Box>
      <Box n="" l="保険者番号" w={2}><In v={f.hokensha} on={set('hokensha')} ph="8桁" /></Box><Box n="" l="給付割合" w={1}>{10 - bill.jp_ratio}割</Box><Box n="" l="記号・番号（枝番）" w={3}><In v={f.kigo} on={set('kigo')} w="80px" ph="記号" /> · <In v={f.bango} on={set('bango')} w="90px" ph="番号" /> （<In v={f.eda} on={set('eda')} w="30px" />）</Box>
      <Box n="" l="氏名" w={2}><b>{emr?.name || p.name}</b>{emr?.name_kana ? <div className="small">{emr.name_kana}</div> : null}</Box><Box n="" l="性別" w={1}>{emr?.sex === 'F' ? '2 女' : '1 男'}</Box><Box n="" l="生年月日" w={1}>{emr?.birth_date || '—'}</Box><Box n="" l="職務上の事由" w={1}>—</Box><Box n="" l="特記事項" w={1} />
      <Box n="" l="保険医療機関の所在地及び名称" w={6}>{rep.hospital?.name || rep.site} {rep.hospital?.region || ''}</Box>
    </div>
    <table className="rp-t"><thead><tr><th>傷病名</th><th>ICD-10</th><th>診療開始日</th><th>転帰</th></tr></thead>
      <tbody>{dx.slice(0, 4).map((d, i) => <tr key={d.cm}><td>({i + 1}) {d.ja}{i === 0 ? '（主）' : ''}</td><td className="mono">{d.cm}</td><td>{wareki(sd)}</td><td>継続</td></tr>)}</tbody></table>
    <div className="grid g6"><Box n="" l="診療実日数（保険）" w={2}>{series.length} 日</Box><Box n="" l="記録" w={4}>{dt(start, 'ja')} – {dt(a.last, 'ja')} · {hours.toFixed(1)} 時間</Box></div>
    <h3>摘要（60 検査）</h3>
    <table className="rp-t"><thead><tr><th>識別</th><th>区分</th><th>診療行為</th><th className="num">点数</th><th className="num">回数</th><th className="num">小計</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.code}><td>60</td><td className="mono">{l.code}</td><td>{l.name}</td><td className="num">{l.pts.toLocaleString()}</td><td className="num">{l.count}</td><td className="num">{(l.pts * l.count).toLocaleString()}</td></tr>)}</tbody>
      <tfoot><tr><th colSpan="5">請求点数（保険）</th><th className="num">{pts.toLocaleString()}</th></tr><tr><th colSpan="5">一部負担金額（{bill.jp_ratio}割・円）</th><th className="num">{(Math.round((pts * 10 * bill.jp_ratio) / 10 / 10) * 10).toLocaleString()}</th></tr></tfoot></table>
    <p className="small">令和8年度改定（2026-06-01施行）: D210 ホルター型心電図検査 8時間以上 1,730点、7日間以上の記録で長時間心電図加算 320点（解析費用を含む・一連につき1回）。入院の心電図監視は D220 呼吸心拍監視（3時間超・1日につき 7日以内150点／14日以内130点／以降50点、特定入院料・DPC包括に注意）。外来のリアルタイム解析は D212 600点。心電図検査に生体検査判断料はありません。電子レセプト: SI レコード（診療識別 60）、診療行為コード（9桁）は支払基金マスターで確認。</p>
    <div className="rp-sign"><span>判読医: <b>{bill.physician || '________'}</b></span><span>{bill.license}</span></div>
  </div>)
}
