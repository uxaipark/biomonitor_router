// 기본 템플릿: 클리니컬 라이트 — styles.css 의 기본 토큰을 그대로 사용
export default {
  id: 'clinical-light',
  name: '클리니컬 라이트',
  description: '밝은 진료 콘솔 톤 (기본)',
  order: 1,
  // 레이아웃: 시스템 정보 카드 표시, 실시간 이벤트를 상단에 배치
  layout: { showStats: true, showEvents: true, eventsPosition: 'top' },
  vars: {},
  css: '',
}
