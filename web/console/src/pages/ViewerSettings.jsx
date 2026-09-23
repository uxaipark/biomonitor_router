import React from 'react'
import { RENDER_MODES, setRenderMode, useRenderMode } from '../settings.js'

const DESC = {
  quality: '디바이스 픽셀 열마다 파형의 최소·최대를 채우는 병상 모니터 방식. 선 두께가 균일하고, R파처럼 뾰족한 봉우리가 화면보다 촘촘한 샘플에서도 사라지지 않습니다. 프레임마다 채우기 1회.',
  speed: '안티앨리어싱 선분을 이어 그리는 종전 방식. 전체 다시 그리기에서 샘플을 솎아 내고, 프레임 경계에서 선분이 겹쳐 두께가 고르지 않을 수 있습니다.',
}

/** 설정 › 뷰어 설정. Stored in the browser (localStorage) and shared with viewer tabs of the same origin. */
export default function ViewerSettings() {
  const mode = useRenderMode()
  return (
    <div className="page">
      <h2 className="h">뷰어 설정</h2>
      <div className="settings">
        <section>
          <h3>메인 뷰어 그래픽</h3>
          <p className="muted">파형을 그리는 방식입니다. 뷰어 템플릿(중앙 모니터·침상 뷰어)과 콘솔 실시간 카드에 함께 적용되고, 열려 있는 뷰어 탭에도 바로 반영됩니다.</p>
          <div className="choice">
            {RENDER_MODES.map(([k, l]) => (
              <button key={k} className={'choice-item' + (mode === k ? ' on' : '')} onClick={() => setRenderMode(k)}>
                <span className="choice-t"><i className="radio" />{l}{k === RENDER_MODES[0][0] && <small> 권장</small>}</span>
                <span className="choice-d">{DESC[k]}</span>
              </button>
            ))}
          </div>
          <p className="muted">속도 비교는 테스트 › 실시간 페이지의 성능 줄("그리기 ms/프레임")로 두 모드를 바꿔 가며 확인할 수 있습니다.</p>
        </section>
      </div>
    </div>
  )
}
