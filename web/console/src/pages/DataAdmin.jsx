import React, { useState } from 'react'
import { api, usePoll, fmtBytes, fmtTime } from '../api.js'

/** 테스트 › 데이터 관리: storage figures and the full-reset button (wipes every stored waveform file). */
export default function DataAdmin() {
  const [stats, , refresh] = usePoll(api.stats, 3000)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = async () => {
    const size = stats ? fmtBytes(stats.wave_store_bytes) : ''
    if (!window.confirm(`저장된 파형 파일을 모두 삭제하고 처음부터 다시 저장합니다.${size ? ` (현재 ${size}, 패치 ${stats.store_patches?.toLocaleString()}개)` : ''}\n되돌릴 수 없습니다. 계속할까요?`)) return
    if (!window.confirm('정말로 전체 저장 데이터를 삭제할까요?')) return
    setBusy(true)
    try { await api.waveReset(); setMsg(`${fmtTime(Date.now())} 삭제 요청 완료. 저장소가 비워지고 수신 중인 레코드부터 새로 쌓입니다.`); setTimeout(() => refresh?.(), 1500) } catch (e) { setMsg('실패: ' + e.message) } finally { setBusy(false) }
  }
  const pct = stats && stats.disk_total_bytes ? Math.round((stats.disk_total_bytes - stats.disk_free_bytes) / stats.disk_total_bytes * 100) : null
  return (
    <div className="page">
      <h2 className="h">데이터 관리</h2>
      <div className="settings">
        <section>
          <h3>저장소 현황</h3>
          <div className="kv">
            <div><small>저장 파형 용량</small>{stats ? fmtBytes(stats.wave_store_bytes) : '—'}</div>
            <div><small>패치 수</small>{stats?.store_patches?.toLocaleString() ?? '—'}</div>
            <div><small>디스크</small>{stats ? `${fmtBytes(stats.disk_total_bytes - stats.disk_free_bytes)} / ${fmtBytes(stats.disk_total_bytes)} (${pct}%)` : '—'}</div>
            <div><small>저장 큐</small>{stats?.store_queue?.toLocaleString() ?? '—'} · 드롭 {stats?.queue_dropped_wave?.toLocaleString() ?? '—'}</div>
          </div>
          <p className="muted">패치별 파형 파일은 `data/store/patches/&lt;패치&gt;/`에 시간 단위로 쌓이며 상한(200 GB)에 닿으면 오래된 시간부터 지웁니다. 설정 › 생체신호 관리에서 백업 대상을 켜면 검증된 백업이 끝난 파일만 지웁니다.</p>
        </section>
        <section>
          <h3>데이터 전체 삭제</h3>
          <p className="muted">저장소의 패치별 파형 파일과 색인을 모두 삭제하고 새로 시작합니다. 그룹 설정, 알람 규칙, 라우터 DB는 지워지지 않습니다. 실행 중인 수신은 끊기지 않고 다음 레코드부터 새 파일에 기록됩니다.</p>
          <button className="danger" onClick={reset} disabled={busy}>저장된 파형 전체 삭제</button>
          {msg && <p className="muted">{msg}</p>}
        </section>
      </div>
    </div>
  )
}
