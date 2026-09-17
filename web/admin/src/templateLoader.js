// 화면 템플릿 로더.
//
// src/templates/ 폴더의 *.js 파일을 자동 수집한다 (Vite import.meta.glob).
// 새 템플릿 파일을 폴더에 추가하기만 하면 Top Bar 프로파일 메뉴의
// 템플릿 선택 리스트에 자동으로 나타난다.
//
// 템플릿 파일 형식 (default export):
//   {
//     id: 'my-theme',          // 고유 ID (localStorage 저장 키)
//     name: '내 테마',          // 리스트 표시 이름
//     description: '설명',
//     order: 10,               // 리스트 정렬 순서
//     vars: { '--bg': '#fff', ... },  // styles.css 의 :root 토큰 오버라이드
//     css: ''                  // (선택) 추가 CSS 문자열
//   }

const modules = import.meta.glob('./templates/*.js', { eager: true })

export const templates = Object.values(modules)
  .map((m) => m.default)
  .filter((t) => t && t.id)
  .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))

const STORAGE_KEY = 'admin-template'
let appliedVars = []

export function savedTemplateId() {
  // URL ?tpl=id 로도 지정 가능 (테스트/공유용)
  const fromUrl = new URLSearchParams(window.location.search).get('tpl')
  return fromUrl || localStorage.getItem(STORAGE_KEY) || templates[0]?.id
}

export function saveTemplateId(id) {
  localStorage.setItem(STORAGE_KEY, id)
}

export function applyTemplate(id) {
  const t = templates.find((x) => x.id === id) || templates[0]
  if (!t) return
  const root = document.documentElement
  // 이전 템플릿의 변수 오버라이드 제거 → styles.css 기본값으로 복귀
  for (const k of appliedVars) root.style.removeProperty(k)
  appliedVars = Object.keys(t.vars || {})
  for (const [k, v] of Object.entries(t.vars || {})) root.style.setProperty(k, v)
  // 템플릿 전용 추가 CSS
  let styleEl = document.getElementById('tpl-css')
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'tpl-css'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = t.css || ''
  document.body.dataset.template = t.id
}
