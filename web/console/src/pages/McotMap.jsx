import React, { useEffect, useMemo, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import './McotMap.css'
import { api, usePoll } from '../api.js'
import { alarmIndex, SEV_LABEL } from '../model.js'
import { WaveCard } from '../WaveCard.jsx'
import { claimLive, releaseLive, latest } from '../ws.js'
import { LiveModal } from './LiveModal.jsx'
import MapPatientPanel from './MapPatientPanel.jsx'
import { isMobileGw } from './Viewers.jsx'
import { viewerUrl } from '../viewer/templates.js'
import { locate, SIDO } from '../geo/korea.js'

const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1 }
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const KOREA = { center: [36.4, 127.9], zoom: 7 }

// 채널 번호로 고정된 작은 흔들림(±0.012° ≈ 1.3 km): 같은 시군구의 환자 핀이 한 점에 겹치지 않게
const jitter = (id, k) => { let h = 2166136261; for (const c of String(id) + k) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) } return (((h >>> 0) % 1000) / 1000 - 0.5) * 0.024 }
/** 환자 위치: EMR 이 좌표를 주면 그대로(lat/lng · location · geo · home_geo), 아니면 집주소(시군구) 중심 + 흔들림 */
function geoOf(r) {
  const p = r.patient || {}
  for (const o of [p, p.location, p.geo, p.home_geo, r.location]) {
    if (!o) continue
    const lat = Number(o.lat ?? o.latitude), lng = Number(o.lng ?? o.lon ?? o.longitude)
    if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) return { ll: [lat, lng], kind: 'gps', label: '위치 정보' }
  }
  const loc = locate(p.home_region || p.home_address, p.home_address)
  if (!loc) return null
  return { ll: [loc.ll[0] + jitter(r.channel_id, 'a'), loc.ll[1] + jitter(r.channel_id, 'b')], kind: loc.exact ? 'addr' : 'sido', label: loc.exact ? '집주소 (시군구·도시 기준)' : '집주소 (시도·국가 기준)', key: loc.key, sido: loc.sido }
}

/** 원외(MCOT) 환자를 세계 지도 위에 — 줌/이동 가능, 핀 + 이름, 오른쪽에 지역 목록 · 환자 상세 */
export default function McotMap({ alarms }) {
  const [rows] = usePoll(api.channels, 4000)
  const [gws] = usePoll(api.gateways, 4000)
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(null) // { patient, back } | { region }
  const [hx, setHx] = useState(null)
  const [offline, setOffline] = useState(false)
  const [, tick] = useState(0)
  const aidx = useMemo(() => alarmIndex(alarms?.alarms), [alarms])
  const mobile = useMemo(() => new Set((gws || []).filter(isMobileGw).map((g) => String(g.gw_id))), [gws])
  const all = useMemo(() => (rows || []).filter((r) => r.connected !== false && (mobile.has(String(r.gateway_id)) || (r.patient?.mode && r.patient.mode !== 'inpatient'))).map((r) => ({ ...r, geo: geoOf(r) })), [rows, mobile])
  // 주요 국가 탭: 전체 · 한국 · 미국 · 일본 · 기타(그 밖의 나라 + 주소 없음)
  const [nation, setNation] = useState('all')
  const countryOf = (r) => (r.geo ? (SIDO[r.geo.sido] ? '한국' : r.geo.sido) : '')
  const NATION = [['all', '전체', () => true], ['KR', '한국', (c) => c === '한국'], ['US', '미국', (c) => c === '미국'], ['JP', '일본', (c) => c === '일본'], ['other', '기타', (c) => c !== '한국' && c !== '미국' && c !== '일본']]
  const nationCounts = useMemo(() => Object.fromEntries(NATION.map(([k, , f]) => [k, all.filter((r) => f(countryOf(r))).length])), [all]) // eslint-disable-line react-hooks/exhaustive-deps
  const byNation = useMemo(() => { const f = NATION.find(([k]) => k === nation)?.[2] || (() => true); return all.filter((r) => f(countryOf(r))) }, [all, nation]) // eslint-disable-line react-hooks/exhaustive-deps
  const qn = q.trim().toLowerCase()
  const shown = useMemo(() => !qn ? byNation : byNation.filter((r) => [r.patient?.name, r.patient?.home_region, r.patient?.home_address, r.mrn, r.channel_id].some((x) => String(x || '').toLowerCase().includes(qn))), [byNation, qn])
  const regions = useMemo(() => {
    const m = new Map()
    for (const r of shown) {
      const key = r.geo?.key || (r.geo?.kind === 'gps' ? '위치 정보' : '주소 없음')
      let g = m.get(key); if (!g) { g = { key, sido: r.geo?.sido || '', rows: [], alarms: 0, sev: 0, stale: 0, ll: r.geo?.ll } ; m.set(key, g) }
      g.rows.push(r); const a = aidx.get(r.channel_id); if (a) { g.alarms++; g.sev = Math.max(g.sev, SEV_RANK[a.severity] || 0) } if (r.stale) g.stale++
    }
    return [...m.values()].sort((a, b) => b.rows.length - a.rows.length || a.key.localeCompare(b.key, 'ko'))
  }, [shown, aidx])
  const nAlarm = shown.filter((r) => aidx.has(r.channel_id)).length, nStale = shown.filter((r) => r.stale).length, nMoving = shown.filter((r) => r.moving).length, nApprox = shown.filter((r) => r.geo && r.geo.kind !== 'gps').length, nNoGeo = shown.filter((r) => !r.geo).length

  // ── Leaflet ──
  // Leaflet 은 불러올 때 window 를 만지므로(SSR 스모크에서 죽는다) 마운트 뒤에 동적으로 읽는다
  const elRef = useRef(null), mapRef = useRef(null), layerRef = useRef(null), fitted = useRef(false), markers = useRef(new Map()), Lref = useRef(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!elRef.current || mapRef.current) return
    let dead = false, ro = null
    import('leaflet').then(({ default: L }) => {
      if (dead || !elRef.current) return
      Lref.current = L
      // 세계를 한 번만: 타일 반복(noWrap) 없이, 최소 줌은 컨테이너 폭에 세계 한 바퀴가 딱 맞는 값(0.25 단위) — 세계 버튼과
      // 처음 '전체 맞춤'이 같은 배율이 되고, 미국이 양쪽에 두 번 보이는 과도한 줌아웃이 없다
      const minZoomFor = (w) => Math.max(1, Math.ceil(Math.log2(Math.max(256, w) / 256) * 4) / 4)
      const map = L.map(elRef.current, { worldCopyJump: false, zoomSnap: 0.25, zoomDelta: 0.5, minZoom: minZoomFor(elRef.current.clientWidth), maxBounds: [[-85, -180], [85, 180]], maxBoundsViscosity: 1, zoomControl: true }).setView(KOREA.center, KOREA.zoom)
      const tiles = L.tileLayer(TILES, { maxZoom: 19, noWrap: true, bounds: [[-85, -180], [85, 180]], attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })
      let errs = 0, oks = 0
      tiles.on('tileerror', () => { errs++; if (errs >= 4 && !oks) setOffline(true) })
      tiles.on('tileload', () => { oks++; setOffline(false) })
      tiles.addTo(map)
      layerRef.current = L.layerGroup().addTo(map)
      mapRef.current = map
      setTimeout(() => map.invalidateSize(), 50)
      ro = new ResizeObserver(() => { map.invalidateSize(); map.setMinZoom(minZoomFor(elRef.current?.clientWidth || 256)) }); ro.observe(elRef.current)
      setReady(true)
    })
    return () => { dead = true; ro?.disconnect(); mapRef.current?.remove(); mapRef.current = null; markers.current.clear() }
  }, [])
  // 핀 갱신: 목록·알람이 바뀔 때마다 (위치는 주소 기준이라 거의 고정, 색·라벨만 바뀐다)
  useEffect(() => {
    const map = mapRef.current, layer = layerRef.current, L = Lref.current; if (!map || !layer || !L) return
    const keep = new Set()
    for (const r of shown) {
      if (!r.geo) continue
      const id = r.channel_id; keep.add(id)
      const a = aidx.get(id)
      const cls = 'mm-pin' + (a ? ` sev-${a.severity}` : '') + (r.stale ? ' stale' : '') + (pick?.patient === id ? ' on' : '') + (r.geo.kind === 'sido' ? ' approx' : '')
      const html = `<i></i><b>${esc(r.patient?.name || r.mrn || id)}</b>`
      let m = markers.current.get(id)
      if (!m) {
        m = L.marker(r.geo.ll, { icon: L.divIcon({ className: cls, html, iconSize: [0, 0], iconAnchor: [0, 0] }), riseOnHover: true })
        m.on('click', () => setPick((cur) => ({ patient: id, back: cur?.region ? cur : null })))
        m.addTo(layer); markers.current.set(id, m)
      } else {
        m.setLatLng(r.geo.ll)
        if (m._mmCls !== cls || m._mmHtml !== html) m.setIcon(L.divIcon({ className: cls, html, iconSize: [0, 0], iconAnchor: [0, 0] }))
      }
      m._mmCls = cls; m._mmHtml = html
      const live = latest.get(id), v = live?.vitals || r.vitals || {}
      m.bindTooltip(`<div class="mm-tip"><b>${esc(r.patient?.name || id)}</b> · ${esc(r.patient?.home_address || r.patient?.home_region || '주소 없음')}<br>HR ${v.hr ?? '—'} · SpO₂ ${v.spo2 ?? '—'} · RR ${v.resp ?? '—'}${a ? `<br><span style="color:var(--sev-${a.severity})">${SEV_LABEL[a.severity]} · ${esc(a.message)}</span>` : ''}<br><span style="opacity:.7">${esc(r.geo.label)} · 패치 ${id} · GW ${esc(r.gateway_id || '—')}${r.stale ? ' · 수신 없음' : ''}</span></div>`, { direction: 'top', offset: [0, -30], sticky: false })
    }
    for (const [id, m] of markers.current) if (!keep.has(id)) { layer.removeLayer(m); markers.current.delete(id) }
    if (!fitted.current && shown.some((r) => r.geo)) { fitted.current = true; fitAll() }
  }, [shown, aidx, pick?.patient, ready]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 5000); return () => clearInterval(t) }, []) // 툴팁 수치 갱신용
  const nationRef = useRef('all')
  useEffect(() => { if (nationRef.current !== nation) { nationRef.current = nation; setPick(null); setTimeout(fitAll, 30) } }, [nation, shown]) // eslint-disable-line react-hooks/exhaustive-deps
  const fitAll = () => { const map = mapRef.current, L = Lref.current; const pts = shown.filter((r) => r.geo).map((r) => r.geo.ll); if (map && L && pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 9 }) }
  const flyTo = (ll, z) => mapRef.current?.flyTo(ll, z, { duration: 0.6 })

  // 오른쪽 패널 목록의 파형 구독
  const region = pick?.region ? regions.find((g) => g.key === pick.region) : null
  const listIds = (pick?.patient ? [] : region ? region.rows : []).map((r) => String(r.channel_id)).join(',')
  useEffect(() => { if (!listIds) { releaseLive('mcot-side'); return } claimLive('mcot-side', listIds.split(',')); return () => releaseLive('mcot-side') }, [listIds])
  useEffect(() => { const f = (e) => { if (e.key === 'Escape') setPick((cur) => (cur?.patient ? cur.back || null : null)) }; window.addEventListener('keydown', f); return () => window.removeEventListener('keydown', f) }, [])
  useEffect(() => { if (pick?.patient) { const r = all.find((x) => x.channel_id === pick.patient); if (r?.geo) flyTo(r.geo.ll, Math.max(mapRef.current?.getZoom() || 0, 11)) } }, [pick?.patient]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page map-page" style={{ maxWidth: 'none' }}>
      <div className="mm-tools">
        <h3 className="h" style={{ margin: 0 }}>MCOT</h3>
        <span className="mm-summary"><span>환자 <b>{shown.length}</b></span><span>알람 <b className={nAlarm ? 'err' : ''}>{nAlarm}</b></span><span>수신 없음 <b>{nStale}</b></span><span>이동 중 <b>{nMoving}</b></span><span>지역 <b>{regions.length}</b></span>{nNoGeo > 0 && <span className="muted">주소 없음 {nNoGeo}</span>}</span>
        <span className="spacer" />
        <input type="search" placeholder="이름 · 지역 · MRN" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="primary" disabled={!shown.length} title="지금 고른 탭(·검색)의 환자들로 중앙 모니터를 새 탭에 연다"
          onClick={() => { const nm = NATION.find(([k]) => k === nation)?.[1] || '전체'; const label = `MCOT · ${nm}${qn ? ` · "${q.trim()}"` : ''}`; window.open(viewerUrl({ tpl: 'central', ids: shown.map((r) => r.channel_id), label }), `mcot:${nation}:${qn}`) }}>
          중앙 모니터 ({NATION.find(([k]) => k === nation)?.[1] || '전체'} {shown.length}명)</button>
      </div>
      <div className="map-cols">
        <div className="mm-map">
          <div ref={elRef} style={{ height: '100%' }} />
          {offline && <div className="mm-offline">지도 타일(OpenStreetMap)을 불러오지 못했습니다.<br />이 브라우저에서 인터넷이 막혀 있으면 핀만 표시됩니다.</div>}
          <div className="mm-note">핀 위치: {nApprox ? '집주소(시군구) 기준 근사' : '위치 정보'}{nApprox && shown.length - nApprox - nNoGeo > 0 ? ` · 좌표 있는 환자 ${shown.length - nApprox - nNoGeo}` : ''} — 점선 핀은 시도·국가만 아는 경우</div>
        </div>
        {pick?.patient ? (
          <aside className="map-side wide">
            <MapPatientPanel channelId={pick.patient} alarms={alarms} onClose={() => setPick(pick.back || null)} onHistory={() => setHx(pick.patient)}
              onBack={pick.back ? () => setPick(pick.back) : null} backLabel={pick.back?.region ? `${pick.back.region} 목록` : '목록'} />
          </aside>
        ) : region ? (
          <aside className="map-side">
            <div className="mp-top"><button className="ghost mp-back" onClick={() => setPick(null)} title="지역 목록">←</button><b className="mp-name">{region.key}</b><span className="spacer" /><small className="muted">{region.rows.length}명</small></div>
            <div className="mm-summary" style={{ marginTop: 6 }}><span>알람 <b className={region.alarms ? 'err' : ''}>{region.alarms}</b></span><span>수신 없음 <b>{region.stale}</b></span></div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="primary" onClick={() => window.open(viewerUrl({ tpl: 'central', ids: region.rows.map((r) => r.channel_id), label: `MCOT · ${region.key}` }), `mcot:${region.key}`)}>중앙 모니터</button>
              <button onClick={() => region.ll && flyTo(region.ll, 11)}>지도에서 보기</button>
            </div>
            <div className="map-plist">
              {region.rows.map((r) => <WaveCard key={r.channel_id} row={r} density="dense" alarm={aidx.get(r.channel_id)} onClick={() => setPick((cur) => ({ patient: String(r.channel_id), back: cur }))} />)}
            </div>
          </aside>
        ) : (
          <aside className="map-side">
            <div className="seg mm-nation">{NATION.map(([k, l]) => <button key={k} className={nation === k ? 'active' : ''} onClick={() => { if (nation === k) fitAll(); else setNation(k) }} title={nation === k ? '다시 누르면 핀에 맞춤' : undefined}>{l}<small>{nationCounts[k] ?? 0}</small></button>)}</div>
            <h4>지역별 <small>{regions.length}곳 · {shown.length}명</small></h4>
            <p className="muted small" style={{ margin: '0 0 6px' }}>누르면 그 지역 환자 목록 · 지도의 핀을 눌러도 상세</p>
            {regions.map((g) => (
              <div key={g.key} className="mm-region" onClick={() => { setPick({ region: g.key }); if (g.ll) flyTo(g.ll, 10) }}>
                <span className={'vw-dot ' + (g.sev ? `sev${g.sev - 1}` : '')} style={{ background: g.sev ? undefined : 'var(--accent)' }} />
                <span className="nm"><b>{g.key}</b><small>{g.rows.slice(0, 4).map((r) => r.patient?.name || r.channel_id).join(' · ')}{g.rows.length > 4 ? ` 외 ${g.rows.length - 4}` : ''}</small></span>
                {g.alarms > 0 && <span className="tag small err">{g.alarms}</span>}
                {g.stale > 0 && <span className="tag small">끊김 {g.stale}</span>}
                <span className="n mono">{g.rows.length}</span>
              </div>
            ))}
            {!regions.length && <p className="muted small">{rows ? 'MCOT(원외) 환자가 없습니다.' : '불러오는 중…'}</p>}
          </aside>
        )}
      </div>
      {hx && <LiveModal channelId={hx} alarms={alarms} initialHistory onClose={() => setHx(null)} />}
    </div>
  )
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
