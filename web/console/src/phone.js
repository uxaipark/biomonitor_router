// 스마트폰 화면(폭 640px 이하) 판단 — 넓은 화면은 그대로 두고 폰에서만 간략 레이아웃을 쓴다.
import { useEffect, useState } from 'react'

export const PHONE_QUERY = '(max-width: 640px)'
export const isPhone = () => { try { return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_QUERY).matches } catch { return false } }

export function useIsPhone() {
  const [v, setV] = useState(isPhone)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const m = window.matchMedia(PHONE_QUERY)
    const f = () => setV(m.matches)
    m.addEventListener ? m.addEventListener('change', f) : m.addListener(f)
    f()
    return () => { m.removeEventListener ? m.removeEventListener('change', f) : m.removeListener(f) }
  }, [])
  return v
}
