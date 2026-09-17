import React, { useEffect, useRef, useState } from 'react'
import ReportModal from './ReportModal.jsx'
import { WS_URL } from './endpoints.js'
import { decodeStreamBatch } from './wsDecode.js'
import { appendSamples, getStream, playoutNow } from './waveStore.js'
import { registerDraw } from './renderLoop.js'

const WINDOW_S = 4 // 캔버스 가로폭이 나타내는 시간

// 채널 하나의 미니 스윕 파형 — 뷰어와 동일한 타임스탬프 기반 렌더링.
// 샘플은 waveStore(공유 플레이아웃 클록)에 쌓이고, x 좌표는 샘플 시각 t 로
// 고정된다 → 모달 안 모든 파형의 스캔 시점이 동일하고(동기), 도착 지터가
// 재생 속도에 누적되지 않는다(딜레이 증가 없음). 매 프레임 전체 재드로잉이라
// 증분 지우기 아티팩트도 없다.
export function MiniWave({ channelId, store, width = 400, height = 56 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    const W = width
    const H = height
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const windowMs = WINDOW_S * 1000
    const GAP_PX = 12
    const gapMs = (GAP_PX / W) * windowMs
    const xOf = (t) => ((((t % windowMs) + windowMs) % windowMs) / windowMs) * W

    // 진폭 스케일: 잠금 + 지속조건 전환 (뷰어와 동일 — 숨쉬기/떨림 방지)
    let envMin = -0.4
    let envMax = 1.2
    let tgtMin = null, tgtMax = null
    let clipFrames = 0, smallFrames = 0
    let envTick = 0
    const yOf = (v) => {
      const span = Math.max(envMax - envMin, 0.2)
      return H * (0.9 - 0.8 * ((v - envMin) / span))
    }

    let staleShown = false

    const draw = (now) => {
      const meta = store.current[channelId]
      // 3초 이상 수신이 없으면 사유 오버레이 표시 (게이트웨이 장애/연결 해제 등)
      const stale = !meta || !meta.lastRx || Date.now() - meta.lastRx > 3000
      if (stale) {
        if (!staleShown) {
          staleShown = true
          ctx.fillStyle = 'rgba(11, 17, 32, 0.6)'
          ctx.fillRect(0, 0, W, H)
          ctx.fillStyle = '#94a3b8'
          ctx.font = '12px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('수신 없음 — 게이트웨이 장애 / 연결 해제 / 이동 중 끊김', W / 2, H / 2 + 4)
          ctx.textAlign = 'start'
        }
        return
      }
      staleShown = false

      const T = playoutNow(now) // 전 파형 공유 플레이아웃 시각 → 스캔 동기
      const st = getStream(channelId)
      if (T == null || !st || st.len === 0) return
      const step = 1000 / st.sampleRate
      const tOld = T - windowMs + gapMs

      ctx.fillStyle = '#0b1220'
      ctx.fillRect(0, 0, W, H)

      let hi = st.len - 1
      while (hi >= 0 && st.tAt(hi) > T) hi--
      if (hi < 0) return
      let lo = hi
      while (lo > 0 && st.tAt(lo - 1) >= tOld) lo--

      // 진폭 스케일 검사 (0.25초 주기 + 전환 중 매 프레임)
      if (++envTick >= 15 || tgtMin != null) {
        envTick = 0
        let vmin = Infinity, vmax = -Infinity
        for (let i = lo; i <= hi; i++) { const v = st.vAt(i); if (v < vmin) vmin = v; if (v > vmax) vmax = v }
        if (vmin < vmax) {
          const span = Math.max(envMax - envMin, 0.2)
          clipFrames = (vmax > envMax || vmin < envMin) ? clipFrames + 1 : 0
          smallFrames = (vmax - vmin) < span * 0.45 ? smallFrames + 1 : 0
          if (tgtMin == null && (clipFrames > 2 || smallFrames > 12)) {
            const m = (vmax - vmin) * 0.15 + 0.05
            tgtMin = vmin - m
            tgtMax = vmax + m
          }
          if (tgtMin != null) {
            envMin += (tgtMin - envMin) * 0.03
            envMax += (tgtMax - envMax) * 0.03
            const tspan = Math.max(tgtMax - tgtMin, 0.2)
            if (Math.abs(envMin - tgtMin) < tspan * 0.02 && Math.abs(envMax - tgtMax) < tspan * 0.02) {
              tgtMin = null; tgtMax = null
              clipFrames = 0; smallFrames = 0
            }
          }
        }
      }

      // 폴리라인 — 고정 위치 xOf(t), 위상 고정 데시메이션, 공백/wrap 펜업
      const stride = Math.max(1, Math.ceil((hi - lo + 1) / (W * 2)))
      let i0 = lo
      if (stride > 1) {
        const rem = Math.round(st.tAt(lo) / step) % stride
        if (rem) i0 = lo + (stride - rem)
        if (i0 > hi) i0 = lo
      }
      ctx.strokeStyle = '#3ddc84'
      ctx.lineWidth = 1.2
      ctx.lineJoin = 'round'
      ctx.beginPath()
      let started = false, pT = 0, pX = -1
      for (let i = i0; i <= hi; i += stride) {
        const t = st.tAt(i)
        const x = xOf(t)
        const y = yOf(st.vAt(i))
        const gap = t - pT > step * stride * 1.5
        if (!started || gap || x < pX) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
        started = true
        pT = t
        pX = x
      }
      ctx.stroke()
    }
    const unregister = registerDraw(draw)
    return () => unregister()
  }, [channelId, store, width, height])

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="mini-wave"
      style={{ height: `${height}px` }}
    />
  )
}

// 게이트웨이 파형 스트림 구독 훅 (모달 공용)
function useGatewayStream(gw, onlyChannel) {
  const store = useRef({}) // channel_id -> { q: [], sr, hr, name, space }
  const [meta, setMeta] = useState({})
  const [wsState, setWsState] = useState('connecting')

  useEffect(() => {
    if (!gw) return undefined
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      setWsState('connected')
      ws.send(JSON.stringify({ type: 'subscribe_gateway', gateway_id: gw }))
    }
    ws.onclose = () => setWsState('closed')
    ws.onerror = () => setWsState('error')
    const handle = (m) => {
      if (m.type !== 'stream' || m.gateway_id !== gw) return
      if (onlyChannel && m.channel_id !== onlyChannel) return
      let st = store.current[m.channel_id]
      if (!st) st = store.current[m.channel_id] = { hr: null, name: '', space: '' }
      st.lastRx = Date.now()
      st.hr = m.hr
      st.name = m.patient?.name || st.name  // patient 는 5초당 1회만 옴 — last-known 유지
      st.space = m.space
      // 샘플은 타임스탬프와 함께 waveStore 로 — MiniWave 가 공유 클록으로 렌더링
      appendSamples(m.channel_id, m.samples, m.sample_rate, m.ts_ms)
    }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        for (const item of decodeStreamBatch(e.data)) handle(item)
        return
      }
      const m = JSON.parse(e.data)
      if (m.type === 'stream_batch') for (const item of m.items || []) handle(item)
      else handle(m)
    }
    const t = setInterval(() => {
      const next = {}
      for (const [id, st] of Object.entries(store.current)) {
        next[id] = { hr: st.hr, name: st.name, space: st.space }
      }
      setMeta(next)
    }, 500)
    return () => {
      clearInterval(t)
      try {
        ws.send(JSON.stringify({ type: 'unsubscribe_gateway', gateway_id: gw }))
      } catch { /* 이미 닫힘 */ }
      ws.close()
      store.current = {}
    }
  }, [gw, onlyChannel])

  return { store, meta, wsState }
}

// 채널 목록 구독 훅 (주치의/간호사 등 코호트 파형)
function useChannelsStream(channelIds) {
  const store = useRef({})
  const [meta, setMeta] = useState({})
  const [wsState, setWsState] = useState('connecting')
  const idsKey = channelIds.join(',')

  useEffect(() => {
    const ids = new Set(channelIds)
    if (ids.size === 0) return undefined
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      setWsState('connected')
      ws.send(JSON.stringify({ type: 'subscribe_channels', channel_ids: [...ids] }))
    }
    ws.onclose = () => setWsState('closed')
    ws.onerror = () => setWsState('error')
    const handle = (m) => {
      if (m.type !== 'stream' || !ids.has(m.channel_id)) return
      let st = store.current[m.channel_id]
      if (!st) st = store.current[m.channel_id] = { hr: null, name: '', space: '' }
      st.lastRx = Date.now()
      st.hr = m.hr
      st.name = m.patient?.name || st.name  // patient 는 5초당 1회만 옴 — last-known 유지
      st.space = m.space
      // 샘플은 타임스탬프와 함께 waveStore 로 — MiniWave 가 공유 클록으로 렌더링
      appendSamples(m.channel_id, m.samples, m.sample_rate, m.ts_ms)
    }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        for (const item of decodeStreamBatch(e.data)) handle(item)
        return
      }
      const m = JSON.parse(e.data)
      if (m.type === 'stream_batch') for (const item of m.items || []) handle(item)
      else handle(m)
    }
    const t = setInterval(() => {
      const next = {}
      for (const [id, st] of Object.entries(store.current)) {
        next[id] = { hr: st.hr, name: st.name, space: st.space }
      }
      setMeta(next)
    }, 500)
    return () => {
      clearInterval(t)
      try {
        ws.send(JSON.stringify({ type: 'unsubscribe_channels' }))
      } catch { /* 이미 닫힘 */ }
      ws.close()
      store.current = {}
    }
  }, [idsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return { store, meta, wsState }
}

// 파형 행 (목록형 모달 공용): 메타 3줄 | 파형 | 심박.
// 파형을 클릭하면 환자 리포트(얼굴/병변/치료 이력/저장 파형 뷰어)가 열린다.
function WaveRow({ id, m, known, store, onReport }) {
  const name = m.name || known?.patient?.name || '—'
  const pid = known?.patient?.id || ''
  return (
    <div className="gw-wave-row">
      <div className="gw-wave-info">
        <b>{name}</b>
        <small>{pid}{pid ? '·' : ''}{id}</small>
        <span className="gw-space">{m.space || known?.space || '—'}</span>
      </div>
      <div
        className="wave-click"
        title="클릭: 환자 리포트 (저장 파형 · 치료 이력)"
        onClick={() => onReport && onReport(id)}
      >
        <MiniWave channelId={id} store={store} />
      </div>
      <div className="gw-hr-col">
        <span className="gw-hr">{m.hr != null ? Math.round(m.hr) : '--'}</span>
        <small>bpm</small>
      </div>
    </div>
  )
}

// 코호트 파형 모달: 주치의/간호사 등 특정 담당자의 환자 전체 파형
export function CohortWaveModal({ title, channelIds, channels, onClose }) {
  const { store, meta, wsState } = useChannelsStream(channelIds)
  const [report, setReport] = useState(null)
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal gw-wave-modal">
        <div className="modal-head">
          <h3>담당 환자 실시간 파형</h3>
          <span className="modal-sub">
            {title} · {channelIds.length}명
            <span className={'pill ' + (wsState === 'connected' ? 'ok' : 'warn')} style={{ marginLeft: 8 }}>
              {wsState}
            </span>
          </span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="gw-wave-list">
          {channelIds.map((id) => (
            <WaveRow
              key={id}
              id={id}
              m={meta[id] || {}}
              known={channels.find((c) => c.channel_id === id)}
              store={store}
              onReport={setReport}
            />
          ))}
          {channelIds.length === 0 && <div className="sr-empty">담당 환자가 없습니다.</div>}
        </div>
        {report && <ReportModal channelId={report} onClose={() => setReport(null)} />}
      </div>
    </div>
  )
}

// 게이트웨이 파형 모달: 해당 게이트웨이로 전송 중인 환자들의 실시간 파형
export default function GatewayWaveModal({ gw, label, channels, onClose }) {
  const { store, meta, wsState } = useGatewayStream(gw)
  const members = channels.filter((c) => c.gateway_id === gw)
  const liveIds = [...new Set([...members.map((c) => c.channel_id), ...Object.keys(meta)])].sort()
  const [report, setReport] = useState(null)

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal gw-wave-modal">
        <div className="modal-head">
          <h3>게이트웨이 실시간 파형</h3>
          <span className="modal-sub">
            {label} · <code>{gw}</code> · {liveIds.length}개 패치
            <span className={'pill ' + (wsState === 'connected' ? 'ok' : 'warn')} style={{ marginLeft: 8 }}>
              {wsState}
            </span>
          </span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="gw-wave-list">
          {liveIds.map((id) => (
            <WaveRow
              key={id}
              id={id}
              m={meta[id] || {}}
              known={members.find((c) => c.channel_id === id)}
              store={store}
              onReport={setReport}
            />
          ))}
          {liveIds.length === 0 && (
            <div className="sr-empty">
              이 게이트웨이로 전송 중인 패치가 없습니다 (장애 중이거나 빈 공간).
            </div>
          )}
        </div>
        {report && <ReportModal channelId={report} onClose={() => setReport(null)} />}
      </div>
    </div>
  )
}

// 환자 단일 파형 모달: 맵의 환자 칩 클릭 시.
// 환자가 이동해 게이트웨이가 바뀌면 자동으로 재구독한다.
export function PatientWaveModal({ ch, channels, onClose }) {
  const live = channels.find((c) => c.channel_id === ch.channel_id) || ch
  const gw = live.gateway_id
  const { store, meta, wsState } = useGatewayStream(gw, ch.channel_id)
  const m = meta[ch.channel_id] || {}
  const p = live.patient || {}
  const [report, setReport] = useState(null)

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal gw-wave-modal">
        <div className="modal-head">
          <h3>환자 실시간 파형</h3>
          <span className="modal-sub">
            <b>{p.name}</b> ({p.id}·{ch.channel_id}) · {m.space || live.space}
            · <code>{gw}</code>
            <span className={'pill ' + (wsState === 'connected' ? 'ok' : 'warn')} style={{ marginLeft: 8 }}>
              {wsState}
            </span>
          </span>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>
        {/* 모든 줄 상시 렌더링 → 모달/카드 크기 고정. 심박은 파형 바로 옆 */}
        <div className="gw-wave-row single">
          <div className="gw-wave-info">
            <b>{p.name || '—'}</b>
            <small>{p.building || '—'}동 {p.floor || '—'}층 {p.room || '—'}호</small>
            <small>{p.doctor || '—'} · {p.department || '—'}</small>
            <span className="gw-space">{m.space || live.space || '—'}</span>
          </div>
          <div
            className="wave-click"
            title="클릭: 환자 리포트 (저장 파형 · 치료 이력)"
            onClick={() => setReport(ch.channel_id)}
          >
            <MiniWave channelId={ch.channel_id} store={store} width={500} height={140} />
          </div>
          <div className="gw-hr-col">
            <span className="gw-hr big">{m.hr != null ? Math.round(m.hr) : '--'}</span>
            <small>bpm</small>
          </div>
        </div>
        {report && <ReportModal channelId={report} onClose={() => setReport(null)} />}
      </div>
    </div>
  )
}
