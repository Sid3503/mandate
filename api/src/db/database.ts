import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEMO_BUYER_RULES, DEMO_SELLER_RULES, PartyRulesSchema } from '../domain/deal'
import { LINE_STUDIO_WARRANT, WARRANT_ID, WarrantBodySchema } from '../domain/schemas'

/** Northwind, the demo client. Its deal rules are keyed by the client id on the warrant. */
export const BUYER_PARTY_ID = 'client_northwind'

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
  payout_batch_id TEXT,
  payout_item_id TEXT,
  payout_status TEXT,
  payout_txn_id TEXT,
  payout_fee_cents INTEGER,
  deal_id TEXT,
  milestone INTEGER,
  lock_sig TEXT,
  lock_key_id TEXT,
  invoice_id TEXT,
  invoice_url TEXT,
  invoice_status TEXT,
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

CREATE TABLE IF NOT EXISTS party_rules (
  party_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (party_id, version)
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  buyer_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  offered_by TEXT NOT NULL,
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  job_id TEXT,
  terms_json TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  buyer_rules_version INTEGER NOT NULL,
  seller_rules_version INTEGER NOT NULL,
  terms_hash TEXT NOT NULL,
  sig TEXT,
  key_id TEXT,
  run_id TEXT,
  prompt TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deals_thread ON deals(thread_id, created_at);
CREATE INDEX IF NOT EXISTS deals_created ON deals(created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id),
  milestone INTEGER NOT NULL,
  proof_url TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  delivered_by TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT,
  decided_by TEXT,
  run_id TEXT,
  sig TEXT,
  key_id TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS deliveries_deal ON deliveries(deal_id, milestone, created_at);

CREATE TABLE IF NOT EXISTS webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS paypal_disputes (
  dispute_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT,
  amount_cents INTEGER,
  currency TEXT,
  opened_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paypal_disputes_txn ON paypal_disputes(transaction_id);

CREATE TABLE IF NOT EXISTS signing_keys (
  key_id TEXT PRIMARY KEY,
  public_pem TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  actor TEXT NOT NULL,
  conversation_id TEXT,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT,
  trace_json TEXT NOT NULL,
  error TEXT,
  ms INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_runs_conversation ON agent_runs(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS client_errors (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  stack TEXT,
  url TEXT,
  agent TEXT,
  release_id TEXT
);
CREATE INDEX IF NOT EXISTS client_errors_at ON client_errors(at);

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
  for (const [name, type] of [['deal_id', 'TEXT'], ['milestone', 'INTEGER'], ['lock_sig', 'TEXT'], ['lock_key_id', 'TEXT'], ['invoice_id', 'TEXT'], ['invoice_url', 'TEXT'], ['invoice_status', 'TEXT']] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${type}`)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS proposals_invoice ON proposals(invoice_id) WHERE invoice_id IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS proposals_deal ON proposals(deal_id, milestone)')
  for (const [name, type] of [['payout_batch_id', 'TEXT'], ['payout_item_id', 'TEXT'], ['payout_status', 'TEXT'], ['payout_txn_id', 'TEXT'], ['payout_fee_cents', 'INTEGER']] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE proposals ADD COLUMN ${name} ${type}`)
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS proposals_payout_batch ON proposals(payout_batch_id) WHERE payout_batch_id IS NOT NULL')
  db.exec('CREATE INDEX IF NOT EXISTS proposals_job ON proposals(job_id, created_at)')
  db.exec('CREATE INDEX IF NOT EXISTS proposals_funding ON proposals(funding_capture_id)')
  // What each agent run cost and which wording produced it, so "why did it say that?" and "what does it cost?" have answers.
  const runColumns = new Set((db.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name))
  for (const [name, type] of [['prompt_version', 'TEXT'], ['input_tokens', 'INTEGER'], ['output_tokens', 'INTEGER'], ['turns', 'INTEGER']] as const) {
    if (!runColumns.has(name)) db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${type}`)
  }
}

export function seed(db: DatabaseSync, now: Date): void {
  const existing = db.prepare('SELECT id FROM warrants LIMIT 1').get()
  if (!existing) {
    const body = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)
    db.prepare('INSERT INTO warrants (id, version, body_json, created_at) VALUES (?, 1, ?, ?)').run(
      WARRANT_ID,
      JSON.stringify(body),
      now.toISOString(),
    )
  }
  // Each company's deal rules are versioned data too. Seeded once per party, never overwritten.
  const seedRules = db.prepare('INSERT OR IGNORE INTO party_rules (party_id, version, body_json, created_at) VALUES (?, 1, ?, ?)')
  seedRules.run(BUYER_PARTY_ID, JSON.stringify(PartyRulesSchema.parse(DEMO_BUYER_RULES)), now.toISOString())
  seedRules.run(WARRANT_ID, JSON.stringify(PartyRulesSchema.parse(DEMO_SELLER_RULES)), now.toISOString())
}

export function databaseReady(db: DatabaseSync): boolean {
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
    return row?.ok === 1
  } catch {
    return false
  }
}
