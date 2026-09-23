import React, { useState } from 'react'
import { api, usePoll } from '../api.js'
import Dropdown from '../Dropdown.jsx'
import EventList from '../EventList.jsx'
import { EVENT_KIND } from '../model.js'

export default function Events() {
  const [events] = usePoll(api.events, 3000)
  const [kind, setKind] = useState('')
  const list = (events || []).filter((e) => !kind || e.kind === kind).slice().reverse()
  const byKind = new Map()
  for (const e of events || []) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1)
  const kinds = [{ value: '', label: '모든 종류', count: (events || []).length }, ...[...byKind].sort((a, b) => a[0].localeCompare(b[0])).map(([k, n]) => ({ value: k, label: EVENT_KIND[k] || k, count: n }))]
  return (
    <div className="page">
      <div className="toolbar">
        <Dropdown value={kind} options={kinds} onChange={setKind} placeholder="모든 종류" countUnit="건" width={220} />
        <span className="muted">{list.length}건 · 라우터 메모리에 최근 300건까지 보관</span>
      </div>
      <section className="panel"><EventList events={list} big /></section>
    </div>
  )
}
