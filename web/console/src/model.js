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
  lead_off: '전극 탈락', battery_low: '배터리 부족', patch_silent: '패치 무응답', patch_expiring: '패치 교체 예정', patch_expired: '패치 교체 필요', gateway_down: 'GW 끊김',
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

/** ECG 패치 수명: 최대 착용 14일(그 뒤 교체), 배터리 약 15.5일 — 알람 규칙(patch_wear_days)과 같은 기본값 */
export const PATCH_WEAR_DAYS = 14
export const PATCH_BATTERY_DAYS = 15.5
const DAY = 86400000
/**
 * 패치 수명 요약: 착용 일수, 배터리로 남은 일수(잔량 % × 15.5일), 교체 예정 시각 = min(착용 시작 + 14일, 지금 + 배터리 남은 일수)
 * 반환 null = 착용 시작을 모름
 */
export function patchLife(row, battery, now = Date.now(), wearDays = PATCH_WEAR_DAYS) {
  const ws = row?.wear_start_ms
  if (!ws) return null
  const worn = (now - ws) / DAY
  const batLeft = battery > 0 ? (battery / 100) * PATCH_BATTERY_DAYS : null
  const byWear = ws + wearDays * DAY
  const byBat = batLeft != null ? now + batLeft * DAY : Infinity
  const due = Math.min(byWear, byBat)
  const left = (due - now) / DAY
  return {
    worn, batLeft, due, left,
    reason: byBat < byWear ? '배터리' : '착용 기간',
    level: left <= 0 ? 'err' : left <= 1 ? 'warn' : '',
    estimated: !row.patch_issued_ms, // 발급 시각을 몰라 첫 수신 시각으로 셈
  }
}
export const fmtDays = (d) => (d == null ? '—' : d >= 1 ? `${d.toFixed(1)}일` : `${Math.max(0, d * 24).toFixed(0)}시간`)

/** 게이트웨이 이름 표시: 에뮬레이터 이름의 뒷번호는 0부터(GW-101-0000 = 1번) → 화면에서는 게이트웨이 번호와 같게 1부터 (GW-101-0001) */
export const gwLabel = (name) => (typeof name === 'string' ? name.replace(/^(GW-\d+-)(\d+)$/, (_, p, n) => p + String(Number(n) + 1).padStart(n.length, '0')) : name)

/** 게이트웨이 공간 id → 읽기 쉬운 이름: "B1-01-투석실" → "투석실", 병동 병실 id 는 "3B병동 304호" */
export const spaceName = (id) => { if (!id) return ''; const w = wardRoom(id); if (w) return `${w.ward} ${w.room}`; const m = /^B\d+-\d+-(.+)$/.exec(id); return m ? m[1] : id }
/**
 * 입원 병실 표기 — 건물은 입원 병실의 건물(home_building). 현재 위치(검사·이동 중)의 건물·층과 섞지 않는다.
 * p = row.patient, space = row.space (지금 있는 곳)
 */
export function homePlace(p = {}, space = '') {
  const room = p.room || space
  const m = /^\d(\d\d)([A-Z])(\d\d)$/.exec(room || '')
  const bed = /-([A-Z0-9]+)$/.exec(p.bed || '')
  if (m) {
    const fl = parseInt(m[1], 10)
    const b = p.home_building || (room === space ? p.building : '')
    return [b, `${fl}층`, `${fl}${m[2]}병동`, `${fl}${m[3]}호`, bed && `${bed[1]}침대`].filter(Boolean).join(' · ')
  }
  return [p.building, p.floor && `${p.floor}층`, p.ward, spaceName(room)].filter(Boolean).join(' · ')
}
/**
 * 병실 밖(검사·치료·이동 중): 지금 공간이 입원 병실과 다르고 복도가 아닐 때.
 * 복도 게이트웨이는 게이트웨이 없는 병실의 환자도 잡으므로 복도는 '병실 밖'으로 치지 않는다.
 */
export const isAway = (p = {}, space = '') => !!space && !!p.room && space !== p.room && !space.includes('복도')
/** 지금 있는 곳 — 병실 밖일 때만 ("" = 병실에 있음) */
export const nowPlace = (p = {}, space = '') => (!isAway(p, space) ? '' : [p.building, p.floor && `${p.floor}층`, spaceName(space)].filter(Boolean).join(' · '))
