import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import { can, useMe } from '../auth.js'
import { ReadOnly } from '../ReadOnly.jsx'
import { RHYTHM_LABEL, ALARM_KIND } from '../model.js'
import './EcgEngine.css'

/**
 * 관리 › ECG 분석 엔진 — live-ecg 엔진의 현재 상태, 실행 설정(프리셋·단계 선택), 버전 보관함(활성화·삭제·문서),
 * 활성화 이력, 지금 채널들의 판정 분포, 그리고 엔진 성능(레포 보고서). "엔진 다시 읽기"는 서비스 제어 페이지에 그대로 둔다.
 */
const KIND_LABEL = { qrs: 'QRS 검출', beats: '박동 분류', af: '심방세동', vf: '심실세동', svrun: '상심실 런' }
const fmtDT = (ms) => (ms ? new Date(ms).toLocaleString('ko-KR', { hour12: false }) : '—')

// README/PERFORMANCE.md 의 봉인(TEST) 구역 수치 — 레포 보고서 요약 (엔진 버전에 perf.md 가 있으면 그것도 아래에 그대로 보여 준다)
const PERF_SUMMARY = [
  ['QRS 검출 (민감도 / 정밀도)', '99.20 % / 97.96 %', '공개 코퍼스 318 기록 · 885 h, 봉인'],
  ['심방세동 (민감도 / 정밀도, 검출부터 끝까지)', '90.5 % / 98.8 %', 'AFDB · 30초 이상 에피소드 33/34'],
  ['심방세동 오경보 (AF 없는 리듬)', '2.22 회 / 24 h', 'NSRDB 270 h'],
  ['심실 박동 (민감도 / 정밀도, 박동 단위)', '95.1 % / 83.3 %', 'MIT-BIH · 패치 코퍼스 65.2 % / 88.4 %'],
  ['심실 검토 큐', '96.1 % / 89.2 %', '기록당 8.3 형태'],
  ['상심실 박동 (박동 단위)', '24.9 % / 26.0 %', 'MIT-BIH — 단일 유도 한계 · 패치 설정은 런 단위로'],
  ['심정지 / 휴지', '100 % / 99.2 %', 'MIT-BIH 14/14'],
  ['서맥 / 빈맥 (민감도)', '99.5 % / 97.6 %', '정밀도 95.7 % / 100 %'],
  ['심실세동 경보', '19 / 20 발생 탐지 · 지연 중앙값 9 s', '오경보 4.97/24 h (1건 제외 0.61) · 다른 Holter 616 h 에서 4회'],
  ['신호 품질 판정', 'AUC 0.996', 'BUT QDB · 판독자 4명 대비'],
  ['처리량', '211 ns / 샘플 / 채널', '≈ 19,000 채널 / 코어 @ 250 Hz (Apple M1 Ultra 기준)'],
]

function MdTable({ text }) {
  // 아주 작은 마크다운 렌더: 표(| a | b |)와 제목(#), 나머지는 문단
  const lines = String(text || '').split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^\s*\|/.test(l)) {
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++ }
      const cells = rows.filter((r) => !/^\s*\|\s*-+/.test(r)).map((r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
      out.push(<table key={out.length} className="tbl md"><tbody>{cells.map((r, k) => <tr key={k}>{r.map((c, j) => k === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>)}</tr>)}</tbody></table>)
      continue
    }
    if (/^#+\s/.test(l)) { out.push(<h5 key={out.length}>{l.replace(/^#+\s/, '')}</h5>); i++; continue }
    if (l.trim()) { out.push(<p key={out.length}>{l.replace(/[*_`]/g, '')}</p>) }
    i++
  }
  return <div className="md">{out}</div>
}

export default function EcgEngine() {
  const me = useMe()
  const edit = can(me, 'page.ecg_engine', 2)
  const [e, , refreshE] = usePoll(api.ecg.engine, 5000)
  const [cfg, , refreshCfg] = usePoll(api.ecg.config, 15000)
  const [ver, , refreshVer] = usePoll(api.ecg.versions, 15000)
  const [hist, , refreshHist] = usePoll(api.ecg.history, 15000)
  const [sum] = usePoll(api.ecg.summary, 5000)
  const [ahist] = usePoll(() => api.alarmHistory(500), 15000)
  const [benchBusy, setBenchBusy] = useState(false)
  const [bench, setBench] = useState(null)
  useEffect(() => { if (e?.bench && !bench) setBench(e.bench) }, [e, bench])
  const [benchFlash, setBenchFlash] = useState(false)
  // 알고리즘 검증 (에뮬레이터 정답지)
  const [evalR, , refreshEval] = usePoll(api.ecg.evalLast, 30000)
  const [evalBusy, setEvalBusy] = useState(false)
  const [evalHours, setEvalHours] = useState(1)
  const [evalNow, setEvalNow] = useState(null)
  const runEval = async () => { setEvalBusy(true); setMsg(''); try { const r = await api.ecg.evalRun(evalHours); setEvalNow(r); refreshEval(); setMsg(`검증 완료 — 정답 ${r.labels}개 · 채널 ${r.channels}개`) } catch (x) { setMsg('검증 실패: ' + x.message) } finally { setEvalBusy(false) } }
  const ev = evalNow || evalR?.last
  const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
  const runBench = async () => {
    setBenchBusy(true); setMsg('')
    const t0 = Date.now()
    try {
      const r = await api.ecg.bench(120, 64) // 1.9M 샘플 — 이 기기에서 1초 남짓
      await new Promise((res) => setTimeout(res, Math.max(0, 600 - (Date.now() - t0)))) // 너무 빨리 끝나도 '측정 중' 이 보이게
      setBench({ ...r, _fresh: Date.now() }); setBenchFlash(true); setTimeout(() => setBenchFlash(false), 2500)
      setMsg(`시뮬레이션 측정 완료 — ${r.elapsed_ms} ms 동안 ${(r.samples || 0).toLocaleString()} 샘플 처리`)
    } catch (x) { setMsg('측정 실패: ' + x.message) } finally { setBenchBusy(false) }
  }
  // 오늘 ECG 분석 알람 통계 (종류별 발생 수)
  const ecgAlarms = useMemo(() => { const c = {}; const day = new Date().toDateString(); for (const a of ahist || []) if (String(a.kind).startsWith('ecg_') && new Date(a.since_ms).toDateString() === day) c[a.kind] = (c[a.kind] || 0) + 1; return Object.entries(c).sort((x, y) => y[1] - x[1]) }, [ahist])
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [doc, setDoc] = useState(null) // { key, name, text }
  const [draft, setDraft] = useState(null) // { preset, stages: {kind: name} }
  const stagesByKind = useMemo(() => {
    const m = {}
    for (const s of e?.stages || []) { const kind = s.name.split('.')[0]; (m[kind] = m[kind] || []).push(s) }
    return m
  }, [e])
  useEffect(() => {
    if (!cfg || draft) return
    const sel = {}
    for (const part of String(cfg.stages || '').split(';')) { const [k, v] = part.split('='); if (k && v) sel[k.trim()] = v.trim() }
    setDraft({ preset: cfg.preset || 'patch', stages: sel })
  }, [cfg, draft])
  const stagesStr = (d) => Object.entries(d.stages).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(';')
  const dirty = draft && cfg && (draft.preset !== cfg.preset || stagesStr(draft) !== (cfg.stages || ''))
  const saveCfg = async () => { setBusy(true); setMsg(''); try { await api.ecg.setConfig(draft.preset, stagesStr(draft)); setMsg('설정 저장 — 모든 채널이 새 설정으로 다시 만들어집니다'); refreshCfg(); refreshE(); refreshHist() } catch (x) { setMsg(x.message) } finally { setBusy(false) } }
  const activate = async (v) => { if (!window.confirm(`엔진 ${v.id || v.key} 을(를) 활성화할까요?\n모든 채널이 새 엔진으로 옮겨 가며 박동 템플릿 등 상태가 초기화됩니다.`)) return; setBusy(true); setMsg(''); try { await api.ecg.activate(v.key); setMsg('활성화됨'); refreshE(); refreshVer(); refreshHist() } catch (x) { setMsg(x.message) } finally { setBusy(false) } }
  const remove = async (v) => { if (!window.confirm(`보관함에서 ${v.key} 를 지울까요?`)) return; setBusy(true); try { await api.ecg.removeVersion(v.key); refreshVer() } catch (x) { setMsg(x.message) } finally { setBusy(false) } }
  const openDoc = async (v, name) => { try { const r = await fetch(api.ecg.docUrl(v.key, name), { credentials: 'same-origin' }); setDoc({ key: v.key, name, text: r.ok ? await r.text() : '(없음)' }) } catch (x) { setMsg(x.message) } }
  const busyPct = e?.busy_ms && e?.loaded_ms ? Math.min(100, (e.busy_ms / Math.max(1, Date.now() - e.loaded_ms)) * 100) : 0
  const rhythms = Object.entries(sum?.rhythm || {}).sort((a, b) => b[1] - a[1])
  const versions = ver?.versions || []
  const activeV = versions.find((v) => v.active)

  return (
    <div className="page ecg-page">
      <div className="ecg-head"><h2 className="h">ECG 실시간 분석 엔진</h2><span className={'tag ' + (e?.enabled ? 'ok' : 'warn')}>{e?.enabled ? '가동 중' : '엔진 없음'}</span>{msg && <span className="muted small">{msg}</span>}</div>

      {/* 현재 엔진 */}
      <section className="ecg-card">
        <h3>현재 엔진</h3>
        <div className="ecg-grid">
          <div><small>엔진</small><b className="mono">{e?.engine || '—'}</b><span className="muted">ABI {e?.abi || '—'} · 세대 {e?.gen ?? 0}</span></div>
          <div><small>파일</small><b className="mono" title={e?.path}>{e?.path?.split('/').slice(-2).join('/')}</b><span className="muted">{fmtDT(e?.file_mtime_ms)}{e?.file_size ? ` · ${(e.file_size / 1048576).toFixed(1)} MB` : ''}</span></div>
          <div><small>읽은 시각</small><b>{fmtDT(e?.loaded_ms)}</b><span className="muted">감시: 파일이 바뀌면 10초 안에 자동 교체</span></div>
          <div><small>채널 · 스레드</small><b>{(e?.channels ?? 0).toLocaleString()} · {e?.threads ?? '—'}</b><span className="muted">요약 행 {(e?.rows ?? 0).toLocaleString()}</span></div>
          <div><small>처리</small><b>{(e?.packets || 0).toLocaleString()} 패킷</b><span className="muted">박동 {(e?.beats || 0).toLocaleString()} · 이벤트 {(e?.events || 0).toLocaleString()}</span></div>
          <div><small>드롭 · 늦은 패킷 · 유실 선언</small><b className={e?.dropped ? 'warnv' : ''}>{e?.dropped || 0} · {e?.stale || 0} · {e?.gaps || 0}</b><span className="muted">드롭 = 분석 큐 포화 (샤드 스레드 늘리기)</span></div>
          <div><small>분석 부하</small><b>{busyPct.toFixed(1)}% <span className="muted">of 1코어</span></b><span className="muted">가동 후 평균 · 스레드 {e?.threads}개에 분산</span></div>
          {e?.last_error && <div className="ecg-err"><small>오류</small><b>{e.last_error}</b></div>}
        </div>
        <p className="muted small">엔진을 다시 읽거나 재시작하는 버튼은 <a href="#/admin/control">서비스 제어</a>에 있습니다. 새 엔진 설치: 라우터 PC 에서 <code>scripts/update-ecg-engine.sh</code> (레포 pull → 빌드 → 적합성 검사 → 보관함 등록 → 활성화).</p>
      </section>

      {/* 실행 설정 */}
      <ReadOnly edit={edit}>
        <section className="ecg-card">
          <h3>선택 동작 <small className="muted">프리셋과 단계 구현 — 저장하면 모든 채널이 새 설정으로 다시 만들어집니다</small></h3>
          {draft && (
            <div className="ecg-cfg">
              <label>프리셋</label>
              <span className="seg"><button className={draft.preset === 'patch' ? 'active' : ''} onClick={() => setDraft({ ...draft, preset: 'patch' })} title="며칠씩 착용하는 단일 유도 패치: 패치 코퍼스로 고른 심실 판별기 + 리듬 단위 상심실 런">patch</button><button className={draft.preset === 'clinical' ? 'active' : ''} onClick={() => setDraft({ ...draft, preset: 'clinical' })} title="임상 전극 기본값 (공개 코퍼스 성능)">clinical</button></span>
              {Object.entries(KIND_LABEL).map(([kind, label]) => (
                <React.Fragment key={kind}>
                  <label>{label} <small className="mono muted">{kind}</small></label>
                  <select value={draft.stages[kind] || ''} onChange={(ev) => setDraft({ ...draft, stages: { ...draft.stages, [kind]: ev.target.value } })}>
                    <option value="">프리셋 기본</option>
                    {(stagesByKind[kind] || []).map((s) => <option key={s.name} value={s.name}>{s.name} — {s.desc}</option>)}
                  </select>
                </React.Fragment>
              ))}
              <span />
              <div className="toolbar"><button className="primary" onClick={saveCfg} disabled={!dirty || busy}>설정 저장</button>{dirty && <button onClick={() => setDraft(null)}>되돌리기</button>}<span className="muted small">현재: {cfg?.preset} · {cfg?.stages || '프리셋 기본'}</span></div>
            </div>
          )}
          <p className="muted small">이름은 <span className="mono">kind.variant@version</span> 이며 판정이 달라질 때만 version 이 오릅니다. 새 단계는 옛 단계와 나란히 비교한 뒤 채택하거나 되돌릴 수 있습니다.</p>
        </section>

        {/* 버전 보관함 */}
        <section className="ecg-card">
          <h3>엔진 보관함 <small className="muted">{versions.length}개 · {e?.versions_dir}</small></h3>
          <div className="tbl-wrap"><table className="tbl ecg-ver"><thead><tr><th>상태</th><th>엔진</th><th>버전 키</th><th>빌드</th><th>크기</th><th>소스</th><th>단계</th><th>문서</th><th></th></tr></thead>
            <tbody>{versions.map((v) => (
              <tr key={v.key} className={v.active ? 'active' : ''}>
                <td>{v.active ? <span className="tag ok">활성</span> : <span className="muted">보관</span>}</td>
                <td className="mono">{v.id || '—'}</td><td className="mono small">{v.key}</td>
                <td>{fmtDT(v.built_ms || v.file_ms)}</td><td className="num">{v.size ? `${(v.size / 1048576).toFixed(1)} MB` : '—'}</td>
                <td className="small">{v.source || '—'}{v.commit ? ` · ${String(v.commit).slice(0, 8)}` : ''}{v.conformance != null ? (v.conformance ? ' · 적합성 통과' : ' · 적합성 실패') : ''}</td>
                <td className="small muted">{Array.isArray(v.stages) ? v.stages.length + '개' : '—'}</td>
                <td>{v.has_perf && <button className="ghost" onClick={() => openDoc(v, 'perf.md')}>성능</button>}{v.has_notes && <button className="ghost" onClick={() => openDoc(v, 'notes.md')}>노트</button>}<button className="ghost" onClick={() => openDoc(v, 'meta.json')}>메타</button></td>
                <td className="actions">{!v.active && <button onClick={() => activate(v)} disabled={busy}>활성화</button>}{!v.active && <button className="ghost danger" onClick={() => remove(v)} disabled={busy}>삭제</button>}</td>
              </tr>))}
              {!versions.length && <tr><td colSpan="9" className="muted">보관함이 비어 있습니다. 갱신 스크립트가 빌드한 엔진은 자동으로 등록됩니다.</td></tr>}
            </tbody></table></div>
          {doc && <div className="ecg-doc"><div className="ecg-doc-h"><b>{doc.key} · {doc.name}</b><span className="spacer" /><button className="icon" onClick={() => setDoc(null)}>✕</button></div>{doc.name.endsWith('.md') ? <MdTable text={doc.text} /> : <pre>{doc.text}</pre>}</div>}
        </section>
      </ReadOnly>

      {/* 이력 */}
      <section className="ecg-card">
        <h3>엔진 이력 <small className="muted">읽기 · 활성화 · 설정 변경</small></h3>
        <div className="tbl-wrap"><table className="tbl"><thead><tr><th>시각</th><th>동작</th><th>엔진</th><th>내용</th></tr></thead>
          <tbody>{[...(hist || [])].reverse().slice(0, 50).map((h, i) => <tr key={i}><td>{fmtDT(h.ms)}</td><td>{{ load: '읽음', activate: '활성화', config: '설정' }[h.action] || h.action}</td><td className="mono small">{h.engine}</td><td className="small">{h.detail}</td></tr>)}
            {!(hist || []).length && <tr><td colSpan="4" className="muted">이력 없음</td></tr>}</tbody></table></div>
      </section>

      {/* 지금 판정 분포 */}
      <section className="ecg-card">
        <h3>지금 판정 분포 <small className="muted">10초 안에 갱신된 채널 {sum?.channels?.toLocaleString() ?? '—'}개</small></h3>
        <div className="ecg-dist">
          {rhythms.map(([k, n]) => <div key={k} className="ecg-dist-i"><b>{n.toLocaleString()}</b><small>{RHYTHM_LABEL[k] || k}</small></div>)}
          {!rhythms.length && <span className="muted">분석 결과 없음</span>}
        </div>
        <h5 className="muted" style={{ margin: '10px 0 4px' }}>오늘 ECG 분석 알람 <small>(이력 최근 500건 기준)</small></h5>
        <div className="ecg-dist">{ecgAlarms.map(([k, n]) => <div key={k} className="ecg-dist-i"><b>{n}</b><small>{ALARM_KIND[k] || k}</small></div>)}{!ecgAlarms.length && <span className="muted small">오늘 발생한 ECG 분석 알람 없음</span>}</div>
        <p className="muted small">품질: 양호 {sum?.quality?.good ?? 0} · 리듬만 신뢰 {sum?.quality?.acceptable ?? 0} · 사용 불가 {sum?.quality?.unusable ?? 0} · 미정 {sum?.quality?.unknown ?? 0} · 평균 분석 HR {sum?.hr_mean ? Math.round(sum.hr_mean) : '—'} · PVC 합계 {sum?.pvc_min_total ?? 0}/분</p>
      </section>

      {/* 알고리즘 검증 */}
      <section className="ecg-card">
        <h3>알고리즘 검증 <small className="muted">에뮬레이터 정답지(리듬 에피소드·전극 탈락) 대비 — 엔진 판정 흔적과 대조</small></h3>
        <div className="ecg-bench-h">
          <span className="seg">{[0.5, 1, 3, 6].map((h) => <button key={h} className={evalHours === h ? 'active' : ''} onClick={() => setEvalHours(h)}>{h < 1 ? '30분' : `${h}시간`}</button>)}</span>
          <button className="primary" onClick={runEval} disabled={!edit || evalBusy || !e?.enabled}>{evalBusy ? '검증 중…' : '지금 검증'}</button>
          {ev && <span className="muted small">마지막 검증 {fmtDT(ev.ms)} · 정답 {ev.labels?.toLocaleString()}개 · 채널 {ev.channels?.toLocaleString()}개</span>}
        </div>
        {ev ? (
          <>
            <div className="ecg-grid" style={{ margin: '8px 0' }}>
              <div><small>지원 클래스 합계 · 민감도</small><b>{pct(ev.overall?.sensitivity)}</b><span className="muted">검출 {ev.overall?.tp} · 놓침 {ev.overall?.fn}</span></div>
              <div><small>지원 클래스 합계 · 정밀도</small><b>{pct(ev.overall?.precision)}</b><span className="muted">오검출 {ev.overall?.fp}</span></div>
              <div><small>박동 단위 (R파 · N/S/V)</small><b>—</b><span className="muted">에뮬레이터 박동 정답 대기</span></div>
              <div><small>구간</small><b>{fmtDT(ev.from_ms)} ~</b><span className="muted">{fmtDT(ev.to_ms)}</span></div>
            </div>
            <div className="tbl-wrap"><table className="tbl ecg-eval"><thead><tr><th>정답 클래스</th><th>엔진 라벨</th><th className="num">정답</th><th className="num">검출</th><th className="num">놓침</th><th className="num">오검출</th><th className="num">민감도</th><th className="num">정밀도</th><th className="num">지연 중앙값</th><th className="num">p90</th></tr></thead>
              <tbody>{(ev.classes || []).map((c) => (
                <tr key={c.name + c.engine.join()} className={c.unsupported ? 'muted' : ''}>
                  <td>{c.name}</td><td className="mono small">{c.unsupported ? '미지원' : c.engine.join(' · ')}</td>
                  <td className="num">{c.labels}</td><td className="num">{c.unsupported ? '—' : c.tp}</td><td className="num">{c.unsupported ? '—' : c.fn_}</td><td className="num">{c.unsupported ? '—' : c.fp}</td>
                  <td className="num"><b className={c.sensitivity != null && c.sensitivity < 0.7 ? 'warnv' : ''}>{c.unsupported ? '—' : pct(c.sensitivity)}</b></td><td className="num">{c.unsupported ? '—' : pct(c.precision)}</td>
                  <td className="num">{c.latency_median_ms != null ? `${(c.latency_median_ms / 1000).toFixed(1)} s` : '—'}</td><td className="num">{c.latency_p90_ms != null ? `${(c.latency_p90_ms / 1000).toFixed(1)} s` : '—'}</td>
                </tr>))}</tbody></table></div>
            <p className="muted small">{ev.note}</p>
            {(evalR?.history || []).length > 1 && <p className="muted small">검증 이력 {(evalR.history || []).length}회 — 민감도 추이: {(evalR.history || []).slice(-8).map((h) => h.overall?.sensitivity != null ? (h.overall.sensitivity * 100).toFixed(0) + '%' : '—').join(' → ')}</p>}
          </>
        ) : <p className="muted small">아직 검증하지 않았습니다. 최근 구간을 고르고 "지금 검증"을 누르면 에뮬레이터에서 정답을 받아 엔진의 판정 흔적(라벨 전환·V/S 박동 시각)과 대조합니다. 흔적은 채널당 최근 160회 전환·300박동까지 남으므로 긴 구간은 오래된 부분이 빠질 수 있습니다.</p>}
      </section>

      {/* 성능 */}
      <section className="ecg-card">
        <h3>엔진 성능 <small className="muted">live_ecg 보고서(README · reports/PERFORMANCE.md) — 학습·조정에 쓰지 않은 봉인(TEST) 구역 수치</small></h3>
        <div className="ecg-bench">
          <div className="ecg-bench-h"><b>이 기기 시뮬레이션 성능</b><span className="muted small">합성 ECG(60 bpm)를 64채널 × 120초 분량 처리해 시간을 잽니다 — 운영과 별도 스레드, 1~2초</span><span className="spacer" /><button onClick={runBench} disabled={!edit || benchBusy || !e?.enabled}>{benchBusy ? '측정 중…' : '측정 실행'}</button></div>
          {bench && bench.ns_per_sample != null && (
            <div className={'ecg-grid ecg-bench-r' + (benchFlash ? ' flash' : '')}>
              <div><small>샘플당 처리 시간</small><b>{bench.ns_per_sample} ns</b><span className="muted">보고서 기준 211 ns (M1 Ultra)</span></div>
              <div><small>코어당 처리 가능 채널 (@250 Hz)</small><b>{(bench.channels_per_core || 0).toLocaleString()} 채널</b><span className="muted">지금 운영 {(bench.channels_live || 0).toLocaleString()} 채널 · 스레드 {bench.threads_live}</span></div>
              <div><small>박동 검출</small><b>{(bench.beats || 0).toLocaleString()} / {(bench.beats_expected || 0).toLocaleString()}</b><span className="muted">합성 60 bpm 기준 (첫 몇 초는 학습)</span></div>
              <div><small>측정</small><b>{bench._fresh && Date.now() - bench._fresh < 60000 ? '방금 측정' : fmtDT(bench.ms)}</b><span className="muted">{bench.engine} · {bench.samples?.toLocaleString()} 샘플 / {bench.elapsed_ms} ms{bench._fresh ? '' : ' · 마지막 측정값'}</span></div>
            </div>
          )}
        </div>
        <h5 className="muted" style={{ margin: '10px 0 4px' }}>레포 보고서 수치</h5>
        <table className="tbl ecg-perf"><thead><tr><th>항목</th><th>수치</th><th>데이터 · 비고</th></tr></thead>
          <tbody>{PERF_SUMMARY.map(([a, b, c]) => <tr key={a}><td>{a}</td><td className="num"><b>{b}</b></td><td className="small muted">{c}</td></tr>)}</tbody></table>
        <p className="muted small">한계도 보고서에 그대로 있습니다: 상심실 박동은 단일 유도의 P파 한계로 낮고(패치 설정은 런 단위로 찾음), 심실빈맥 경보 정밀도는 22.9 %(변행전도 구분 문제). 수치는 Apple M1 Ultra 에서 측정된 것이라 이 기기의 처리량은 위 "분석 부하"로 확인하세요.{activeV?.has_perf ? ' 활성 엔진의 보고서 전문은 보관함의 "성능" 버튼에서.' : ''}</p>
      </section>
    </div>
  )
}
