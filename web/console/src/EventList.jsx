import React from 'react'
import { fmtTime } from './api.js'
import { EVENT_KIND, SEV_LABEL } from './model.js'
import { openLive } from './App.jsx'

const SEV_OF = { Critical: 'critical', High: 'high', Medium: 'medium', Low: 'low' }

/** Router events as aligned rows: time · kind · patch · message (alarm events get their severity as a tag). */
export default function EventList({ events, big }) {
  return (
    <div className={'evl' + (big ? ' big' : '')}>
      {events.map((e, i) => {
        const m = /^\[(Critical|High|Medium|Low)\]\s*(.*)$/.exec(e.message || '')
        const sev = m && SEV_OF[m[1]]
        return (
          <div key={i} className={'evl-row ev-' + e.kind}>
            <span className="evl-ts">{fmtTime(e.ts_ms)}</span>
            <span className="evl-kind">{EVENT_KIND[e.kind] || e.kind}</span>
            <span className="evl-ch">{e.channel_id ? <a onClick={() => openLive(e.channel_id)} title="환자 상세">{e.channel_id}</a> : ''}</span>
            <span className="evl-msg">{sev && <span className={`tag small sev-${sev}`}>{SEV_LABEL[sev]}</span>}{m ? m[2] : e.message}</span>
          </div>
        )
      })}
      {!events.length && <p className="muted">이벤트가 없습니다.</p>}
    </div>
  )
}
