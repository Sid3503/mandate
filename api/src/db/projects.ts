import type { DatabaseSync } from 'node:sqlite'

/**
 * Storage for two-sided projects. Plain rows, no decisions: the ProjectService decides, this only reads and writes.
 */

export type ProjectRow = {
  id: string
  job_id: string
  client_id: string
  client_name: string
  client_email: string | null
  title: string
  summary: string
  brief: string
  brief_source: string | null
  currency: string
  category: string
  review_days: number
  revise_days: number
  questions_json: string
  status: 'draft' | 'sent' | 'changes' | 'agreed' | 'done' | 'cancelled'
  plan_version: number
  agreed_version: number | null
  deal_id: string | null
  created_by: string
  created_at: string
  updated_at: string
}

export type StageStatus = 'open' | 'delivered' | 'held' | 'changes' | 'released' | 'cancelled' | 'removed'

export type StageRow = {
  id: string
  project_id: string
  position: number
  title: string
  description: string
  deliverables_json: string
  amount_cents: number
  due_date: string
  status: StageStatus
  milestone: number | null
  charge_id: string | null
  round: number
  review_ends_at: string | null
  revise_by: string | null
  released_by: string | null
  created_at: string
  updated_at: string
}

export type PlanRow = {
  project_id: string
  version: number
  terms_json: string
  terms_hash: string
  status: 'sent' | 'agreed' | 'changes' | 'superseded'
  sent_by: string
  sent_at: string
  studio_sig: string
  studio_key_id: string
  decided_at: string | null
  client_note: string | null
  client_sig: string | null
  client_key_id: string | null
  deal_id: string | null
}

export type FileRow = {
  id: string
  project_id: string
  stage_id: string
  round: number
  name: string
  mime: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  kind: 'image' | 'file'
  uploaded_by: string
  uploaded_at: string
  removed_at: string | null
}

export type DeliveryRow = {
  id: string
  project_id: string
  stage_id: string
  round: number
  manifest_json: string
  manifest_hash: string
  check_json: string | null
  sent_by: string
  sent_at: string
  charge_id: string | null
}

export type LinkRow = { id: string; project_id: string; secret_hash: string; created_at: string; revoked_at: string | null; last_seen_at: string | null; views: number }
export type RequestRow = { id: string; project_id: string; stage_id: string | null; kind: 'stage_changes' | 'plan_changes'; note: string; at: string; resolved_at: string | null }
export type ReleaseRow = { stage_id: string; project_id: string; charge_id: string; manifest_hash: string; decided_by: 'client' | 'review_window'; sig: string; key_id: string; at: string }
export type ReviewRow = { id: string; project_id: string; stars: number; text: string; capture_ids_json: string; sig: string; key_id: string; at: string }
export type ActivityRow = { id: string; project_id: string; stage_id: string | null; kind: string; text: string; at: string }
export type ViewRow = { id: string; project_id: string; stage_id: string; file_id: string; kind: 'open' | 'closeup' | 'download'; session_code: string; at: string }
export type ReminderRow = { id: string; project_id: string; stage_id: string; n: number; tone: string; text: string; written_by: string; at: string }
export type ProfileRow = { id: 1; handle: string; display_name: string; headline: string; bio: string; website: string | null; email: string | null; updated_at: string }

export class ProjectRepo {
  constructor(private readonly db: DatabaseSync) {}

  // projects
  insertProject(row: ProjectRow): void {
    this.db.prepare(`INSERT INTO projects (id, job_id, client_id, client_name, client_email, title, summary, brief, brief_source, currency, category, review_days, revise_days, questions_json, status, plan_version, agreed_version, deal_id, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.job_id, row.client_id, row.client_name, row.client_email, row.title, row.summary, row.brief, row.brief_source, row.currency, row.category, row.review_days, row.revise_days, row.questions_json, row.status, row.plan_version, row.agreed_version, row.deal_id, row.created_by, row.created_at, row.updated_at)
  }
  project(id: string): ProjectRow | null { return (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null }
  projectByJob(jobId: string): ProjectRow | null { return (this.db.prepare('SELECT * FROM projects WHERE job_id = ?').get(jobId) as ProjectRow | undefined) ?? null }
  projects(): ProjectRow[] { return this.db.prepare(`SELECT * FROM projects WHERE status != 'cancelled' ORDER BY created_at DESC`).all() as ProjectRow[] }
  allProjects(): ProjectRow[] { return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as ProjectRow[] }
  updateProject(id: string, patch: Partial<Pick<ProjectRow, 'title' | 'summary' | 'status' | 'plan_version' | 'agreed_version' | 'deal_id' | 'review_days' | 'revise_days' | 'questions_json'>>, now: string): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    this.db.prepare(`UPDATE projects SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => patch[key] as string | number | null), now, id)
  }
  isProjectDeal(dealId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM project_plans WHERE deal_id = ? LIMIT 1').get(dealId))
  }

  // stages
  insertStage(row: StageRow): void {
    this.db.prepare(`INSERT INTO project_stages (id, project_id, position, title, description, deliverables_json, amount_cents, due_date, status, milestone, charge_id, round, review_ends_at, revise_by, released_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.id, row.project_id, row.position, row.title, row.description, row.deliverables_json, row.amount_cents, row.due_date, row.status, row.milestone, row.charge_id, row.round, row.review_ends_at, row.revise_by, row.released_by, row.created_at, row.updated_at)
  }
  stage(id: string): StageRow | null { return (this.db.prepare('SELECT * FROM project_stages WHERE id = ?').get(id) as StageRow | undefined) ?? null }
  stages(projectId: string): StageRow[] { return this.db.prepare(`SELECT * FROM project_stages WHERE project_id = ? AND status != 'removed' ORDER BY position`).all(projectId) as StageRow[] }
  allStages(): StageRow[] { return this.db.prepare(`SELECT * FROM project_stages WHERE status != 'removed'`).all() as StageRow[] }
  stageByCharge(chargeId: string): StageRow | null { return (this.db.prepare('SELECT * FROM project_stages WHERE charge_id = ?').get(chargeId) as StageRow | undefined) ?? null }
  updateStage(id: string, patch: Partial<Omit<StageRow, 'id' | 'project_id' | 'created_at' | 'updated_at'>>, now: string): void {
    const keys = Object.keys(patch) as Array<keyof typeof patch>
    if (keys.length === 0) return
    this.db.prepare(`UPDATE project_stages SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((key) => patch[key] as string | number | null), now, id)
  }
  stagesDueForRelease(nowIso: string): StageRow[] {
    return this.db.prepare(`SELECT * FROM project_stages WHERE status = 'held' AND review_ends_at IS NOT NULL AND review_ends_at <= ?`).all(nowIso) as StageRow[]
  }

  // plans
  insertPlan(row: PlanRow): void {
    this.db.prepare(`INSERT INTO project_plans (project_id, version, terms_json, terms_hash, status, sent_by, sent_at, studio_sig, studio_key_id, decided_at, client_note, client_sig, client_key_id, deal_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.project_id, row.version, row.terms_json, row.terms_hash, row.status, row.sent_by, row.sent_at, row.studio_sig, row.studio_key_id, row.decided_at, row.client_note, row.client_sig, row.client_key_id, row.deal_id)
  }
  plan(projectId: string, version: number): PlanRow | null { return (this.db.prepare('SELECT * FROM project_plans WHERE project_id = ? AND version = ?').get(projectId, version) as PlanRow | undefined) ?? null }
  plans(projectId: string): PlanRow[] { return this.db.prepare('SELECT * FROM project_plans WHERE project_id = ? ORDER BY version').all(projectId) as PlanRow[] }
  decidePlan(projectId: string, version: number, patch: { status: PlanRow['status']; decidedAt?: string; note?: string | null; sig?: string | null; keyId?: string | null; dealId?: string | null }): void {
    this.db.prepare('UPDATE project_plans SET status = ?, decided_at = COALESCE(?, decided_at), client_note = COALESCE(?, client_note), client_sig = COALESCE(?, client_sig), client_key_id = COALESCE(?, client_key_id), deal_id = COALESCE(?, deal_id) WHERE project_id = ? AND version = ?')
      .run(patch.status, patch.decidedAt ?? null, patch.note ?? null, patch.sig ?? null, patch.keyId ?? null, patch.dealId ?? null, projectId, version)
  }

  // links
  insertLink(row: LinkRow): void { this.db.prepare('INSERT INTO project_links (id, project_id, secret_hash, created_at, revoked_at, last_seen_at, views) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.secret_hash, row.created_at, row.revoked_at, row.last_seen_at, row.views) }
  link(id: string): LinkRow | null { return (this.db.prepare('SELECT * FROM project_links WHERE id = ?').get(id) as LinkRow | undefined) ?? null }
  activeLink(projectId: string): LinkRow | null { return (this.db.prepare('SELECT * FROM project_links WHERE project_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1').get(projectId) as LinkRow | undefined) ?? null }
  revokeLinks(projectId: string, now: string): void { this.db.prepare('UPDATE project_links SET revoked_at = ? WHERE project_id = ? AND revoked_at IS NULL').run(now, projectId) }
  noteLinkSeen(id: string, now: string): void { this.db.prepare('UPDATE project_links SET last_seen_at = ?, views = views + 1 WHERE id = ?').run(now, id) }

  // files
  putBlob(sha256: string, bytes: Uint8Array, now: string): void { this.db.prepare('INSERT OR IGNORE INTO project_blobs (sha256, bytes, size, created_at) VALUES (?, ?, ?, ?)').run(sha256, bytes, bytes.length, now) }
  blob(sha256: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM project_blobs WHERE sha256 = ?').get(sha256) as { bytes: Uint8Array } | undefined
    return row ? row.bytes : null
  }
  insertFile(row: FileRow): void {
    this.db.prepare(`INSERT INTO project_files (id, project_id, stage_id, round, name, mime, size, sha256, width, height, kind, uploaded_by, uploaded_at, removed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.project_id, row.stage_id, row.round, row.name, row.mime, row.size, row.sha256, row.width, row.height, row.kind, row.uploaded_by, row.uploaded_at, row.removed_at)
  }
  file(id: string): FileRow | null { return (this.db.prepare('SELECT * FROM project_files WHERE id = ?').get(id) as FileRow | undefined) ?? null }
  filesForRound(stageId: string, round: number): FileRow[] { return this.db.prepare('SELECT * FROM project_files WHERE stage_id = ? AND round = ? AND removed_at IS NULL ORDER BY uploaded_at, name').all(stageId, round) as FileRow[] }
  removeFile(id: string, now: string): void { this.db.prepare('UPDATE project_files SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(now, id) }

  // deliveries
  insertDelivery(row: DeliveryRow): void {
    this.db.prepare(`INSERT INTO project_deliveries (id, project_id, stage_id, round, manifest_json, manifest_hash, check_json, sent_by, sent_at, charge_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.project_id, row.stage_id, row.round, row.manifest_json, row.manifest_hash, row.check_json, row.sent_by, row.sent_at, row.charge_id)
  }
  delivery(id: string): DeliveryRow | null { return (this.db.prepare('SELECT * FROM project_deliveries WHERE id = ?').get(id) as DeliveryRow | undefined) ?? null }
  latestDelivery(stageId: string): DeliveryRow | null { return (this.db.prepare('SELECT * FROM project_deliveries WHERE stage_id = ? ORDER BY round DESC LIMIT 1').get(stageId) as DeliveryRow | undefined) ?? null }
  deliveries(stageId: string): DeliveryRow[] { return this.db.prepare('SELECT * FROM project_deliveries WHERE stage_id = ? ORDER BY round').all(stageId) as DeliveryRow[] }
  firstDelivery(stageId: string): DeliveryRow | null { return (this.db.prepare('SELECT * FROM project_deliveries WHERE stage_id = ? ORDER BY round ASC LIMIT 1').get(stageId) as DeliveryRow | undefined) ?? null }
  setDeliveryCharge(id: string, chargeId: string): void { this.db.prepare('UPDATE project_deliveries SET charge_id = ? WHERE id = ?').run(chargeId, id) }

  // client actions
  insertRequest(row: RequestRow): void { this.db.prepare('INSERT INTO project_requests (id, project_id, stage_id, kind, note, at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.stage_id, row.kind, row.note, row.at, row.resolved_at) }
  openRequests(projectId: string): RequestRow[] { return this.db.prepare('SELECT * FROM project_requests WHERE project_id = ? AND resolved_at IS NULL ORDER BY at').all(projectId) as RequestRow[] }
  requests(projectId: string): RequestRow[] { return this.db.prepare('SELECT * FROM project_requests WHERE project_id = ? ORDER BY at').all(projectId) as RequestRow[] }
  resolveRequests(projectId: string, stageId: string | null, now: string): void {
    if (stageId) this.db.prepare('UPDATE project_requests SET resolved_at = ? WHERE project_id = ? AND stage_id = ? AND resolved_at IS NULL').run(now, projectId, stageId)
    else this.db.prepare(`UPDATE project_requests SET resolved_at = ? WHERE project_id = ? AND kind = 'plan_changes' AND resolved_at IS NULL`).run(now, projectId)
  }
  insertRelease(row: ReleaseRow): void { this.db.prepare('INSERT OR IGNORE INTO project_releases (stage_id, project_id, charge_id, manifest_hash, decided_by, sig, key_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.stage_id, row.project_id, row.charge_id, row.manifest_hash, row.decided_by, row.sig, row.key_id, row.at) }
  release(stageId: string): ReleaseRow | null { return (this.db.prepare('SELECT * FROM project_releases WHERE stage_id = ?').get(stageId) as ReleaseRow | undefined) ?? null }
  releasesPending(): ReleaseRow[] {
    return this.db.prepare(`SELECT r.* FROM project_releases r JOIN project_stages s ON s.id = r.stage_id WHERE s.status IN ('held', 'changes')`).all() as ReleaseRow[]
  }
  insertReview(row: ReviewRow): void { this.db.prepare('INSERT INTO project_reviews (id, project_id, stars, text, capture_ids_json, sig, key_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.stars, row.text, row.capture_ids_json, row.sig, row.key_id, row.at) }
  review(projectId: string): ReviewRow | null { return (this.db.prepare('SELECT * FROM project_reviews WHERE project_id = ?').get(projectId) as ReviewRow | undefined) ?? null }
  reviews(): ReviewRow[] { return this.db.prepare('SELECT * FROM project_reviews ORDER BY at DESC').all() as ReviewRow[] }

  // what happened
  insertActivity(row: ActivityRow): void { this.db.prepare('INSERT INTO project_activity (id, project_id, stage_id, kind, text, at) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.stage_id, row.kind, row.text, row.at) }
  activity(projectId: string | null, limit = 50): ActivityRow[] {
    return (projectId
      ? this.db.prepare('SELECT * FROM project_activity WHERE project_id = ? ORDER BY at DESC, rowid DESC LIMIT ?').all(projectId, limit)
      : this.db.prepare('SELECT * FROM project_activity ORDER BY at DESC, rowid DESC LIMIT ?').all(limit)) as ActivityRow[]
  }
  insertView(row: ViewRow): void { this.db.prepare('INSERT INTO project_views (id, project_id, stage_id, file_id, kind, session_code, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.stage_id, row.file_id, row.kind, row.session_code, row.at) }
  views(stageId: string): ViewRow[] { return this.db.prepare('SELECT * FROM project_views WHERE stage_id = ? ORDER BY at').all(stageId) as ViewRow[] }
  insertReminder(row: ReminderRow): void { this.db.prepare('INSERT INTO project_reminders (id, project_id, stage_id, n, tone, text, written_by, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(row.id, row.project_id, row.stage_id, row.n, row.tone, row.text, row.written_by, row.at) }
  reminders(stageId: string): ReminderRow[] { return this.db.prepare('SELECT * FROM project_reminders WHERE stage_id = ? ORDER BY at').all(stageId) as ReminderRow[] }

  // profile
  profile(): ProfileRow | null { return (this.db.prepare('SELECT * FROM studio_profile WHERE id = 1').get() as ProfileRow | undefined) ?? null }
  saveProfile(row: Omit<ProfileRow, 'id'>): void {
    this.db.prepare(`INSERT INTO studio_profile (id, handle, display_name, headline, bio, website, email, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name, headline = excluded.headline, bio = excluded.bio, website = excluded.website, email = excluded.email, updated_at = excluded.updated_at`)
      .run(row.handle, row.display_name, row.headline, row.bio, row.website, row.email, row.updated_at)
  }
}
