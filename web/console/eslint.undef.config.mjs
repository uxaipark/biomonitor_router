// 정의되지 않은 이름(import 누락 등) 검사 — 빌드·SSR 점검은 마우스 이벤트 안에서만 쓰는 함수의 누락을 못 잡는다.
// 실행: npm run check:undef  (npx eslint@10 — 시스템 eslint 6 은 flat config 를 모름)
export default [{
  files: ['**/*.js', '**/*.jsx'],
  languageOptions: {
    ecmaVersion: 2023, sourceType: 'module',
    parserOptions: { ecmaFeatures: { jsx: true } },
    globals: { window: 'readonly', document: 'readonly', location: 'readonly', history: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly', fetch: 'readonly', console: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', URLSearchParams: 'readonly', WebSocket: 'readonly', performance: 'readonly', ResizeObserver: 'readonly', Event: 'readonly', CustomEvent: 'readonly', alert: 'readonly', confirm: 'readonly', prompt: 'readonly', navigator: 'readonly', Blob: 'readonly', URL: 'readonly', getComputedStyle: 'readonly', matchMedia: 'readonly', devicePixelRatio: 'readonly', DataView: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly', ArrayBuffer: 'readonly', Float32Array: 'readonly', Int16Array: 'readonly', Uint8Array: 'readonly', Uint16Array: 'readonly', Int8Array: 'readonly', Float64Array: 'readonly', Int32Array: 'readonly', Uint32Array: 'readonly', Path2D: 'readonly', HTMLElement: 'readonly', process: 'readonly', globalThis: 'readonly', queueMicrotask: 'readonly', structuredClone: 'readonly', Image: 'readonly', AbortController: 'readonly', OffscreenCanvas: 'readonly', Intl: 'readonly', crypto: 'readonly', btoa: 'readonly', atob: 'readonly', FileReader: 'readonly', MutationObserver: 'readonly', IntersectionObserver: 'readonly', screen: 'readonly', open: 'readonly' },
  },
  linterOptions: { noInlineConfig: true },
  rules: { 'no-undef': 'error' },
}]
