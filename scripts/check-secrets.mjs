// Fails the gates when a tracked file looks like a live secret.
// Allow a fixture by putting its path:line, or a unique substring of that line, in scripts/check-secrets.allow.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const allowPath = new URL('./check-secrets.allow', import.meta.url)
const allow = existsSync(allowPath)
  ? readFileSync(allowPath, 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  : []

const patterns = [
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'mandate-machine-key', re: /mnd_[a-z0-9]+_[A-Za-z0-9_-]{16,}/ },
  { name: 'assigned-secret', re: /(?:secret|token|api[_-]?key|password)\s*[:=]\s*['"]?[A-Za-z0-9+/]{40,}={0,2}/i },
]

const skip = /\.(png|jpg|jpeg|gif|webp|woff2|ico|pdf)$/i
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
let failed = 0

for (const file of files) {
  if (skip.test(file) || file === 'scripts/check-secrets.allow') continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (text.includes('\u0000')) continue
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of patterns) {
      if (!pattern.re.test(line)) continue
      const id = `${file}:${index + 1}`
      if (allow.some((rule) => id === rule || (rule.length >= 12 && line.includes(rule)))) continue
      console.error(`${id} ${pattern.name}`)
      failed += 1
    }
  }
}

if (failed > 0) {
  console.error(`secret check failed: ${failed}`)
  process.exit(1)
}
console.log(`secret check passed (${files.length} tracked files)`)
