import React, { useEffect, useMemo, useState } from 'react'
import { WaveCard } from '../WaveCard.jsx'
import { alarmIndex } from '../model.js'
import { openLive } from '../App.jsx'

/** The console's own card grid as a full-screen template (operator view). */
export default function GridTemplate({ rows, alarms, unit, onClose }) {
  const [density, setDensity] = useState('compact')
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t) }, [])
  const sorted = useMemo(() => [...rows].sort((a, b) => (a.patient?.room || '').localeCompare(b.patient?.room || '', 'ko') || Number(a.channel_id) - Number(b.channel_id)), [rows])
  return (
    <div className="page" style={{ maxWidth: 'none' }}>
      <div className="toolbar">
        <b>{unit}</b>
        <span className="seg">{['normal', 'compact', 'dense'].map((d) => <button key={d} className={density === d ? 'active' : ''} onClick={() => setDensity(d)}>{{ normal: '크게', compact: '보통', dense: '촘촘' }[d]}</button>)}</span>
        <span className="muted">{sorted.length}명</span>
        <span className="spacer" />
        {onClose && <button onClick={onClose}>닫기</button>}
      </div>
      <div className={'grid ' + density}>
        {sorted.map((r) => <WaveCard key={r.channel_id} row={r} density={density} alarm={aidx.get(r.channel_id)} onClick={() => openLive(r.channel_id)} />)}
      </div>
    </div>
  )
}
