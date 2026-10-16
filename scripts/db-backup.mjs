// Copies a database with VACUUM INTO. Does not delete the source.
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'

const source = resolve(process.argv[2] ?? process.env.DATABASE_PATH ?? 'api/data/mandate.sqlite')
mkdirSync(resolve('backups'), { recursive: true })
const dest = resolve('backups', `mandate-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
const db = new DatabaseSync(source)
db.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`)
db.close()
console.log(dest)
