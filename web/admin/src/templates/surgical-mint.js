// 라이트 템플릿: 서지컬 민트 — 수술복 그린 계열의 차분한 클리닉 톤
export default {
  id: 'surgical-mint',
  name: '서지컬 민트',
  description: '수술복 그린 계열의 밝은 톤',
  order: 3,
  // 레이아웃: 간결 모드 — 시스템 정보 카드 숨김, 실시간 이벤트는 채널 목록 다음에 배치
  layout: { showStats: false, showEvents: true, eventsPosition: 'afterChannels' },
  vars: {
    '--bg': '#edf4f0',
    '--surface': '#ffffff',
    '--surface-2': '#f4faf7',
    '--line': '#d3e5db',
    '--line-soft': '#e3efe8',
    '--ink-1': '#132a22',
    '--ink-2': '#416154',
    '--ink-3': '#87a396',
    '--accent': '#0f766e',
    '--accent-strong': '#115e59',
    '--accent-soft': '#e6faf5',
    '--good': '#15803d',
    '--good-bg': '#eafbf0',
    '--warn': '#a16207',
    '--warn-bg': '#fdf7e7',
    '--crit': '#b91c1c',
    '--crit-bg': '#fdf0f0',
    '--console': '#0d1f1a',
  },
  css: `
    .chip { border-color: #bfe6da; }
    .event-log { border-color: #1c3b32; }
    .log-time { color: #5b7a6e; }
  `,
}
