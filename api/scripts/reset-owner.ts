import { dirname, join, resolve } from 'node:path'
import { ControlStore } from '../src/control/store'
import { openDatabase } from '../src/db/database'

const ledger = resolve(process.argv[2] ?? process.env.DATABASE_PATH ?? 'api/data/mandate.sqlite')
const memberId = process.argv[3] ?? null
const pepper = process.env.KEY_PEPPER ?? ''
if (pepper.length < 16) {
  console.error('KEY_PEPPER is required')
  process.exit(1)
}
const db = openDatabase(join(dirname(ledger), 'control.sqlite'))
const store = new ControlStore(db, pepper)
const result = store.resetOwner(memberId, new Date().toISOString())
db.close()
if (result === 'missing') {
  console.error('No active member with that id')
  process.exit(1)
}
console.log(memberId ? 'promoted' : 'sessions-ended')
