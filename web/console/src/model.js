// Shared vocab: record flags, severities, gateway status, sorting helpers.
export const FLAGS = [
  [0x01, 'LEAD_OFF'], [0x02, 'MOTION'], [0x04, 'LOW_BATTERY'], [0x08, 'SPO2_OFF'],
  [0x10, 'PACEMAKER'], [0x20, 'CHARGING'], [0x40, 'NEW_PATCH'],
]
export const flagNames = (f) => FLAGS.filter(([b]) => f & b).map(([, n]) => n)

export const SEV_ORDER = { critical: 3, high: 2, medium: 1, low: 0 }
export const SEV_LABEL = { critical: '위험', high: '높음', medium: '중간', low: '낮음' }

export const GW_STATUS = { 0: '정상', 1: '저하', 2: '다운' }

export function sortBy(rows, key, dir) {
  const s = [...rows]
  const get = typeof key === 'function' ? key : (r) => r[key]
  s.sort((a, b) => {
    const x = get(a), y = get(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko')
    return dir === 'desc' ? -c : c
  })
  return s
}

/** Map of channel_id → most severe active alarm. */
export function alarmIndex(alarms) {
  const m = new Map()
  for (const a of alarms || []) {
    if (!a.channel_id) continue
    const prev = m.get(a.channel_id)
    if (!prev || SEV_ORDER[a.severity] > SEV_ORDER[prev.severity]) m.set(a.channel_id, a)
  }
  return m
}

export function gatewayAlarmIndex(alarms) {
  const m = new Map()
  for (const a of alarms || []) {
    if (a.channel_id || !a.gateway_id) continue
    const prev = m.get(a.gateway_id)
    if (!prev || SEV_ORDER[a.severity] > SEV_ORDER[prev.severity]) m.set(a.gateway_id, a)
  }
  return m
}

export const ALARM_KIND = {
  hr_critical: '심박수 위험', hr_high: '빈맥', hr_low: '서맥', spo2_critical: 'SpO₂ 위험', spo2_low: '저산소',
  spo2_sensor_off: 'SpO₂ 센서 분리', resp_high: '빈호흡', resp_low: '서호흡', temp_high: '고열', temp_low: '저체온',
  lead_off: '전극 탈락', battery_low: '배터리 부족', patch_silent: '패치 무응답', gateway_down: 'GW 끊김',
  gateway_status_down: 'GW 다운 보고', gateway_silent: 'GW 무응답', gateway_degraded: 'GW 저하', store_backpressure: '저장 지연',
}

export const EVENT_KIND = {
  alarm: '알람', alarm_rules: '알람 규칙', analysis_up: '분석 서버', backup_config: '백업 설정', backup_fail: '백업 실패',
  backup_unbacked_delete: '비상 삭제', bad_crc: 'CRC 오류', ingest_allow: '수신 허용', link: '연결', metrics_reset: '통계 초기화',
  network_config: '네트워크 설정', registry_prune: '레지스트리 정리', silent: '무응답', stats_reset: '카운터 초기화', wave_reset: '파형 삭제',
}

/** Ward room id "103B07" (building·floor·ward·room) → { ward: "3B병동", room: "307호" }; anything else → null. */
export function wardRoom(id) {
  const m = /^\d(\d\d)([A-Z])(\d\d)$/.exec(id || '')
  if (!m) return null
  const fl = parseInt(m[1], 10)
  return { ward: `${fl}${m[2]}병동`, room: `${fl}${m[3]}호` }
}

/** Room id for tables: "3B병동 307호" for ward rooms, the id itself otherwise. */
export const roomText = (id) => { const w = wardRoom(id); return w ? `${w.ward} ${w.room}` : id || '' }

/** Ward id "W103B" → "3B병동" (the building digit is shown separately). */
export const wardText = (id) => { const m = /^W\d(\d\d)([A-Z])$/.exec(id || ''); return m ? `${parseInt(m[1], 10)}${m[2]}병동` : id || '' }

export const FLAG_LABEL = {
  LEAD_OFF: '전극 탈락', MOTION: '움직임', LOW_BATTERY: '배터리 부족', SPO2_OFF: 'SpO₂ 분리', PACEMAKER: '페이스메이커', CHARGING: '충전 중', NEW_PATCH: '새 패치',
}
export const FLAG_WARN = new Set(['LEAD_OFF', 'LOW_BATTERY', 'SPO2_OFF'])
