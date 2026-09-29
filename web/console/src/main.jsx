import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './theme-pro.css'

// 배포 뒤에도 열려 있던 탭: 지연 로드 청크(leaflet 등)의 해시가 바뀌어 import 가 실패한다 → 한 번만 자동 새로고침
const reloadOnce = () => { try { if (sessionStorage.getItem('reloaded-for-chunk') === '1') return; sessionStorage.setItem('reloaded-for-chunk', '1') } catch { /* ignore */ } location.reload() }
window.addEventListener('vite:preloadError', (e) => { e.preventDefault(); reloadOnce() })
window.addEventListener('unhandledrejection', (e) => { const m = String(e.reason?.message || e.reason || ''); if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(m)) reloadOnce() })
setTimeout(() => { try { sessionStorage.removeItem('reloaded-for-chunk') } catch { /* ignore */ } }, 30000)

/** 화면 하나가 렌더 중 오류를 내도 콘솔 전체가 하얗게 비지 않게: 오류 문구 + 새로고침 */
class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null } }
  static getDerivedStateFromError(err) { return { err } }
  componentDidCatch(err, info) { console.error('console render error', err, info?.componentStack) }
  render() {
    if (!this.state.err) return this.props.children
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <h3 className="h">화면을 그리는 중 오류가 났습니다</h3>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, opacity: .8 }}>{String(this.state.err?.stack || this.state.err)}</pre>
        <p><button className="primary" onClick={() => location.reload()}>새로고침</button> <button onClick={() => { this.setState({ err: null }); location.hash = '#/' }}>첫 화면으로</button></p>
      </div>
    )
  }
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>)
