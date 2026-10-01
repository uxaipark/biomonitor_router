// GS1 바코드(DataMatrix/GS1-128) 해석 — 패치 상자 라벨을 스캔하면 로트·유효기간을 채운다.
// 지원 형식: "(01)08801234567890(17)270930(10)LOT123", 스캐너 원문("]d2" 머리 + GS(\x1d) 구분), 괄호 없는 연속 문자열.
const FIXED = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 }
export function parseGS1(raw) {
  if (!raw) return null
  let s = String(raw).trim().replace(/^\][A-Za-z]\d/, '')
  const out = {}
  if (s.includes('(')) {
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) out[m[1]] = m[2].replace(/\x1d/g, '').trim()
  } else {
    let i = 0
    while (i < s.length) {
      const ai = s.slice(i, i + 2)
      if (!/^\d\d$/.test(ai)) break
      i += 2
      if (FIXED[ai]) { out[ai] = s.slice(i, i + FIXED[ai]); i += FIXED[ai] } else { const end = s.indexOf('\x1d', i); const e = end < 0 ? s.length : end; out[ai] = s.slice(i, e); i = e + 1 }
    }
  }
  if (!out['10'] && !out['17'] && !out['01']) return null
  let expiry = ''
  if (out['17'] && /^\d{6}$/.test(out['17'])) {
    const y = 2000 + Number(out['17'].slice(0, 2)), mo = Number(out['17'].slice(2, 4)); let d = Number(out['17'].slice(4, 6))
    if (d === 0) d = new Date(y, mo, 0).getDate() // DD=00 → 그 달 말일
    expiry = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  return { gtin: out['01'] || '', lot: out['10'] || '', expiry, serial: out['21'] || '' }
}
