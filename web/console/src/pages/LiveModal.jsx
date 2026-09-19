import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime, fmtBytes } from '../api.js'
import { claimLive, releaseLive, latest } from '../ws.js'
import { WaveCard, WaveCanvas } from '../WaveCard.jsx'
import { alarmIndex, flagNames, SEV_LABEL } from '../model.js'
import HistoryPanel from '../viewer/History.jsx'
import '../viewer/ds.css'

/** One patient in detail: all waveforms, vitals, EMR profile (via the router's EMR proxy), storage index, alarms. */
export function LiveModal({ channelId, alarms, onClose }) {
  const [rows] = usePoll(api.channels, 5000)
  const row = useMemo(() => (rows || []).find((r) => r.channel_id === channelId), [rows, channelId])
  const [idx] = usePoll(() => api.patch(channelId), 10000, [channelId])
  const [emr, setEmr] = useState(null)
  const [history, setHistory] = useState(false)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const mine = (alarms?.alarms || []).filter((a) => a.channel_id === channelId)
  useEffect(() => { claimLive('modal', [channelId]); return () => releaseLive('modal') }, [channelId])
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t) }, [])
  useEffect(() => {
    const f = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', f)
    return () => window.removeEventListener('keydown', f)
  }, [onClose])
  const pid = row?.profile_id || row?.patient?.profile_no
  useEffect(() => { if (pid) api.emu.patient(pid).then(setEmr).catch(() => setEmr(null)) }, [pid])
  const live = latest.get(channelId)
  const waves = row?.channels || []
  const p = row?.patient || {}
  if (!row) return <div className="modal-bg" onClick={onClose}><div className="modal"><p>패치 {channelId} 정보를 불러오는 중…</p></div></div>
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{p.name || row.mrn} <small className="mono">패치 {channelId} · 환자번호 {row.patient_id} · {row.mrn}</small></h2>
          <span className="spacer" />
          <button className={history ? 'primary' : ''} onClick={() => setHistory(!history)} title="저장된 파형 이력">이력</button>
          <button className="icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-cols">
          <div className="modal-main">
            {history ? <div className="ds hx-host"><HistoryPanel id={channelId} compact onClose={() => setHistory(false)} /></div> : <WaveCard row={row} density="normal" alarm={aidx.get(channelId)} waves={waves} />}
            {waves.includes('accel') && (
              <div className="accel">
                <small>가속도 X/Y/Z (g)</small>
                <WaveCanvas id={channelId} wave="accel0" density="dense" color="#ff6b6b" height={40} />
                <WaveCanvas id={channelId} wave="accel1" density="dense" color="#6bff95" height={40} />
                <WaveCanvas id={channelId} wave="accel2" density="dense" color="#6bb5ff" height={40} />
              </div>
            )}
            <div className="kv">
              <div><small>채널</small>{waves.join(', ') || '—'}</div>
              <div><small>게이트웨이</small>{row.gateway_id} ({p.zone})</div>
              <div><small>위치</small>{[p.building, p.floor && `${p.floor}F`, p.ward, p.room || row.space].filter(Boolean).join(' · ')}</div>
              <div><small>의료진</small>{[p.doctor, p.nurse, p.department].filter(Boolean).join(' · ') || '—'}</div>
              <div><small>플래그</small>{flagNames(live?.flags ?? row.flags).join(', ') || '없음'}</div>
              <div><small>seq / 마지막 수신</small>{live?.seq ?? row.last_seq} · {fmtTime(live?.ts_ms ?? row.last_ts_ms)}</div>
              <div><small>ECG fs</small>{row.sample_rate} Hz</div>
              <div><small>페이스마크</small>{live?.pace?.length ? `${live.pace.length}개 (이번 번들)` : '—'}</div>
            </div>
          </div>
          <div className="modal-side">
            <h4>알람</h4>
            {mine.length ? mine.map((a) => <div key={a.id} className={`alarm-row sev-${a.severity}`}><span className={`tag sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span> {a.message} <small>{fmtTime(a.since_ms)}</small></div>) : <p className="muted">활성 알람 없음</p>}
            <h4>EMR</h4>
            {emr ? (
              <div className="kv one">
                <img className="avatar" src={`/api/emr/patients/${pid}/avatar.svg`} alt="" />
                <div><small>성별/나이</small>{emr.sex} / {emr.age}세 · {emr.blood_type}</div>
                <div><small>진단</small>{emr.disease} <small className="mono muted">{emr.icd10}</small></div>
                <div><small>리듬 / 페이스메이커</small>{emr.rhythm} / {emr.pacemaker ? '있음' : '없음'}</div>
                <div><small>진료과</small>{emr.ward_specialty}</div>
                <div><small>신체</small>{emr.height_cm} cm · {emr.weight_kg} kg · BMI {emr.bmi}</div>
                {emr.comorbidities?.length > 0 && <div><small>기저질환</small>{emr.comorbidities.join(', ')}</div>}
                {emr.devices?.length > 0 && <div><small>기기</small>{emr.devices.map((d) => d.label || d.key || d).join(', ')}</div>}
                {emr.allergies && <div><small>알레르기</small>{emr.allergies}</div>}
              </div>
            ) : <p className="muted">EMR 정보 없음</p>}
            <h4>저장</h4>
            {idx?.index ? (
              <div className="kv one">
                <div><small>레코드</small>{(idx.index.records ?? 0).toLocaleString()} · 유실 {idx.index.lost ?? 0}</div>
                <div><small>용량</small>{fmtBytes(idx.index.bytes)} · 파일 {(idx.files || []).length}개</div>
                <div><small>기간</small>{fmtTime(idx.index.first_ts_ms)} ~ {fmtTime(idx.index.last_ts_ms)}</div>
              </div>
            ) : <p className="muted">저장 인덱스 없음</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
