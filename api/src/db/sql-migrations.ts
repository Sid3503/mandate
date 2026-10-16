import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type SqlStep = { id: string; sql: string }

export const OPS_STEPS: SqlStep[] = [
  {
    id: '0001_ops',
    sql: `
CREATE TABLE IF NOT EXISTS payees (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','pending','disabled')),
  verified_method TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  total_paid_cents INTEGER NOT NULL DEFAULT 0,
  change_email TEXT,
  change_pending INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schema_migrations_mark (id TEXT PRIMARY KEY);
`,
  },
  {
    id: '0002_warrant_signature',
    sql: `
ALTER TABLE warrants ADD COLUMN signature_json TEXT;
`,
  },
]

/**
 * Runs numbered SQL once, inside a transaction, and stores a checksum.
 * A changed checksum refuses to boot. The caller takes a backup before the first new step on a file database.
 */
export function applySqlSteps(db: DatabaseSync, steps: SqlStep[], now = new Date().toISOString(), backup?: (db: DatabaseSync) => void): string[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied: string[] = []
  let copied = false
  const read = db.prepare('SELECT checksum FROM schema_migrations WHERE id = ?')
  const write = db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
  for (const step of steps) {
    const checksum = createHash('sha256').update(step.sql).digest('hex')
    const row = read.get(step.id) as { checksum: string } | undefined
    if (row) {
      if (row.checksum !== checksum) throw new Error(`migration checksum changed: ${step.id}`)
      continue
    }
    if (!copied) {
      backup?.(db)
      copied = true
    }
    db.exec('BEGIN')
    try {
      db.exec(step.sql)
      write.run(step.id, checksum, now)
      db.exec('COMMIT')
      applied.push(step.id)
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* already closed */ }
      throw error
    }
  }
  return applied
}
