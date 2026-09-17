import React, { useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'

export default function Events() {
  const [events] = usePoll(api.events, 3000)
  const [kind, setKind] = useState('')
  const list = (events || []).filter((e) => !kind || e.kind === kind).slice().reverse()
  const kinds = [...new Set((events || []).map((e) => e.kind))].sort()
  return (
    <div className="page">
      <div className="toolbar">
        <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">모든 종류</option>{kinds.map((k) => <option key={k}>{k}</option>)}</select>
        <span className="muted">{list.length}건 (라우터 메모리 링 최근 300건)</span>
      </div>
      <div className="events big">
        {list.map((e, i) => <div key={i} className={'ev ev-' + e.kind}><span className="ts">{fmtTime(e.ts_ms)}</span><span className="kind">{e.kind}</span>{e.channel_id && <span className="mono muted">{e.channel_id}</span>}<span>{e.message}</span></div>)}
      </div>
    </div>
  )
}
