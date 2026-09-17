// 중앙 엔드포인트 설정 (어드민).
//
// - 서버측 서비스(라우터 :7300, DB API :7600, 뷰어 :5173)는 이 웹앱을 서빙하는
//   머신(맥 미니)에 함께 있으므로 페이지 자신의 hostname 에서 호스트를 유도한다.
//   → 브라우저를 노트북/맥 미니 어디서 열어도 웹을 서빙한 머신으로 요청이 간다.
// - 에뮬레이터/게이트웨이 제어 API(:7500)는 별도 머신에 있다
//   (현재는 노트북 에뮬레이터, 향후 라즈베리파이 게이트웨이).
//   → VITE_EMU_HOST 로 그 머신의 IP 를 지정한다 (.env). 미지정 시 서버 호스트로 폴백.
//
// 강제 지정: VITE_SERVER_HOST(서버 머신), VITE_EMU_HOST(에뮬/게이트웨이 머신).
const SERVER_HOST =
  import.meta.env.VITE_SERVER_HOST || window.location.hostname || 'localhost'

// 원격(라즈베리파이) 게이트웨이 후보 IP 목록 (쉼표 구분, VITE_EMU_HOSTS 로 오버라이드).
// 항목에 "ip=라벨" 형식으로 유선/무선 라벨을 붙일 수 있다.
// 어드민 테스트 메뉴의 입력 소스 선택(원격 2채널)이 이 목록을 쓴다.
// 기본값: .166 = 유선(eth0), .71 = 무선(wlan0) — 같은 라즈베리파이의 두 인터페이스.
const REMOTE_ENTRIES = (import.meta.env.VITE_EMU_HOSTS ||
  import.meta.env.VITE_EMU_HOST ||
  '192.168.1.166=유선,192.168.1.71=무선')
  .split(',').map((h) => h.trim()).filter(Boolean)
  .map((e) => {
    const [ip, label] = e.split('=').map((s) => s.trim())
    return { ip, label: label || '' }
  })
export const REMOTE_EMU_HOSTS = REMOTE_ENTRIES.map((e) => e.ip)
export const REMOTE_EMU_LABELS = Object.fromEntries(
  REMOTE_ENTRIES.map((e) => [e.ip, e.label]))

// 에뮬레이터 제어(:7500) 프로브 후보: 로컬(서버 머신) 우선, 그다음 원격 후보들.
// 로컬 에뮬레이터가 떠 있으면 로컬을, 아니면 응답하는 원격을 쓴다.
// EMU_API 는 live binding 이라 임포트한 쪽에도 반영된다.
const EMU_HOSTS = [SERVER_HOST, ...REMOTE_EMU_HOSTS]

export const API = `http://${SERVER_HOST}:7300`
export const WS_URL = `ws://${SERVER_HOST}:7300/ws`
export const DB_API = `http://${SERVER_HOST}:7600`
export let EMU_API = `http://${EMU_HOSTS[0]}:7500`
export const VIEWER = `http://${SERVER_HOST}:5173`

// 응답하는 에뮬레이터 호스트 선택 (첫 성공 = 채택). 로드 시 1회 + 실패 시 재시도.
async function probeEmu() {
  for (const h of EMU_HOSTS) {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 1500)
      const r = await fetch(`http://${h}:7500/status`, { signal: ctl.signal })
      clearTimeout(timer)
      if (r.ok) {
        EMU_API = `http://${h}:7500`
        return
      }
    } catch { /* 다음 후보 */ }
  }
}
probeEmu()

// 에뮬레이터 호출이 실패했을 때 호출부에서 부르면 다른 후보로 재프로브한다.
export async function reprobeEmu() {
  await probeEmu()
  return EMU_API
}
