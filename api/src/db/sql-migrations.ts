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
  {
    id: '0003_dual_tap',
    sql: `
ALTER TABLE proposals ADD COLUMN dual_tap_expires_at TEXT;
`,
  },
  {
    // The database stops trusting the code. Until now every rule about money lived only in TypeScript: a bug, a stale
    // read or a hand-run UPDATE could rewind a paid row, edit a signed cart or rewrite history. From here the database
    // itself refuses those writes. Every guard yields to `maintenance_mode`, which only the demo reset and an operator
    // with the file in hand switch on, so nothing here can trap a real recovery.
    id: '0004_hardening',
    sql: `
CREATE TABLE IF NOT EXISTS maintenance_mode (id INTEGER PRIMARY KEY CHECK (id = 1));

-- The state machine, as data. Rewritten from domain/phases.ts at every boot, so the code and the database agree.
CREATE TABLE IF NOT EXISTS known_phases (phase TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS phase_transitions (
  from_phase TEXT NOT NULL,
  to_phase TEXT NOT NULL,
  PRIMARY KEY (from_phase, to_phase)
);

-- What a request is allowed to be. SQLite cannot add a CHECK to an existing table, so these are triggers.
CREATE TRIGGER IF NOT EXISTS proposals_valid_insert BEFORE INSERT ON proposals
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode)
BEGIN
  SELECT RAISE(ABORT, 'proposals: amount_cents must be a positive whole number of cents')
    WHERE typeof(NEW.amount_cents) != 'integer' OR NEW.amount_cents <= 0;
  SELECT RAISE(ABORT, 'proposals: kind must be payment, charge or refund') WHERE NEW.kind NOT IN ('payment', 'charge', 'refund');
  SELECT RAISE(ABORT, 'proposals: unknown gate') WHERE NEW.gate NOT IN ('DENY', 'AUTO', 'NEEDS_APPROVAL', 'DUAL_TAP');
  SELECT RAISE(ABORT, 'proposals: currency must be a three-letter code') WHERE length(NEW.currency) != 3 OR NEW.currency != upper(NEW.currency);
  SELECT RAISE(ABORT, 'proposals: unknown phase') WHERE NOT EXISTS (SELECT 1 FROM known_phases WHERE phase = NEW.phase);
END;

-- A phase only moves along an edge of the state machine. A re-read that would rewind a paid row is refused here.
CREATE TRIGGER IF NOT EXISTS proposals_phase_transition BEFORE UPDATE OF phase ON proposals
WHEN NEW.phase IS NOT OLD.phase
  AND NOT EXISTS (SELECT 1 FROM maintenance_mode)
  AND NOT EXISTS (SELECT 1 FROM phase_transitions WHERE from_phase = OLD.phase AND to_phase = NEW.phase)
BEGIN
  SELECT RAISE(ABORT, 'proposals: phase transition not allowed');
END;

-- Once a cart is locked (hashed and signed), what it pays, to whom, from what, cannot change. A lock made before
-- signing existed may be signed once, at boot; a signature is never replaced.
CREATE TRIGGER IF NOT EXISTS proposals_cart_immutable BEFORE UPDATE ON proposals
WHEN OLD.cart_hash IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM maintenance_mode)
  AND (NEW.amount_cents IS NOT OLD.amount_cents OR NEW.currency IS NOT OLD.currency OR NEW.kind IS NOT OLD.kind
    OR NEW.payee_id IS NOT OLD.payee_id OR NEW.category IS NOT OLD.category OR NEW.evidence_url IS NOT OLD.evidence_url
    OR NEW.warrant_id IS NOT OLD.warrant_id OR NEW.warrant_version IS NOT OLD.warrant_version OR NEW.job_id IS NOT OLD.job_id
    OR NEW.funding_capture_id IS NOT OLD.funding_capture_id OR NEW.deal_id IS NOT OLD.deal_id OR NEW.milestone IS NOT OLD.milestone
    OR NEW.parent_capture_id IS NOT OLD.parent_capture_id OR NEW.cart_hash IS NOT OLD.cart_hash
    OR (OLD.lock_sig IS NOT NULL AND NEW.lock_sig IS NOT OLD.lock_sig)
    OR (OLD.lock_key_id IS NOT NULL AND NEW.lock_key_id IS NOT OLD.lock_key_id))
BEGIN
  SELECT RAISE(ABORT, 'proposals: a locked cart cannot change');
END;

-- History is append-only. A correction is a new row, never an edit.
CREATE TRIGGER IF NOT EXISTS events_append_only_update BEFORE UPDATE ON events
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_delete BEFORE DELETE ON events
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS safety_events_append_only_update BEFORE UPDATE ON safety_events
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'safety events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS safety_events_append_only_delete BEFORE DELETE ON safety_events
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'safety events are append-only'); END;
-- A published version of the rules is what a lock was approved under. A change is a new version.
CREATE TRIGGER IF NOT EXISTS warrants_append_only_update BEFORE UPDATE ON warrants
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'published rules are append-only: publish a new version'); END;
CREATE TRIGGER IF NOT EXISTS warrants_append_only_delete BEFORE DELETE ON warrants
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'published rules are append-only'); END;

-- The double-entry ledger. Every movement of money is one journal entry of two or more postings that sum to zero.
-- Postings are written first and the entry header last; the header's trigger refuses an entry that does not balance,
-- and once the header exists its postings are sealed. Each entry carries the hash of the one before it.
CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  purpose TEXT NOT NULL,
  currency TEXT NOT NULL,
  delta_cents INTEGER NOT NULL,
  memo TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_proposal ON journal_entries(proposal_id, purpose);
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) DEFERRABLE INITIALLY DEFERRED,
  account TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (typeof(amount_cents) = 'integer' AND amount_cents != 0)
);
CREATE INDEX IF NOT EXISTS postings_entry ON postings(entry_id);
CREATE INDEX IF NOT EXISTS postings_account ON postings(account);
CREATE TRIGGER IF NOT EXISTS journal_balanced BEFORE INSERT ON journal_entries
BEGIN
  SELECT RAISE(ABORT, 'journal entry does not balance')
    WHERE (SELECT COALESCE(SUM(amount_cents), 0) FROM postings WHERE entry_id = NEW.id) != 0
       OR (SELECT COUNT(*) FROM postings WHERE entry_id = NEW.id) < 2;
END;
CREATE TRIGGER IF NOT EXISTS postings_sealed BEFORE INSERT ON postings
BEGIN
  SELECT RAISE(ABORT, 'journal entry is sealed') WHERE EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id);
END;
CREATE TRIGGER IF NOT EXISTS journal_append_only_update BEFORE UPDATE ON journal_entries
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_append_only_delete BEFORE DELETE ON journal_entries
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS postings_append_only_update BEFORE UPDATE ON postings
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;
CREATE TRIGGER IF NOT EXISTS postings_append_only_delete BEFORE DELETE ON postings
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'the ledger is append-only'); END;

-- Every call to PayPal that can move money, written before the call leaves and finished after it answers. A crash
-- between the two leaves a 'started' row: the server then knows money may have moved, and resumes the same call with
-- the same request id (PayPal answers a repeat with the first answer) instead of re-deciding whether to send it.
CREATE TABLE IF NOT EXISTS paypal_attempts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  op TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
  external_id TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS paypal_attempts_proposal ON paypal_attempts(proposal_id, started_at);
CREATE TRIGGER IF NOT EXISTS paypal_attempts_append_only_delete BEFORE DELETE ON paypal_attempts
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'PayPal attempts are kept'); END;

-- The webhook inbox: an event is received, processed, then done. A crash mid-way leaves it 'processing', and PayPal's
-- next retry of the same event may take it over once it is stale instead of being dropped as a duplicate.
ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'done';
ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE webhook_events ADD COLUMN processed_at TEXT;
ALTER TABLE webhook_events ADD COLUMN error TEXT;
CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events(received_at);

-- When the sweep last asked PayPal about a row. The sweep takes the least recently asked first, so a handful of rows
-- PayPal never changes cannot hold the window shut on newer ones.
ALTER TABLE proposals ADD COLUMN last_polled_at TEXT;
CREATE INDEX IF NOT EXISTS proposals_phase_polled ON proposals(phase, last_polled_at);

CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created_at);
CREATE INDEX IF NOT EXISTS events_type ON events(type, created_at);
CREATE INDEX IF NOT EXISTS proposals_payee ON proposals(payee_id, kind, phase);
`,
  },
  {
    // The dispute desk. A response to a client's PayPal dispute is built up as appended rows and never edited: the
    // draft (written by the model or by the template), each edit by the owner, the owner's approval, and the send.
    // A correction is a new row. The partial unique index below lets a dispute be sent once, whatever the code does:
    // a second 'sent' row for the same dispute is refused by the database. Every guard yields to `maintenance_mode`,
    // like the ones in 0004.
    id: '0006_disputes',
    sql: `
CREATE TABLE IF NOT EXISTS dispute_responses (
  id TEXT PRIMARY KEY,
  dispute_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  -- snapshot: what PayPal said about the dispute when we last read it. draft: text written by the model or the
  -- template. edit: the owner's own words. approval: the owner's passkey-backed yes, bound to this exact text.
  -- sent: PayPal took it. failed: PayPal refused it or could not be reached.
  kind TEXT NOT NULL CHECK (kind IN ('snapshot', 'draft', 'edit', 'approval', 'sent', 'failed')),
  text TEXT,
  text_sha256 TEXT,
  source TEXT,
  packet_sha256 TEXT,
  payload_json TEXT,
  request_id TEXT,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (dispute_id, seq)
);
CREATE INDEX IF NOT EXISTS dispute_responses_dispute ON dispute_responses(dispute_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS dispute_responses_one_send ON dispute_responses(dispute_id) WHERE kind = 'sent';
CREATE TRIGGER IF NOT EXISTS dispute_responses_append_only_update BEFORE UPDATE ON dispute_responses
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'dispute responses are append-only'); END;
CREATE TRIGGER IF NOT EXISTS dispute_responses_append_only_delete BEFORE DELETE ON dispute_responses
WHEN NOT EXISTS (SELECT 1 FROM maintenance_mode) BEGIN SELECT RAISE(ABORT, 'dispute responses are append-only'); END;
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
