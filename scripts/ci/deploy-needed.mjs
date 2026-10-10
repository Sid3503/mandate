// Run: node scripts/ci/deploy-needed.mjs <base> <head>
// Says whether Render would deploy for the commits between base and head, using the same ignoredPaths list render.yaml gives
// Render. Prints needed=true or needed=false (and writes it to $GITHUB_OUTPUT when run by Actions). When in doubt it says true.
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deployNeeded, ignoredPathsFrom } from './repo-rules.mjs'

const [base, head] = process.argv.slice(2)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
let needed = true
let why = 'could not compare the commits, so assuming a deploy'
if (base && head && /^[0-9a-f]{7,40}$/i.test(base) && /^[0-9a-f]{7,40}$/i.test(head)) {
  try {
    const changed = execFileSync('git', ['diff', '--name-only', base, head], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)
    needed = deployNeeded(changed, ignoredPathsFrom(readFileSync(resolve(root, 'render.yaml'), 'utf8')))
    why = `${changed.length} file(s) changed, ${needed ? 'at least one is not in render.yaml ignoredPaths' : 'all are in render.yaml ignoredPaths'}`
  } catch { /* keep the safe answer */ }
}
console.log(`needed=${needed}  (${why})`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`)
