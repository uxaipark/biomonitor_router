import React, { useEffect, useMemo, useState } from 'react'
import { api, usePoll } from '../api.js'
import { claimLive, releaseLive } from '../ws.js'
import { templateById } from '../viewer/templates.js'
import { isMobileGw } from './Viewers.jsx'
import '../viewer/ds.css'

/**
 * Full-screen viewer route: `#/viewer?tpl=central&gw=895` | `ward=W110A` | `room=110A01` | `b=0&f=10` | `ids=1,2,3`
 *   | `doctor=D1300` | `nurse=N1301` | `dept=종양내과` | `dx=암` | `group=<id>`; `label=` overrides the caption.
 * Scopes the registry rows, enriches them with EMR facts (sex/age/diagnosis/bed) via the router's EMR proxy,
 * subscribes the shown patches on the shared WS and hands everything to the template component.
 */
export default function Viewer({ alarms, hash }) {
  const q = useMemo(() => new URLSearchParams((hash.split('?')[1] || '')), [hash])
  const tpl = templateById(q.get('tpl'))
  const [rows] = usePoll(api.channels, 4000)
  const [gws] = usePoll(api.gateways, 15000)
  const [emr, setEmr] = useState({ byPatient: new Map(), bedByPatch: new Map() })
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [adm, list] = await Promise.all([api.emu.admissions(), fetchJson('/api/emr/patients?status=admitted&limit=5000')])
        const byPatient = new Map()
        for (const p of list?.patients || []) byPatient.set(String(p.patient_no ?? p.id), p)
        const bedByPatch = new Map()
        for (const a of adm?.admissions || []) bedByPatch.set(String(a.patch_id), a.bed)
        if (alive) setEmr({ byPatient, bedByPatch })
      } catch { /* EMR optional */ }
    }
    load()
    const t = setInterval(load, 60000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const scoped = useMemo(() => {
    let v = (rows || []).filter((r) => r.connected)
    const gw = q.get('gw'), ward = q.get('ward'), room = q.get('room'), ids = q.get('ids'), b = q.get('b'), f = q.get('f')
    if (gw) v = v.filter((r) => r.gateway_id === gw)
    if (ward) v = v.filter((r) => r.patient?.ward === ward)
    if (room) v = v.filter((r) => (r.patient?.room || r.space) === room)
    if (ids) { const set = new Set(ids.split(',')); v = v.filter((r) => set.has(r.channel_id)) }
    const doctor = q.get('doctor'), nurse = q.get('nurse'), dept = q.get('dept'), dx = q.get('dx'), group = q.get('group'), paced = q.get('paced'), mode = q.get('mode')
    if (paced) v = v.filter((r) => (r.flags & 0x10) !== 0)
    if (mode === 'mcot') { const mobile = new Set((gws || []).filter(isMobileGw).map((g) => String(g.gw_id))); v = v.filter((r) => mobile.has(r.gateway_id) || (r.patient?.mode && r.patient.mode !== 'inpatient')) }
    else if (mode) v = v.filter((r) => r.patient?.mode === mode)
    if (doctor) v = v.filter((r) => r.patient?.doctor === doctor)
    if (nurse) v = v.filter((r) => r.patient?.nurse === nurse)
    if (dept) v = v.filter((r) => r.patient?.department === dept)
    if (dx) v = v.filter((r) => r.patient?.diagnosis === dx)
    if (group) v = v.filter((r) => (r.groups || []).includes(group))
    if (b != null && f != null) v = v.filter((r) => String(r.patient?.building_idx ?? '') === b && String(r.patient?.floor) === f)
    v = v.map((r) => ({ ...r, emr: emr.byPatient.get(String(r.patient_id)), bed: emr.bedByPatch.get(r.channel_id) }))
    return v.slice(0, tpl.maxRows || 200)
  }, [rows, q, emr, tpl, gws])
  const ids = scoped.map((r) => r.channel_id).join(',')
  useEffect(() => { claimLive('viewer', ids ? ids.split(',') : []); return () => releaseLive('viewer') }, [ids])
  const unit = useMemo(() => {
    if (q.get('label')) return q.get('label')
    const gw = q.get('gw')
    if (gw) { const g = (gws || []).find((x) => String(x.gw_id) === gw); return g ? `${g.location?.building || ''} ${g.location?.floor ? g.location.floor + 'F' : ''} · ${g.location?.room || ''} · ${g.name} #${g.gw_id}` : `GW #${gw}` }
    return [q.get('ward') && `병동 ${q.get('ward')}`, q.get('room') && `병실 ${q.get('room')}`, q.get('doctor') && `담당의 ${q.get('doctor')}`, q.get('nurse') && `간호사 ${q.get('nurse')}`, q.get('dept') && `진료과 ${q.get('dept')}`, q.get('dx') && `주진단 ${q.get('dx')}`, q.get('group') && `그룹 ${q.get('group')}`, q.get('paced') && '페이스메이커', q.get('mode') && q.get('mode').toUpperCase(), q.get('b') != null && `건물 ${q.get('b')} · ${q.get('f')}F`, q.get('ids') && `선택 ${scoped.length}명`].filter(Boolean).join(' · ') || '전체'
  }, [q, gws, scoped.length])
  const Template = tpl.component
  useEffect(() => { document.title = `${tpl.name} · ${unit}` ; return () => { document.title = 'Biomonitor Router' } }, [tpl, unit])
  return <Template rows={scoped} alarms={alarms} unit={unit} onClose={() => { if (window.opener || history.length <= 1) window.close(); else location.hash = '#/viewers' }} />
}

async function fetchJson(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(String(r.status))
  return r.json()
}
