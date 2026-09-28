import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import { useMe, can } from '../auth.js'
import { wardText } from '../model.js'
import Dropdown from '../Dropdown.jsx'
import './Integration.css'

/**
 * 운영관리 › EMR 연동 — 라우터가 받은 생체 수치를 병원 EMR 에 간호 바이탈로 보낸다.
 * 연결 하나 = 이 라우터 병원 × 외부 EMR 한 곳(FHIR R4/STU3 · HL7 v2 MLLP). 인증·재원 명단·환자 매칭·전송·재시도는 라우터가 한다.
 * 시험용: 에뮬레이터의 가상 EMR 20곳 카탈로그에서 골라 붙인다(환자가 서로 달라 '시험용 짝짓기'로 매칭).
 */
const PROTO = { fhir: 'FHIR', hl7v2: 'HL7 v2', 'kr-json': 'REST JSON', 'kr-xml': 'XML 전문', cda: 'CDA R2', athena: 'athena REST' }
const ADT_HOW = {
  hl7v2: 'HL7 ADT 피드 15초', 'kr-json': '이벤트(EVT_SEQ) 15초', 'kr-xml': 'EMR_ADT_0002 15초', athena: '변경 구독 15초',
  fhir: 'Encounter _lastUpdated 15초', group: '명단 다시 받기 60초', cda: '문서 목록 다시 받기 60초',
}
const ADT_CODE = { A01: '입원', A02: '전동', A03: '퇴원', A08: '정보 변경', A11: '입원 취소' }
const MATCH = { pair: '순서', emr: '연동 키', mrn: 'MRN' }
/** 형식 카드 (제안안 ⑫): 카탈로그에 있고 라우터가 지원하는 형식만 보인다 */
const FORMATS = [
  ['fhir', 'FHIR', 'R4 · STU3'],
  ['hl7v2', 'HL7 v2', 'MLLP 전송'],
  ['kr-json', '국내 REST JSON', '기관별 REST API'],
  ['kr-xml', 'EUC-KR XML 전문', 'EUC-KR 인코딩 XML'],
  ['cda', '진료정보교류 CDA R2', '진료정보교류 표준 문서'],
  ['athena', 'athena REST', 'athena REST API'],
]
const MATCH_HELP = { pair: '시험용 — 병동 순서대로 짝지음 (같은 사람 아님)', emr: '에뮬레이터 연동 병원 조인 키(등록번호·FHIR id·내원번호)로 같은 사람을 찾음', mrn: '우리 MRN = 기관 등록번호' }
const ago = (ms) => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 1000))}초 전` : '—')

export default function Integration() {
  const me = useMe()
  const edit = can(me, 'page.integration', 2)
  const [data, err, refresh] = usePoll(api.integ.list, 3000)
  const [sel, setSel] = useState(null)
  const [adding, setAdding] = useState(false)
  const conns = data?.connections || []
  useEffect(() => { if (!sel && conns.length) setSel(conns[0].config.id) }, [conns, sel])
  const toggle = async (c, on) => { try { await api.integ.update(c.config.id, { enabled: on }); refresh?.() } catch (e) { alert(e.message) } }
  const noSite = !me?.site?.tenant_id
  const enabledN = conns.filter((c) => c.config.enabled).length
  return (
    <div className="page adm integ">
      <div className="adm-head">
        <h2 className="h">EMR 연동</h2>
        <span className="integ-counters"><span><b>{conns.length}</b> 연결</span><span className="sep">·</span><span><b className={enabledN ? 'ok' : ''}>{enabledN}</b> 켜짐</span></span>
        <span className="spacer" />
        {edit && !noSite && <button className="primary" onClick={() => setAdding(true)}>+ 연결 추가</button>}
      </div>
      <p className="muted adm-desc">
        패치의 HR · 호흡수 · SpO₂ · 체온을 병원 EMR에 간호 바이탈로 기록합니다. FHIR R4/STU3 · HL7 v2(MLLP) · 국내 REST JSON · EUC-KR XML 전문 ·
        진료정보교류 CDA R2 · athena REST 를 지원하며, 기관마다 다른 인증, 재원 명단, 환자 식별자, 시간대·단위(미국 °F)·문자셋(ISO-2022-JP·ISO 8859-1·EUC-KR)을 라우터가 맞춰 보냅니다.{data?.site ? ` 이 라우터 병원(${data.site}) 환자만 보냅니다.` : ''}
      </p>
      {noSite && (
        <div className="integ-nosite" role="status">
          <b>이 라우터에 병원이 지정되지 않았습니다.</b>
          <span>전송 대상 환자를 정할 수 없어 연결을 켤 수 없습니다.</span>
          <a href="#/admin/tenants">병원 (테넌트) 지정 →</a>
        </div>
      )}
      {err && <p className="err">{err.message}</p>}
      <table className="tbl adm-tbl integ-tbl">
        <thead><tr><th>켜기</th><th>기관</th><th>형식</th><th>범위</th><th className="num">재원 매칭</th><th className="num">성공</th><th className="num">실패</th><th>마지막 전송</th><th>상태</th></tr></thead>
        <tbody>
          {conns.map((c) => {
            const s = c.state, g = c.config
            const backoff = s.backoff_until_ms > Date.now()
            return (
              <tr key={g.id} className={'clickable' + (sel === g.id ? ' sel' : '')} onClick={() => setSel(g.id)}>
                <td onClick={(e) => e.stopPropagation()}><label className="switch"><input type="checkbox" checked={g.enabled} disabled={!edit || noSite} onChange={(e) => toggle(c, e.target.checked)} /><i /></label></td>
                <td><b>{g.name}</b></td>
                <td><span className={'proto p-' + g.protocol}>{PROTO[g.protocol] || g.protocol}{/^\d/.test(g.version) ? ` ${g.version}` : ''}</span> <small className="muted">{g.flavor}</small></td>
                <td>{g.scope_ward ? wardText(g.scope_ward) : '전체'}</td>
                <td className="num" title="재원 명단 인원 / 매칭된 환자">{s.census || '—'} / {s.linked || '—'}</td>
                <td className="num">{s.sent_ok.toLocaleString()}</td>
                <td className="num">{s.sent_fail ? <span className="nz-bad">{s.sent_fail}</span> : <span className="zero">0</span>}</td>
                <td className="muted">{ago(s.last_send_ms)}</td>
                <td>{!g.enabled ? <span className="tag small">꺼짐</span> : backoff ? <span className="tag warn small" title={s.last_error}>재시도 대기</span> : s.running ? <span className="tag ok small">동작</span> : <span className="tag small">시작 중</span>}</td>
              </tr>
            )
          })}
          {!conns.length && <tr><td colSpan="9"><div className="integ-empty"><b>연결을 만들면 여기에서 켜고 끄며 전송 성공률을 확인합니다.</b>{edit && !noSite && <span>"+ 연결 추가" 로 형식 → 기관 → 매칭 → 시험 전송 순서로 만듭니다.</span>}</div></td></tr>}
        </tbody>
      </table>
      {sel && conns.some((c) => c.config.id === sel) && <Detail id={sel} edit={edit} onDeleted={() => { setSel(null); refresh?.() }} onChanged={refresh} />}
      {adding && <AddModal onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setSel(id); refresh?.() }} />}
    </div>
  )
}

function Detail({ id, edit, onDeleted, onChanged }) {
  const [d] = usePoll(() => api.integ.get(id), 3000, [id])
  const [tab, setTab] = useState('links')
  const [recv, setRecv] = useState(null)
  const [wards] = usePoll(() => api.channels().then((rows) => [...new Set(rows.map((r) => r.patient?.ward).filter(Boolean))].sort()).catch(() => []), 60000)
  useEffect(() => { if (tab === 'recv') api.integ.received(id).then(setRecv).catch((e) => setRecv({ error: e.message })) }, [tab, id])
  if (!d) return <div className="panel"><p className="muted">불러오는 중…</p></div>
  const g = d.config, s = d.state
  const put = async (b) => { try { await api.integ.update(id, b); onChanged?.() } catch (e) { alert(e.message) } }
  const run = async (what) => { try { await api.integ.run(id, what) } catch (e) { alert(e.message) } }
  const del = async () => { if (!window.confirm(`${g.name} 연결을 지웁니다. 계속할까요?`)) return; await api.integ.remove(id); onDeleted() }
  const authType = g.auth?.type || '—'
  return (
    <section className="panel integ-detail">
      <div className="id-head">
        <h3>{g.name}</h3>
        <span className={'proto p-' + g.protocol}>{PROTO[g.protocol] || g.protocol}{/^\d/.test(g.version) ? ` ${g.version}` : ''}</span>
        <span className="muted">{g.flavor} · {g.tz} · 인증 {authType}{g.charset && g.charset !== 'utf-8' ? ` · 문자셋 ${g.charset}` : ''}</span>
        <span className="spacer" />
        {edit && <><button onClick={() => run('census')} disabled={!g.enabled}>재원 명단 다시 받기</button><button onClick={() => run('adt_rewind')} disabled={!g.enabled} title="입퇴원 피드를 조금 되감아 최근 변경을 다시 적용합니다 (장애 뒤 재동기화)">입퇴원 다시 읽기</button><button className="primary" onClick={() => run('send')} disabled={!g.enabled}>지금 보내기</button><button className="danger" onClick={del}>삭제</button></>}
      </div>
      <div className="id-grid">
        <div><small>주소</small><span className="mono">{g.protocol === 'fhir' ? g.fhir_base : g.protocol === 'hl7v2' ? `mllp://${g.mllp_host}:${g.mllp_port} · MSH-5/6 ${g.receiving_app}/${g.facility}` : g.base_url}</span></div>
        <div><small>재원 명단</small><span className="mono">{g.census_url}</span></div>
        <div><small>보낼 환자 범위</small>
          <Dropdown value={g.scope_ward || ''} options={[{ value: '', label: '전체 병동' }, ...(wards || []).map((w) => ({ value: w, label: `${wardText(w)} (${w})` }))]} onChange={(v) => put({ scope_ward: v })} searchable width={220} />
        </div>
        <div><small>환자 매칭</small>
          <span className="seg">{[['pair', '시험용 짝짓기'], ['mrn', '식별자 일치']].map(([k, l]) => <button key={k} className={g.match_mode === k ? 'active' : ''} disabled={!edit} onClick={() => put({ match_mode: k })}>{l}</button>)}</span>
        </div>
        <div><small>전송 주기</small>
          <span className="seg">{[60, 300, 900, 3600].map((n) => <button key={n} className={g.interval_s === n ? 'active' : ''} disabled={!edit} onClick={() => put({ interval_s: n })}>{n < 3600 ? `${n / 60}분` : '1시간'}</button>)}</span>
        </div>
        <div><small>최대 환자 수</small><input type="number" min="1" max="500" defaultValue={g.max_patients} disabled={!edit} onBlur={(e) => put({ max_patients: Number(e.target.value) })} style={{ width: 90 }} /></div>
        <div><small>토큰</small>{s.token_exp_ms ? `만료 ${fmtTime(s.token_exp_ms)}` : authType.includes('basic') || authType === 'bearer-static' || authType === 'api-key' || authType === 'mllp-facility' || authType === 'ip-allow' ? '필요 없음' : '—'}</div>
        <div><small>재원 명단 받은 때</small>{ago(s.census_ms)} · {s.census}명</div>
        <div><small>입퇴원 반영</small>{s.adt_ms ? `${ago(s.adt_ms)} 확인 · 누적 ${s.adt_count}건` : '—'} <span className="muted">{ADT_HOW[g.protocol === 'fhir' && ['epic', 'oracle'].includes(g.flavor) ? 'group' : g.protocol] || ''}</span></div>
      </div>
      {s.last_error && <p className="integ-err">마지막 오류: {s.last_error}</p>}
      <div className="seg id-tabs">
        {[['links', `환자 매칭 ${d.links.length}`], ['adt', `입퇴원 ${d.adt?.length || 0}`], ['log', `기록 ${d.log.length}`], ['recv', 'EMR이 받은 값']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'links' && (
        <table className="tbl adm-tbl">
          <thead><tr><th>우리 환자</th><th>침대</th><th>매칭</th><th>EMR 환자</th><th>EMR 위치</th><th>내원번호</th><th className="num">성공</th><th className="num">실패</th><th>마지막 결과</th></tr></thead>
          <tbody>
            {d.links.map((l) => (
              <tr key={l.channel_id}>
                <td><b>{l.local_name}</b> <small className="mono muted">{l.channel_id}</small></td>
                <td className="mono">{l.local_room}</td>
                <td><span className={'tag small m-' + l.matched_by} title={MATCH_HELP[l.matched_by]}>{MATCH[l.matched_by] || '→'}</span></td>
                <td><b>{l.remote.name}</b> <small className="mono muted">{l.remote.ident || l.remote.id}</small></td>
                <td>{l.remote.location || <span className="muted">—</span>}</td>
                <td className="mono">{l.remote.encounter || <span className="muted">—</span>}</td>
                <td className="num">{l.ok}</td>
                <td className="num">{l.fail ? <span className="nz-bad">{l.fail}</span> : <span className="zero">0</span>}</td>
                <td className={l.last_result && !/저장|등록|ACK A/.test(l.last_result) ? 'err' : 'muted'}>{l.last_result || '—'}</td>
              </tr>
            ))}
            {!d.links.length && <tr><td colSpan="9" className="muted">매칭된 환자가 없습니다 (연결을 켜면 재원 명단을 받아 짝짓습니다).</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'adt' && (
        <table className="tbl adm-tbl">
          <thead><tr><th>반영 시각</th><th>종류</th><th>EMR 환자</th><th>위치</th><th>짝에 준 영향</th></tr></thead>
          <tbody>
            {(d.adt || []).map((e, i) => (
              <tr key={i}>
                <td className="muted">{fmtTime(e.ts_ms)}</td>
                <td><span className={'tag small adt-' + e.code}>{ADT_CODE[e.code] || e.code}</span></td>
                <td><b>{e.name}</b> <small className="mono muted">{e.remote_id}</small></td>
                <td>{e.location || <span className="muted">—</span>}</td>
                <td className={e.effect.startsWith('짝 해제') ? 'nz-bad' : e.effect.startsWith('새 짝') ? 'ok' : 'muted'}>{e.effect || '—'}</td>
              </tr>
            ))}
            {!(d.adt || []).length && <tr><td colSpan="5" className="muted">아직 반영한 입퇴원이 없습니다. 연결을 켠 뒤 생긴 입원·전동·퇴원이 여기에 쌓입니다.</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'log' && (
        <div className="evl">
          {d.log.map((e, i) => (
            <div key={i} className="evl-row">
              <span className="evl-ts">{fmtTime(e.ts_ms)}</span>
              <span className="evl-kind" style={{ color: e.ok ? 'var(--accent)' : 'var(--err)' }}>{({ token: '토큰', census: '재원 명단', send: '전송', error: '오류', adt: '입퇴원' })[e.kind] || e.kind}</span>
              <span className="evl-ch">{e.status}</span>
              <span className="evl-msg" title={e.summary}>{e.summary}</span>
            </div>
          ))}
        </div>
      )}
      {tab === 'recv' && (
        recv?.error ? <p className="err">{recv.error}</p> : !recv ? <p className="muted">불러오는 중…</p> : (
          <>
            <p className="muted">가상 EMR({g.site_id})이 검증을 통과해 저장한 값 {recv.total}건 — 최근 {Math.min(40, recv.rows?.length || 0)}건</p>
            <table className="tbl adm-tbl">
              <thead><tr><th>측정 (현지 시각)</th><th>환자</th><th>내원</th><th>항목</th><th className="num">값</th><th>단위</th></tr></thead>
              <tbody>{(recv.rows || []).slice(0, 40).map((r) => (
                <tr key={r.id}><td className="mono">{r.measured}</td><td>{r.patient}</td><td className="mono">{r.visit}</td><td>{r.label}</td><td className="num">{r.value}</td><td>{r.unit}</td></tr>
              ))}</tbody>
            </table>
          </>
        )
      )}
    </section>
  )
}

/**
 * 연결 추가 마법사 (제안안 ⑫): 1 형식 선택 → 2 기관 · 인증 → 3 재원 명단 · 환자 매칭 → 4 시험 전송 후 켜기.
 * 기관·인증은 카탈로그(에뮬레이터 가상 EMR)에서 오고, 3단계 값은 만든 뒤 update 로 넣는다. 4단계에서 켜고 시험 전송까지.
 */
const STEPS = ['형식 선택', '기관 · 인증', '재원 명단 · 환자 매칭', '시험 전송 후 켜기']
function AddModal({ onClose, onAdded }) {
  const [cat, setCat] = useState(null)
  const [err, setErr] = useState('')
  const [step, setStep] = useState(0)
  const [proto, setProto] = useState('')
  const [site, setSite] = useState('')
  const [opts, setOpts] = useState({ scope_ward: '', match_mode: 'pair', interval_s: 300, max_patients: 100 })
  const [made, setMade] = useState(null) // 만든 연결 { id, name }
  const [busy, setBusy] = useState(false)
  const [testMsg, setTestMsg] = useState('')
  const [wards] = usePoll(() => api.channels().then((rows) => [...new Set(rows.map((r) => r.patient?.ward).filter(Boolean))].sort()).catch(() => []), 60000)
  useEffect(() => { api.integ.catalog().then(setCat).catch((e) => setErr(e.message)) }, [])
  const sites = cat?.sites || []
  const protos = FORMATS.filter(([p]) => sites.some((x) => x.protocol === p && x.supported))
  const groups = useMemo(() => {
    const m = new Map()
    for (const x of sites) { if (x.protocol !== proto) continue; if (!m.has(x.country_ko)) m.set(x.country_ko, []); m.get(x.country_ko).push(x) }
    return [...m]
  }, [sites, proto])
  const picked = sites.find((x) => x.id === site)
  const canNext = step === 0 ? !!proto : step === 1 ? !!site : step === 2 ? true : false
  const create = async () => {
    setBusy(true); setErr('')
    try {
      const r = await api.integ.create({ site_id: site })
      await api.integ.update(r.config.id, { scope_ward: opts.scope_ward, match_mode: opts.match_mode, interval_s: opts.interval_s, max_patients: Number(opts.max_patients) || 100 })
      setMade({ id: r.config.id, name: r.config.name })
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const enableAndTest = async () => {
    if (!made) return
    setBusy(true); setErr(''); setTestMsg('')
    try {
      await api.integ.update(made.id, { enabled: true })
      await api.integ.run(made.id, 'census')
      await api.integ.run(made.id, 'send')
      setTestMsg('켜고 재원 명단을 받은 뒤 시험 전송을 요청했습니다. 결과는 연결 상세의 기록 탭에서 확인하세요.')
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const next = async () => {
    if (step === 2 && !made) { await create(); setStep(3); return }
    setStep(step + 1)
  }
  return (
    <div className="modal-bg" onClick={busy ? undefined : onClose}>
      <div className="modal adm-form integ-add integ-wiz" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>EMR 연결 추가 <small>에뮬레이터 가상 EMR 카탈로그</small></h2><span className="spacer" /><button className="icon" onClick={onClose} disabled={busy}>✕</button></div>
        <ol className="wiz-steps">
          {STEPS.map((l, i) => <li key={l} className={i === step ? 'cur' : i < step ? 'done' : ''}><span className="wiz-n">{i + 1}</span><span>{l}</span></li>)}
        </ol>

        {step === 0 && (
          <div className="wiz-body">
            {!cat && !err && <p className="muted">카탈로그 불러오는 중…</p>}
            <div className="fmt-grid">
              {protos.map(([p, name, sub]) => (
                <button key={p} className={'fmt-card' + (proto === p ? ' on' : '')} onClick={() => { setProto(p); setSite('') }}>
                  <b>{name}</b><span>{sub}</span>
                  <small className="muted">{sites.filter((x) => x.protocol === p && x.supported).length}개 기관</small>
                </button>
              ))}
              {cat && !protos.length && <p className="muted">지원하는 형식의 기관이 카탈로그에 없습니다.</p>}
            </div>
            <p className="muted small">라우터가 자동으로 맞춤: 기관별 인증 · 재원 명단 · 환자 식별자 · 시간대 · 단위 (°F 등) · 문자셋 (EUC-KR · ISO-2022-JP · ISO 8859-1)</p>
          </div>
        )}

        {step === 1 && (
          <div className="wiz-body">
            {groups.map(([country, list]) => (
              <div key={country} className="ia-group">
                <span className="ia-country">{country}</span>
                <div className="ia-list">{list.map((x) => (
                  <button key={x.id} className={'ia-site' + (site === x.id ? ' on' : '')} disabled={!x.supported} onClick={() => setSite(x.id)} title={x.style}>
                    <b>{x.name_local || x.name}</b>
                    <span>{x.protocol_ko} {x.version} · {x.flavor}</span>
                    {!x.supported ? <small className="muted">다음 단계에서 지원</small> : x.added ? <small className="ok">연결 있음</small> : null}
                  </button>
                ))}</div>
              </div>
            ))}
            {picked && <p className="muted small">인증·주소·시간대·문자셋은 카탈로그 값으로 채워집니다{picked.style ? ` (${picked.style})` : ''}. 만든 뒤 상세에서 바꿀 수 있습니다.</p>}
          </div>
        )}

        {step === 2 && (
          <div className="wiz-body wiz-form">
            <label><span>보낼 환자 범위</span>
              <Dropdown value={opts.scope_ward} options={[{ value: '', label: '전체 병동' }, ...(wards || []).map((w) => ({ value: w, label: `${wardText(w)} (${w})` }))]} onChange={(v) => setOpts({ ...opts, scope_ward: v })} searchable width={260} />
            </label>
            <label><span>환자 매칭</span>
              <span className="seg">{[['pair', '시험용 짝짓기'], ['mrn', '식별자 일치']].map(([k, l]) => <button key={k} className={opts.match_mode === k ? 'active' : ''} onClick={() => setOpts({ ...opts, match_mode: k })}>{l}</button>)}</span>
              <small className="muted">{MATCH_HELP[opts.match_mode]}</small>
            </label>
            <label><span>전송 주기</span>
              <span className="seg">{[60, 300, 900, 3600].map((n) => <button key={n} className={opts.interval_s === n ? 'active' : ''} onClick={() => setOpts({ ...opts, interval_s: n })}>{n < 3600 ? `${n / 60}분` : '1시간'}</button>)}</span>
            </label>
            <label><span>최대 환자 수</span><input type="number" min="1" max="500" value={opts.max_patients} onChange={(e) => setOpts({ ...opts, max_patients: e.target.value })} style={{ width: 90 }} /></label>
          </div>
        )}

        {step === 3 && (
          <div className="wiz-body">
            {!made ? <p className="muted">{busy ? '연결을 만드는 중…' : '연결을 만들지 못했습니다. 이전 단계로 돌아가 다시 시도하세요.'}</p> : (
              <>
                <p><b>{made.name}</b> 연결을 꺼진 상태로 만들었습니다. 켜면 재원 명단을 받아 환자를 짝짓고, 시험 전송을 한 번 보냅니다.</p>
                <dl className="wiz-sum">
                  <dt>형식</dt><dd>{(FORMATS.find(([p]) => p === proto) || [])[1] || proto}</dd>
                  <dt>기관</dt><dd>{picked?.name_local || picked?.name}</dd>
                  <dt>범위</dt><dd>{opts.scope_ward ? wardText(opts.scope_ward) : '전체 병동'}</dd>
                  <dt>매칭 · 주기</dt><dd>{opts.match_mode === 'pair' ? '시험용 짝짓기' : '식별자 일치'} · {opts.interval_s < 3600 ? `${opts.interval_s / 60}분` : '1시간'}</dd>
                </dl>
                <div className="toolbar" style={{ marginBottom: 0 }}>
                  <button className="primary" onClick={enableAndTest} disabled={busy}>{busy ? '요청 중…' : '켜고 시험 전송'}</button>
                  <button onClick={() => onAdded(made.id)} disabled={busy}>꺼진 채로 두기</button>
                  {testMsg && <span className="muted small">{testMsg}</span>}
                </div>
              </>
            )}
          </div>
        )}

        {err && <p className="err">{err}</p>}
        <div className="toolbar wiz-nav">
          <button onClick={onClose} disabled={busy}>취소</button>
          <span className="spacer" />
          {step > 0 && step < 3 && <button onClick={() => setStep(step - 1)} disabled={busy}>이전</button>}
          {step < 3 && <button className="primary" disabled={!canNext || busy} onClick={next}>{step === 2 ? '연결 만들기' : '다음'}</button>}
          {step === 3 && made && testMsg && <button className="primary" onClick={() => onAdded(made.id)}>완료</button>}
        </div>
      </div>
    </div>
  )
}
