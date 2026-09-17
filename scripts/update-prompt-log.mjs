// Claude Code 내장 히스토리(~/.claude/history.jsonl)에서 이 프로젝트의 프롬프트를
// 추출해 prompt-logs/YYYY-MM-DD.log 로 재생성한다. 멱등(idempotent) 실행.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HISTORY = path.join(os.homedir(), '.claude', 'history.jsonl')
const OUT_DIR = 'C:/dev/router/prompt-logs'
const PROJECT = 'c:/dev/router'

const z = (n) => String(n).padStart(2, '0')
const byDay = {}
let count = 0

for (const line of fs.readFileSync(HISTORY, 'utf8').split('\n')) {
  if (!line) continue
  let e
  try { e = JSON.parse(line) } catch { continue }
  if (!e.display || !e.project) continue
  if (e.project.split('\\').join('/').toLowerCase() !== PROJECT) continue
  const t = new Date(e.timestamp)
  const day = `${t.getFullYear()}-${z(t.getMonth() + 1)}-${z(t.getDate())}`
  const time = `${z(t.getHours())}:${z(t.getMinutes())}:${z(t.getSeconds())}`
  ;(byDay[day] = byDay[day] || []).push(`[${time}] ${e.display.split('\n').join(' ')}`)
  count++
}

fs.mkdirSync(OUT_DIR, { recursive: true })
for (const [day, arr] of Object.entries(byDay))
  fs.writeFileSync(path.join(OUT_DIR, `${day}.log`), arr.join('\n') + '\n')
console.log(`prompt log updated: ${count} prompts, days: ${Object.keys(byDay).join(', ')}`)
