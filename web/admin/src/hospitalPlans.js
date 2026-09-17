// 병원 평면도 로더.
// src/floorplans/*.json 을 자동 수집한다 — 파일을 추가하면
// Top Bar 병원선택 메뉴에 자동으로 나타난다.
// 각 파일: { id, name, order, viewBox, buildings, floors, plans }
// (에뮬레이터의 HOSPITALS 정의와 id 가 일치해야 환자 배치가 연동된다)

const modules = import.meta.glob('./floorplans/*.json', { eager: true })

export const hospitals = Object.values(modules)
  .map((m) => m.default)
  .filter((h) => h && h.id)
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

export const hospitalById = (id) =>
  hospitals.find((h) => h.id === id) || hospitals[0]

// 병원 전체 게이트웨이 배치 수 (평면도 정의에서 파생)
export function gwTotal(h) {
  if (!h) return 0
  let perBuilding = 0
  for (const f of h.floors) {
    const plan = h.plans[String(f)] || h.plans.default
    perBuilding += plan.spaces.filter((s) => s.gw).length
  }
  return perBuilding * h.buildings.length
}
