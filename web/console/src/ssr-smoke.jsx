// Server-side smoke test: renders every page (and the modal) with react-dom/server under shimmed browser
// globals. Effects do not run, so this catches import cycles, TDZ/reference errors and bad JSX in the render
// path — not data-shape bugs. Run: `npm run smoke`.
import React from 'react'
import { renderToString } from 'react-dom/server'

const stub = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = globalThis
globalThis.location = { hash: '#/', host: 'localhost:7300', hostname: 'localhost', protocol: 'http:', pathname: '/' }
globalThis.localStorage = stub
globalThis.matchMedia = () => ({ matches: false })
globalThis.document = { documentElement: { dataset: {} }, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} }
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}
globalThis.dispatchEvent = () => true
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail } }
globalThis.WebSocket = class { constructor() { throw new Error('no ws in ssr') } }
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.IntersectionObserver = class { observe() {} disconnect() {} }
globalThis.fetch = async () => ({ ok: false, status: 0, json: async () => null, text: async () => '' })

async function main() {
const mods = await Promise.all([
  import('./App.jsx'), import('./pages/Dashboard.jsx'), import('./pages/Patients.jsx'), import('./pages/Live.jsx'),
  import('./pages/MapPage.jsx'), import('./pages/Gateways.jsx'), import('./pages/Alarms.jsx'), import('./pages/Events.jsx'),
  import('./pages/LiveModal.jsx'), import('./WaveCard.jsx'), import('./pages/Viewer.jsx'), import('./pages/Viewers.jsx'), import('./viewer/CentralStation.jsx'), import('./viewer/BedViewer.jsx'),
  import('./pages/MultiViewerTest.jsx'),
])
const [App, Dashboard, Patients, Live, MapPage, Gateways, Alarms, Events, LiveModal, WaveCard, Viewer, Viewers, Central, Bed, MultiViewerTest] = mods
const alarms = { alarms: [{ id: 1, kind: 'hr_high', severity: 'high', channel_id: '65538', gateway_id: '895', patient_id: 39905, patient_name: '조상호', room: '209A01', value: '159 bpm', message: '빈맥 159 bpm', since_ms: Date.now() - 5000, last_ms: Date.now(), acked: false }], summary: { active: 1, unacked: 1, high: 1 } }
const row = { channel_id: '65538', connected: true, stale: false, quality: 'good', moving: false, gateway_id: '895', space: '209A01', last_seq: 10, last_ts_ms: Date.now(), patient: { id: '39905', name: '조상호', building: '본관', floor: '9', ward: 'W209A', zone: 'GW-209-0894', room: '209A01', doctor: 'D0001', nurse: 'N0001' }, groups: ['all'], patient_id: 39905, mrn: 'MRN-11200001', profile_id: 2, sample_rate: 250, flags: 0x10, battery: 87, rssi: -50, channels: ['ecg', 'hr', 'resp', 'spo2', 'accel', 'pace'], vitals: { hr: 72, spo2: 97, resp: 16, temp: 36.6 }, vitals_ts_ms: Date.now(), pseq_reorder: 0 }
let failed = 0
const check = (name, el) => {
  try {
    const html = renderToString(el)
    console.log(`ok   ${name} (${html.length} chars)`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}: ${e.stack?.split('\n').slice(0, 4).join(' | ')}`)
  }
}
check('App', <App.default />)
check('Dashboard', <Dashboard.default alarms={alarms} />)
check('Patients', <Patients.default alarms={alarms} />)
check('Live', <Live.default alarms={alarms} />)
check('MapPage', <MapPage.default alarms={alarms} hash="#/map" />)
check('Gateways', <Gateways.default alarms={alarms} />)
check('Alarms', <Alarms.default alarms={alarms} />)
check('Events', <Events.default />)
check('LiveModal', <LiveModal.LiveModal channelId="65538" alarms={alarms} onClose={() => {}} />)
check('WaveCard', <WaveCard.WaveCard row={row} density="normal" alarm={alarms.alarms[0]} waves={row.channels} />)
check('WaveCard dense', <WaveCard.WaveCard row={row} density="dense" alarm={alarms.alarms[0]} />)
check('WaveCard dense (empty)', <WaveCard.WaveCard row={{ ...row, vitals: {}, patient: null }} density="dense" />)
globalThis.ResizeObserver = class { observe() {} disconnect() {} }
check('Viewers', <Viewers.default />)
check('MultiViewerTest', <MultiViewerTest.default />)
check('Viewer route', <Viewer.default alarms={alarms} hash="#/viewer?tpl=central&gw=895" />)
check('CentralStation', <Central.default rows={[row, { ...row, channel_id: '65539', flags: 0x01 }]} alarms={alarms} unit="TEST" onClose={() => {}} />)
check('CentralStation numeric', <Central.default rows={Array.from({ length: 60 }, (_, i) => ({ ...row, channel_id: String(70000 + i) }))} alarms={alarms} unit="TEST" />)
check('BedViewer', <Bed.default row={row} alarms={alarms} unit="TEST" onBack={() => {}} />)
console.log(failed ? `${failed} FAILED` : 'all pages render')
process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.log('FAIL smoke runner:', e.stack); process.exit(1) })
