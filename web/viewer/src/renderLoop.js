// 공유 렌더 루프 — 카드마다 requestAnimationFrame 을 도는 대신
// 등록된 draw 콜백들을 하나의 rAF 루프가 일괄 호출한다.
// (rAF 스케줄링/콜백 오버헤드가 채널 수에 비례해 커지는 것을 방지)
const draws = new Set()
let raf = 0
let frame = 0

// 증분 드로잉(카드당 프레임에 새 샘플 ~4개)이라 전 카드 60fps 가 가능하다.
// 스태거링(프레임 분산 스킵)은 스윕이 뚝뚝 끊겨 보여 제거 — 초대규모(400+)
// 에서만 절반 fps 로 보호한다.
function loop(now) {
  frame++
  const skip = draws.size > 400 ? 2 : 1
  let i = 0
  for (const fn of draws) {
    if ((frame + i) % skip === 0) fn(now, frame)
    i++
  }
  raf = draws.size ? requestAnimationFrame(loop) : 0
}

/** draw(now, frame) 콜백 등록. 반환된 함수로 해제. */
export function registerDraw(fn) {
  draws.add(fn)
  if (!raf) raf = requestAnimationFrame(loop)
  return () => {
    draws.delete(fn)
    if (!draws.size && raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
}
