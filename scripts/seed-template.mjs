import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const tsx = resolve('api/node_modules/tsx/dist/cli.mjs')
const script = resolve('api/scripts/seed-template.ts')
const args = process.argv.slice(2)
execFileSync('node', [tsx, script, ...args], { stdio: 'inherit' })
