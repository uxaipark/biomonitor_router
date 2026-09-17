// 파형 샘플 저장소 — 타임스탬프 기반 플레이아웃(지터버퍼).
//
// 왜 바꿨나: 예전에는 도착한 샘플을 큐에 쌓고 "로컬 재생속도(고정 sample_rate)"로
// 소비했다. 소스(게이트웨이)의 실효 레이트가 어긋나거나(드리프트) 패킷이 지연되면
// 큐가 넘치거나 말라서 파형이 가로로 압축/신장 → **왜곡**됐다.
//
// 지금은 각 샘플에 **소스 시각 t(ms)** 를 부여해 저장하고, 화면은 x 좌표를 t 로
// 계산한다. 모든 채널이 공유하는 **플레이아웃 클록**(고정 표시지연 뒤를 따라가는
// 시계)이 페이스를 정한다. 결과:
//  - 소스 레이트가 드리프트해도 샘플 간격은 t 로 고정 → 모양 왜곡 없음.
//  - 지연/지터는 고정 지연 버퍼가 흡수(제자리의 짧은 공백으로만 표현, 누적 안 됨).
//  - 모든 채널이 같은 시계를 공유 → 채널 간 위상 정렬 유지.

const store = new Map() // channelId -> 채널 링버퍼 (아래 makeChannel)

const RETAIN_MS = 8000         // 채널별 보관 창(표시 창 6s 보다 넉넉히)
const DISPLAY_DELAY_MS = 1000  // 지터버퍼 깊이: 채널 위상차+WiFi 도착 버스트를 흡수
                              // (클수록 지연↑·매끄러움↑). 1s = 모니터링에 무난.

// 공유 플레이아웃 클록 상태 (전 채널 공용)
let newestSrc = null   // 지금까지 본 최신 소스 시각(= 각 채널 lastT 의 최대)
let anchorLocal = null // performance.now() 앵커
let anchorSrc = null   // 앵커 시점의 소스 시각

// 채널 저장소: typed-array 링버퍼.
// {t,v} 객체 배열 대신 Float64/Float32 고정 버퍼를 재사용 —
// GC 할당 0 (기존: 초당 채널수×250개 객체), splice 이동 없음 (17.9× 빠른 append).
// trimmed = 지금까지 앞에서 밀려난(덮어쓴) 샘플 수 — 렌더러가 "절대 인덱스" 로
// 마지막 그린 위치를 기억할 수 있게 한다.
function makeChannel(sampleRate) {
  const cap = Math.ceil((RETAIN_MS / 1000) * sampleRate)
  return {
    sampleRate,
    lastT: null,
    trimmed: 0,
    cap,
    head: 0,
    len: 0,
    tBuf: new Float64Array(cap),
    vBuf: new Float32Array(cap),
    tAt(i) { return this.tBuf[(this.head + i) % this.cap] },
    vAt(i) { return this.vBuf[(this.head + i) % this.cap] },
    push(t, v) {
      if (this.len === this.cap) {
        // 가득 참: 가장 오래된 자리를 덮어쓰고 링을 한 칸 회전
        this.tBuf[this.head] = t
        this.vBuf[this.head] = v
        this.head = (this.head + 1) % this.cap
        this.trimmed++
      } else {
        const i = (this.head + this.len) % this.cap
        this.tBuf[i] = t
        this.vBuf[i] = v
        this.len++
      }
    },
  }
}

// ts_ms 는 패킷의 마지막(가장 최근) 샘플 시각에 대응(에뮬레이터 now_ms()=생성시각,
// samples 는 직전 packet_ms 구간). 첫 샘플 시각 = ts_ms - (n-1)*step.
export function appendSamples(channelId, samples, sampleRate, tsMs) {
  if (!samples || samples.length === 0) return
  let ch = store.get(channelId)
  if (!ch || ch.sampleRate !== sampleRate) {
    ch = makeChannel(sampleRate)
    store.set(channelId, ch)
  }
  const step = 1000 / sampleRate
  const n = samples.length
  let t0 = (tsMs ?? 0) - (n - 1) * step
  if (ch.lastT != null) {
    const expected = ch.lastT + step   // 연속이라면 이 패킷 첫 샘플은 정확히 여기
    const realGap = step * n * 1.5     // 1.5패킷 이상 앞서면 진짜 유실/점프
    // 송신 ts 지터(앞뒤 흔들림)는 등간격으로 스냅해 흡수 → 가짜 갭/선 끊김 방지.
    // 진짜 큰 공백(유실 → ts 가 realGap 이상 앞섬)만 그대로 두어 스윕에 갭으로 표현.
    if (t0 < expected + realGap) t0 = expected
  }
  for (let i = 0; i < n; i++) ch.push(t0 + i * step, samples[i])
  ch.lastT = t0 + (n - 1) * step

  if (newestSrc == null || ch.lastT > newestSrc) newestSrc = ch.lastT
  // 별도 시간 기반 트림 불필요 — 링 용량(RETAIN_MS×sampleRate)이 곧 보존 창이다.
}

// 지금 화면에 표시할 소스 시각. 전 채널이 같은 값을 공유 → 시간축 정렬.
//
// 핵심: 클록은 데드밴드 안에서 **순수 1:1 실시간 자유진행**한다(매 프레임 보정 없음).
// newestSrc 는 패킷마다 200ms씩 계단식으로 뛰므로, 이를 매 프레임 보정하면 그 톱니가
// 클록 속도에 실려 5Hz 떨림이 된다. 그래서 목표(newestSrc-표시지연)와의 오차가
// 넉넉한 밴드(±COMFORT) 안이면 아예 손대지 않고, 밴드를 벗어날 때만(누적 드리프트/
// 스톨/기동) 한 번 재앵커한다.
// 재앵커 임계값을 넉넉히 크게: 정상 스트리밍의 도착 버스트(수백 ms)로는 절대 발동하지
// 않고, 오직 진짜 장시간 정지(수 초) 뒤 따라잡을 때만 한 번 발동 → 커서는 항상 1:1
// 자유진행(매끄러움). 작으면 버스트마다 클록이 튀어 커서 떨림/파형 빠짐이 생긴다.
const COMFORT_MS = 2500
export function playoutNow(localNow) {
  if (newestSrc == null) return null
  const target = newestSrc - DISPLAY_DELAY_MS
  if (anchorLocal == null) { anchorLocal = localNow; anchorSrc = target }
  let t = anchorSrc + (localNow - anchorLocal)  // 앵커 이후 정확히 실시간(1:1)
  const err = target - t
  if (err > COMFORT_MS) {
    // 뒤처짐(스톨 종료 후 버퍼 밀림)일 때만 **앞으로** 재앵커해 따라잡는다.
    anchorLocal = localNow; anchorSrc = target; t = target
  }
  // err < 0 (클록이 목표보다 앞섬 = 소스 일시 정지)은 **뒤로 되감지 않는다**.
  // 되감으면 커서가 뒤로 튀어 자취를 지운다. 데이터가 없으면 그냥 블랭크로 지나가게 둔다.
  return t
}

export function getStream(channelId) {
  return store.get(channelId)
}

export function dropChannel(channelId) {
  store.delete(channelId)
}

export function clearAll() {
  store.clear()
  newestSrc = null
  anchorLocal = null
  anchorSrc = null
}

export { DISPLAY_DELAY_MS }
