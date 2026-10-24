import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { backupFileDatabase, migrate, openDatabase, SCHEMA, seed } from '../src/db/database'
import { applySqlSteps, OPS_STEPS, type SqlStep } from '../src/db/sql-migrations'

describe('Pre-migration backups and older database copy migration', () => {
  it('creates a backup before applying a new migration step on a file database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-migration-backup-'))
    const dbPath = join(dir, 'test.sqlite')
    const db = openDatabase(dbPath)

    // Initial step applied
    const initialSteps: SqlStep[] = [
      { id: 'step_initial', sql: 'CREATE TABLE t1 (id TEXT PRIMARY KEY);' },
    ]
    applySqlSteps(db, initialSteps, new Date().toISOString(), backupFileDatabase)

    // Check backups folder before second step
    const backupsDir = join(dir, 'backups')
    const beforeCount = existsSync(backupsDir) ? readdirSync(backupsDir).length : 0

    // Apply second step - triggers backup
    const updatedSteps: SqlStep[] = [
      { id: 'step_initial', sql: 'CREATE TABLE t1 (id TEXT PRIMARY KEY);' },
      { id: 'step_second', sql: 'ALTER TABLE t1 ADD COLUMN val TEXT;' },
    ]
    const applied = applySqlSteps(db, updatedSteps, new Date().toISOString(), backupFileDatabase)
    expect(applied).toEqual(['step_second'])

    expect(existsSync(backupsDir)).toBe(true)
    const afterFiles = readdirSync(backupsDir).filter((f) => f.endsWith('.sqlite')).sort()
    expect(afterFiles.length).toBeGreaterThan(beforeCount)

    // Verify latest backup file is a valid database taken before step_second
    const latestBackup = afterFiles[afterFiles.length - 1]!
    const backupDb = new DatabaseSync(join(backupsDir, latestBackup))
    const row = backupDb.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
    expect(row.c).toBe(1)
    backupDb.close()
    db.close()
  })

  it('skips file backup on in-memory databases without error', () => {
    const db = openDatabase(':memory:')
    expect(() => backupFileDatabase(db)).not.toThrow()
    db.close()
  })

  it('migrates a copy of an older seeded database cleanly and preserves all data', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-older-copy-'))
    const olderDbPath = join(dir, 'older-seeded.sqlite')
    const olderDb = openDatabase(olderDbPath)

    // Run baseline schema and step 0001 only (pre-step 0002 state)
    olderDb.exec(SCHEMA)
    applySqlSteps(olderDb, [OPS_STEPS[0]!])
    seed(olderDb, new Date('2026-01-01T00:00:00Z'))

    // Verify warrants does NOT have signature_json before migration
    const beforeCols = (olderDb.prepare('PRAGMA table_info(warrants)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(beforeCols).not.toContain('signature_json')

    // Insert test proposal
    olderDb.prepare(`
      INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at)
      VALUES (?, ?, 1, 'payment', 5000, 'USD', 'Old work', 'allow', 'clause_1', 'detail_1', 'approved', '2026-01-01', '2026-01-01')
    `).run('prop_old_1', 'warrant_default')

    olderDb.close()

    // Make a seeded copy
    const copyPath = join(dir, 'copy-to-migrate.sqlite')
    copyFileSync(olderDbPath, copyPath)

    // Open the copy and run full migrate()
    const copyDb = openDatabase(copyPath)
    migrate(copyDb)

    // Verify older data survived intact
    const prop = copyDb.prepare('SELECT * FROM proposals WHERE id = ?').get('prop_old_1') as Record<string, unknown>
    expect(prop).toBeDefined()
    expect(prop.amount_cents).toBe(5000)
    expect(prop.description).toBe('Old work')

    // Verify new columns were added seamlessly
    const columns = (copyDb.prepare('PRAGMA table_info(warrants)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toContain('signature_json')

    const propColumns = (copyDb.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(propColumns).toContain('funding_capture_id')
    expect(propColumns).toContain('payout_batch_id')

    const rulesColumns = (copyDb.prepare('PRAGMA table_info(party_rules)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(rulesColumns).toContain('origin')

    copyDb.close()
  })

  it('refuses to boot if a migration checksum has been altered', () => {
    const db = openDatabase(':memory:')
    applySqlSteps(db, [{ id: 'm1', sql: 'CREATE TABLE t (id INT);' }])
    expect(() => {
      applySqlSteps(db, [{ id: 'm1', sql: 'CREATE TABLE t (id INT, tampered INT);' }])
    }).toThrow(/migration checksum changed: m1/)
    db.close()
  })
})

describe('Database backup and restore scripts (scripts/db-backup.mjs, scripts/db-restore.mjs)', () => {
  const rootDir = resolve(__dirname, '../..')
  const backupScript = join(rootDir, 'scripts/db-backup.mjs')
  const restoreScript = join(rootDir, 'scripts/db-restore.mjs')

  it('executes db:backup and creates a working sqlite backup file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-script-backup-'))
    const sourceDbPath = join(dir, 'source.sqlite')
    const sourceDb = openDatabase(sourceDbPath)
    migrate(sourceDb)
    seed(sourceDb, new Date())
    sourceDb.exec("INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at) VALUES ('p_test', 'w1', 1, 'pay', 100, 'USD', 'desc', 'allow', 'c', 'd', 'approved', 'now', 'now')")
    sourceDb.close()

    // Run db-backup script
    const output = execFileSync('node', [backupScript, sourceDbPath], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()

    expect(output).toContain('mandate-')
    expect(existsSync(output)).toBe(true)

    // Open the backup and check rows
    const backupDb = new DatabaseSync(output)
    const row = backupDb.prepare("SELECT id FROM proposals WHERE id = 'p_test'").get() as { id: string }
    expect(row.id).toBe('p_test')
    backupDb.close()
  })

  it('executes db:restore with safety validations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-script-restore-'))
    const backupPath = join(dir, 'backup.sqlite')
    const bdb = openDatabase(backupPath)
    migrate(bdb)
    bdb.exec("INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at) VALUES ('from_backup', 'w1', 1, 'pay', 999, 'USD', 'desc', 'allow', 'c', 'd', 'approved', 'now', 'now')")
    bdb.close()

    const targetDbPath = join(dir, 'target.sqlite')
    const tdb = openDatabase(targetDbPath)
    migrate(tdb)
    tdb.exec("INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at) VALUES ('original_target', 'w1', 1, 'pay', 111, 'USD', 'desc', 'allow', 'c', 'd', 'approved', 'now', 'now')")
    tdb.close()

    // 1. Calling restore without --yes must fail with exit code 2
    expect(() => {
      execFileSync('node', [restoreScript, backupPath], {
        cwd: dir,
        env: { ...process.env, DATABASE_PATH: targetDbPath },
        encoding: 'utf8',
      })
    }).toThrow()

    // 2. Calling restore on non-existent file must fail with exit code 1
    expect(() => {
      execFileSync('node', [restoreScript, join(dir, 'missing.sqlite'), '--yes'], {
        cwd: dir,
        env: { ...process.env, DATABASE_PATH: targetDbPath },
        encoding: 'utf8',
      })
    }).toThrow()

    // 3. Calling restore with --yes backs up current target and restores backup
    const output = execFileSync('node', [restoreScript, backupPath, '--yes'], {
      cwd: dir,
      env: { ...process.env, DATABASE_PATH: targetDbPath },
      encoding: 'utf8',
    })

    expect(output).toContain('before-restore-')
    expect(output).toContain(targetDbPath)

    // Target now contains rows from backup
    const restoredDb = new DatabaseSync(targetDbPath)
    const backupRow = restoredDb.prepare("SELECT id FROM proposals WHERE id = 'from_backup'").get() as { id: string }
    expect(backupRow.id).toBe('from_backup')
    const originalRow = restoredDb.prepare("SELECT id FROM proposals WHERE id = 'original_target'").get()
    expect(originalRow).toBeUndefined()
    restoredDb.close()

    // Safety backup of original target exists in dir/backups
    const backupsDir = join(dir, 'backups')
    expect(existsSync(backupsDir)).toBe(true)
    const beforeRestoreFiles = readdirSync(backupsDir).filter((f) => f.startsWith('before-restore-'))
    expect(beforeRestoreFiles.length).toBe(1)

    const safetyDb = new DatabaseSync(join(backupsDir, beforeRestoreFiles[0]!))
    const safetyRow = safetyDb.prepare("SELECT id FROM proposals WHERE id = 'original_target'").get() as { id: string }
    expect(safetyRow.id).toBe('original_target')
    safetyDb.close()
  })
})
