// Restores a backup onto DATABASE_PATH. Requires --yes. Copies the current file aside first. Deletes nothing.
import { copyFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

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
  const aside = resolve('backups', `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
  copyFileSync(target, aside)
  console.log(aside)
}
copyFileSync(source, target)
console.log(target)
