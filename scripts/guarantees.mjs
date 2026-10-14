import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const file = resolve(root, 'docs/guarantees.json')

if (!existsSync(file)) {
  console.error('Error: docs/guarantees.json not found')
  process.exit(1)
}

const data = JSON.parse(readFileSync(file, 'utf-8'))
const guarantees = data.guarantees ?? []

console.log(`Mandate Guarantees (${guarantees.length} total, deep run: ${data.deepRun?.months ?? 0} months, ${data.deepRun?.violations ?? 0} violations):\n`)

let failures = 0
for (const g of guarantees) {
  const missingTests = []
  for (const t of g.tests ?? []) {
    const fullPath = resolve(root, 'api', t)
    if (!existsSync(fullPath)) {
      missingTests.push(t)
    }
  }

  const ok = missingTests.length === 0
  const marker = ok ? '✓' : '✗'
  console.log(`  ${marker} [${g.id}] ${g.promise}`)
  if (g.audit) console.log(`      audit check: ${g.audit}`)
  console.log(`      tests: ${(g.tests ?? []).join(', ')}`)
  if (!ok) {
    failures += 1
    console.error(`      MISSING TEST FILES: ${missingTests.join(', ')}`)
  }
}

console.log(`\n${guarantees.length - failures} of ${guarantees.length} guarantees verified.`)
if (failures > 0) {
  process.exit(1)
}
