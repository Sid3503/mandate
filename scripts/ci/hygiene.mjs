// Run: node scripts/ci/hygiene.mjs   Checks the repo rules the pipeline depends on. Exit 1 if any fail.
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkRepo } from './repo-rules.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const results = checkRepo(root)
for (const { ok, name, detail } of results) console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`)
const failed = results.filter((item) => !item.ok).length
console.log(failed === 0 ? `\n${results.length} checks passed.` : `\n${failed} of ${results.length} checks failed.`)
process.exit(failed === 0 ? 0 : 1)
