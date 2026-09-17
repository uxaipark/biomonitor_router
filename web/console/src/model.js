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
