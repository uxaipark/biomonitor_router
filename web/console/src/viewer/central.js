// Central Station logic ported from the emulator (emulator/web/static/app.js: CS_PRESETS, csAutoGrid, csLayout,
// monAlarm, shortAlarm). Pure functions: the React component applies the returned CSS variables / classes.
export const CS_C = { hr: '#3ddc84', spo2: '#38c8f0', rr: '#f5d33d', nibp: '#ff8a3d', temp: '#e8e8e8', gl: '#d9a5ff' }
export const LIMITS = { hr: [50, 120], spo2: [90, 100], rr: [8, 30], nibp: [90, 160], temp: [35.5, 38.5], gl: [70, 250] }
export const BAT_LOW = 15
export const CS_TH = { bg: '#000', grid: 'rgba(243,242,242,.10)', paceLine: ['#ffe34d', '#ffffff', '#ff9783'] }
export const VM_TH = {
  light: { bg: '#f3f2f2', grid: 'rgba(32,30,29,.16)', ecg: '#201e1d', ppg: '#7d7979', resp: '#7d7979', paceLine: ['#dd2b0f', '#ec3013', '#ff9783'] },
  night: { bg: '#141313', grid: 'rgba(243,242,242,.18)', ecg: '#f3f2f2', ppg: '#9b9797', resp: '#9b9797', paceLine: ['#ffe34d', '#ff9783', '#ffc4b8'] },
}
// n-up presets (cols × rows); numeric boards above 48
export const CS_PRESETS = [
  { id: 'auto', label: 'Auto' },
  { id: '2x1', c: 2, r: 1 }, { id: '2x2', c: 2, r: 2 }, { id: '2x3', c: 2, r: 3 }, { id: '3x3', c: 3, r: 3 }, { id: '3x4', c: 3, r: 4 }, { id: '4x5', c: 4, r: 5 }, { id: '4x6', c: 4, r: 6 }, { id: '6x8', c: 6, r: 8 },
  { id: '8x8', c: 8, r: 8, numeric: true }, { id: '12x8', c: 12, r: 8, numeric: true }, { id: '12x10', c: 12, r: 10, numeric: true }, { id: '16x10', c: 16, r: 10, numeric: true },
]

const _mctx = typeof document !== 'undefined' && document.createElement ? document.createElement('canvas').getContext('2d') : null
export function textW(txt, px, weight = 800) {
  if (!_mctx) return txt.length * px * 0.6
  _mctx.font = `${weight} ${px}px Archivo, system-ui, sans-serif`
  return _mctx.measureText(txt).width
}
export const fitPx = (txt, maxW, px, weight = 800) => { const w = textW(txt, px, weight); return w > maxW ? px * maxW / w : px }

export function csAutoGrid(n, W, H, maxCols = 8) {
  let best = null
  for (let c = 1; c <= maxCols; c++) {
    const r = Math.max(1, Math.ceil(n / c)); const asp = (W / c) / (H / r)
    const cost = Math.abs(Math.log(asp / 1.55)) + 0.25 * (c * r - n) / Math.max(1, n)
    if (!best || cost < best.cost) best = { c, r, cost }
  }
  return best
}

/** Grid geometry + type scale for n beds in a W×H box. Returns { cols, rows, fitAll, vars, classes, numeric }. */
export function csLayout(n, W, H, preset, numericAuto) {
  n = Math.max(1, n)
  const numeric = preset ? !!preset.numeric : numericAuto
  let cols, rows
  if (preset) { cols = preset.c; rows = preset.r }
  else if (numeric) { const g = csAutoGrid(Math.min(n, 160), W, H, 16); cols = g.c; rows = g.r }
  else { const g = csAutoGrid(Math.min(n, 24), W, H); cols = g.c; rows = n <= 24 ? g.r : Math.ceil(n / g.c) }
  const fitAll = !!preset || numeric || n <= 24
  const th = fitAll ? H / rows : 140, tw = W / cols
  const vars = {}, classes = { numeric }
  const set = (k, v) => { vars[k] = `${(+v).toFixed(1)}px` }
  if (numeric) {
    const headH = Math.max(18, Math.min(30, th * 0.2)); const minor = th > 110
    const labPx = Math.max(8, Math.min(13, th * 0.075))
    const cellH = (th - headH - 6 - labPx * 1.5) / (minor ? 2.6 : 2), cellW = tw / 2 - 11
    let val = Math.max(9, Math.min(64, cellH * 0.62)); val = Math.max(9, fitPx('188/88', cellW - 10, val))
    set('--cn-val', val); set('--cn-lab', labPx)
    set('--head', Math.max(9, Math.min(14, headH * 0.42))); set('--headbig', Math.max(10, Math.min(17, headH * 0.5)))
    Object.assign(classes, { minor, compact: true, tiny: tw < 105 })
    return { cols, rows, fitAll, vars, classes, numeric }
  }
  const k = Math.min(th / 300, tw / 460)
  const vitw = Math.max(114, Math.min(280, tw * 0.34 + 10))
  const headH = 22 + Math.max(10, Math.min(16, 15 * k)) * 1.2
  const VPAD = 24
  const rowH5 = (th - headH - VPAD) / 5
  const full = rowH5 >= 48, midv = !full && rowH5 >= 40, grid2 = rowH5 < 40
  const narrow = !grid2 && vitw < 140
  const rowH = Math.max(12, grid2 ? (th - headH - 14) / 3 : (th - headH - VPAD) / (narrow ? 6 : 5))
  const rowBig = grid2 ? rowH : rowH * (narrow ? 1.24 : 1.18), rowSmall = grid2 ? rowH : rowH * (narrow ? 0.93 : 0.88), rowPair = grid2 ? rowH : rowH * (narrow ? 0.83 : 0.88)
  const lab = full ? Math.max(9, Math.min(13.5, 12 * k, rowH * 0.26)) : midv ? Math.max(9, Math.min(12, rowH * 0.22)) : Math.max(8, Math.min(11.5, rowH * 0.26))
  const fit = grid2 ? Math.max(11, rowH - lab * 1.15 - 3) : Math.max(12, rowBig - 9)
  const fitSmall = grid2 ? fit : Math.max(10, rowSmall - 8)
  const dense = grid2 && rowH < 26
  Object.assign(classes, { midv, grid2, dense, narrow, compact: tw < 380 || cols * rows >= 48, tiny: tw < 250 })
  set('--lab', lab)
  const availW = vitw - 24
  const stackBudget = grid2 ? 1e9 : (rowSmall - (full ? lab * 1.05 : 0) - 4) / 2.1
  const sub0 = Math.max(7, Math.min(18, 16 * k, stackBudget))
  const colR = grid2 ? 0 : Math.max(textW('SpO₂', sub0, 800), textW('NIBP', sub0, 800), full ? textW('90–160', lab, 400) : 0, textW('mmHg', sub0, 400)) + 8
  const cellW = grid2 ? (vitw - 24 - 8) / 2 : availW
  let big = Math.max(9, Math.min(96, 64 * k, fit)), small = Math.max(8, Math.min(52, 34 * k, grid2 ? fit * 0.9 : fitSmall))
  big = fitPx('188', cellW - colR - 4, big)
  small = fitPx('188/88', cellW - colR - 4, small)
  const pairW = grid2 ? cellW : narrow ? availW : (vitw - 24 - 16) / 2
  let pair = Math.min(small, fitPx('38.8', pairW - 4, small), fitPx('188', pairW - 4, small))
  pair = Math.min(pair, grid2 ? fit : Math.max(9, rowPair - lab * 1.15 - 4))
  classes.nounit = grid2 && (textW('NIBP', lab, 600) + 5 + textW('mmHg', lab, 600) > cellW - 2)
  pair = Math.max(8, pair)
  set('--big', big); set('--small', small); set('--pair', pair); set('--sub', Math.min(sub0, big * 0.34))
  const px = (v, lo, hi) => Math.max(lo, Math.min(hi, v * k))
  set('--head', px(14, 11, 16)); set('--headbig', px(18, 13, 20)); vars['--vitw'] = `${vitw.toFixed(0)}px`
  return { cols, rows, fitAll, vars, classes, numeric }
}

/** Router alarm → central-station colour/label. Critical/high → red, medium/low → yellow. */
export function monAlarm(row, live, alarm) {
  if (row && row.connected === false) return ['red', 'NO SIGNAL']
  if (live && Date.now() - live.rx > 8000) return ['red', 'NO SIGNAL']
  if (alarm) {
    const sev = alarm.severity
    const label = alarmLabel(alarm)
    return [sev === 'critical' || sev === 'high' ? 'red' : 'yellow', label]
  }
  const flags = live?.flags ?? row?.flags ?? 0
  if (flags & 0x01) return ['yellow', 'ECG LEAD OFF']
  return ['', 'NORMAL']
}
function alarmLabel(a) {
  const v = a.value || ''
  switch (a.kind) {
    case 'hr_critical': case 'hr_high': return `HR HIGH ${parseInt(v) || ''}`.trim().replace('HIGH', parseInt(v) < 60 ? 'LOW' : 'HIGH')
    case 'hr_low': return `HR LOW ${parseInt(v) || ''}`
    case 'spo2_critical': case 'spo2_low': return `SpO₂ LOW ${parseInt(v) || ''}`
    case 'resp_low': return `RR LOW ${parseInt(v) || ''}`
    case 'resp_high': return `RR HIGH ${parseInt(v) || ''}`
    case 'temp_high': return `TEMP HIGH ${v.replace('°C', '')}`
    case 'temp_low': return `TEMP LOW ${v.replace('°C', '')}`
    case 'lead_off': return 'ECG LEAD OFF'
    case 'spo2_sensor_off': return 'SpO₂ SENSOR OFF'
    case 'battery_low': return `BATTERY LOW ${v}`
    case 'patch_silent': return 'NO SIGNAL'
    default: return (a.message || a.kind).toUpperCase()
  }
}
export const shortAlarm = (t) => t.replace('ECG LEAD OFF', 'LEAD OFF').replace('BATTERY LOW', 'BAT↓').replace('NO SIGNAL', 'NO SIG').replace('SENSOR OFF', 'OFF')
  .replace(/ HIGH (\d+)\/\d+/, '↑$1').replace(/ LOW (\d+)\/\d+/, '↓$1').replace(' HIGH ', '↑').replace(' LOW ', '↓').replace(/ HIGH$/, '↑').replace(/ LOW$/, '↓')
export const alarmKey = (txt) => /HR/.test(txt) ? 'hr' : /SpO/.test(txt) ? 'spo2' : /RR/.test(txt) ? 'rr' : /NIBP/.test(txt) ? 'nibp' : /TEMP/.test(txt) ? 'temp' : /GLU/.test(txt) ? 'gl' : ''
