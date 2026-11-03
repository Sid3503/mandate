// Backs up everything the server keeps under its data root: the ledger, the control database (people, passkeys,
// sessions), every studio's own ledger under ws/, the demo template, and the signing key file. Each SQLite file is
// copied with VACUUM INTO, which is consistent even while the server is writing, and a manifest records the SHA-256 of
// every file so a restore can prove nothing was cut short or changed. Nothing in the source is deleted.
//
//   node scripts/db-backup.mjs [database-path] [--out <dir>]
//
// The database path defaults to DATABASE_PATH, then api/data/mandate.sqlite; its folder is the data root. The backup
// goes to --out, then BACKUP_DIR, then ./backups, in a folder of its own named mandate-<time>. A backup on the same
// disk as the data is lost with that disk, so the script says so when it is. It prints the copy of the main ledger.
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const args = process.argv.slice(2)
const outFlag = args.indexOf('--out')
const outArg = outFlag >= 0 ? args[outFlag + 1] : undefined
const positional = args.filter((arg, index) => !arg.startsWith('--') && (outFlag < 0 || index !== outFlag + 1))

const source = resolve(positional[0] ?? process.env.DATABASE_PATH ?? 'api/data/mandate.sqlite')
if (!existsSync(source)) {
  console.error(`database is missing: ${source}`)
  process.exit(1)
}
const dataRoot = dirname(source)
const outRoot = resolve(outArg ?? process.env.BACKUP_DIR ?? 'backups')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const dest = join(outRoot, `mandate-${stamp}`)
mkdirSync(dest, { recursive: true })

const inside = (child, parent) => child === parent || child.startsWith(parent + sep)

/**
 * Every SQLite file under the data root, skipping the backup folder itself, the server's own pre-migration copies in
 * backups/ (they are backups already), and SQLite's -wal/-shm companions (VACUUM INTO folds those in).
 */
function sqliteFiles(dir, depth = 0) {
  if (depth > 3 || inside(dir, outRoot)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'backups' || entry.name.startsWith('.')) continue
      found.push(...sqliteFiles(full, depth + 1))
    } else if (entry.isFile() && entry.name.endsWith('.sqlite')) {
      found.push(full)
    }
  }
  return found
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

const files = []
const targets = [...new Set([source, ...sqliteFiles(dataRoot)])]
for (const file of targets) {
  const rel = relative(dataRoot, file)
  const copy = join(dest, rel)
  mkdirSync(dirname(copy), { recursive: true })
  const db = new DatabaseSync(file)
  try {
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`)
  } finally {
    db.close()
  }
  files.push({ path: rel, kind: 'sqlite', sha256: sha256(copy), bytes: statSync(copy).size })
}

// The development signing key lives next to the ledger. Without it, receipts signed before the backup stop verifying.
const keyFile = join(dataRoot, 'signing-key.pem')
if (existsSync(keyFile)) {
  copyFileSync(keyFile, join(dest, 'signing-key.pem'))
  files.push({ path: 'signing-key.pem', kind: 'key', sha256: sha256(join(dest, 'signing-key.pem')), bytes: statSync(keyFile).size })
}

const manifest = { version: 1, createdAt: new Date().toISOString(), dataRoot, main: relative(dataRoot, source), files }
writeFileSync(join(dest, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

try {
  if (statSync(outRoot).dev === statSync(dataRoot).dev) {
    console.error(`warning: ${dest} is on the same disk as ${dataRoot}. Copy it somewhere else (--out or BACKUP_DIR) to survive losing that disk.`)
  }
} catch {
  // Not knowing the disk is not a reason to fail a backup.
}
console.error(`backed up ${files.length} file(s) from ${dataRoot} to ${dest}`)
console.log(join(dest, basename(source)))
