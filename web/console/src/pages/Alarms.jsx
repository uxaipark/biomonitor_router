import React, { useEffect, useState } from 'react'
import { api, usePoll, fmtTime, fmtAgo } from '../api.js'
import { SEV_LABEL } from '../model.js'
import { openLive } from '../App.jsx'

const RULE_FIELDS = [
  ['hr_low', '서맥 HR <', 'bpm'], ['hr_high', '빈맥 HR >', 'bpm'], ['hr_crit_low', '위험 HR ≤', 'bpm'], ['hr_crit_high', '위험 HR ≥', 'bpm'],
  ['spo2_low', 'SpO₂ <', '%'], ['spo2_crit_low', '위험 SpO₂ <', '%'], ['temp_low', '저체온 ≤', '°C'], ['temp_high', '고열 ≥', '°C'],
  ['resp_low', '서호흡 <', '/min'], ['resp_high', '빈호흡 >', '/min'], ['battery_low_pct', '배터리 ≤', '%'],
  ['sustain_s', '수치 지속', 's'], ['lead_off_s', '전극 탈락 지속', 's'], ['patch_silent_s', '패치 무응답', 's'], ['clear_s', '해제 유예', 's'],
]

export default function Alarms({ alarms }) {
  const [hist] = usePoll(() => api.alarmHistory(200), 5000)
  const [rules, setRules] = useState(null)
  const [draft, setDraft] = useState(null)
  const [tab, setTab] = useState('active')
  useEffect(() => { api.alarmRules().then((r) => { setRules(r); setDraft(r) }) }, [])
  const active = alarms?.alarms || []
  const ack = async (id) => { await api.ackAlarm(id) }
  const save = async () => { const r = await api.setAlarmRules(draft); setRules(r); setDraft(r) }
  return (
    <div className="page">
      <div className="toolbar">
        <span className="seg">{[['active', `활성 ${active.length}`], ['history', '이력'], ['rules', '규칙']].map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</span>
        {tab === 'active' && <button onClick={() => active.filter((a) => !a.acked).forEach((a) => ack(a.id))}>모두 확인</button>}
      </div>
      {tab !== 'rules' && (
        <table className="tbl">
          <thead><tr><th>심각도</th><th>종류</th><th>대상</th><th>위치</th><th>내용</th><th>값</th><th>발생</th><th>{tab === 'active' ? '경과' : '해제'}</th><th /></tr></thead>
          <tbody>
            {(tab === 'active' ? active : hist || []).map((a) => (
              <tr key={a.id + (a.cleared_ms || '')} className={`sev-${a.severity} ${a.acked ? 'acked' : ''}`}>
                <td><span className={`tag sev-${a.severity}`}>{SEV_LABEL[a.severity]}</span></td>
                <td className="mono">{a.kind}</td>
                <td className="clickable" onClick={() => a.channel_id && openLive(a.channel_id)}>{a.patient_name || (a.gateway_id ? `GW ${a.gateway_id}` : '시스템')}{a.channel_id && <small className="mono muted"> {a.channel_id}</small>}</td>
                <td>{a.room}</td><td>{a.message}</td><td>{a.value}</td><td>{fmtTime(a.since_ms)}</td>
                <td>{tab === 'active' ? fmtAgo(a.since_ms) : a.cleared_ms ? fmtTime(a.cleared_ms) : <span className="muted">발생</span>}</td>
                <td>{tab === 'active' && !a.acked && <button onClick={() => ack(a.id)}>확인</button>}{a.acked && <span className="muted">확인됨</span>}</td>
              </tr>
            ))}
            {tab === 'active' && !active.length && <tr><td colSpan="9" className="muted">활성 알람 없음</td></tr>}
          </tbody>
        </table>
      )}
      {tab === 'rules' && draft && (
        <div className="panel rules">
          <div className="rule-grid">
            {RULE_FIELDS.map(([k, label, unit]) => (
              <label key={k}><span>{label}</span><input type="number" step={k.startsWith('temp') ? 0.1 : 1} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /><small>{unit}</small></label>
            ))}
          </div>
          <div className="toolbar">
            <button className="primary" onClick={save} disabled={JSON.stringify(draft) === JSON.stringify(rules)}>저장</button>
            <button onClick={() => setDraft(rules)}>되돌리기</button>
            <span className="muted">수치 알람은 임계를 '지속' 시간 이상 벗어나야 발생하고, 조건이 사라진 뒤 '해제 유예' 시간이 지나면 자동 해제됩니다. 전극 탈락 중에는 수치 알람을 평가하지 않습니다.</span>
          </div>
        </div>
      )}
    </div>
  )
}
