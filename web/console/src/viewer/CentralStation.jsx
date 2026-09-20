import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import Sweep from './Sweep.jsx'
import { CS_C, CS_TH, CS_PRESETS, LIMITS, BAT_LOW, csLayout, monAlarm, shortAlarm, alarmKey } from './central.js'
import { latest } from '../ws.js'
import { alarmIndex } from '../model.js'
import BedViewer from './BedViewer.jsx'
import Dropdown from '../Dropdown.jsx'

const BELL = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /></svg>
const BELL_OFF = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /><path d="M18.63 13A17.89 17.89 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
export const BatIcon = ({ pct }) => {
  const lvl = Math.max(0, Math.min(100, pct || 0)), col = lvl <= BAT_LOW ? 'var(--color-accent)' : 'currentColor'
  return <svg width="18" height="10" viewBox="0 0 18 10" style={{ display: 'inline-block', verticalAlign: '-1px' }}><rect x="0.5" y="0.5" width="14" height="9" fill="none" stroke={col} strokeWidth="1" /><rect x="15" y="3" width="2" height="4" fill={col} /><rect x="2" y="2" width={(11 * lvl / 100).toFixed(1)} height="6" fill={col} /></svg>
}
export const Dec = ({ v, cls = 'cs-dec' }) => { const t = String(v); const i = t.indexOf('.'); return i < 0 ? t : <>{t.slice(0, i)}<span className={cls}>{t.slice(i)}</span></> }
// bed / room label; an outside (MCOT) patient has no bed, so the home region stands in for the location
export const bedOf = (row) => row.patient?.bed || row.bed || row.patient?.room || row.space || (row.patient?.home_region ? `외부 · ${row.patient.home_region}` : '')
export const useClock = () => { const [t, setT] = useState(''); useEffect(() => { const f = () => setT(new Date().toTimeString().slice(0, 8)); f(); const i = setInterval(f, 1000); return () => clearInterval(i) }, []); return t }

/** Tile vitals column (full / midv / grid2 forms are CSS-driven). */
function Vitals({ row, live, flag, v }) {
  const V = ({ k, cls, label, lim, unit, span, val, fmt, unitInLabel }) => (
    <div className={'cs-v ' + (span ? 'cs-span' : '')} style={{ color: CS_C[k] }}>
      <span className="cs-lab">{label}{unitInLabel && <i>{unitInLabel}</i>}</span><span className="cs-lim">{lim}</span>
      <b className={`cs-val ${cls} ${val == null ? 'ds-none' : ''} ${flag === k ? 'cs-flag' : ''}`}>{val == null ? '--' : <Dec v={fmt ? fmt(val) : val} />}</b><u className="cs-unit">{unit}</u>
    </div>
  )
  return (
    <div className="cs-vit">
      <V k="hr" cls="" label="HR" lim={`${LIMITS.hr[0]}–${LIMITS.hr[1]}`} unit="bpm" span val={v.hr} />
      <V k="spo2" cls="" label="SpO₂" lim={`${LIMITS.spo2[0]}–`} unit="%" span val={v.spo2} />
      <V k="rr" cls="cs-small" label="RR" lim={`${LIMITS.rr[0]}–${LIMITS.rr[1]}`} unit="/min" span val={v.resp} />
      <V k="nibp" cls="cs-small" label="NIBP" lim={`${LIMITS.nibp[0]}–${LIMITS.nibp[1]}`} unit="mmHg" span val={null} />
      <V k="temp" cls="cs-small" label="Temp" unitInLabel="°C" lim="" unit="" val={v.temp} fmt={(x) => x.toFixed(1)} />
      <V k="gl" cls="cs-small" label="GLU" unitInLabel="mg/dL" lim="" unit="" val={v.glucose} fmt={(x) => x.toFixed(0)} />
    </div>
  )
}

function Tile({ row, alarm, small, onOpen }) {
  const id = row.channel_id
  const live = latest.get(id)
  const v = { ...(row.vitals || {}), ...(live?.vitals || {}) }
  const p = row.patient || {}
  const ch = row.channels || []
  const hasPpg = ch.includes('ppg'), hasResp = ch.includes('resp_wave'), hasAcc = ch.includes('accel')
  const sec = hasPpg ? 'ppg' : hasAcc && !hasResp ? 'accel' : ''
  const a = monAlarm(row, live, alarm)
  const flags = live?.flags ?? row.flags ?? 0
  const bat = live?.battery ?? row.battery
  const flag = alarmKey(a[1])
  const emr = row.emr || {}
  return (
    <article className={'cs-tile' + (a[0] ? ' a-' + a[0] : '') + (flags & 0x01 ? ' leadoff' : '')} onClick={() => onOpen(id)} title={`${p.name || ''} 단일 침상 모니터 열기`}>
      <div className="cs-head">
        <span className="cs-bed">{bedOf(row)}</span><span className="ds-nm">{p.name || row.mrn}</span>
        <span className="ds-meta">{[emr.sex, emr.age && `${emr.age}`, emr.disease].filter(Boolean).join(' ') || p.ward}{flags & 0x10 ? ' · PACED' : ''}</span>
        <span className="cs-bat"><BatIcon pct={bat} /> {bat ?? '--'}%</span>
        <span className="cs-st" title={a[1]}>{small ? shortAlarm(a[1]) : a[1]}</span>
      </div>
      <div className="cs-waves">
        <div className="cs-wv cs-ecg"><span className="cs-lbl" style={{ color: CS_C.hr }}>II</span><Sweep id={id} wave="ecg" range={[-1.5, 2.0]} color={CS_C.hr} theme={CS_TH} /><div className="ds-off">LEAD OFF</div></div>
        {sec === 'ppg' && <div className="cs-wv"><span className="cs-lbl" style={{ color: CS_C.spo2 }}>Pleth</span><Sweep id={id} wave="ppg" range={[-1.2, 1.5]} color={CS_C.spo2} theme={CS_TH} pace={false} /></div>}
        {sec === 'accel' && <div className="cs-wv"><span className="cs-lbl" style={{ color: CS_C.temp }}>Accel</span><Sweep id={id} wave="accel0" range={[-1.6, 1.6]} color="#ff9783" theme={CS_TH} pace={false} /></div>}
        {!sec && <div className="cs-wv cs-nosensor"><span className="cs-lbl">Pleth · no sensor</span></div>}
        {hasResp ? <div className="cs-wv"><span className="cs-lbl" style={{ color: CS_C.rr }}>Resp</span><Sweep id={id} wave="resp_wave" range={[-1.5, 1.5]} color={CS_C.rr} theme={CS_TH} pace={false} /></div> : <div className="cs-wv cs-nosensor"><span className="cs-lbl">Resp · —</span></div>}
      </div>
      <Vitals row={row} live={live} flag={flag} v={v} />
    </article>
  )
}

function NumTile({ row, alarm, onOpen }) {
  const id = row.channel_id
  const live = latest.get(id)
  const v = { ...(row.vitals || {}), ...(live?.vitals || {}) }
  const p = row.patient || {}
  const a = monAlarm(row, live, alarm)
  const flags = live?.flags ?? row.flags ?? 0
  const flag = alarmKey(a[1])
  const V = ({ k, label, val, fmt }) => <div className="cn-v" style={{ color: CS_C[k] }}><span className="cn-l">{label}</span><b className={(val == null ? 'ds-none' : '') + (flag === k ? ' cs-flag' : '')}>{val == null ? '--' : (fmt ? fmt(val) : val)}</b></div>
  return (
    <article className={'cs-tile cs-num' + (a[0] ? ' a-' + a[0] : '') + (flags & 0x01 ? ' leadoff' : '')} onClick={() => onOpen(id)}>
      <div className="cs-head"><span className="cs-bed">{bedOf(row)}</span><span className="ds-nm">{p.name || row.mrn}</span><span className="cs-bat"><BatIcon pct={live?.battery ?? row.battery} /></span></div>
      <div className="cn-grid">
        <V k="hr" label="HR" val={v.hr} /><V k="spo2" label="SpO₂" val={v.spo2} /><V k="rr" label="RR" val={v.resp} /><V k="nibp" label="NIBP" val={null} />
        <div className="cn-st" title={a[1]}>{a[0] ? shortAlarm(a[1]) : (row.emr?.rhythm || 'NSR').toUpperCase()}</div>
        <div className="cn-v cn-minor"><span className="cn-l" style={{ color: CS_C.temp }}>Temp</span><b className={v.temp == null ? 'ds-none' : ''} style={{ color: CS_C.temp }}>{v.temp != null ? v.temp.toFixed(1) : '--'}</b><span className="cn-l" style={{ color: CS_C.gl }}>GLU</span><b className={v.glucose == null ? 'ds-none' : ''} style={{ color: CS_C.gl }}>{v.glucose != null ? v.glucose.toFixed(0) : '--'}</b></div>
      </div>
    </article>
  )
}

/**
 * Central Station template: n-up grid of bed tiles for `rows` (registry rows already scoped by the caller),
 * paged fixed presets or auto layout, numeric boards above 48, red/yellow alarm heads, tile → bed viewer.
 */
export default function CentralStation({ rows, alarms, unit, onClose }) {
  const gridRef = useRef(null)
  const [preset, setPreset] = useState(() => { try { return CS_PRESETS.find((x) => x.id === localStorage.getItem('cs:preset') && x.c) || null } catch { return null } })
  const [page, setPage] = useState(0)
  const [silenced, setSilenced] = useState(false)
  const [open, setOpen] = useState(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [, tick] = useState(0)
  const clock = useClock()
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const sorted = useMemo(() => [...rows].sort((a, b) => bedOf(a).localeCompare(bedOf(b), 'ko') || Number(a.channel_id) - Number(b.channel_id)), [rows])
  useEffect(() => { try { localStorage.setItem('cs:preset', preset ? preset.id : 'auto') } catch { /* ignore */ } }, [preset])
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t) }, []) // vitals are 1 Hz; re-rendering 4×/s only stole frames from the traces
  useLayoutEffect(() => {
    const el = gridRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setBox({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const n = sorted.length
  const lay = useMemo(() => csLayout(n, box.w || window.innerWidth, box.h || (window.innerHeight - 52), preset, n > 48), [n, box, preset])
  const cap = lay.cols * lay.rows
  const pages = preset ? Math.max(1, Math.ceil(n / cap)) : 1
  const cur = Math.min(page, pages - 1)
  const shown = preset ? sorted.slice(cur * cap, cur * cap + cap) : sorted
  const blanks = preset ? Math.max(0, cap - shown.length) : 0
  const nAlarms = shown.filter((r) => monAlarm(r, latest.get(r.channel_id), aidx.get(r.channel_id))[0]).length
  const gridStyle = { gridTemplateColumns: `repeat(${lay.cols},minmax(0,1fr))`, ...(lay.fitAll ? { gridTemplateRows: `repeat(${lay.rows},minmax(0,1fr))` } : { gridAutoRows: 'minmax(140px,1fr)' }), ...lay.vars }
  const gridCls = 'cs-grid ' + Object.entries(lay.classes).filter(([, v]) => v).map(([k]) => k).join(' ')
  const small = lay.classes.compact
  return (
    <div className={'ds dark cs' + (silenced ? ' silenced' : '')}>
      <header className="nav">
        <div className="cs-brand nav-brand"><span>CENTRAL</span><span className="ds-unit">{unit}</span></div>
        <div className="cs-legend">{[['ECG / HR', CS_C.hr], ['SpO₂', CS_C.spo2], ['RR', CS_C.rr], ['NIBP', CS_C.nibp], ['Temp', CS_C.temp], ['GLU', CS_C.gl]].map(([l, c]) => <span key={l} style={{ color: c }}><i style={{ background: c }} />{l}</span>)}</div>
        <div className="cs-right">
          <span className="cs-presets">
            <button className={'btn ' + (!preset ? 'on' : '')} onClick={() => { setPreset(null); setPage(0) }} title="자동 배치 (48명 초과 시 숫자만)">Auto{!preset && <small> {n}명</small>}</button>
            <Dropdown className="csdd" searchable={false} value={preset ? preset.id : ''} placeholder="n-up…"
              options={[
                ...CS_PRESETS.filter((x) => x.c && !x.numeric).map((x) => ({ value: x.id, label: `${x.c * x.r}-up · ${x.c}×${x.r}`, group: '파형 + 수치' })),
                ...CS_PRESETS.filter((x) => x.numeric).map((x) => ({ value: x.id, label: `${x.c * x.r}-up · ${x.c}×${x.r} · 숫자만`, group: '숫자 전용 보드' })),
              ]}
              renderValue={(o) => `${o.label}${n ? ` (${n}명)` : ''}`}
              onChange={(v) => { setPreset(CS_PRESETS.find((x) => x.id === v) || null); setPage(0) }} />
          </span>
          {pages > 1 && <span className="cs-pager"><button className="btn btn-secondary" onClick={() => setPage(Math.max(0, cur - 1))}>‹</button><span>{cur + 1} / {pages}</span><button className="btn btn-secondary" onClick={() => setPage(Math.min(pages - 1, cur + 1))}>›</button></span>}
          <span className={'cs-alarms' + (nAlarms ? (silenced ? ' is-muted' : '') : ' ds-none')}>{nAlarms} alarm{nAlarms === 1 ? '' : 's'}{silenced ? ' · silenced' : ''}</span>
          <span className="cs-clock">{clock}</span>
          <button className={'btn btn-secondary ds-icon' + (silenced ? ' on' : '')} onClick={() => setSilenced(!silenced)} title="알람 묵음 (전체) 켜기/끄기">{silenced ? BELL_OFF : BELL}</button>
          {onClose && <button className="btn btn-secondary" onClick={onClose}>Close</button>}
        </div>
      </header>
      <main ref={gridRef} className={gridCls} style={gridStyle}>
        {n === 0 && <div className="cs-empty">표시할 환자가 없습니다.</div>}
        {shown.map((r) => lay.numeric ? <NumTile key={r.channel_id} row={r} alarm={aidx.get(r.channel_id)} onOpen={setOpen} /> : <Tile key={r.channel_id} row={r} alarm={aidx.get(r.channel_id)} small={small} onOpen={setOpen} />)}
        {Array.from({ length: blanks }, (_, i) => <article key={'b' + i} className="cs-tile cs-blank" />)}
      </main>
      {open && <BedViewer row={sorted.find((r) => r.channel_id === open) || rows.find((r) => r.channel_id === open)} alarms={alarms} unit={unit} onBack={() => setOpen(null)} />}
    </div>
  )
}
