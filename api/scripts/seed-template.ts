import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { migrate, openDatabase, seed } from '../src/db/database'

const target = resolve(process.argv[2] ?? process.env.TEMPLATE_PATH ?? 'api/data/templates/line-studio.sqlite')
mkdirSync(dirname(target), { recursive: true })
const db = openDatabase(target)
migrate(db)
seed(db, new Date())
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
console.log(target)
