import React, { useEffect, useMemo, useState } from 'react'
import Sweep from './Sweep.jsx'
import { LIMITS, BAT_LOW, VM_TH, monAlarm, alarmKey } from './central.js'
import { latest } from '../ws.js'
import { api, usePoll, fmtTime } from '../api.js'
import { alarmIndex } from '../model.js'

const BELL = <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /></svg>
const Dec = ({ v }) => { const t = String(v); const i = t.indexOf('.'); return i < 0 ? t : <>{t.slice(0, i)}<span className="vm-dec">{t.slice(i)}</span></> }
const useClock = () => { const [t, setT] = useState(''); useEffect(() => { const f = () => setT(new Date().toTimeString().slice(0, 8)); f(); const i = setInterval(f, 1000); return () => clearInterval(i) }, []); return t }

function VmTile({ k, label, unit, hi, lo, note, val, fmt, flag, alarmColor, spark }) {
  const isAlarm = flag === k
  return (
    <div className={'vm-tile' + (isAlarm ? ' is-alarm' + (alarmColor === 'yellow' ? ' is-yellow' : '') : '')}>
      <div className="vm-lab"><b>{label}</b><span className="ds-dim">{unit}</span></div>
      <div className="vm-lim"><span>{hi}</span><span>{lo}</span></div>
      <div className="vm-val"><b className={val == null ? 'ds-none' : ''}>{val == null ? '--' : <Dec v={fmt ? fmt(val) : val} />}</b><u>{val != null ? unit : ''}</u></div>
      <div className="vm-foot"><svg width="96" height="18" viewBox="0 0 96 18" fill="none" stroke="currentColor" strokeWidth="1.5"><polyline points={spark} /></svg><span>{note}</span></div>
    </div>
  )
}

/** Single-bed viewer (Vitals Monitor Viewer): three large traces, six vital tiles, 6 h trend, events. */
export default function BedViewer({ row, alarms, unit, onBack }) {
  const id = row?.channel_id
  const [night, setNight] = useState(() => { try { return localStorage.getItem('vm:night') === '1' } catch { return false } })
  const [silenced, setSilenced] = useState(false)
  const [emr, setEmr] = useState(null)
  const [hist, setHist] = useState([]) // sampled vitals for the sparkline / trend table
  const [, tick] = useState(0)
  const clock = useClock()
  const [events] = usePoll(api.events, 5000)
  const [ahist] = usePoll(() => api.alarmHistory(300), 10000)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  useEffect(() => { try { localStorage.setItem('vm:night', night ? '1' : '0') } catch { /* ignore */ } }, [night])
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t) }, [])
  useEffect(() => { const f = (e) => { if (e.key === 'Escape') onBack() }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f) }, [onBack])
  const pid = row?.profile_id || row?.patient?.profile_no
  useEffect(() => { if (pid) api.emu.patient(pid).then(setEmr).catch(() => setEmr(null)) }, [pid])
  // vitals history: one sample every 5 s while the viewer is open (the router keeps no numeric history yet)
  useEffect(() => {
    if (!id) return
    const f = () => { const l = latest.get(id); const v = l?.vitals || row.vitals; if (v) setHist((h) => [...h.slice(-359), { t: Date.now(), ...v }]) }
    f(); const t = setInterval(f, 5000)
    return () => clearInterval(t)
  }, [id])
  if (!row) return null
  const live = latest.get(id)
  const v = { ...(row.vitals || {}), ...(live?.vitals || {}) }
  const p = row.patient || {}
  const flags = live?.flags ?? row.flags ?? 0
  const a = monAlarm(row, live, aidx.get(id))
  const flag = alarmKey(a[1])
  const th = night ? VM_TH.night : VM_TH.light
  const ch = row.channels || []
  const spark = (k) => { const s = hist.slice(-24).map((h) => h[k]).filter((x) => x != null); if (s.length < 2) return ''; const lo = Math.min(...s), hi = Math.max(...s); return s.map((x, i) => `${(i / (s.length - 1)) * 96},${hi === lo ? 9 : 16 - ((x - lo) / (hi - lo)) * 14}`).join(' ') }
  const bat = live?.battery ?? row.battery
  const myEvents = (events || []).filter((e) => e.channel_id === id).slice(-8).reverse()
  const myAlarms = (ahist || []).filter((x) => x.channel_id === id).slice(0, 8)
  // trend table: one row per minute over the last hour of samples (the emulator's 6 h hourly table has no router-side source yet)
  const trend = []
  for (let i = hist.length - 1; i >= 0 && trend.length < 12; i -= 12) trend.push(hist[i])
  return (
    <div className={'ds vm' + (night ? ' night' : '') + (silenced ? ' silenced' : '') + (flags & 0x01 ? ' leadoff' : '')}>
      <header className="nav">
        <div className="vm-brand nav-brand"><span>BED {p.bed || p.room || row.space}</span><span className="ds-unit">{[p.ward, unit].filter(Boolean).join(' · ')}</span></div>
        <div className="vm-who">
          <span className="ds-nm">{p.name || row.mrn}</span>
          <span className="ds-meta">{[emr?.sex, emr?.age && `${emr.age}y`, emr?.weight_kg && `${emr.weight_kg} kg`].filter(Boolean).join(' · ')}</span>
          <span className="ds-meta">{row.mrn}</span>
          <span className="vm-tags">
            {emr?.rhythm && <span className={'tag ' + (a[0] ? 'tag-accent' : 'tag-neutral')}>{emr.rhythm}</span>}
            <span className="tag tag-outline">{flags & 0x10 ? 'Pacer: Yes' : 'Pacer: No'}</span>
            <span className={'tag ' + (bat <= BAT_LOW ? 'tag-accent' : 'tag-neutral')}>Patch {bat}% · {id} · {live?.rssi ?? row.rssi} dBm</span>
            {emr?.disease && <span className="tag tag-neutral">{emr.disease}</span>}
          </span>
        </div>
        <div className="vm-right">
          {a[0] ? <span className={'vm-alarm' + (a[0] === 'yellow' ? ' is-yellow' : '')}>{a[1]}</span> : <span className="vm-quiet">{BELL}No active alarms</span>}
          <span className="vm-clock">{clock}</span>
          <button className={'btn btn-secondary ds-icon' + (silenced ? ' on' : '')} onClick={() => setSilenced(!silenced)} title="알람 묵음">{BELL}</button>
          <button className={'btn ' + (night ? 'btn-primary' : 'btn-secondary')} onClick={() => setNight(!night)}>Night</button>
          <button className="btn btn-secondary" onClick={onBack}>Back</button>
        </div>
      </header>
      <main className="vm-main">
        <section className="vm-waves">
          <div className="vm-row cs-ecg"><div className="vm-ttl"><b>ECG · Lead II</b><span className="ds-dim">25 mm/s · 10 mm/mV</span><span className="ds-dim">Filter 0.5–40 Hz</span><span className="ds-dim vm-r">{flags & 0x10 ? 'Pacer on · pulse marks A/V' : 'Pacer off'}</span></div><div className="vm-box"><Sweep id={id} wave="ecg" range={[-1.5, 2.0]} color={th.ecg} theme={th} /><div className="ds-off">LEAD OFF</div></div></div>
          <div className="vm-row"><div className="vm-ttl"><b>Pleth · SpO₂</b><span className="ds-dim">{ch.includes('ppg') ? 'PPG' : ch.includes('spo2') ? 'Rate only' : 'No SpO₂ sensor'}</span></div><div className="vm-box">{ch.includes('ppg') ? <Sweep id={id} wave="ppg" range={[-1.2, 1.5]} color={th.ppg} theme={th} pace={false} /> : ch.includes('accel') ? <Sweep id={id} wave="accel0" range={[-1.6, 1.6]} color={th.ppg} theme={th} pace={false} /> : null}</div></div>
          <div className="vm-row"><div className="vm-ttl"><b>Resp · Impedance</b><span className="ds-dim">{ch.includes('resp_wave') ? 'Capacitive · Apnea limit 20 s' : 'Rate only'}</span></div><div className="vm-box">{ch.includes('resp_wave') && <Sweep id={id} wave="resp_wave" range={[-1.5, 1.5]} color={th.resp} theme={th} pace={false} />}</div></div>
        </section>
        <aside className="vm-aside">
          <VmTile k="hr" label="HR" unit="bpm" hi={LIMITS.hr[1]} lo={LIMITS.hr[0]} note="ECG · Lead II" val={v.hr} flag={flag} alarmColor={a[0]} spark={spark('hr')} />
          <VmTile k="spo2" label="SpO₂" unit="%" hi="100" lo={LIMITS.spo2[0]} note={ch.includes('ppg') ? 'PPG' : 'Patch'} val={v.spo2} flag={flag} alarmColor={a[0]} spark={spark('spo2')} />
          <VmTile k="rr" label="RR" unit="/min" hi={LIMITS.rr[1]} lo={LIMITS.rr[0]} note={ch.includes('resp_wave') ? 'Capacitive' : 'Derived'} val={v.resp} flag={flag} alarmColor={a[0]} spark={spark('resp')} />
          <VmTile k="nibp" label="NIBP" unit="mmHg" hi={LIMITS.nibp[1]} lo={LIMITS.nibp[0]} note="No cuff" val={null} flag={flag} alarmColor={a[0]} spark="" />
          <VmTile k="temp" label="Temp" unit="°C" hi={LIMITS.temp[1]} lo={LIMITS.temp[0]} note="Skin patch" val={v.temp} fmt={(x) => x.toFixed(1)} flag={flag} alarmColor={a[0]} spark={spark('temp')} />
          <VmTile k="gl" label="GLU" unit="mg/dL" hi={LIMITS.gl[1]} lo={LIMITS.gl[0]} note="CGM" val={v.glucose} fmt={(x) => x.toFixed(0)} flag={flag} alarmColor={a[0]} spark={spark('glucose')} />
        </aside>
      </main>
      <section className="vm-bottom">
        <div><div className="vm-cap"><h6>Vitals trend · session</h6><span>1-min samples while this viewer is open</span></div>
          <table className="table"><thead><tr><th>Time</th><th>HR</th><th>SpO₂</th><th>RR</th><th>Temp</th><th>GLU</th></tr></thead>
            <tbody>{trend.map((h) => <tr key={h.t}><td>{fmtTime(h.t)}</td><td>{h.hr ?? '--'}</td><td>{h.spo2 ?? '--'}</td><td>{h.resp ?? '--'}</td><td>{h.temp != null ? h.temp.toFixed(1) : '--'}</td><td>{h.glucose != null ? h.glucose.toFixed(0) : '--'}</td></tr>)}{!trend.length && <tr><td colSpan="6" className="ds-dim">수집 중…</td></tr>}</tbody></table></div>
        <div><h6>Events</h6><div style={{ display: 'flex', flexDirection: 'column' }}>
          {myAlarms.map((x) => <div key={'a' + x.id + (x.cleared_ms || '')} className="vm-ev"><span className="vm-t">{fmtTime(x.cleared_ms || x.since_ms)}</span><span>{x.message}</span><span className="ds-dim">{x.cleared_ms ? 'cleared' : x.severity}</span></div>)}
          {myEvents.map((e, i) => <div key={'e' + i} className="vm-ev"><span className="vm-t">{fmtTime(e.ts_ms)}</span><span>{e.message}</span><span className="ds-dim">{e.kind}</span></div>)}
          {!myAlarms.length && !myEvents.length && <div className="vm-ev"><span className="vm-t">—</span><span className="ds-dim">이벤트 없음</span><span /></div>}
        </div></div>
      </section>
    </div>
  )
}
