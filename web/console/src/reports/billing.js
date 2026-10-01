// 보험 청구 코드 표와 산정 규칙 (한국 HIRA · 미국 CPT/CMS-1500 · 일본 診療報酬).
// 출처: HIRA 「건강보험요양급여비용」 2026.3 (고시 제2025-249호), CMS PFS 2026 (CF $33.4009),
// Noridian A60279/L40255 · WPS A57476 · Novitas A59268, 令和8年度 診療報酬点数表 (2026-06-01 施行).
// 실제 청구 전 기관 원무·청구 담당이 확인해야 하는 '초안' 이다.

export const RHYTHM = {
  nsr: ['정상 동율동', 'Normal sinus rhythm', '正常洞調律'],
  afib: ['심방세동', 'Atrial fibrillation', '心房細動'],
  pvc: ['심실조기수축', 'PVC', '心室性期外収縮'],
  bigeminy: ['심실 이단맥', 'Ventricular bigeminy', '心室二段脈'],
  trigeminy: ['심실 삼단맥', 'Ventricular trigeminy', '心室三段脈'],
  tachy: ['빈맥', 'Tachycardia', '頻脈'],
  brady: ['서맥', 'Bradycardia', '徐脈'],
  pause: ['휴지 의심', 'Suspected pause', 'ポーズ疑い'],
  asystole: ['무수축 의심', 'Suspected asystole', '心停止疑い'],
  vf: ['심실세동', 'Ventricular fibrillation', '心室細動'],
  vtach: ['심실빈맥', 'Ventricular tachycardia', '心室頻拍'],
  vrun: ['비지속성 심실빈맥', 'NSVT (V-run)', '非持続性心室頻拍'],
  ivr: ['심실고유리듬', 'Idioventricular rhythm', '心室固有調律'],
  svrun: ['상심실성 빈맥(연발)', 'SVT run', '上室性頻拍(連発)'],
  leadoff: ['전극 탈락', 'Lead off', '電極外れ'],
  noise: ['잡음', 'Noise', 'ノイズ'],
  unknown: ['미확인', 'Unclassified', '未分類'],
}
export const LI = { ko: 0, en: 1, ja: 2 }
export const rname = (l, lang) => (RHYTHM[l] || [l, l, l])[LI[lang] ?? 0]

// 진단 키워드(한국어 EMR) · 엔진 소견 → ICD-10 (CM: 미국, 한국 KCD·일본 標準病名 은 대부분 앞 4자리 동일)
const DX_MAP = [
  [/심방세동|atrial fib|心房細動/i, 'I48.91', 'I48.9', 'Unspecified atrial fibrillation', '심방세동, 상세불명', '心房細動'],
  [/심방조동|flutter|心房粗動/i, 'I48.92', 'I48.9', 'Unspecified atrial flutter', '심방조동, 상세불명', '心房粗動'],
  [/방실\s*차단|AV block|房室ブロック/i, 'I44.30', 'I44.3', 'Unspecified atrioventricular block', '방실차단, 상세불명', '房室ブロック'],
  [/심실빈맥|ventricular tach|心室頻拍/i, 'I47.20', 'I47.2', 'Ventricular tachycardia, unspecified', '심실빈맥', '心室頻拍'],
  [/상심실성|SVT|上室性頻拍/i, 'I47.10', 'I47.1', 'Supraventricular tachycardia, unspecified', '상심실성 빈맥', '発作性上室頻拍'],
  [/동기능부전|동기능 부전|sick sinus|洞不全/i, 'I49.5', 'I49.5', 'Sick sinus syndrome', '동기능부전증후군', '洞不全症候群'],
  [/심부전|heart failure|心不全/i, 'I50.9', 'I50.9', 'Heart failure, unspecified', '심부전, 상세불명', '心不全'],
  [/심근경색|myocardial infarction|心筋梗塞/i, 'I21.9', 'I21.9', 'Acute myocardial infarction, unspecified', '급성 심근경색증, 상세불명', '急性心筋梗塞'],
  [/협심증|angina|狭心症/i, 'I20.9', 'I20.9', 'Angina pectoris, unspecified', '협심증, 상세불명', '狭心症'],
  [/뇌경색|뇌졸중|stroke|脳梗塞/i, 'I63.9', 'I63.9', 'Cerebral infarction, unspecified', '뇌경색증, 상세불명', '脳梗塞'],
  [/실신|syncope|失神/i, 'R55', 'R55', 'Syncope and collapse', '실신 및 허탈', '失神'],
  [/두근|palpitation|動悸/i, 'R00.2', 'R00.2', 'Palpitations', '두근거림', '動悸'],
  [/어지럼|dizz|めまい/i, 'R42', 'R42', 'Dizziness and giddiness', '어지럼 및 현기증', 'めまい'],
  [/심근병증|cardiomyopathy|心筋症/i, 'I42.9', 'I42.9', 'Cardiomyopathy, unspecified', '심근병증, 상세불명', '心筋症'],
  [/고혈압|hypertension|高血圧/i, 'I10', 'I10', 'Essential (primary) hypertension', '본태성(원발성) 고혈압', '本態性高血圧症'],
]
const FINDING_ICD = {
  afib: ['I48.91', 'I48.9', 'Unspecified atrial fibrillation', '심방세동, 상세불명', '心房細動'],
  vtach: ['I47.20', 'I47.2', 'Ventricular tachycardia, unspecified', '심실빈맥', '心室頻拍'],
  vrun: ['I47.20', 'I47.2', 'Ventricular tachycardia, unspecified', '심실빈맥', '非持続性心室頻拍'],
  vf: ['I49.01', 'I49.0', 'Ventricular fibrillation', '심실세동', '心室細動'],
  svrun: ['I47.10', 'I47.1', 'Supraventricular tachycardia, unspecified', '상심실성 빈맥', '上室頻拍'],
  pvc: ['I49.3', 'I49.3', 'Ventricular premature depolarization', '심실조기탈분극', '心室性期外収縮'],
  bigeminy: ['I49.3', 'I49.3', 'Ventricular premature depolarization', '심실조기탈분극', '心室性期外収縮'],
  brady: ['R00.1', 'R00.1', 'Bradycardia, unspecified', '서맥, 상세불명', '徐脈'],
  tachy: ['R00.0', 'R00.0', 'Tachycardia, unspecified', '빈맥, 상세불명', '頻脈'],
  pause: ['I49.9', 'I49.9', 'Cardiac arrhythmia, unspecified', '상세불명의 심장부정맥', '不整脈'],
  asystole: ['I46.9', 'I46.9', 'Cardiac arrest, cause unspecified', '심장정지, 상세불명', '心停止'],
}
/** 진단·소견 → 상병 후보 [{cm, kcd, en, ko, ja, from}] (중복 제거, 진단 먼저) */
export function suggestDx(diagnosis, counts) {
  const out = []
  const add = (row, from) => { if (!out.some((x) => x.cm === row[0])) out.push({ cm: row[0], kcd: row[1], en: row[2], ko: row[3], ja: row[4], from }) }
  for (const m of DX_MAP) if (diagnosis && m[0].test(diagnosis)) add(m.slice(1), 'emr')
  // 휴지·무수축은 원인(신호 문제 포함)을 알 수 없어 상병 후보로 자동 제안하지 않는다 — 의사가 파형을 보고 직접 넣는다
  for (const k of ['vf', 'vtach', 'vrun', 'afib', 'svrun', 'bigeminy', 'pvc', 'brady', 'tachy']) if (counts?.[k]) add(FINDING_ICD[k], 'ecg')
  if (!out.length) add(['R00.2', 'R00.2', 'Palpitations', '두근거림', '動悸'], 'default')
  return out.slice(0, 12)
}

// ───────── 한국 ─────────
export const KR_CLASS = [['clinic', '의원', 95.6, 0], ['hospital', '병원', 83.8, 0.05], ['general', '종합병원', 83.8, 0.10], ['tertiary', '상급종합병원', 83.8, 0.15]]
export const KR_CODES = {
  E6544: { name: '심전도 침상감시 [1일당]', pts: 201.40, hang: '09', mok: '01', unit: 'day' },
  EX871: { name: '원격심박기술에 의한 감시 [1일당]', pts: 474.27, hang: '09', mok: '01', unit: 'day' },
  E6545: { name: '홀터기록 - 48시간 이내', pts: 629.49, hang: '09', mok: '01', unit: 'once' },
  E6556: { name: '홀터기록 - 48시간 초과 7일 이내', pts: 1677.68, hang: 'B', mok: '03', unit: 'once', note: '선별급여 본인부담 80%' },
  E6557: { name: '홀터기록 - 7일 초과 14일 이내', pts: 2292.09, hang: 'B', mok: '03', unit: 'once', note: '선별급여 본인부담 80%' },
  E6546: { name: '일상 생활의 간헐적 심전도 감시 [1회당]', pts: 301.91, hang: '09', mok: '01', unit: 'once' },
}
export const krPrice = (pts, cls) => { const c = KR_CLASS.find((x) => x[0] === cls) || KR_CLASS[1]; return Math.round((pts * c[2] * (1 + c[3])) / 10) * 10 }
/** 입원: 원격심박감시(EX871) 일수 / 외래: 기록 시간으로 홀터 구간 */
export function krLines(mode, hours, days, cls) {
  const lines = []
  if (mode === 'inpatient') lines.push({ code: 'EX871', qty: 1, days: Math.max(1, days) })
  else lines.push({ code: hours <= 48 ? 'E6545' : hours <= 168 ? 'E6556' : 'E6557', qty: 1, days: 1, over: hours > 336 })
  return lines.map((l) => { const c = KR_CODES[l.code]; const unit = krPrice(c.pts, cls); return { ...l, ...c, unit, amount: unit * l.qty * l.days } })
}
export const KR_COPAY = { inpatient: 0.2, clinic: 0.3, hospital: 0.4, general: 0.5, tertiary: 0.6 }

// ───────── 미국 ─────────
export const US_CODES = {
  '93224': { desc: 'External ECG recording up to 48 h, global (recording, scanning analysis with report, review and interpretation)', fee: 70.48, comp: 'Global' },
  '93227': { desc: 'External ECG recording up to 48 h; review and interpretation', fee: 17.70, comp: 'Professional' },
  '93241': { desc: 'External ECG recording >48 h up to 7 days, global', fee: 279.23, comp: 'Global' },
  '93244': { desc: 'External ECG recording >48 h up to 7 days; review and interpretation', fee: 22.71, comp: 'Professional' },
  '93245': { desc: 'External ECG recording >7 days up to 15 days, global', fee: 289.59, comp: 'Global' },
  '93248': { desc: 'External ECG recording >7 days up to 15 days; review and interpretation', fee: 24.72, comp: 'Professional' },
  '0937T': { desc: 'External ECG recording >15 days up to 30 days, global (Category III, contractor-priced)', fee: 0, comp: 'Global' },
  '0940T': { desc: 'External ECG recording >15 days up to 30 days; review and interpretation', fee: 0, comp: 'Professional' },
  '93228': { desc: 'Mobile cardiovascular telemetry up to 30 days; review and interpretation with report', fee: 25.05, comp: 'Professional' },
  '93229': { desc: 'Mobile cardiovascular telemetry up to 30 days; technical support, attended surveillance, analysis and transmission', fee: 758.53, comp: 'Technical' },
}
export const US_PAYERS = [
  ['UHC', 'UnitedHealthcare', 'Commercial 2026T0489JJ (ILR/wearables) · MA MMP109.19 AECG — covered-diagnosis list; 24–48 h monitor for daily symptoms'],
  ['ELV', 'Elevance Health (Anthem)', 'CG-MED-40 External Ambulatory Cardiac Monitors (04/15/2026) · CG-MED-74 MCT: requires ≥14 days non-diagnostic external monitoring first'],
  ['AET', 'Aetna (CVS Health)', 'CPB 0073 Cardiac Event Monitors · CPB 0019 Holter — repeat study within 1 year goes to medical-necessity review'],
  ['CNC', 'Centene (Ambetter/WellCare)', 'CP.MP.113 Holter (24–48 h) · >48 h, event and MCT reviewed under InterQual; MCT may need prior auth'],
  ['CI', 'Cigna', 'MCP 0547 (09/15/2026) — MCT only after non-diagnostic ambulatory monitoring; claims without a listed ICD-10 are denied'],
  ['MCR', 'Medicare (MAC)', 'NCD 20.15 + LCD L40255 / A57476 / A59268 / A60279 — MCT 1 unit per 30 days, DOS = hook-up date'],
  ['OTH', 'Other', ''],
]
/** 외래·MCOT: 기록 기간으로 글로벌 코드 / MCOT: 93228+93229 / 입원: 판독(professional) 코드만, POS 21 */
export function usLines(mode, hours) {
  let codes
  if (mode === 'mcot') codes = ['93228', '93229']
  else if (mode === 'inpatient') codes = [hours <= 48 ? '93227' : hours <= 168 ? '93244' : hours <= 360 ? '93248' : '0940T']
  else codes = [hours <= 48 ? '93224' : hours <= 168 ? '93241' : hours <= 360 ? '93245' : '0937T']
  return codes.map((c) => ({ code: c, ...US_CODES[c], mod: c === '93224' && hours < 12 ? '52' : '', units: 1 }))
}
export const US_POS = { inpatient: '21', outpatient: '11', mcot: '11' }

// ───────── 일본 ─────────
/** 外来: D210 ホルター型 (8時間以上 1,730点 + 7日以上 長時間心電図加算 320点 / 8時間未満は30分ごと 90点), MCOT 外来はリアルタイム解析 D212 600点 を選べる
 *  入院: D220 呼吸心拍監視 (3時間超 1日につき: 7日以内 150 / 14日以内 130 / 以降 50, 1時間ごと 50) */
export function jpLines(mode, hours, dayIndex, days, useD212) {
  if (mode === 'inpatient') {
    const lines = []
    for (let d = dayIndex - days + 1; d <= dayIndex; d++) {
      const tier = d <= 7 ? ['D220 2イ', '呼吸心拍監視（3時間を超えた場合・7日以内）1日につき', 150] : d <= 14 ? ['D220 2ロ', '呼吸心拍監視（3時間を超えた場合・7日を超え14日以内）1日につき', 130] : ['D220 2ハ', '呼吸心拍監視（3時間を超えた場合・14日を超えた場合）1日につき', 50]
      const last = lines[lines.length - 1]
      if (last && last.code === tier[0]) last.count++
      else lines.push({ code: tier[0], name: tier[1], pts: tier[2], count: 1 })
    }
    return lines
  }
  if (mode === 'mcot' && useD212) return [{ code: 'D212', name: 'リアルタイム解析型心電図（入院中の患者以外）', pts: 600, count: 1 }]
  if (hours < 8) return [{ code: 'D210 1', name: 'ホルター型心電図検査（30分又はその端数を増すごとに）', pts: 90, count: Math.max(1, Math.ceil(hours * 2)) }]
  const l = [{ code: 'D210 2', name: 'ホルター型心電図検査（8時間以上の場合）', pts: 1730, count: 1 }]
  if (hours >= 168) l.push({ code: 'D210 注2', name: '長時間心電図加算（7日間以上）', pts: 320, count: 1 })
  return l
}
