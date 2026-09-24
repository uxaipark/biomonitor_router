import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime, fmtBytes } from '../api.js'
import { claimLive, releaseLive, latest } from '../ws.js'
import { WaveCanvas } from '../WaveCard.jsx'
import { AccelPlot, accelNow, ACCEL_COLORS } from '../AccelPlot.jsx'
import { alarmIndex, flagNames, SEV_LABEL, FLAG_LABEL, FLAG_WARN, patchLife, fmtDays, PATCH_WEAR_DAYS, PATCH_BATTERY_DAYS } from '../model.js'
import HistoryPanel from '../viewer/History.jsx'
import '../viewer/ds.css'
import { useMe, canBio, canPhi } from '../auth.js'

/** 리듬 코드 → 이름 (에뮬레이터 rhythm_label 과 같게) */
const RHYTHM = {
  nsr: '정상 동율동 (NSR)', sinus: '정상 동리듬', sinus_tachy: '동빈맥 (Sinus Tachycardia)', sinus_brady: '동서맥 (Sinus Bradycardia)',
  sinus_pause: '동정지 / 동휴지 (Sinus Pause)', brady: '서맥', afib: '심방세동 (AFib)', afib_rvr: '심방세동 빠른 심실반응 (AFib RVR)',
  aflutter: '심방조동 (Atrial Flutter)', pac: '심방조기수축 (PAC)', pvc: '심실조기수축 (PVC)', pvc_bigeminy: '심실 이단맥 (Bigeminy)',
  svt: '상심실성 빈맥 (SVT episodes)', nsvt: '비지속성 심실빈맥 (NSVT)', vt: '심실빈맥 (VT)', vfib: '심실세동 (VFib)', asystole: '무수축',
  avb1: '1도 방실차단', avb2_m1: '2도 방실차단 Mobitz I (Wenckebach)', avb2_m2: '2도 방실차단 Mobitz II', avb3: '3도 (완전) 방실차단', block: '방실차단',
  lbbb: '좌각차단 (LBBB)', rbbb: '우각차단 (RBBB)', stemi: 'ST 상승 (STEMI)', ischemia: '허혈 (Ischemia)',
  paced: '페이스 리듬', paced_aai: '단일심방 페이싱 (AAI/AAIR)', paced_vvi: '단일심실 페이싱 (VVI/VVIR)', paced_ddd: '이중방 페이싱 (DDD/DDDR)',
  paced_crt: '양심실 페이싱 (CRT)', paced_malfunction: '페이스메이커 오작동 (캡처실패/언더센싱/오버센싱)',
}
const SEX = { M: '남', F: '여' }
const MOBILITY = { ambulatory: '보행 가능', limited: '보행 제한', bedridden: '와상' }

/** "210A01" + bed "210A01-A" + floor → "10A병동 · 1001호 · A침대" (other spaces as given). */
function placeText(p, space) {
  const room = p.room || space
  const m = /^\d(\d\d)([A-Z])(\d\d)$/.exec(room || '')
  const bed = /-([A-Z0-9]+)$/.exec(p.bed || '')
  const parts = [p.building, p.floor && `${p.floor}층`]
  if (m) { const fl = parseInt(m[1], 10); parts.push(`${fl}${m[2]}병동`, `${fl}${m[3]}호`) } else parts.push(p.ward, room)
  if (bed) parts.push(`${bed[1]}침대`)
  return parts.filter(Boolean).join(' · ')
}

const Vital = ({ label, value, unit, cls, sub }) => (
  <div className={'lm-vital ' + (cls || '')}>
    <span className="lm-vl">{label}</span>
    <span className="lm-vv">{value ?? '—'}<small>{unit}</small></span>
    {sub && <span className="lm-vs">{sub}</span>}
  </div>
)

const Row = ({ k, children }) => <><dt>{k}</dt><dd>{children}</dd></>

const dt16 = (t) => (t ? String(t).replace('T', ' ').slice(0, 16) : '')
const md16 = (t) => (t ? String(t).replace('T', ' ').slice(5, 16) : '')
const NEWS_CLS = { 낮음: 'ok', 중간: 'warn', 높음: 'err' }
const ACTIVITY = { still: '안정', walking: '보행', moving: '움직임', sleeping: '수면' }
const POSTURE = { supine: '앙와위', prone: '복와위', left: '좌측와위', right: '우측와위', sitting: '좌위', standing: '입위' }

/**
 * 에뮬레이터 환자 상세(`/api/emr/patients/{profile}`, 라우터 EMR 프록시) — 에뮬레이터 '환자 정보' 패널과 같은 항목, 기기 세트는 뺌.
 * 순서는 보는 사람에 따라: 병원 계정(의료진·IT) = 입원 기록 → 임상 → 기기·전송(맨 아래),
 * 플랫폼 계정(수퍼 어드민·시스템 관리자·리셀러·영업) = 패치 사양·센서 → 임상 → 입원 기록.
 */
function EmrPanel({ emr, p, row, platform }) {
  const rt = emr.runtime || {}
  const adm = emr.admission || {}
  const mon = adm.monitoring || {}
  const link = emr.emr_link
  const news = emr.news2
  const staff = (x) => (x && typeof x === 'object' ? `${x.name}${x.title ? ` ${x.title}` : ''}` : x)
  const bed = /-([A-Z0-9]+)$/.exec(adm.bed || '')?.[1]
  const record = (
    <section key="record">
      <h5 className="lm-sub">입원 기록</h5>
      <div className="lm-dx">
        <b>{emr.disease}</b>
        <span className="mono">{emr.icd10}</span>
      </div>
      <dl className="lm-dl">
        <Row k="주진단">{[emr.disease && `${emr.disease} (${emr.icd10})`, emr.ward_specialty].filter(Boolean).join(' · ')}</Row>
        <Row k="상태">{emr.status}{adm.mode ? ` · ${adm.mode === 'inpatient' ? '입원' : adm.mode}` : ''}</Row>
        {adm.time && <Row k="입원">{dt16(adm.time)} · {adm.ward_name || adm.ward} {adm.bed}</Row>}
        <Row k="입원 병실">{[rt.home_where, adm.ward_name, adm.room && `병실 ${adm.room}`, bed && `침상 ${adm.bed}`].filter(Boolean).join(' · ') || placeText(p, row.space)}</Row>
        {rt.location && <Row k="현재 위치">{[rt.location_where, rt.location !== rt.home_room ? rt.location_name || rt.location : `입원 병실 내 ${rt.location}`].filter(Boolean).join(' ')}{rt.trip_active && <span className="lm-warn"> · 이동 중</span>}</Row>}
        {(rt.doctor || rt.nurse) && <Row k="담당">{[staff(rt.doctor), staff(rt.nurse)].filter(Boolean).join(' / ')}</Row>}
        <Row k="번호"><span className="mono">#{adm.patient_no || rt.patient_no || '—'} · {emr.mrn}</span></Row>
        <Row k="환자">{[emr.nationality_label, emr.height_cm && `${emr.height_cm} cm`, emr.weight_kg && `${emr.weight_kg} kg`, emr.bmi && `BMI ${emr.bmi}`].filter(Boolean).join(' · ')}</Row>
        {emr.address?.label && <Row k="거주지">{emr.address.label}</Row>}
        {adm.exams?.length > 0 && <Row k="검사 일정">{adm.exams.map((x, i) => <div key={i}>{md16(x.time)} {x.type}{x.room ? ` (${x.room}, ${x.duration_min}분)` : ''}{x.done ? ' · 완료' : ''}</div>)}</Row>}
        {link && (
          <Row k="연동 EMR">
            <b>{link.name}</b> <span className="mono">{link.site}</span>
            <div className="mono muted">mrn {link.identifiers?.mrn}{link.identifiers?.rrn ? ` · rrn ${link.identifiers.rrn}` : ''} · 내원 {link.visit} · FHIR Patient/{link.fhir_patient_id}</div>
            <div className="muted">{link.location?.ward_name} {link.location?.room}{link.location?.bed ? `-${link.location.bed}` : ''} · EMR 수신 {link.received?.count ?? 0}건</div>
          </Row>
        )}
      </dl>
    </section>
  )
  const clinical = (
    <section key="clinical">
      <h5 className="lm-sub">임상</h5>
      <dl className="lm-dl">
        {rt.rhythm_now && <Row k="현재 리듬"><b className={rt.episode ? 'lm-warn' : ''}>{rt.rhythm_now}</b></Row>}
        {mon.tier_ko && (
          <Row k="모니터링 처방">
            <b>{mon.tier_ko} {mon.days}일</b>{rt.rx_day != null && ` · D+${rt.rx_day}`}{rt.rx_left_h != null && ` · 남은 ${(rt.rx_left_h / 24).toFixed(1)}일`}{mon.acuity != null && ` · 위중도 ${mon.acuity}`}
            <div className="muted">{md16(mon.start)} ~ {md16(mon.end)}</div>
            {mon.reason && <div className="muted">{mon.reason}</div>}
          </Row>
        )}
        <Row k="기저 리듬">{RHYTHM[emr.rhythm] || emr.rhythm || '—'}</Row>
        {news && (
          <Row k="NEWS2">
            <span className={`tag small ${NEWS_CLS[news.risk] || ''}`}>{news.score}</span> {news.risk}
            {Object.entries(news.parts || {}).filter(([, v]) => v > 0).map(([k, v]) => ` ${k} ${v}`).join(' ·')}
          </Row>
        )}
        <Row k="페이스메이커">{emr.pacemaker ? (emr.pacemaker_info?.mode || emr.pacemaker_info?.type || '있음') : '없음'}</Row>
        {emr.comorbidities?.length > 0 && <Row k="기저질환">{emr.comorbidities.join(', ')}</Row>}
        <Row k="알레르기"><span className={emr.allergies && emr.allergies !== '없음' ? 'lm-warn' : ''}>{emr.allergies || '없음'}</span></Row>
        {emr.mobility && <Row k="거동">{MOBILITY[emr.mobility] || emr.mobility}</Row>}
        {(rt.activity || rt.posture) && <Row k="활동/자세">{[ACTIVITY[rt.activity] || rt.activity, POSTURE[rt.posture] || rt.posture].filter(Boolean).join(' / ')}</Row>}
        <Row k="체온/혈당/호흡">{[emr.temp_profile, emr.glucose_profile, emr.resp_kind].filter(Boolean).join(' / ')}</Row>
      </dl>
    </section>
  )
  const device = (
    <section key="device">
      <h5 className="lm-sub">패치 · 센서 · 전송</h5>
      <dl className="lm-dl">
        {rt.patch && <Row k="패치"><span className="mono">{rt.patch} (id {rt.patch_id})</span> · <b className={rt.battery <= 15 ? 'lm-warn' : ''}>{Math.round(rt.battery)}%</b>{rt.lead_off && <span className="lm-warn"> · 전극 탈락</span>}{rt.spo2_off && <span className="lm-warn"> · SpO₂ 센서 이탈</span>}</Row>}
        {rt.patch_wear_days != null && <Row k="착용">{rt.patch_wear_days}일 / 최대 14일 · 배터리 약 15.5일</Row>}
        {rt.channels?.length > 0 && <Row k="전송 채널"><span className="mono">{rt.channels.join(', ')}</span></Row>}
        {row.sample_rate > 0 && <Row k="ECG">{row.sample_rate} Hz</Row>}
        {rt.gateway && <Row k="게이트웨이"><span className="mono">{rt.gateway}</span> · RSSI {rt.rssi} dBm</Row>}
      </dl>
    </section>
  )
  return <>{platform ? [device, clinical, record] : [record, clinical, device]}</>
}

/** One patient in detail: header (who / where / status), live vitals and waves (or the stored history), and
 *  side cards with alarms, the EMR profile (via the router's EMR proxy) and the storage index. */
export function LiveModal({ channelId, alarms, onClose }) {
  // only this patch's row (the full list is ~1.7 MB for 2,100 patches)
  const [rows] = usePoll(() => api.channelsScoped(`ids=${encodeURIComponent(channelId)}`), 3000, [channelId])
  const row = useMemo(() => (rows || []).find((r) => r.channel_id === channelId), [rows, channelId])
  const me = useMe()
  const bio = canBio(me), phi = canPhi(me)
  const [idx] = usePoll(() => (bio ? api.patch(channelId) : Promise.resolve(null)), 10000, [channelId, bio])
  const [emr, setEmr] = useState(null)
  const [history, setHistory] = useState(false)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const mine = (alarms?.alarms || []).filter((a) => a.channel_id === channelId)
  useEffect(() => { if (!bio || !phi) return; claimLive('modal', [channelId]); return () => releaseLive('modal') }, [channelId, bio, phi])
  // live numbers re-read from the WS map twice a second — not in history mode (the history list would re-render)
  useEffect(() => { if (history) return; const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t) }, [history])
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [onClose])
  const pid = row?.profile_id || row?.patient?.profile_no
  useEffect(() => {
    let alive = true
    setEmr(null)
    // 현재 리듬·위치·배터리·NEWS2 같은 실시간 항목이 있어 10초마다 다시 읽는다
    const load = () => { if (pid) api.emu.patient(pid).then((d) => { if (alive) setEmr(d) }).catch(() => {}) }
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [pid])
  if (!row) return <div className="modal-bg" onClick={onClose}><div className="modal lm"><p className="muted">패치 {channelId} 정보를 불러오는 중…</p></div></div>

  const live = latest.get(channelId)
  const waves = row.channels || []
  const p = row.patient || {}
  const v = live?.vitals || row.vitals || {}
  const flags = flagNames(live?.flags ?? row.flags)
  const stale = live ? Date.now() - live.rx > 5000 : row.stale
  const alarm = aidx.get(channelId)
  const bat = live?.battery ?? row.battery
  const life = patchLife(row, bat)
  const rssi = live?.rssi ?? row.rssi
  const acc = accelNow(channelId)
  const ix = idx?.index
  // highlight the vital tile the alarm is about (alarm kinds: hr_*, spo2_*, resp_*, temp_*)
  const sevOf = (prefix) => (alarm?.kind?.startsWith(prefix) ? `sev-${alarm.severity}` : '')

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className={'modal lm' + (alarm ? ` lm-sev-${alarm.severity}` : '')} onClick={(e) => e.stopPropagation()}>
        <header className="lm-head">
          {pid && phi ? <img className="lm-avatar" src={`/api/emr/patients/${pid}/avatar.svg`} alt="" /> : <div className="lm-avatar" />}
          <div className="lm-who">
            <div className="lm-name">
              <h2>{p.name || row.mrn}</h2>
              {emr && <span className="lm-demo">{SEX[emr.sex] || emr.sex} · {emr.age}세 · {emr.blood_type}</span>}
              {alarm && <span className={`tag sev-${alarm.severity}`}>{SEV_LABEL[alarm.severity]} · {alarm.message}</span>}
              {flags.map((n) => <span key={n} className={'tag ' + (FLAG_WARN.has(n) ? 'warn' : '')}>{FLAG_LABEL[n] || n}</span>)}
              {stale ? <span className="tag err">수신 없음</span> : <span className="tag ok">수신 중</span>}
            </div>
            <div className="lm-place">{placeText(p, row.space)}</div>
            <div className="lm-ids">
              <span><small>패치</small>{channelId}</span>
              <span><small>환자번호</small>{row.patient_id}</span>
              <span><small>MRN</small>{row.mrn}</span>
              <span><small>게이트웨이</small>{row.gateway_id}</span>
              {(p.doctor || p.nurse) && <span><small>담당</small>{[p.doctor, p.nurse].filter(Boolean).join(' / ')}</span>}
            </div>
          </div>
          <div className="lm-actions">
            <div className="seg">
              <button className={!history ? 'active' : ''} onClick={() => setHistory(false)}>실시간</button>
              {bio && <button className={history ? 'active' : ''} onClick={() => setHistory(true)} title="저장된 파형 이력">이력</button>}
            </div>
            <button className="icon lm-close" onClick={onClose} title="닫기 (Esc)">✕</button>
          </div>
        </header>

        <div className="lm-body">
          <main className="lm-main">
            {!bio ? (
              <div className="panel no-access"><h3>생체신호 보기 권한 없음</h3><p>이 계정은 파형과 생체 수치를 볼 수 없습니다{!phi ? ' — 환자 개인정보도 가려서(마스킹) 보여 줍니다' : ''}. 필요하면 권한 설정에서 요청하세요.</p></div>
            ) : history ? (
              <div className="ds hx-host lm-hx"><HistoryPanel id={channelId} compact onClose={() => setHistory(false)} /></div>
            ) : (
              <>
                <div className="lm-vitals">
                  <Vital label="심박수 HR" value={v.hr} unit="bpm" cls={'hr ' + sevOf('hr_')} />
                  {waves.includes('spo2') && <Vital label="산소포화도 SpO₂" value={v.spo2} unit="%" cls={'spo2 ' + sevOf('spo2_')} />}
                  <Vital label="호흡수 RR" value={v.resp} unit="/min" cls={'rr ' + sevOf('resp_')} />
                  {waves.includes('temp') && <Vital label="체온" value={v.temp != null ? v.temp.toFixed(1) : null} unit="°C" cls={'temp ' + sevOf('temp_')} />}
                  {v.glucose != null && <Vital label="혈당" value={Math.round(v.glucose)} unit="mg/dL" cls="glu" />}
                </div>
                <section className="lm-panel">
                  <div className="lm-ph"><b>ECG</b><span className="muted">{row.sample_rate} Hz · 6초 스윕</span>{live?.pace?.length ? <span className="tag small">페이스 {live.pace.length}</span> : null}</div>
                  <WaveCanvas id={channelId} wave="ecg" width={920} height={190} />
                  {waves.includes('resp_wave') && <><div className="lm-ph sub"><b>호흡 파형</b></div><WaveCanvas id={channelId} wave="resp_wave" width={920} height={60} color="#7cc4ff" /></>}
                  {waves.includes('ppg') && <><div className="lm-ph sub"><b>Pleth</b></div><WaveCanvas id={channelId} wave="ppg" width={920} height={60} color="#ff9f6b" /></>}
                </section>
                {waves.includes('accel') && (
                  <section className="lm-panel">
                    <div className="lm-ph">
                      <b>가속도</b><span className="muted">g · 최근 6초</span>
                      <span className="spacer" />
                      {['X', 'Y', 'Z'].map((n, i) => (
                        <span key={n} className="lm-axis"><i style={{ background: ACCEL_COLORS[i] }} />{n}<b>{acc[i] != null ? acc[i].toFixed(2) : '—'}</b></span>
                      ))}
                      {row.moving && <span className="tag warn">움직임</span>}
                    </div>
                    <AccelPlot id={channelId} height={96} />
                  </section>
                )}
                <div className="lm-dev">
                  <span><small>배터리</small><b className={bat != null && bat <= 15 ? 'low' : ''}>{bat ?? '—'}%{life?.batLeft != null ? ` · 약 ${fmtDays(life.batLeft)}` : ''}</b></span>
                  {life && <span title={`착용 시작 ${new Date(row.wear_start_ms).toLocaleString('ko-KR', { hour12: false })}${life.estimated ? ' (첫 수신 기준 추정)' : ''} · 최대 ${PATCH_WEAR_DAYS}일, 배터리 약 ${PATCH_BATTERY_DAYS}일`}><small>패치 착용</small><b>{fmtDays(life.worn)}째{life.estimated ? '*' : ''}</b></span>}
                  {life && <span><small>교체 예정</small><b className={life.level === 'err' ? 'low' : ''}>{life.left <= 0 ? `지금 교체 (${life.reason})` : `${fmtDays(life.left)} 뒤 · ${life.reason}`}</b></span>}
                  <span><small>신호</small><b>{rssi ?? '—'} dBm</b></span>
                  <span><small>수신 품질</small><b>{row.quality || '—'}</b></span>
                  <span><small>마지막 수신</small><b>{fmtTime(live?.ts_ms ?? row.last_ts_ms)}</b></span>
                  <span><small>seq</small><b>{live?.seq ?? row.last_seq}</b></span>
                  <span><small>채널</small><b>{waves.filter((w) => w !== 'pace').join(' · ') || '—'}</b></span>
                </div>
              </>
            )}
          </main>

          <aside className="lm-side">
            <section className="lm-card">
              <h4>알람 <span className="lm-count">{mine.length}</span></h4>
              {mine.length ? mine.map((a) => (
                <div key={a.id} className={`lm-alarm sev-${a.severity}`}>
                  <span className={`tag sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span>
                  <span className="lm-am">{a.message}</span>
                  <small>{fmtTime(a.since_ms)}</small>
                </div>
              )) : <p className="muted">활성 알람이 없습니다.</p>}
            </section>
            <section className="lm-card">
              <h4>환자 정보</h4>
              {emr ? <EmrPanel emr={emr} p={p} row={row} platform={!me?.user?.tenant_id} /> : <p className="muted">EMR 정보를 불러오지 못했습니다.</p>}
            </section>
            <section className="lm-card">
              <h4>파형 저장</h4>
              {ix ? (
                <dl className="lm-dl">
                  <Row k="기간">{fmtTime(ix.first_ts_ms)} ~ {fmtTime(ix.last_ts_ms)}</Row>
                  <Row k="레코드">{(ix.records ?? 0).toLocaleString()}{ix.lost ? <span className="lm-warn"> · 유실 {ix.lost}</span> : ''}</Row>
                  <Row k="용량">{fmtBytes(ix.bytes)} · 파일 {(idx.files || []).length}개</Row>
                </dl>
              ) : <p className="muted">{bio ? '저장된 파형이 없습니다.' : '생체신호 권한이 없어 표시하지 않습니다.'}</p>}
              {bio && !history && ix && <button className="lm-hxbtn" onClick={() => setHistory(true)}>저장된 파형 보기 →</button>}
            </section>
          </aside>
        </div>
      </div>
    </div>
  )
}
