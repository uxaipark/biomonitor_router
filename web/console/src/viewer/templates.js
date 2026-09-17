// Viewer template registry. A template is a full-screen React component that receives the scoped registry
// rows (`rows`), the alarm feed, a `unit` caption and `onClose`. Templates target different audiences
// (medical staff, operators, patients) and are opened as `#/viewer?tpl=<id>&<scope>` in their own tab.
import CentralStation from './CentralStation.jsx'
import GridTemplate from './GridTemplate.jsx'

export const TEMPLATES = [
  {
    id: 'central',
    name: '중앙 모니터 (Central Station)',
    audience: '의료진 · 간호사실',
    desc: '에뮬레이터 모니터링 화면과 같은 n-up 격자. 침상 타일(ECG·Pleth·Resp + HR/SpO₂/RR/NIBP/Temp/GLU), 적/황 알람 헤더, 12-up 이상 2열 수치, 48 초과 숫자 보드, 타일 클릭 → 단일 침상 뷰어.',
    component: CentralStation,
    maxRows: 200,
  },
  {
    id: 'grid',
    name: '콘솔 파형 그리드',
    audience: '운영자',
    desc: '라우터 콘솔의 카드형 실시간 파형(ECG 스윕 + 수치)을 전체 화면으로. 최대 48명.',
    component: GridTemplate,
    maxRows: 48,
  },
]

export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || TEMPLATES[0]

/** Build a viewer URL for a scope: { gw, ward, room, ids, tpl }. */
export function viewerUrl(scope) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(scope)) if (v != null && v !== '') q.set(k, Array.isArray(v) ? v.join(',') : String(v))
  return `#/viewer?${q.toString()}`
}
