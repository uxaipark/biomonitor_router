import React, { useEffect, useRef, useState } from 'react'
import ChannelCard from './ChannelCard.jsx'
import { appendSamples, clearAll, dropChannel } from './waveStore.js'
import { API, WS_URL } from './endpoints.js'
import { decodeStreamBatch } from './wsDecode.js'

const MAX_EVENTS = 3

// 채널 최신 상태는 ref 에 모으고 500ms 마다 React 상태로 флush 한다.
// (채널 수 × 5패킷/초 setState 는 리렌더 폭주를 일으키므로)
export default function App() {
  const [groups, setGroups] = useState([])
  // 기본: 전체 채널 그룹. ?group=그룹ID 로 열면 해당 그룹 자동 구독
  // (어드민 Patch Map 의 디스플레이 링크가 사용)
  const [groupId, setGroupId] = useState(
    () => new URLSearchParams(window.location.search).get('group') || 'all',
  )
  const [channels, setChannels] = useState({})
  const [wsState, setWsState] = useState('connecting')
  const chRef = useRef({})
  const wsRef = useRef(null)
  const groupRef = useRef(groupId)

  // 그룹 목록 로드 (어드민이 바꾸면 주기적으로 반영)
  useEffect(() => {
    const load = () =>
      fetch(`${API}/api/groups`)
        .then((r) => r.json())
        .then(setGroups)
        .catch(() => {})
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  // WS 연결 (재접속 포함)
  useEffect(() => {
    let closed = false
    let ws
    const connect = () => {
      if (closed) return
      ws = new WebSocket(WS_URL)
      ws.binaryType = 'arraybuffer' // stream_batch 는 바이너리 프레임
      wsRef.current = ws
      ws.onopen = () => {
        setWsState('connected')
        ws.send(JSON.stringify({ type: 'subscribe', group_id: groupRef.current }))
      }
      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          for (const item of decodeStreamBatch(e.data)) handleMsg(item)
        } else {
          handleMsg(JSON.parse(e.data))
        }
      }
      ws.onclose = () => {
        setWsState('reconnecting')
        setTimeout(connect, 1500)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => {
      closed = true
      ws && ws.close()
    }
  }, [])

  // 그룹 전환: 이전 그룹 unsubscribe → 화면 비움 → 새 그룹 subscribe
  const switchGroup = (next) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', group_id: groupRef.current }))
      ws.send(JSON.stringify({ type: 'subscribe', group_id: next }))
    }
    groupRef.current = next
    chRef.current = {}
    clearAll()
    setChannels({})
    setGroupId(next)
  }

  const ensure = (id) => {
    if (!chRef.current[id]) {
      chRef.current[id] = {
        channelId: id, patient: null, hr: null, quality: 'good',
        moving: false, status: 'connected', events: [], flashUntil: 0,
      }
    }
    return chRef.current[id]
  }

  const pushEvents = (ch, events) => {
    const time = new Date().toLocaleTimeString('ko-KR', { hour12: false })
    for (const e of events) {
      ch.events = [{ ...e, time }, ...ch.events].slice(0, MAX_EVENTS)
      if (e.kind === 'arrhythmia') ch.flashUntil = Date.now() + 4000
      if (e.kind === 'disconnected' || e.kind === 'ingest_disconnected') ch.status = 'disconnected'
      if (e.kind === 'reconnected') ch.status = 'connected'
    }
  }

  const handleMsg = (msg) => {
    // 스트림 배치: 라우터가 100ms 창의 stream 들을 한 프레임으로 묶어 보낸다
    if (msg.type === 'stream_batch') {
      for (const item of msg.items || []) handleMsg(item)
      return
    }
    // 현재 구독 그룹과 무관한 메시지 방어 (그룹 전환 직후 잔여분)
    if (msg.group_ids && !msg.group_ids.includes(groupRef.current)) return

    if (msg.type === 'stream') {
      const ch = ensure(msg.channel_id)
      ch.patient = msg.patient || ch.patient
      ch.hr = msg.hr
      ch.quality = msg.quality
      ch.moving = msg.moving
      ch.status = 'connected'
      if (msg.events && msg.events.length) pushEvents(ch, msg.events)
      appendSamples(msg.channel_id, msg.samples, msg.sample_rate, msg.ts_ms)
    } else if (msg.type === 'membership') {
      if (msg.event === 'leave') {
        delete chRef.current[msg.channel_id]
        dropChannel(msg.channel_id)
      } else {
        // join | snapshot — 카드 즉시 생성 (매끄러운 편입)
        const ch = ensure(msg.channel_id)
        if (msg.patient) ch.patient = msg.patient
        ch.status = msg.connected === false ? 'disconnected' : ch.status
      }
    } else if (msg.type === 'channel_event') {
      const ch = ensure(msg.channel_id)
      pushEvents(ch, msg.events || [])
    }
  }

  // 500ms 주기로 ref → state 반영.
  // 표시값(정수 HR/상태/뱃지/환자정보)이 바뀐 채널만 새 객체 identity 를 부여한다
  // → React.memo(ChannelCard) 가 나머지 카드의 재렌더를 건너뛴다.
  // (200채널에서 매 틱 전 카드 재렌더 → 주기적 덜덜거림의 원인이었음)
  const sigRef = useRef({})
  const idsRef = useRef('')
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      let changed = false
      for (const [id, ch] of Object.entries(chRef.current)) {
        const p = ch.patient
        const psig = p
          ? `${p.name},${p.building},${p.floor},${p.ward},${p.zone},${p.room},${p.doctor},${p.department},${p.nurse}`
          : ''
        const e0 = ch.events[0]
        const sig =
          `${ch.hr != null ? Math.round(ch.hr) : ''}|${ch.quality}|${ch.moving}|` +
          `${ch.status}|${ch.flashUntil > now}|${psig}|${e0 ? e0.time + e0.kind : ''}`
        if (sigRef.current[id] !== sig) {
          sigRef.current[id] = sig
          chRef.current[id] = { ...ch } // 새 identity → 이 카드만 재렌더
          changed = true
        }
      }
      const ids = Object.keys(chRef.current).sort().join(',')
      if (ids !== idsRef.current) {
        idsRef.current = ids
        changed = true
        for (const k of Object.keys(sigRef.current)) {
          if (!chRef.current[k]) delete sigRef.current[k]
        }
      }
      if (changed) setChannels({ ...chRef.current })
    }, 500)
    return () => clearInterval(t)
  }, [])

  const list = Object.values(channels).sort((a, b) =>
    a.channelId.localeCompare(b.channelId),
  )

  // 표시 채널 수에 따른 자동 밀도: 많을수록 카드를 줄여 화면에 더 담는다
  const density = list.length > 40 ? 'dense' : list.length > 12 ? 'compact' : 'normal'
  const densityLabel = { normal: '상세', compact: '컴팩트', dense: '고밀도' }[density]

  return (
    <div className="app">
      <header>
        <h1>ECG 실시간 모니터링</h1>
        <select value={groupId} onChange={(e) => switchGroup(e.target.value)}>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} ({g.member_count})
            </option>
          ))}
          {!groups.some((g) => g.id === groupId) && (
            <option value={groupId}>{groupId}</option>
          )}
        </select>
        <span className={'ws-state ' + wsState}>{wsState}</span>
        <span className="count">{list.length} 채널 · {densityLabel} 모드</span>
      </header>
      <div className={'grid ' + density}>
        {list.map((ch) => (
          <ChannelCard key={ch.channelId} ch={ch} density={density} />
        ))}
        {list.length === 0 && (
          <div className="empty">이 그룹에 채널이 없습니다. 에뮬레이터/라우터 상태를 확인하세요.</div>
        )}
      </div>
    </div>
  )
}
