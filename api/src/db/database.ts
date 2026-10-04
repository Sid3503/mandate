import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LINE_STUDIO_WARRANT, WARRANT_ID, WarrantBodySchema } from '../domain/schemas'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS warrants (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  warrant_id TEXT NOT NULL,
  warrant_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  parent_capture_id TEXT,
  payee_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  category TEXT,
  description TEXT NOT NULL,
  evidence_url TEXT,
  prompt TEXT,
  gate TEXT NOT NULL,
  clause TEXT NOT NULL,
  detail TEXT NOT NULL,
  phase TEXT NOT NULL,
  cart_hash TEXT,
  order_id TEXT,
  capture_id TEXT,
  refund_id TEXT,
  approve_url TEXT,
  captured_amount_cents INTEGER,
  reserved_at TEXT,
  job_id TEXT,
  funding_capture_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS proposals_order_id ON proposals(order_id) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS proposals_capture_id ON proposals(capture_id) WHERE capture_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS proposals_reserved ON proposals(warrant_id, reserved_at);
CREATE INDEX IF NOT EXISTS proposals_parent ON proposals(parent_capture_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  type TEXT NOT NULL,
  clause TEXT,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS events_created ON events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS events_proposal ON events(proposal_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency (
  key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA)
  const columns = new Set((db.prepare('PRAGMA table_info(proposals)').all() as Array<{ name: string }>).map((column) => column.name))
  if (!columns.has('job_id')) db.exec('ALTER TABLE proposals ADD COLUMN job_id TEXT')
  if (!columns.has('funding_capture_id')) db.exec('ALTER TABLE proposals ADD COLUMN funding_capture_id TEXT')
  db.exec('CREATE INDEX IF NOT EXISTS proposals_job ON proposals(job_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS proposals_funding ON proposals(funding_capture_id)')
}

export function seed(db: DatabaseSync, now: Date): void {
  const existing = db.prepare('SELECT id FROM warrants LIMIT 1').get()
  if (existing) return
  const body = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)
  db.prepare('INSERT INTO warrants (id, version, body_json, created_at) VALUES (?, 1, ?, ?)').run(
    WARRANT_ID,
    JSON.stringify(body),
    now.toISOString(),
  )
}

export function databaseReady(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    return row?.ok === 1
  } catch {
    return false
  }
}
