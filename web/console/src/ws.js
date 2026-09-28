// Router output WebSocket: one shared connection for the whole console.
//  * stream_batch v2 binary frames → waveform rings (waveStore) + latest vitals/flags per patch
//  * alarm / membership / channel_event text messages → listeners
// Subscriptions are reference-counted so several views can share the socket.
import { WS_URL } from './api.js'
import { appendSamples } from './waveStore.js'

const td = new TextDecoder()
let ws = null
let retry = 0
let wantChannels = new Set() // patch ids the live views want
let wantGroups = new Set()   // pseudo groups: alarms, or real groups
const listeners = { alarm: new Set(), stream: new Set(), status: new Set(), membership: new Set() }
export const latest = new Map() // patch id → last stream item (vitals, flags, hr, seq, ts …)
// cumulative WS ingress counters (stream_batch frames) — pages diff them to show packets/s, KB/s, items/s
export const wsCounters = { frames: 0, bytes: 0, items: 0, decodeMs: 0 }
let status = 'closed'

export function onWs(kind, fn) {
  listeners[kind].add(fn)
  return () => listeners[kind].delete(fn)
}
const emit = (kind, v) => { for (const fn of listeners[kind]) fn(v) }
export const wsStatus = () => status
const setStatus = (s) => { status = s; emit('status', s) }

// 전송 지연(travel time): 시계가 모두 NTP 로 맞춰져 있다는 전제로 보정 없이 차이만 본다 (사용자 결정)
//  e2r = 라우터 송신(sent_ms) − 프레임 ts_ms (에뮬레이터→라우터), r2v = 브라우저 수신 − sent_ms (라우터→뷰어), e2e = 수신 − ts_ms
const LAT_KEEP = 40
const lat = { e2e: [], e2r: [], r2v: [], at: 0 }
const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
// 이 브라우저의 시계 보정값: 라우터 보정을 더하고도 음수가 나오면(브라우저 시계가 뒤짐) 그 최대 절대값을 기억해 더한다.
// 종단 간(e2e)과 라우터→뷰어(r2v)에 각각 하나씩. localStorage 에 두고, 라우터의 리셋 시각(lat_epoch)이 바뀌면 함께 버린다.
const LS = 'lat.browser'
let mine = { e2e: 0, r2v: 0, epoch: 0 }
try { mine = { ...mine, ...(JSON.parse(localStorage.getItem(LS) || '{}')) } } catch { /* ignore */ }
const saveMine = () => { try { localStorage.setItem(LS, JSON.stringify(mine)) } catch { /* ignore */ } }
function noteLatency(recv, sentMs, items, offsetMs = 0, epoch = 0) {
  const ts = med(items.map((it) => it.ts_ms).filter((t) => t > 0))
  if (ts == null) return
  if (epoch !== mine.epoch) { mine = { e2e: 0, r2v: 0, epoch }; saveMine() } // 라우터에서 '지연시간 계산 리셋' / 가동 초기화
  const push = (k, v) => { lat[k].push(v); if (lat[k].length > LAT_KEEP) lat[k].shift() }
  // offsetMs = 라우터가 관측한 에뮬레이터 시계 앞섬(음수 나이의 최대 절대값) — 에뮬레이터 시각이 들어가는 구간에 더한다
  let e2e = recv - ts + offsetMs
  if (e2e < 0 && -e2e > mine.e2e) { mine.e2e = -e2e; saveMine() }
  push('e2e', e2e + mine.e2e)
  if (sentMs > 0) {
    push('e2r', sentMs - ts + offsetMs)
    let r2v = recv - sentMs
    if (r2v < 0 && -r2v > mine.r2v) { mine.r2v = -r2v; saveMine() }
    push('r2v', r2v + mine.r2v)
  }
  lat.at = recv; lat.offset = offsetMs
}
// 5초마다 라우터에 이 탭의 지연을 보고 (운영 통계 '브라우저 최대' 선). 탭마다 WS 가 하나라 탭 단위로 집계된다.
setInterval(() => {
  const l = latencyNow()
  if (l && ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ type: 'latency', e2e: l.e2e ?? -1, r2v: l.r2v ?? -1 })) } catch { /* ignore */ } }
}, 5000)
/** 이 브라우저의 보정값 (표시용) */
export const browserLatencyOffset = () => ({ ...mine })
/** 최근 40개 배치의 중앙값 (ms). 스트림이 2초 넘게 없으면 null */
export function latencyNow() {
  if (!lat.at || Date.now() - lat.at > 2000) return null
  return { e2e: med(lat.e2e), e2r: med(lat.e2r), r2v: med(lat.r2v), n: lat.e2e.length, at: lat.at, offset: lat.offset || 0, mine: { ...mine } }
}

function decodeBatch(buf) {
  const dv = new DataView(buf)
  const marker = dv.getUint8(0)
  const hlen = dv.getUint32(1, true)
  const header = JSON.parse(td.decode(new Uint8Array(buf, 5, hlen)))
  const items = header.items || []
  items.sentMs = header.sent_ms || 0
  items.offsetMs = header.offset_ms || 0
  items.latEpoch = header.lat_epoch || 0
  const counts = header.counts || []
  let off = 5 + hlen
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const n = counts[i] || 0
    if (marker === 0xb2 && it.waves && it.waves.length) {
      let o = off
      it.blocks = []
      for (const w of it.waves) {
        const total = w.n * w.axes
        const data = new Float32Array(total)
        for (let k = 0; k < total; k++) data[k] = dv.getInt16(o + k * 2, true) * w.scale
        o += total * 2
        it.blocks.push({ ...w, data })
      }
    } else if (n) {
      // v1: a single ECG block, ×1000
      const data = new Float32Array(n)
      for (let k = 0; k < n; k++) data[k] = dv.getInt16(off + k * 2, true) / 1000
      it.blocks = [{ key: 'ecg', fs: it.sample_rate, axes: 1, n, data }]
    }
    off += n * 2
  }
  return items
}

function handleItems(items) {
  for (const it of items) {
    const id = it.channel_id
    for (const b of it.blocks || []) {
      if (b.axes === 1) appendSamples(`${id}:${b.key}`, b.data, b.fs, it.ts_ms)
      else {
        // multi-axis (accel xyz): one ring per axis
        for (let a = 0; a < b.axes; a++) {
          const one = new Float32Array(b.n)
          for (let k = 0; k < b.n; k++) one[k] = b.data[k * b.axes + a]
          appendSamples(`${id}:${b.key}${a}`, one, b.fs, it.ts_ms)
        }
      }
    }
    const prev = latest.get(id) || {}
    const vitals = { ...(prev.vitals || {}), ...(it.vitals || {}) }
    // pace marks arrive as their own record (no ECG block); keep the last set with the seq/ts they belong to,
    // so a viewer draws each spike once instead of re-drawing it under every later packet's timestamp
    const hasPace = Array.isArray(it.pace) && it.pace.length > 0
    latest.set(id, { ...prev, ...it, vitals, patient: it.patient || prev.patient, rx: Date.now(), pace: hasPace ? it.pace : prev.pace, paceSeq: hasPace ? it.seq : prev.paceSeq, paceTs: hasPace ? it.ts_ms : prev.paceTs })
  }
  emit('stream', items)
}

// The router only accepts the stream for accounts with 생체신호 + 개인정보 rights; others never connect.
let allowed = false
export function setWsAllowed(on) {
  allowed = on
  if (!on && ws) { try { ws.close() } catch { /* ignore */ } ws = null; setStatus('off') }
  else if (on) open()
}

function open() {
  if (!allowed) return
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return
  setStatus('connecting')
  try { ws = new WebSocket(WS_URL) } catch { scheduleRetry(); return }
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    retry = 0
    setStatus('open')
    for (const g of wantGroups) ws.send(JSON.stringify({ type: 'subscribe', group_id: g }))
    if (wantChannels.size) ws.send(JSON.stringify({ type: 'subscribe_channels', channel_ids: [...wantChannels] }))
  }
  ws.onmessage = (ev) => {
    if (ev.data instanceof ArrayBuffer) {
      const t0 = performance.now()
      const items = decodeBatch(ev.data)
      noteLatency(Date.now(), items.sentMs, items, items.offsetMs, items.latEpoch)
      handleItems(items)
      wsCounters.frames++; wsCounters.bytes += ev.data.byteLength; wsCounters.items += items.length; wsCounters.decodeMs += performance.now() - t0
      return
    }
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'alarm') emit('alarm', m)
    else if (m.type === 'membership') emit('membership', m)
    else if (m.type === 'channel_event') {
      const prev = latest.get(m.channel_id)
      if (prev) latest.set(m.channel_id, { ...prev, events: m.events, disconnected: m.events.some((e) => e.kind === 'ingest_disconnected') })
    }
  }
  ws.onclose = () => { setStatus('closed'); scheduleRetry() }
  ws.onerror = () => { try { ws.close() } catch { /* ignore */ } }
}

function scheduleRetry() {
  if (!allowed) return
  const wait = Math.min(1000 * 2 ** retry, 15000)
  retry++
  setTimeout(open, wait)
}

function sendChannels() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe_channels', channel_ids: [...wantChannels] }))
}

// The server keeps one channel list per socket, so every live view claims its ids under a key and the
// union is what gets subscribed (a modal on top of the live grid must not cancel the grid).
const claims = new Map()
function pushClaims() {
  const all = new Set()
  for (const ids of claims.values()) for (const id of ids) all.add(String(id))
  wantChannels = all
  open()
  sendChannels()
}
export function claimLive(key, ids) { claims.set(key, ids); pushClaims() }
export function releaseLive(key) { if (claims.delete(key)) pushClaims() }

export function subscribeGroup(g) {
  wantGroups.add(g)
  open()
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', group_id: g }))
  return () => {
    wantGroups.delete(g)
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'unsubscribe', group_id: g }))
  }
}

export function ensureOpen() { open() }
