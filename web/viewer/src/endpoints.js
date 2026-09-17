// 중앙 엔드포인트 설정 (뷰어).
//
// 서버측 서비스(라우터)는 이 웹앱을 서빙하는 머신(맥 미니)에 함께 있으므로
// 페이지 자신의 hostname 에서 호스트를 유도한다 → 브라우저를 노트북에서 열든
// 맥 미니에서 열든, 웹을 서빙한 머신으로 정확히 요청이 간다.
// 필요 시 VITE_SERVER_HOST 로 강제 지정할 수 있다 (.env).
const SERVER_HOST =
  import.meta.env.VITE_SERVER_HOST || window.location.hostname || 'localhost'

export const API = `http://${SERVER_HOST}:7300`
export const WS_URL = `ws://${SERVER_HOST}:7300/ws`
