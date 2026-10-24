import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const file = process.argv[2]
const yes = process.argv.includes('--yes')
if (!file || file.startsWith('--') || !yes) {
  console.error('Usage: node scripts/db-restore.mjs <backup.sqlite> --yes')
  process.exit(2)
}
const source = resolve(file)
if (!existsSync(source)) {
  console.error('backup file is missing')
  process.exit(1)
}
const target = resolve(process.env.DATABASE_PATH ?? 'api/data/mandate.sqlite')
if (existsSync(target)) {
  mkdirSync(resolve('backups'), { recursive: true })
  const aside = resolve('backups', `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
  copyFileSync(target, aside)
  console.log(aside)
}
mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)
console.log(target)
