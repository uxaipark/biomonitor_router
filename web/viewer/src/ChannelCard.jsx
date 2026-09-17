import React, { useEffect, useRef } from 'react'
import { getStream, playoutNow } from './waveStore.js'
import { registerDraw } from './renderLoop.js'

const WINDOW_S = 6      // 화면 가로폭이 나타내는 시간
const GAP_PX = 16       // 스윕 커서 앞의 지움(블랭크) 폭
const GRID_PX = 40

// 밀도별 파형 캔버스 높이
const WAVE_H = { normal: 110, compact: 68, dense: 46 }

// 개별 채널 카드. density 에 따라 3단계 레이아웃:
//  - normal : 전체 정보 (배지 + 이벤트 리스트 + 큰 파형)
//  - compact: 메타데이터 한 줄 압축 + 중간 파형, 이벤트 리스트 생략
//  - dense  : 메타데이터 한 줄 압축(축소) + 작은 파형 — 화면에 최대한 많이
// 메타데이터(환자/위치/의료진)는 어떤 밀도에서도 생략하지 않는다.
// React.memo: App 이 표시값 변경 시에만 ch 의 identity 를 바꾸므로
// 값이 그대로인 카드는 재렌더를 건너뛴다 (다채널 재렌더 폭풍 방지).
function ChannelCard({ ch, density = 'normal' }) {
  const canvasRef = useRef(null)
  const statusRef = useRef(ch.status)
  statusRef.current = ch.status
  const H = WAVE_H[density] || WAVE_H.normal

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    // 레티나 고해상도: 백킹 스토어만 DPR 배로 키우고 좌표는 논리 W×H 유지 → 선 선명.
    // 표시 크기(width:100%, height)는 CSS 가 제어하므로 style 은 건드리지 않는다
    // (건드리면 반응형 폭이 깨져 카드 밖으로 튀어나온다).
    const W = 460
    // dense(고밀도)는 카드가 작아 DPR 1.5 로도 충분 — 래스터 픽셀 44% 절감
    const dpr = Math.min(window.devicePixelRatio || 1, density === 'dense' ? 1.5 : 2)
    canvas.width = W * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // 파형 창 높이는 고정, 신호는 진폭 범위(envelope)에 맞춰 자동 스케일.
    // 스케일은 기본적으로 **잠금(고정)** 상태 — 조건이 "지속"될 때만 목표를 정해
    // 한 번 천천히 전환하고 다시 잠근다 (매 프레임 추종 금지 → 숨쉬기/떨림 없음).
    let envMin = -0.4
    let envMax = 1.2
    let tgtMin = null, tgtMax = null // 전환 목표 (null = 잠금 상태)
    let clipFrames = 0, smallFrames = 0
    const yOf = (v) => {
      const span = Math.max(envMax - envMin, 0.2)
      return H * (0.9 - 0.8 * ((v - envMin) / span))
    }

    const windowMs = WINDOW_S * 1000
    // 스윕 배치: 샘플 시각 t 의 x 는 고정(t mod 창). 파형은 제자리에 머물고
    // 커서(쓰기 위치)와 그 앞의 블랭크만 이동한다 — 클래식 ECG 스윕.
    const xOf = (t) => ((((t % windowMs) + windowMs) % windowMs) / windowMs) * W
    const gapMs = (GAP_PX / W) * windowMs

    // 화면 밖 카드는 그리지 않는다 (스크롤 시 CPU 절감 — 채널 수 비례 병목 완화).
    // 주의: 콜백의 entries 는 전환 이력이 배치로 묶여 올 수 있다 — 반드시 "마지막"
    // 항목을 읽어야 한다. entries[0](가장 오래된 상태)을 읽으면 초기 레이아웃이
    // 출렁일 때 visible=false 로 고착돼 일부 카드가 빈 채로 남는다
    // (리사이즈해야 나타나던 버그의 원인).
    let visible = true
    const io = new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1].isIntersecting
      },
      // 뷰포트 밖 200px 까지는 미리 그려 스크롤 진입 시 빈 캔버스가 안 보이게
      { rootMargin: '200px' },
    )
    io.observe(canvas)

    // 매 프레임 전체 재드로잉(증분 지우기 없음): 표시 대상은 최근 한 바퀴
    // [T-windowMs+gapMs, T] 의 샘플이고 각자 고정 위치 xOf(t) 에 그린다.
    // 커서 잔상·자취 지움·이음새 아티팩트가 구조적으로 없다.
    // 공유 rAF 루프(registerDraw)가 호출 — 카드별 rAF 를 돌지 않는다.
    // 배경+그리드는 오프스크린에 1회 렌더 → 매 프레임 drawImage 블릿
    // (프레임마다 11회 stroke 호출하던 것을 1회 복사로 대체)
    const gridCanvas = document.createElement('canvas')
    gridCanvas.width = W * dpr
    gridCanvas.height = H * dpr
    {
      const g = gridCanvas.getContext('2d')
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = '#0b1220'
      g.fillRect(0, 0, W, H)
      g.strokeStyle = '#182338'
      g.lineWidth = 1
      for (let gx = GRID_PX; gx < W; gx += GRID_PX) {
        g.beginPath()
        g.moveTo(gx + 0.5, 0)
        g.lineTo(gx + 0.5, H)
        g.stroke()
      }
    }

    // ── 드로잉 전략: 증분(기본) + 필요 시에만 풀 리드로우 ──────────────────
    // 매 프레임 새 샘플(초당 250개 → 프레임당 ~4개)과 커서 전진분만 그린다.
    // 풀 리드로우는 첫 프레임/화면 재진입/스케일 전환 중에만 — 전 카드 60fps 를
    // 유지하면서 캔버스 호출을 프레임당 수천 → 수백 회로 줄인다.
    let lastT = null       // 마지막 플레이아웃 시각 (커서 위치)
    let lastAbsIdx = null  // 마지막으로 그린 샘플의 절대 인덱스 (trimmed + i)
    let penX = null, penY = null, penT = null // 폴리라인 연속용 펜 상태
    let needFull = true
    let envTick = 0

    const strokeStyleNow = () =>
      statusRef.current === 'disconnected' ? '#5a6a80' : '#3ddc84'

    // 그리드 부분 블릿: [x, x+w) 구간을 오프스크린 그리드로 복원
    const blit = (x, w) => {
      if (w <= 0) return
      ctx.drawImage(gridCanvas, x * dpr, 0, w * dpr, H * dpr, x, 0, w, H)
    }
    // 커서 a→b 전진 구간 + 앞쪽 블랭크(GAP) 지움 (wrap 처리 포함)
    const eraseAdvance = (a, b) => {
      let len = (b - a + W * 2) % W + GAP_PX
      if (len > W) len = W
      const w1 = Math.min(len, W - a)
      blit(a, w1)
      if (len > w1) blit(0, len - w1)
    }

    // 진폭 스케일 (잠금 + 지속조건 전환) — 0.25초마다 창 전체 스캔으로 검사
    const envUpdate = (st, lo, hi) => {
      let vmin = Infinity, vmax = -Infinity
      for (let i = lo; i <= hi; i++) { const v = st.vAt(i); if (v < vmin) vmin = v; if (v > vmax) vmax = v }
      if (vmin >= vmax) return
      const span = Math.max(envMax - envMin, 0.2)
      clipFrames = (vmax > envMax || vmin < envMin) ? clipFrames + 1 : 0
      smallFrames = (vmax - vmin) < span * 0.45 ? smallFrames + 1 : 0
      if (tgtMin == null && (clipFrames > 2 || smallFrames > 12)) { // 0.25s 틱 기준 0.5s/3s
        const m = (vmax - vmin) * 0.15 + 0.05 // 15% 헤드룸 마진
        tgtMin = vmin - m
        tgtMax = vmax + m
      }
    }

    // 풀 리드로우: 창 전체를 다시 그림 (스케일 전환/재진입/첫 프레임)
    const renderFull = (T, st, step) => {
      ctx.drawImage(gridCanvas, 0, 0, W, H)
      const tOld = T - windowMs + gapMs
      let hi = st.len - 1
      while (hi >= 0 && st.tAt(hi) > T) hi--
      if (hi < 0) return null // 아직 T 이하 샘플 없음 (초기 웜업) — 그린 것 없음
      let lo = hi
      while (lo > 0 && st.tAt(lo - 1) >= tOld) lo--
      // 픽셀당 ≤2점 데시메이션, 위상은 절대 샘플 번호에 고정 (프레임 간 안정)
      const stride = Math.max(1, Math.ceil((hi - lo + 1) / (W * 2)))
      let i0 = lo
      if (stride > 1) {
        const rem = Math.round(st.tAt(lo) / step) % stride
        if (rem) i0 = lo + (stride - rem)
        if (i0 > hi) i0 = lo
      }
      ctx.strokeStyle = strokeStyleNow()
      ctx.lineWidth = density === 'dense' ? 1.1 : 1.4
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
      // 커서 앞 블랭크 + 펜 상태 갱신 (증분 이어그리기 기준점)
      blit(Math.min(xOf(T), W - 1), Math.min(GAP_PX, W - xOf(T)))
      penX = xOf(st.tAt(hi)); penY = yOf(st.vAt(hi)); penT = st.tAt(hi)
      lastAbsIdx = null // 아래 draw 에서 st.trimmed 기준으로 재설정
      return hi
    }

    // IO 오판 자가복구: 팝업 창 등에서 초기 콜백이 '안 보임'으로 잘못 오면
    // 스크롤 전까지 재평가가 없어 카드가 빈 채 고착된다 → invisible 상태에서는
    // 1초(60프레임)마다 실측으로 가시성을 재확인한다.
    let invisFrames = 0
    const draw = (now) => {
      if (!visible) {
        needFull = true
        if (++invisFrames >= 60) {
          invisFrames = 0
          const r = canvas.getBoundingClientRect()
          visible = r.width > 0 && r.bottom > -200 && r.top < window.innerHeight + 200
        }
        if (!visible) return
      }
      invisFrames = 0
      const T = playoutNow(now)              // 전 채널 공유 플레이아웃 시각
      const st = getStream(ch.channelId)
      if (T == null || !st || st.len === 0) return
      const step = 1000 / st.sampleRate

      // 스케일 검사(0.25초 주기) + 전환 중에는 매 프레임 풀 리드로우로 재스케일
      if (++envTick >= 15 || tgtMin != null) {
        envTick = 0
        let hi = st.len - 1
        while (hi >= 0 && st.tAt(hi) > T) hi--
        if (hi >= 0) {
          let lo = hi
          const tOld = T - windowMs + gapMs
          while (lo > 0 && st.tAt(lo - 1) >= tOld) lo--
          envUpdate(st, lo, hi)
        }
        if (tgtMin != null) {
          envMin += (tgtMin - envMin) * 0.03
          envMax += (tgtMax - envMax) * 0.03
          const tspan = Math.max(tgtMax - tgtMin, 0.2)
          if (Math.abs(envMin - tgtMin) < tspan * 0.02 && Math.abs(envMax - tgtMax) < tspan * 0.02) {
            tgtMin = null; tgtMax = null
            clipFrames = 0; smallFrames = 0
          }
          needFull = true
        }
      }

      // 풀 리드로우 경로 (첫 프레임/재진입/스케일 전환/장기 정지)
      if (needFull || lastT == null || T - lastT > windowMs) {
        const hi = renderFull(T, st, step)
        lastT = T
        if (hi == null) {
          // 초기 웜업: 아직 그릴 샘플(t ≤ T)이 없음 — needFull 을 유지해
          // 다음 프레임에 재시도한다. (여기서 꺼버리면 증분 경로가
          // lastAbsIdx=null 로 영원히 아무것도 안 그리는 고착 발생)
          needFull = true
          return
        }
        needFull = false
        lastAbsIdx = st.trimmed + hi
        return
      }

      // ── 증분 경로: 커서 전진분 지우기 + 새 샘플만 그리기 ──
      if (lastAbsIdx == null) { needFull = true; return } // 방어: 기준점 없음 → 풀 리드로우
      eraseAdvance(xOf(lastT), xOf(T))
      let i = lastAbsIdx - st.trimmed + 1
      if (i < 0) { needFull = true; lastT = T; return } // 버퍼가 크게 밀림 → 리시드
      if (i < st.len && st.tAt(i) <= T) {
        ctx.strokeStyle = strokeStyleNow()
        ctx.lineWidth = density === 'dense' ? 1.1 : 1.4
        ctx.lineJoin = 'round'
        ctx.beginPath()
        for (; i < st.len && st.tAt(i) <= T; i++) {
          const t = st.tAt(i)
          const x = xOf(t)
          const y = yOf(st.vAt(i))
          const gap = penT != null && t - penT > step * 1.5
          if (penX == null || gap || x < penX) {
            ctx.moveTo(x, y) // 공백/창 wrap → 펜업
          } else {
            ctx.moveTo(penX, penY)
            ctx.lineTo(x, y)
          }
          penX = x; penY = y; penT = t
          lastAbsIdx = st.trimmed + i
        }
        ctx.stroke()
      }
      lastT = T
    }
    const unregister = registerDraw(draw)
    return () => {
      unregister()
      io.disconnect()
    }
  }, [ch.channelId, H, density])

  const p = ch.patient || {}
  const alarm = ch.flashUntil > Date.now()
  const cls = [
    'card',
    density,
    ch.status === 'disconnected' ? 'disconnected' : '',
    alarm ? 'alarm' : '',
  ].join(' ')
  const hrText = ch.status === 'disconnected' ? '--' : (ch.hr != null ? Math.round(ch.hr) : '--')

  // ---------- normal: 전체 정보 레이아웃 ----------
  if (density === 'normal') {
    return (
      <div className={cls}>
        <div className="card-head">
          <span className="ch-id">{ch.channelId}</span>
          <span className="p-name">{p.name || '—'}</span>
          <span className="p-loc">
            {p.building}동 {p.floor}층 {p.ward}/{p.zone} {p.room}호
          </span>
          <span className="hr">
            {hrText}
            <small> bpm</small>
          </span>
        </div>
        <div className="badges">
          <span className="badge">{p.department}</span>
          <span className="badge">{p.doctor}</span>
          <span className="badge">{p.nurse}</span>
          {ch.quality === 'weak' && <span className="badge warn">약한 신호</span>}
          {ch.moving && <span className="badge warn">이동 중</span>}
          {ch.status === 'disconnected' && <span className="badge err">연결 해제</span>}
        </div>
        <canvas ref={canvasRef} width={460} height={H} />
        <div className="events">
          {(ch.events || []).map((e, i) => (
            <div key={i} className={'ev ' + (e.kind === 'arrhythmia' ? 'ev-arr' : '')}>
              [{e.time}] {e.kind}{e.detail ? ` — ${e.detail}` : ''}
            </div>
          ))}
        </div>
      </div>
    )
  }

  // ---------- compact / dense: 메타데이터 한 줄 압축 (생략 없음) ----------
  const fullMeta = `${ch.channelId} ${p.name || ''} · ${p.building}동 ${p.floor}층 ` +
    `${p.ward}/${p.zone} ${p.room}호 · ${p.doctor} · ${p.department} · ${p.nurse}`
  // dense 는 압축 표기로 같은 정보를 더 짧게 담는다
  const loc = density === 'dense'
    ? `${p.building}-${p.floor}F ${p.ward}/${p.zone} ${p.room}`
    : `${p.building}동 ${p.floor}층 ${p.ward}/${p.zone} ${p.room}호`
  const staff = density === 'dense'
    ? `${p.doctor}·${(p.department || '').slice(0, 5)}·${p.nurse}`
    : `${p.doctor} · ${p.department} · ${p.nurse}`
  return (
    <div className={cls}>
      <div className="c-line" title={fullMeta}>
        <span className="ch-id">{ch.channelId}</span>
        <b className="c-name">{p.name || '—'}</b>
        <span className="c-meta">{loc}</span>
        <span className="c-meta c-staff">{staff}</span>
        {ch.quality === 'weak' && <span className="tag warn">약신호</span>}
        {ch.moving && <span className="tag warn">이동</span>}
        {ch.status === 'disconnected' && <span className="tag err">해제</span>}
        <span className="c-hr">
          {hrText}
          <small> bpm</small>
        </span>
      </div>
      <canvas ref={canvasRef} width={460} height={H} />
    </div>
  )
}

export default React.memo(ChannelCard)
