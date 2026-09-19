import React, { useState } from 'react'
import { api, usePoll, fmtTime } from '../api.js'
import Dropdown from '../Dropdown.jsx'

export default function Events() {
  const [events] = usePoll(api.events, 3000)
  const [kind, setKind] = useState('')
  const list = (events || []).filter((e) => !kind || e.kind === kind).slice().reverse()
  const byKind = new Map()
  for (const e of events || []) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1)
  const kinds = [{ value: '', label: '모든 종류', count: (events || []).length }, ...[...byKind].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ value: k, label: k, count: n }))]
  return (
    <div className="page">
      <div className="toolbar">
        <Dropdown value={kind} options={kinds} onChange={setKind} placeholder="모든 종류" countUnit="건" width={220} />
        <span className="muted">{list.length}건 (라우터 메모리 링 최근 300건)</span>
      </div>
      <div className="events big">
        {list.map((e, i) => <div key={i} className={'ev ev-' + e.kind}><span className="ts">{fmtTime(e.ts_ms)}</span><span className="kind">{e.kind}</span>{e.channel_id && <span className="mono muted">{e.channel_id}</span>}<span>{e.message}</span></div>)}
      </div>
    </div>
  )
}
