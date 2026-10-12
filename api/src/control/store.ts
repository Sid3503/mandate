import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'

export type WorkspaceMode = 'default' | 'demo' | 'studio' | 'live'
export type MemberRole = 'owner' | 'approver' | 'proposer' | 'viewer' | 'payee'

export type WorkspaceRow = {
  id: string
  slug: string
  name: string
  mode: WorkspaceMode
  paypal_mode: 'fake' | 'sandbox'
  db_path: string
  status: string
  created_at: string
  expires_at: string | null
  last_active_at: string
  signing_key_sealed: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('default','demo','studio','live')),
  paypal_mode TEXT NOT NULL CHECK (paypal_mode IN ('fake','sandbox')),
  db_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_active_at TEXT NOT NULL,
  signing_key_sealed TEXT
);
CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL,
  approval_limit_cents INTEGER,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  last_seen_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  credential_id TEXT UNIQUE NOT NULL,
  public_key TEXT NOT NULL,
  alg INTEGER NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backup_state INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  idle_expires_at TEXT NOT NULL,
  abs_expires_at TEXT NOT NULL,
  ip_hash TEXT,
  ua_summary TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  member_id TEXT,
  workspace_id TEXT,
  challenge TEXT NOT NULL,
  binding_kind TEXT,
  binding_hash TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS stepup_grants (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  binding TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  workspace_id TEXT,
  member_id TEXT,
  event TEXT NOT NULL,
  result TEXT NOT NULL,
  ip_hash TEXT,
  ua_summary TEXT,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS recovery_codes (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  salt TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  label TEXT,
  approval_limit_cents INTEGER,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_refs (
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (kind, external_id)
);
CREATE TABLE IF NOT EXISTS model_usage (
  day TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, workspace_id)
);
CREATE TABLE IF NOT EXISTS auth_throttle (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
);
CREATE TRIGGER IF NOT EXISTS auth_events_no_update
BEFORE UPDATE ON auth_events
BEGIN
  SELECT RAISE(ABORT, 'auth_events is append-only');
END;
`

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function ipHash(ip: string, pepper: string): string {
  return createHash('sha256').update(`${pepper}:${ip}`).digest('hex').slice(0, 32)
}

export class ControlStore {
  constructor(private readonly db: DatabaseSync, private readonly pepper: string) {
    this.db.exec(SCHEMA)
  }

  ensureDefault(dbPath: string, now: string): void {
    const row = this.workspace('ws_default')
    if (row) return
    this.db.prepare(`INSERT INTO workspaces (id, slug, name, mode, paypal_mode, db_path, status, created_at, expires_at, last_active_at, signing_key_sealed)
      VALUES ('ws_default', 'default', 'Line Studio', 'default', 'sandbox', ?, 'active', ?, NULL, ?, NULL)`).run(dbPath, now, now)
  }

  workspace(id: string): WorkspaceRow | null {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined ?? null
  }

  insertWorkspace(row: WorkspaceRow): void {
    this.db.prepare(`INSERT INTO workspaces (id, slug, name, mode, paypal_mode, db_path, status, created_at, expires_at, last_active_at, signing_key_sealed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.slug, row.name, row.mode, row.paypal_mode, row.db_path, row.status, row.created_at, row.expires_at, row.last_active_at, row.signing_key_sealed)
  }

  touchWorkspace(id: string, now: string): void {
    this.db.prepare('UPDATE workspaces SET last_active_at = ? WHERE id = ?').run(now, id)
  }

  countActiveDemos(now: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces WHERE mode = 'demo' AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)`).get(now) as { n: number }
    return row.n
  }

  hashIp(ip: string): string {
    return ipHash(ip, this.pepper)
  }

  demosFromIp(hash: string, since: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM auth_events WHERE event = 'demo.start' AND result = 'ok' AND ip_hash = ? AND at >= ?`).get(hash, since) as { n: number }
    return row.n
  }

  expiredDemos(now: string): WorkspaceRow[] {
    return this.db.prepare(`SELECT * FROM workspaces WHERE mode = 'demo' AND expires_at IS NOT NULL AND expires_at < ?`).all(now) as WorkspaceRow[]
  }

  /** Deletes a demo workspace only. Any other mode is left untouched, even if the caller passes an old timestamp. */
  deleteDemo(id: string): boolean {
    const row = this.workspace(id)
    if (!row || row.mode !== 'demo') return false
    const members = this.db.prepare('SELECT id FROM members WHERE workspace_id = ?').all(id) as Array<{ id: string }>
    for (const member of members) {
      this.db.prepare('DELETE FROM credentials WHERE member_id = ?').run(member.id)
      this.db.prepare('DELETE FROM recovery_codes WHERE member_id = ?').run(member.id)
      this.db.prepare('DELETE FROM sessions WHERE member_id = ?').run(member.id)
    }
    this.db.prepare('DELETE FROM members WHERE workspace_id = ?').run(id)
    this.db.prepare('DELETE FROM invites WHERE workspace_id = ?').run(id)
    this.db.prepare('DELETE FROM external_refs WHERE workspace_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE workspace_id = ?').run(id)
    this.db.prepare('DELETE FROM workspaces WHERE id = ? AND mode = ?').run(id, 'demo')
    return true
  }

  addMember(input: { id: string; workspaceId: string; name: string; role: MemberRole; now: string; limit?: number | null; email?: string | null; createdBy?: string | null }): void {
    this.db.prepare(`INSERT INTO members (id, workspace_id, display_name, email, role, approval_limit_cents, status, created_at, created_by)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(input.id, input.workspaceId, input.name, input.email ?? null, input.role, input.limit ?? null, input.now, input.createdBy ?? null)
  }

  member(id: string): { id: string; workspace_id: string; display_name: string; role: MemberRole; approval_limit_cents: number | null; status: string } | null {
    return this.db.prepare('SELECT id, workspace_id, display_name, role, approval_limit_cents, status FROM members WHERE id = ?').get(id) as { id: string; workspace_id: string; display_name: string; role: MemberRole; approval_limit_cents: number | null; status: string } | undefined ?? null
  }

  members(workspaceId: string): Array<{ id: string; display_name: string; role: MemberRole; status: string; approval_limit_cents: number | null }> {
    return this.db.prepare('SELECT id, display_name, role, status, approval_limit_cents FROM members WHERE workspace_id = ? ORDER BY created_at').all(workspaceId) as Array<{ id: string; display_name: string; role: MemberRole; status: string; approval_limit_cents: number | null }>
  }

  ownerCount(workspaceId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM members WHERE workspace_id = ? AND role = 'owner' AND status = 'active'`).get(workspaceId) as { n: number }
    return row.n
  }

  setMemberRole(id: string, role: MemberRole, now: string): 'ok' | 'last-owner' | 'missing' {
    const member = this.member(id)
    if (!member || member.status !== 'active') return 'missing'
    if (member.role === 'owner' && role !== 'owner' && this.ownerCount(member.workspace_id) <= 1) return 'last-owner'
    this.db.prepare('UPDATE members SET role = ? WHERE id = ?').run(role, id)
    this.revokeSessions(id, now)
    return 'ok'
  }

  revokeMember(id: string, now: string): 'ok' | 'last-owner' | 'missing' {
    const member = this.member(id)
    if (!member || member.status === 'revoked') return 'missing'
    if (member.role === 'owner' && this.ownerCount(member.workspace_id) <= 1) return 'last-owner'
    this.db.prepare(`UPDATE members SET status = 'revoked', revoked_at = ? WHERE id = ?`).run(now, id)
    this.revokeSessions(id, now)
    return 'ok'
  }

  putSession(input: { token: string; memberId: string; workspaceId: string; method: string; now: string; idleHours: number; absoluteDays: number; ip?: string; ua?: string }): void {
    const nowMs = Date.parse(input.now)
    const idle = new Date(nowMs + input.idleHours * 3_600_000).toISOString()
    const abs = new Date(nowMs + input.absoluteDays * 86_400_000).toISOString()
    this.db.prepare(`INSERT INTO sessions (id_hash, member_id, workspace_id, method, created_at, last_seen_at, idle_expires_at, abs_expires_at, ip_hash, ua_summary)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hashToken(input.token), input.memberId, input.workspaceId, input.method, input.now, input.now, idle, abs, input.ip ? ipHash(input.ip, this.pepper) : null, input.ua?.slice(0, 80) ?? null)
  }

  session(token: string, now: string): { member_id: string; workspace_id: string; method: string; idle_expires_at: string; abs_expires_at: string } | null {
    const row = this.db.prepare(`SELECT member_id, workspace_id, method, idle_expires_at, abs_expires_at, revoked_at FROM sessions WHERE id_hash = ?`).get(hashToken(token)) as { member_id: string; workspace_id: string; method: string; idle_expires_at: string; abs_expires_at: string; revoked_at: string | null } | undefined
    if (!row || row.revoked_at) return null
    if (row.idle_expires_at <= now || row.abs_expires_at <= now) return null
    return row
  }

  touchSession(token: string, now: string, idleHours: number): void {
    const idle = new Date(Date.parse(now) + idleHours * 3_600_000).toISOString()
    this.db.prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ? AND revoked_at IS NULL').run(now, idle, hashToken(token))
  }

  revokeSession(token: string, now: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE id_hash = ?').run(now, hashToken(token))
  }

  revokeSessions(memberId: string, now: string): void {
    this.db.prepare('UPDATE sessions SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL').run(now, memberId)
  }

  listSessions(memberId: string): Array<{ id_hash: string; created_at: string; last_seen_at: string; ua_summary: string | null; revoked_at: string | null }> {
    return this.db.prepare('SELECT id_hash, created_at, last_seen_at, ua_summary, revoked_at FROM sessions WHERE member_id = ? ORDER BY created_at DESC').all(memberId) as Array<{ id_hash: string; created_at: string; last_seen_at: string; ua_summary: string | null; revoked_at: string | null }>
  }

  putChallenge(input: { id: string; purpose: string; challenge: string; expiresAt: string; memberId?: string | null; workspaceId?: string | null; bindingKind?: string | null; bindingHash?: string | null }): void {
    this.db.prepare(`INSERT INTO webauthn_challenges (id, purpose, member_id, workspace_id, challenge, binding_kind, binding_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.purpose, input.memberId ?? null, input.workspaceId ?? null, input.challenge, input.bindingKind ?? null, input.bindingHash ?? null, input.expiresAt)
  }

  /** Returns the challenge once. A second read finds it used. */
  takeChallenge(id: string, now: string): { challenge: string; purpose: string; member_id: string | null; workspace_id: string | null; binding_kind: string | null; binding_hash: string | null } | null {
    const row = this.db.prepare('SELECT challenge, purpose, member_id, workspace_id, binding_kind, binding_hash, expires_at, used_at FROM webauthn_challenges WHERE id = ?').get(id) as { challenge: string; purpose: string; member_id: string | null; workspace_id: string | null; binding_kind: string | null; binding_hash: string | null; expires_at: string; used_at: string | null } | undefined
    if (!row || row.used_at || row.expires_at <= now) return null
    this.db.prepare('UPDATE webauthn_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, id)
    return row
  }

  saveCredential(input: { id: string; memberId: string; credentialId: string; publicKey: string; alg: number; counter: number; fingerprint: string; backupEligible: boolean; backupState: boolean; now: string; transports?: string | null }): void {
    this.db.prepare(`INSERT INTO credentials (id, member_id, credential_id, public_key, alg, counter, transports, backup_eligible, backup_state, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.memberId, input.credentialId, input.publicKey, input.alg, input.counter, input.transports ?? null, input.backupEligible ? 1 : 0, input.backupState ? 1 : 0, input.fingerprint, input.now)
  }

  credential(credentialId: string): { id: string; member_id: string; credential_id: string; public_key: string; counter: number; revoked_at: string | null; fingerprint: string } | null {
    return this.db.prepare('SELECT id, member_id, credential_id, public_key, counter, revoked_at, fingerprint FROM credentials WHERE credential_id = ?').get(credentialId) as { id: string; member_id: string; credential_id: string; public_key: string; counter: number; revoked_at: string | null; fingerprint: string } | undefined ?? null
  }

  credentials(memberId: string): Array<{ id: string; credential_id: string; fingerprint: string; backup_eligible: number; backup_state: number; revoked_at: string | null }> {
    return this.db.prepare('SELECT id, credential_id, fingerprint, backup_eligible, backup_state, revoked_at FROM credentials WHERE member_id = ?').all(memberId) as Array<{ id: string; credential_id: string; fingerprint: string; backup_eligible: number; backup_state: number; revoked_at: string | null }>
  }

  setCounter(credentialId: string, counter: number, now: string): void {
    this.db.prepare('UPDATE credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?').run(counter, now, credentialId)
  }

  forceRevokeCredential(credentialId: string, now: string): void {
    this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL').run(now, credentialId)
  }

  revokeCredential(id: string, memberId: string, now: string): boolean {
    const active = this.db.prepare('SELECT COUNT(*) AS n FROM credentials WHERE member_id = ? AND revoked_at IS NULL').get(memberId) as { n: number }
    if (active.n <= 1) return false
    const result = this.db.prepare('UPDATE credentials SET revoked_at = ? WHERE id = ? AND member_id = ? AND revoked_at IS NULL').run(now, id, memberId)
    return Number(result.changes) > 0
  }

  putGrant(input: { id: string; memberId: string; workspaceId: string; kind: string; binding: string; now: string }): void {
    this.db.prepare('INSERT INTO stepup_grants (id, member_id, workspace_id, kind, binding, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(input.id, input.memberId, input.workspaceId, input.kind, input.binding, input.now)
  }

  consumeGrant(id: string, kind: string, binding: string, now: string): boolean {
    const row = this.db.prepare('SELECT used_at, kind, binding FROM stepup_grants WHERE id = ?').get(id) as { used_at: string | null; kind: string; binding: string } | undefined
    if (!row || row.used_at || row.kind !== kind || row.binding !== binding) return false
    const result = this.db.prepare('UPDATE stepup_grants SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, id)
    return Number(result.changes) === 1
  }

  event(input: { id: string; at: string; workspaceId?: string | null; memberId?: string | null; event: string; result: string; ip?: string | null; detail?: string | null }): void {
    this.db.prepare('INSERT INTO auth_events (id, at, workspace_id, member_id, event, result, ip_hash, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      input.id, input.at, input.workspaceId ?? null, input.memberId ?? null, input.event, input.result, input.ip ? ipHash(input.ip, this.pepper) : null, input.detail ?? null,
    )
  }

  events(workspaceId: string, limit = 50): Array<{ at: string; event: string; result: string; member_id: string | null }> {
    return this.db.prepare('SELECT at, event, result, member_id FROM auth_events WHERE workspace_id = ? ORDER BY at DESC LIMIT ?').all(workspaceId, limit) as Array<{ at: string; event: string; result: string; member_id: string | null }>
  }

  saveRecovery(memberId: string, codes: string[], nowIgnored = ''): void {
    void nowIgnored
    this.db.prepare('DELETE FROM recovery_codes WHERE member_id = ? AND used_at IS NULL').run(memberId)
    const insert = this.db.prepare('INSERT INTO recovery_codes (id, member_id, salt, code_hash) VALUES (?, ?, ?, ?)')
    for (const code of codes) {
      const salt = randomBytes(16).toString('base64url')
      const hash = scryptSync(code, salt, 32).toString('base64url')
      insert.run(randomBytes(16).toString('base64url'), memberId, salt, hash)
    }
  }

  /** Uses one code. Returns false when none match. A used code cannot be used again. */
  useRecovery(memberId: string, code: string, now: string): boolean {
    const rows = this.db.prepare('SELECT id, salt, code_hash FROM recovery_codes WHERE member_id = ? AND used_at IS NULL').all(memberId) as Array<{ id: string; salt: string; code_hash: string }>
    for (const row of rows) {
      const hash = scryptSync(code, row.salt, 32)
      const expected = Buffer.from(row.code_hash, 'base64url')
      if (hash.length === expected.length && timingSafeEqual(hash, expected)) {
        this.db.prepare('UPDATE recovery_codes SET used_at = ? WHERE id = ? AND used_at IS NULL').run(now, row.id)
        return true
      }
    }
    return false
  }

  createInvite(input: { id: string; workspaceId: string; role: MemberRole; token: string; expiresAt: string; createdBy: string; now: string; label?: string | null; limit?: number | null }): void {
    this.db.prepare(`INSERT INTO invites (id, workspace_id, role, label, approval_limit_cents, token_hash, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.id, input.workspaceId, input.role, input.label ?? null, input.limit ?? null, hashToken(input.token), input.expiresAt, input.createdBy, input.now)
  }

  /** One invite, one use. Two callers: the first update wins. */
  takeInvite(token: string, now: string): { id: string; workspace_id: string; role: MemberRole; label: string | null } | null {
    const row = this.db.prepare('SELECT id, workspace_id, role, label, expires_at, used_at, revoked_at FROM invites WHERE token_hash = ?').get(hashToken(token)) as { id: string; workspace_id: string; role: MemberRole; label: string | null; expires_at: string; used_at: string | null; revoked_at: string | null } | undefined
    if (!row || row.used_at || row.revoked_at || row.expires_at <= now) return null
    const result = this.db.prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, row.id)
    if (Number(result.changes) !== 1) return null
    return row
  }

  peekInvite(token: string, now: string): { workspace_id: string; role: MemberRole; label: string | null; expired: boolean } | null {
    const row = this.db.prepare('SELECT workspace_id, role, label, expires_at, used_at, revoked_at FROM invites WHERE token_hash = ?').get(hashToken(token)) as { workspace_id: string; role: MemberRole; label: string | null; expires_at: string; used_at: string | null; revoked_at: string | null } | undefined
    if (!row || row.used_at || row.revoked_at) return null
    return { workspace_id: row.workspace_id, role: row.role, label: row.label, expired: row.expires_at <= now }
  }

  rememberRef(kind: string, externalId: string, workspaceId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO external_refs (kind, external_id, workspace_id) VALUES (?, ?, ?)').run(kind, externalId, workspaceId)
  }

  workspaceForRef(kind: string, externalId: string): string | null {
    const row = this.db.prepare('SELECT workspace_id FROM external_refs WHERE kind = ? AND external_id = ?').get(kind, externalId) as { workspace_id: string } | undefined
    return row?.workspace_id ?? null
  }
}
