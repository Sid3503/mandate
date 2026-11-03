// Puts a backup back. Stop the server first: a running server holds the files open and would write over the restore.
//
//   node scripts/db-restore.mjs <backup-folder | manifest.json | backup.sqlite> --yes
//
// A folder made by db-backup.mjs restores every file in its manifest (the ledger, the control database, each studio,
// the signing key) under the data root, the folder of DATABASE_PATH. A single .sqlite file restores only the ledger at
// DATABASE_PATH. Either way:
//   - every file's SHA-256 is checked against the manifest before anything is touched (a lone file with no manifest
//     next to it has nothing to check against, and is restored as given);
//   - what is there now is set aside under ./backups/before-restore-<time> first;
//   - the old -wal and -shm files are removed, so SQLite cannot replay a log from the old database over the new one.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, resolve, sep } from 'node:path'

const file = process.argv[2]
const yes = process.argv.includes('--yes')
if (!file || file.startsWith('--') || !yes) {
  console.error('Usage: node scripts/db-restore.mjs <backup-folder | manifest.json | backup.sqlite> --yes')
  process.exit(2)
}
const given = resolve(file)
if (!existsSync(given)) {
  console.error('backup file is missing')
  process.exit(1)
}
const target = resolve(process.env.DATABASE_PATH ?? 'api/data/mandate.sqlite')
const dataRoot = dirname(target)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** What to restore: [{ from, to, sha256? }]. */
let plan
const folder = statSync(given).isDirectory() ? given : basename(given) === 'manifest.json' ? dirname(given) : null
if (folder) {
  const manifestPath = join(folder, 'manifest.json')
  if (!existsSync(manifestPath)) {
    console.error(`no manifest.json in ${folder}`)
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  plan = manifest.files.map((entry) => {
    // A manifest is data, not a set of instructions: a path that climbs out of the data root is refused.
    const to = resolve(dataRoot, entry.path === manifest.main ? basename(target) : entry.path)
    if (!(to === dataRoot || to.startsWith(dataRoot + sep))) {
      console.error(`refusing a path outside the data root: ${entry.path}`)
      process.exit(1)
    }
    return { from: join(folder, entry.path), to, sha256: entry.sha256 }
  })
} else {
  // A single file. If it came out of a backup folder, its manifest still vouches for it.
  const manifestPath = join(dirname(given), 'manifest.json')
  let expected
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    expected = manifest.files.find((entry) => resolve(dirname(given), entry.path) === given)?.sha256
  }
  plan = [{ from: given, to: target, sha256: expected }]
}

// Check every file before touching anything, so a bad backup leaves the current data exactly as it was.
for (const step of plan) {
  if (!existsSync(step.from)) {
    console.error(`backup is incomplete, missing: ${step.from}`)
    process.exit(1)
  }
  if (step.sha256 && sha256(step.from) !== step.sha256) {
    console.error(`checksum does not match the manifest: ${step.from}`)
    process.exit(1)
  }
}

const asideRoot = resolve('backups')
const single = plan.length === 1 && !folder
for (const step of plan) {
  if (existsSync(step.to)) {
    mkdirSync(asideRoot, { recursive: true })
    const rel = step.to.slice(dataRoot.length + 1)
    const aside = single
      ? join(asideRoot, `before-restore-${stamp}.sqlite`)
      : join(asideRoot, `before-restore-${stamp}`, rel)
    mkdirSync(dirname(aside), { recursive: true })
    if (step.to.endsWith('.sqlite')) {
      // VACUUM INTO folds in whatever is still in the old write-ahead log, so the set-aside copy is complete.
      const db = new DatabaseSync(step.to)
      try {
        db.exec(`VACUUM INTO '${aside.replaceAll("'", "''")}'`)
      } finally {
        db.close()
      }
    } else {
      copyFileSync(step.to, aside)
    }
    console.log(aside)
  }
  mkdirSync(dirname(step.to), { recursive: true })
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(step.to + suffix, { force: true })
  copyFileSync(step.from, step.to)
  console.log(step.to)
}
