// 다크 템플릿: 미드나이트 모니터 — 병상 모니터 느낌의 어두운 관제 화면
export default {
  id: 'midnight-monitor',
  name: '미드나이트 모니터',
  description: '어두운 관제실 톤 (야간 모니터링)',
  order: 2,
  // 레이아웃: 관제실 톤 — 시스템 정보/이벤트 모두 상단 표시
  layout: { showStats: true, showEvents: true, eventsPosition: 'top' },
  vars: {
    '--bg': '#0a1120',
    '--surface': '#101b30',
    '--surface-2': '#0c1526',
    '--line': '#20304c',
    '--line-soft': '#182741',
    '--ink-1': '#e2e8f0',
    '--ink-2': '#9db4d4',
    '--ink-3': '#5f7494',
    '--accent': '#1fb6d4',
    '--accent-strong': '#4dd4ec',
    '--accent-soft': '#0e2a3c',
    '--good': '#34d399',
    '--good-bg': '#0a2b20',
    '--warn': '#fbbf24',
    '--warn-bg': '#2d2105',
    '--crit': '#f87171',
    '--crit-bg': '#331111',
    '--console': '#060b14',
    '--shadow': '0 1px 2px rgba(0,0,0,0.4), 0 6px 16px rgba(0,0,0,0.35)',
  },
  css: `
    body { color-scheme: dark; }
    .pill.ok { border-color: #14532d; }
    .pill.warn { border-color: #713f12; }
    .pill.bad { border-color: #7f1d1d; }
    .chip { border-color: #164e63; }
    .chip.inc { border-color: #14532d; }
    .chip.exc { border-color: #7f1d1d; }
    .chip.all { border-color: var(--line); }
    button:hover { border-color: #33507a; }
    ::-webkit-scrollbar-thumb { background: #2b3f61; }
    .dot.on { box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.18); }
    .editor input:focus, input.search:focus { box-shadow: 0 0 0 3px rgba(31, 182, 212, 0.2); }
    .event-log { border-color: #1e2c44; }
  `,
}
