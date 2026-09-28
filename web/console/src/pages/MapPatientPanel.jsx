import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import { claimLive, releaseLive, latest } from '../ws.js'
import { WaveCanvas } from '../WaveCard.jsx'
import { alarmIndex, flagNames, SEV_LABEL, FLAG_LABEL, FLAG_WARN, patchLife, fmtDays, homePlace, nowPlace } from '../model.js'
import { EmrPanel } from './LiveModal.jsx'
import { useMe, canBio, canPhi } from '../auth.js'

/**
 * 병원 지도 오른쪽 패널(320px)용 환자 상세 — 모달을 욱여넣지 않고 좁은 폭에 맞춰 평평하게 새로 짠 화면.
 * 위에서부터: 이름·상태 → 수치 한 줄 → 파형(ECG · 호흡 · Pleth, 패널 폭 그대로) → 패치·신호 → 알람 → 환자 정보.
 * 카드 안 카드 없음: 구획은 얇은 선과 소제목으로만. '이력' 은 기존 실시간 창을 이력 탭으로 띄운다.
 */
const SEX = { M: '남', F: '여' }
const WAVE_W = 296

export default function MapPatientPanel({ channelId, alarms, onClose, onHistory, onBack, backLabel }) {
  const [rows] = usePoll(() => api.channelsScoped(`ids=${encodeURIComponent(channelId)}`), 3000, [channelId])
  const row = useMemo(() => (rows || []).find((r) => r.channel_id === channelId), [rows, channelId])
  const me = useMe()
  const bio = canBio(me), phi = canPhi(me)
  const [emr, setEmr] = useState(null)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const mine = (alarms?.alarms || []).filter((a) => a.channel_id === channelId)
  useEffect(() => { if (!bio || !phi) return; claimLive('map-patient', [channelId]); return () => releaseLive('map-patient') }, [channelId, bio, phi])
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 500); return () => clearInterval(t) }, [])
  const pid = row?.profile_id || row?.patient?.profile_no
  useEffect(() => {
    let alive = true
    setEmr(null)
    const load = () => { if (pid) api.emu.patient(pid).then((d) => { if (alive) setEmr(d) }).catch(() => {}) }
    load()
    const t = setInterval(load, 10000)
    return () => { alive = false; clearInterval(t) }
  }, [pid])
  if (!row) return <div className="mp"><div className="mp-top"><b>패치 {channelId}</b><span className="spacer" /><button className="icon" onClick={onClose} title="닫기">✕</button></div><p className="muted small">정보를 불러오는 중…</p></div>

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
  const sevOf = (prefix) => (alarm?.kind?.startsWith(prefix) ? ` sev-${alarm.severity}` : '')
  const place = homePlace(p, row.space), now = nowPlace(p, row.space)
  return (
    <div className={'mp' + (alarm ? ` mp-sev-${alarm.severity}` : '')}>
      <div className="mp-top">
        {onBack && <button className="ghost mp-back" onClick={onBack} title={backLabel}>←</button>}
        <b className="mp-name">{p.name || row.mrn || channelId}</b>
        {emr && <span className="muted small">{SEX[emr.sex] || emr.sex} · {emr.age}세</span>}
        <span className="spacer" />
        {bio && <button onClick={onHistory} title="저장된 파형 이력 (실시간 창)">이력</button>}
        <button className="icon" onClick={onClose} title="닫기 (Esc)">✕</button>
      </div>
      <div className="mp-tags">
        {alarm && <span className={`tag small sev-${alarm.severity}`}>{SEV_LABEL[alarm.severity]} · {alarm.message}</span>}
        {flags.map((n) => <span key={n} className={'tag small ' + (FLAG_WARN.has(n) ? 'warn' : '')}>{FLAG_LABEL[n] || n}</span>)}
        {stale ? <span className="tag small err">수신 없음</span> : <span className="tag small ok">수신 중</span>}
      </div>
      <div className="mp-place">{place}{now ? <span className="muted"> → 지금 {now}</span> : null}</div>
      <div className="mp-ids mono">패치 {channelId} · MRN {row.mrn || '—'} · GW {row.gateway_id || '—'}{(p.doctor || p.nurse) ? <span className="muted"> · {[p.doctor, p.nurse].filter(Boolean).join(' / ')}</span> : null}</div>

      {!bio ? (
        <p className="muted small mp-noaccess">이 계정은 파형과 생체 수치를 볼 수 없습니다.</p>
      ) : (
        <>
          <div className="mp-vitals">
            <div className={'mp-vital hr' + sevOf('hr_')}><small>HR</small><b>{v.hr ?? '—'}</b><i>bpm</i></div>
            {waves.includes('spo2') && <div className={'mp-vital spo2' + sevOf('spo2_')}><small>SpO₂</small><b>{v.spo2 ?? '—'}</b><i>%</i></div>}
            <div className={'mp-vital rr' + sevOf('resp_')}><small>RR</small><b>{v.resp ?? '—'}</b><i>/min</i></div>
            {waves.includes('temp') && <div className={'mp-vital temp' + sevOf('temp_')}><small>Temp</small><b>{v.temp != null ? v.temp.toFixed(1) : '—'}</b><i>°C</i></div>}
            {v.glucose != null && <div className="mp-vital glu"><small>Glu</small><b>{Math.round(v.glucose)}</b><i>mg/dL</i></div>}
          </div>
          <div className="mp-wave">
            <div className="mp-wl"><b>ECG</b><span className="muted">{row.sample_rate} Hz · 6초</span>{live?.pace?.length ? <span className="tag small">페이스 {live.pace.length}</span> : null}</div>
            <WaveCanvas id={channelId} wave="ecg" width={WAVE_W} height={104} />
            {waves.includes('resp_wave') && <><div className="mp-wl sub"><b>호흡</b></div><WaveCanvas id={channelId} wave="resp_wave" width={WAVE_W} height={40} color="#7cc4ff" /></>}
            {waves.includes('ppg') && <><div className="mp-wl sub"><b>Pleth</b></div><WaveCanvas id={channelId} wave="ppg" width={WAVE_W} height={40} color="#ff9f6b" /></>}
          </div>
          <div className="mp-dev">
            <span><small>배터리</small><b className={bat != null && bat <= 15 ? 'low' : ''}>{bat ?? '—'}%</b></span>
            {life && <span><small>착용</small><b>{fmtDays(life.worn)}째</b></span>}
            {life && <span><small>교체</small><b className={life.level === 'err' ? 'low' : ''}>{life.left <= 0 ? '지금' : `${fmtDays(life.left)} 뒤`}</b></span>}
            <span><small>신호</small><b>{rssi ?? '—'} dBm</b></span>
            <span><small>마지막</small><b>{fmtTime(live?.ts_ms ?? row.last_ts_ms)}</b></span>
          </div>
        </>
      )}

      <div className="mp-sec"><h5>알람 <span className="muted">{mine.length}</span></h5>
        {mine.length ? mine.map((a) => <div key={a.id} className={`mp-alarm sev-${a.severity}`}><span className={`tag small sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span><span>{a.message}</span><small className="muted mono">{fmtTime(a.since_ms)}</small></div>) : <p className="muted small">활성 알람 없음</p>}
      </div>
      <div className="mp-sec mp-emr"><h5>환자 정보</h5>
        {emr ? <EmrPanel emr={emr} p={p} row={row} platform={!me?.user?.tenant_id} onMap={() => {}} /> : <p className="muted small">EMR 정보를 불러오지 못했습니다.</p>}
      </div>
    </div>
  )
}
