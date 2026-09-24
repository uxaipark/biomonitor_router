import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import { useMe, can } from '../auth.js'
import { wardText } from '../model.js'
import Dropdown from '../Dropdown.jsx'

/**
 * 설정 › EMR 연동 — 라우터가 받은 생체 수치를 병원 EMR 에 간호 바이탈로 보낸다.
 * 연결 하나 = 이 라우터 병원 × 외부 EMR 한 곳(FHIR R4/STU3 · HL7 v2 MLLP). 인증·재원 명단·환자 매칭·전송·재시도는 라우터가 한다.
 * 시험용: 에뮬레이터의 가상 EMR 20곳 카탈로그에서 골라 붙인다(환자가 서로 달라 '시험용 짝짓기'로 매칭).
 */
const PROTO = { fhir: 'FHIR', hl7v2: 'HL7 v2' }
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
  return (
    <div className="page adm integ">
      <div className="adm-head">
        <h2 className="h">EMR 연동</h2>
        <span className="muted">{conns.length}개 연결 · 켜짐 {conns.filter((c) => c.config.enabled).length}</span>
        <span className="spacer" />
        {edit && <button className="primary" onClick={() => setAdding(true)}>+ 연결 추가</button>}
      </div>
      <p className="muted adm-desc">
        패치의 HR·호흡수·SpO₂·체온을 병원 EMR 에 간호 바이탈로 기록합니다. 기관마다 인증(SMART·OAuth·Basic·API 키), 재원 명단,
        환자 식별자, 시간대·단위(미국 °F)·문자셋(ISO-2022-JP·ISO 8859-1)이 다르며 라우터가 맞춰 보냅니다. 이 라우터 병원({data?.site}) 환자만 보냅니다.
      </p>
      {err && <p className="err">{err.message}</p>}
      <table className="tbl adm-tbl integ-tbl">
        <thead><tr><th>켜기</th><th>기관</th><th>형식</th><th>범위</th><th className="num">재원</th><th className="num">매칭</th><th className="num">성공</th><th className="num">실패</th><th>마지막 전송</th><th>상태</th></tr></thead>
        <tbody>
          {conns.map((c) => {
            const s = c.state, g = c.config
            const backoff = s.backoff_until_ms > Date.now()
            return (
              <tr key={g.id} className={'clickable' + (sel === g.id ? ' sel' : '')} onClick={() => setSel(g.id)}>
                <td onClick={(e) => e.stopPropagation()}><label className="switch"><input type="checkbox" checked={g.enabled} disabled={!edit} onChange={(e) => toggle(c, e.target.checked)} /><i /></label></td>
                <td><b>{g.name}</b></td>
                <td><span className={'proto p-' + g.protocol}>{PROTO[g.protocol] || g.protocol} {g.version}</span> <small className="muted">{g.flavor}</small></td>
                <td>{g.scope_ward ? wardText(g.scope_ward) : '전체'}</td>
                <td className="num">{s.census || '—'}</td>
                <td className="num">{s.linked || '—'}</td>
                <td className="num">{s.sent_ok.toLocaleString()}</td>
                <td className="num">{s.sent_fail ? <span className="nz-bad">{s.sent_fail}</span> : <span className="zero">0</span>}</td>
                <td className="muted">{ago(s.last_send_ms)}</td>
                <td>{!g.enabled ? <span className="tag small">꺼짐</span> : backoff ? <span className="tag warn small" title={s.last_error}>재시도 대기</span> : s.running ? <span className="tag ok small">동작</span> : <span className="tag small">시작 중</span>}</td>
              </tr>
            )
          })}
          {!conns.length && <tr><td colSpan="10" className="muted">연결이 없습니다. "+ 연결 추가"로 기관을 고르세요.</td></tr>}
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
        <span className={'proto p-' + g.protocol}>{PROTO[g.protocol]} {g.version}</span>
        <span className="muted">{g.flavor} · {g.tz} · 인증 {authType}{g.charset && g.charset !== 'utf-8' ? ` · 문자셋 ${g.charset}` : ''}</span>
        <span className="spacer" />
        {edit && <><button onClick={() => run('census')} disabled={!g.enabled}>재원 명단 다시 받기</button><button className="primary" onClick={() => run('send')} disabled={!g.enabled}>지금 보내기</button><button className="danger" onClick={del}>삭제</button></>}
      </div>
      <div className="id-grid">
        <div><small>주소</small><span className="mono">{g.protocol === 'fhir' ? g.fhir_base : `mllp://${g.mllp_host}:${g.mllp_port} · MSH-5/6 ${g.receiving_app}/${g.facility}`}</span></div>
        <div><small>재원 명단</small><span className="mono">{g.census_url}</span></div>
        <div><small>보낼 환자 범위</small>
          <Dropdown value={g.scope_ward || ''} options={[{ value: '', label: '전체 병동' }, ...(wards || []).map((w) => ({ value: w, label: `${wardText(w)} (${w})` }))]} onChange={(v) => put({ scope_ward: v })} searchable width={220} />
        </div>
        <div><small>환자 매칭</small>
          <span className="seg">{[['pair', '시험용 짝짓기'], ['mrn', 'MRN 일치']].map(([k, l]) => <button key={k} className={g.match_mode === k ? 'active' : ''} disabled={!edit} onClick={() => put({ match_mode: k })}>{l}</button>)}</span>
        </div>
        <div><small>전송 주기</small>
          <span className="seg">{[60, 300, 900, 3600].map((n) => <button key={n} className={g.interval_s === n ? 'active' : ''} disabled={!edit} onClick={() => put({ interval_s: n })}>{n < 3600 ? `${n / 60}분` : '1시간'}</button>)}</span>
        </div>
        <div><small>최대 환자 수</small><input type="number" min="1" max="500" defaultValue={g.max_patients} disabled={!edit} onBlur={(e) => put({ max_patients: Number(e.target.value) })} style={{ width: 90 }} /></div>
        <div><small>토큰</small>{s.token_exp_ms ? `만료 ${fmtTime(s.token_exp_ms)}` : authType.includes('basic') || authType === 'bearer-static' || authType === 'api-key' || authType === 'mllp-facility' ? '필요 없음' : '—'}</div>
        <div><small>재원 명단 받은 때</small>{ago(s.census_ms)} · {s.census}명</div>
      </div>
      {s.last_error && <p className="integ-err">마지막 오류: {s.last_error}</p>}
      <div className="seg id-tabs">
        {[['links', `환자 매칭 ${d.links.length}`], ['log', `기록 ${d.log.length}`], ['recv', 'EMR이 받은 값']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'links' && (
        <table className="tbl adm-tbl">
          <thead><tr><th>우리 환자</th><th>침대</th><th /><th>EMR 환자</th><th>EMR 위치</th><th>내원번호</th><th className="num">성공</th><th className="num">실패</th><th>마지막 결과</th></tr></thead>
          <tbody>
            {d.links.map((l) => (
              <tr key={l.channel_id}>
                <td><b>{l.local_name}</b> <small className="mono muted">{l.channel_id}</small></td>
                <td className="mono">{l.local_room}</td>
                <td className="muted">→</td>
                <td><b>{l.remote.name}</b> <small className="mono muted">{l.remote.ident || l.remote.id}</small></td>
                <td>{l.remote.location || <span className="muted">—</span>}</td>
                <td className="mono">{l.remote.encounter || <span className="muted">—</span>}</td>
                <td className="num">{l.ok}</td>
                <td className="num">{l.fail ? <span className="nz-bad">{l.fail}</span> : <span className="zero">0</span>}</td>
                <td className={l.last_result && !/저장|ACK A/.test(l.last_result) ? 'err' : 'muted'}>{l.last_result || '—'}</td>
              </tr>
            ))}
            {!d.links.length && <tr><td colSpan="9" className="muted">매칭된 환자가 없습니다 (연결을 켜면 재원 명단을 받아 짝짓습니다).</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'log' && (
        <div className="evl">
          {d.log.map((e, i) => (
            <div key={i} className="evl-row">
              <span className="evl-ts">{fmtTime(e.ts_ms)}</span>
              <span className="evl-kind" style={{ color: e.ok ? 'var(--accent)' : 'var(--err)' }}>{({ token: '토큰', census: '재원 명단', send: '전송', error: '오류' })[e.kind] || e.kind}</span>
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

function AddModal({ onClose, onAdded }) {
  const [cat, setCat] = useState(null)
  const [err, setErr] = useState('')
  const [site, setSite] = useState('')
  useEffect(() => { api.integ.catalog().then(setCat).catch((e) => setErr(e.message)) }, [])
  const groups = useMemo(() => {
    const m = new Map()
    for (const s of cat?.sites || []) { if (!m.has(s.country_ko)) m.set(s.country_ko, []); m.get(s.country_ko).push(s) }
    return [...m]
  }, [cat])
  const add = async () => {
    setErr('')
    try { const r = await api.integ.create({ site_id: site }); onAdded(r.config.id) } catch (e) { setErr(e.message) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal adm-form integ-add" onClick={(e) => e.stopPropagation()}>
        <h3>EMR 연결 추가 <small className="muted">에뮬레이터 가상 EMR 카탈로그</small></h3>
        {!cat && !err && <p className="muted">카탈로그 불러오는 중…</p>}
        {groups.map(([country, list]) => (
          <div key={country} className="ia-group">
            <span className="ia-country">{country}</span>
            <div className="ia-list">{list.map((s) => (
              <button key={s.id} className={'ia-site' + (site === s.id ? ' on' : '')} disabled={!s.supported} onClick={() => setSite(s.id)} title={s.style}>
                <b>{s.name_local || s.name}</b>
                <span>{s.protocol_ko} {s.version} · {s.flavor}</span>
                {!s.supported ? <small className="muted">다음 단계에서 지원</small> : s.added ? <small className="ok">연결 있음</small> : null}
              </button>
            ))}</div>
          </div>
        ))}
        {err && <p className="err">{err}</p>}
        <p className="muted">추가하면 꺼진 상태로 만들어집니다. 범위(병동)·주기를 정한 뒤 켜세요.</p>
        <div className="toolbar"><span className="spacer" /><button onClick={onClose}>취소</button><button className="primary" disabled={!site} onClick={add}>추가</button></div>
      </div>
    </div>
  )
}
