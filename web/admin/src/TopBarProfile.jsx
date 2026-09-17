import React, { useEffect, useRef, useState } from 'react'
import { templates } from './templateLoader.js'

// 목업 로그인 정보 (더미)
const USER = {
  name: '김도윤',
  initials: '김',
  role: '시스템 관리자',
  dept: '심장내과 모니터링팀',
  email: 'doyun.kim@hospital.example',
  lastLogin: '2026-08-11 08:52',
}

// Top Bar 오른쪽 로그인 프로파일 메뉴.
// 프로파일 정보(더미) + 화면 템플릿 선택 리스트 (templates/ 폴더 자동 수집).
// 선택 상태는 App 이 소유한다 (템플릿이 레이아웃까지 제어하므로).
export default function TopBarProfile({ tplId, onSelect }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // 바깥 클릭 시 닫기
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  return (
    <div className="profile" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen(!open)}>
        <span className="avatar">{USER.initials}</span>
        <span className="avatar-name">
          {USER.name} <span className="name-sep">|</span> <small>{USER.role}</small>
        </span>
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="profile-menu">
          <div className="pm-user">
            <span className="avatar big">{USER.initials}</span>
            <div>
              <b>{USER.name}</b>
              <div className="pm-line">{USER.role} · {USER.dept}</div>
              <div className="pm-line">{USER.email}</div>
              <div className="pm-line dim2">최근 로그인 {USER.lastLogin}</div>
            </div>
          </div>

          <div className="pm-sep" />
          <div className="pm-title">화면 템플릿</div>
          {templates.map((t) => (
            <button
              key={t.id}
              className={'pm-item' + (t.id === tplId ? ' active' : '')}
              onClick={() => onSelect(t.id)}
            >
              <span
                className="swatch"
                style={{
                  background: t.vars?.['--accent'] || 'var(--accent)',
                  borderColor: t.vars?.['--line'] || 'var(--line)',
                }}
              />
              <span className="pm-item-text">
                {t.name}
                <small>{t.description}</small>
              </span>
              {t.id === tplId && <span className="check">✓</span>}
            </button>
          ))}
          <div className="pm-hint">templates/ 폴더에 파일을 추가하면 목록에 자동 등록됩니다</div>

          <div className="pm-sep" />
          <button className="pm-item" onClick={() => alert('목업: 로그아웃되었습니다')}>
            <span className="pm-item-text">로그아웃</span>
          </button>
        </div>
      )}
    </div>
  )
}
