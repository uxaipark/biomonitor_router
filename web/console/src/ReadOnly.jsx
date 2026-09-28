import React from 'react'
/**
 * 보기 전용 가드. 권한이 '보기'(1)인 사용자는 화면은 보되 상태를 바꾸는 컨트롤(입력·스위치·버튼)을 쓸 수 없어야 한다 —
 * 서버가 쓰기 요청을 403 으로 막지만, 화면에서도 <fieldset disabled> 로 한 번에 비활성화한다. 검색·필터·쪽 넘김은
 * 가드 밖에 두어 계속 쓸 수 있게 한다. `banner` 면 위에 안내 줄을 보인다.
 */
export function ReadOnly({ edit, banner = true, children, className = '' }) {
  if (edit) return children
  return (
    <fieldset disabled className={'ro-fieldset ' + className}>
      {banner && <div className="ro-banner">보기 전용 — 이 화면의 설정을 바꾸려면 권한 설정에서 '편집' 이 필요합니다.</div>}
      {children}
    </fieldset>
  )
}
