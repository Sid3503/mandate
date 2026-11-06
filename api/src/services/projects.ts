import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { DealRow, Repo } from '../db/repo'
import { ProjectRepo, type DeliveryRow, type FileRow, type PlanRow, type ProjectRow, type StageRow } from '../db/projects'
import { DealTermsSchema, type DealTerms } from '../domain/deal'
import { stableHash } from '../domain/hash'
import { fullPhase, fundedPhase, DEAD_PHASES } from '../domain/phases'
import {
  addDays, cleanName, manifestFor, manifestHash, mergeCheck, owedSummary, planDiff, planTerms, ProjectInputSchema, ruleCheck, sha256Hex, sniff, StageInputSchema, termsHash,
  type DeliveryCheck, type FileFacts, type Manifest, type PlanTerms, type ProjectInput, type StageInput,
} from '../domain/project'
import { ProposalCreateSchema, WARRANT_ID } from '../domain/schemas'
import { dealMessage, planDecisionMessage, planMessage, releaseMessage, reviewMessage, type Signer } from '../domain/signing'
import { Problem } from '../http/problem'
import type { AgentModel } from '../agents/model'
import { draftReminder, lookAtDelivery, scopePlan } from '../agents/projectAgents'
import { importBrief } from './briefImport'
import type { MandateService } from './mandate'
import { actorLabel, type Principal } from './principal'
import { closeup, forModel, imageSize, readableImage, reviewCopy, sealedThumb } from './sealed'
import { live, stamp } from './live'

/**
 * Two-sided projects: nobody goes first.
 *
 *   1. The studio turns a brief into a plan (a model drafts it, code reads it back against the brief) and sends it. The
 *      studio's signature covers the plan's hash.
 *   2. The client opens a private link (no account) and approves the plan or asks for changes. Approval is recorded and
 *      signed, and the plan becomes a signed deal: from then on, the gate refuses any bill on this job that is not one
 *      of its stages, once, for exactly its price.
 *   3. The studio uploads a stage's files. They are fingerprinted (SHA-256), checked against what the stage promised,
 *      and sent sealed. The stage's bill is an ordinary charge through the gate, and its proof is the manifest's hash,
 *      so the signed lock names the exact bytes delivered.
 *   4. The client pays into a PayPal hold (intent AUTHORIZE): the money is reserved on their side, not the studio's.
 *      They review watermarked copies; the originals never leave the server.
 *   5. They approve (the hold is captured, the files unlock, a contractor's standing share is paid from the captured
 *      money), ask for changes (the money stays held, the studio gets a revision deadline), or, if the studio misses
 *      that deadline, cancel (the hold is voided: they were never charged). Silence past the review window they agreed
 *      to releases the money, so a client cannot stall a studio.
 */

const MAX_FILE = 15 * 1024 * 1024
const MAX_FILES_PER_ROUND = 20
const SESSION_MS = 10 * 60_000
const CLOSEUPS_PER_SESSION = 12
const DAY = 86_400_000

type Session = { code: string; projectId: string; linkId: string; fileId: string; expiresAt: number; closeups: number }

export type ProjectDeps = { db: DatabaseSync; repo: Repo; mandate: MandateService; signer: Signer; now: () => Date; publicUrl: string; workspaceId?: string; models?: () => { primary: AgentModel | null; fallback: AgentModel | null }; paypalEnvironment?: 'sandbox' | 'live' }

export class ProjectService {
  readonly store: ProjectRepo
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly deps: ProjectDeps) {
    this.store = new ProjectRepo(deps.db)
  }

  private iso(): string { return this.deps.now().toISOString() }
  private models() { return this.modelSource?.() ?? this.deps.models?.() ?? { primary: null, fallback: null } }
  private modelSource: (() => { primary: AgentModel | null; fallback: AgentModel | null }) | null = null
  /** The app hands over its models after the services are built. */
  useModels(source: () => { primary: AgentModel | null; fallback: AgentModel | null }): void { this.modelSource = source }

  private require(id: string): ProjectRow {
    const row = this.store.project(id)
    if (!row) throw new Problem(404, 'project.missing', 'No such project', 'No project matches that id.')
    return row
  }

  private requireStage(projectId: string, stageId: string): StageRow {
    const stage = this.store.stage(stageId)
    if (!stage || stage.project_id !== projectId || stage.status === 'removed') throw new Problem(404, 'stage.missing', 'No such stage', 'That stage is not on this project.')
    return stage
  }

  private note(projectId: string, stageId: string | null, kind: string, text: string, at = this.iso()): void {
    this.store.insertActivity({ id: randomUUID(), project_id: projectId, stage_id: stageId, kind, text, at })
    live.publish({ type: 'changed', scope: 'projects', what: kind, id: projectId, at: stamp() })
  }

  private studioName(): string {
    return this.store.profile()?.display_name ?? 'The studio'
  }

  // ---------- drafting ----------

  /** A brief in, a priced plan out. The model drafts; code reads the plan back against the brief and flags what it finds. */
  async draft(input: { brief: string; rate?: string | null; currency?: string }) {
    const brief = input.brief.trim()
    if (brief.length < 20) throw new Problem(422, 'brief.short', 'Give a bit more of the brief', 'Paste the client\'s message, email or call notes: at least a sentence or two.')
    const { primary, fallback } = this.models()
    const warrant = this.deps.repo.latestWarrant()
    const plan = await scopePlan({ brief, rate: input.rate ?? null, currency: input.currency ?? warrant?.body.currency ?? 'USD', today: this.iso(), model: primary, fallback })
    return { ...plan, categories: warrant?.body.categories ?? [], currency: input.currency ?? warrant?.body.currency ?? 'USD' }
  }

  async importBrief(file: { name: string; bytes: Uint8Array }) {
    const { primary, fallback } = this.models()
    return importBrief(file, [primary, fallback])
  }

  // ---------- creating and editing the plan ----------

  /**
   * Creates a project from a plan the studio has checked. A client not yet on the rules is added to them as a new rules
   * version (money in from a new client is the owner's call, so only the owner may do this). Nothing is sent yet.
   */
  create(raw: unknown, who: Principal) {
    const input = ProjectInputSchema.parse(raw)
    const warrant = this.deps.repo.latestWarrant()
    if (!warrant) throw new Problem(409, 'warrant.missing', 'Set up the rules first', 'A project bills a client through the rules, so the rules must exist.')
    if (!warrant.body.categories.includes(input.category)) throw new Problem(422, 'project.category', 'That kind of work is not on your rules', `Pick one of: ${warrant.body.categories.join(', ')}.`)
    if (input.currency !== warrant.body.currency) throw new Problem(422, 'project.currency', 'That currency is not on your rules', `Your rules bill in ${warrant.body.currency}.`)
    this.checkStages(input.stages)
    const client = this.ensureClient(input.clientName, input.clientEmail, who)
    const now = this.iso()
    const id = `prj_${randomBytes(6).toString('hex')}`
    const jobId = `job_${slugOf(input.clientName)}_${id.slice(4, 10)}`
    this.deps.repo.transaction(() => {
      this.store.insertProject({ id, job_id: jobId, client_id: client.id, client_name: client.displayName, client_email: input.clientEmail, title: input.title, summary: input.summary, brief: input.brief, brief_source: input.briefSource, currency: input.currency, category: input.category, review_days: input.reviewDays, revise_days: input.reviseDays, questions_json: JSON.stringify(input.questions), status: 'draft', plan_version: 0, agreed_version: null, deal_id: null, created_by: actorLabel(who), created_at: now, updated_at: now })
      input.stages.forEach((stage, index) => this.store.insertStage({ id: `stg_${randomBytes(6).toString('hex')}`, project_id: id, position: index, title: stage.title, description: stage.description, deliverables_json: JSON.stringify(stage.deliverables), amount_cents: stage.amountCents, due_date: stage.dueDate, status: 'open', milestone: null, charge_id: null, round: 0, review_ends_at: null, revise_by: null, released_by: null, created_at: now, updated_at: now }))
      this.note(id, null, 'project.created', `Project created for ${client.displayName}: ${input.stages.length} stages, ${money(input.stages.reduce((sum, stage) => sum + stage.amountCents, 0), input.currency)}.`, now)
    })
    return this.studioView(id)
  }

  private checkStages(stages: StageInput[]) {
    const today = this.iso().slice(0, 10)
    for (const stage of stages) if (stage.dueDate < today) throw new Problem(422, 'project.due_past', 'A stage is due in the past', `${stage.title} is due ${stage.dueDate}.`)
    const warrant = this.deps.repo.latestWarrant()?.body
    if (warrant) for (const stage of stages) if (stage.amountCents > warrant.perPaymentCeilingCents) throw new Problem(422, 'project.over_ceiling', 'A stage is over your one-payment ceiling', `${stage.title} is ${money(stage.amountCents, warrant.currency)}; your rules refuse any single payment over ${money(warrant.perPaymentCeilingCents, warrant.currency)}. Split it, or raise the ceiling in Rules.`)
  }

  /** The client on the rules, found by email, or added to them as a new version when the owner creates the project. */
  private ensureClient(name: string, email: string, who: Principal): { id: string; displayName: string } {
    const record = this.deps.repo.latestWarrant()!
    const found = record.body.clients.find((client) => client.email.toLowerCase() === email.toLowerCase())
    if (found) return found
    if (who.role !== 'owner') throw new Problem(403, 'project.client_new', 'Only the owner can add a new client', `${name} is not on your rules yet. Ask the owner to create this project.`)
    const taken = new Set([...record.body.clients.map((client) => client.id), ...record.body.payees.map((payee) => payee.id)])
    let id = `client_${slugOf(name)}`.slice(0, 60)
    for (let n = 2; taken.has(id); n += 1) id = `client_${slugOf(name)}_${n}`.slice(0, 64)
    const client = { id, displayName: name.trim().slice(0, 120), email, aliases: [name.trim().slice(0, 120)] }
    this.deps.mandate.publishWarrant({ ...record.body, clients: [...record.body.clients, client] }, record.version)
    return client
  }

  /**
   * Edits the plan. Stages under way (delivered, held, released) keep their terms; open stages can change, be added or
   * removed. If the client had approved the plan, the new terms go back to them: they cannot pay for an open stage until
   * they approve again, and they see exactly what changed.
   */
  editPlan(projectId: string, raw: unknown, who: Principal) {
    const project = this.require(projectId)
    const parsed = (Array.isArray((raw as { stages?: unknown })?.stages) ? (raw as { stages: unknown[] }).stages : []).map((stage) => StageInputSchema.parse(stage))
    if (parsed.length === 0) throw new Problem(422, 'project.stages', 'Keep at least one stage', 'A plan needs a stage.')
    const extra = raw as { title?: string; summary?: string; reviewDays?: number; reviseDays?: number }
    const now = this.iso()
    const current = this.store.stages(projectId)
    const byId = new Map(current.map((stage) => [stage.id, stage]))
    const kept = new Set(parsed.map((stage) => stage.id).filter(Boolean) as string[])
    const changes: string[] = []
    for (const stage of current) {
      if (!kept.has(stage.id) && stage.status !== 'open' && stage.status !== 'cancelled') throw new Problem(409, 'stage.under_way', `${stage.title} is under way`, 'A stage with work delivered or money held stays in the plan.')
    }
    this.checkStages(parsed.filter((stage) => !stage.id || byId.get(stage.id)?.status === 'open'))
    this.deps.repo.transaction(() => {
      parsed.forEach((stage, index) => {
        const was = stage.id ? byId.get(stage.id) : undefined
        if (stage.id && !was) throw new Problem(404, 'stage.missing', 'A stage in this plan no longer exists', 'Reload and try again.')
        if (was) {
          const same = was.title === stage.title && was.amount_cents === stage.amountCents && was.due_date === stage.dueDate && was.deliverables_json === JSON.stringify(stage.deliverables) && was.description === stage.description
          if (was.status !== 'open' && was.status !== 'cancelled') {
            if (!same) throw new Problem(409, 'stage.under_way', `${was.title} is under way`, 'Its terms cannot change once work is delivered or money is held.')
            this.store.updateStage(was.id, { position: index }, now)
            return
          }
          if (!same) changes.push(was.amount_cents !== stage.amountCents ? `${stage.title} to ${money(stage.amountCents, project.currency)}` : stage.title)
          this.store.updateStage(was.id, { position: index, title: stage.title, description: stage.description, deliverables_json: JSON.stringify(stage.deliverables), amount_cents: stage.amountCents, due_date: stage.dueDate }, now)
        } else {
          this.store.insertStage({ id: `stg_${randomBytes(6).toString('hex')}`, project_id: projectId, position: index, title: stage.title, description: stage.description, deliverables_json: JSON.stringify(stage.deliverables), amount_cents: stage.amountCents, due_date: stage.dueDate, status: 'open', milestone: null, charge_id: null, round: 0, review_ends_at: null, revise_by: null, released_by: null, created_at: now, updated_at: now })
          changes.push(`added ${stage.title}`)
        }
      })
      for (const stage of current) {
        if (!kept.has(stage.id) && stage.status === 'open') {
          this.store.updateStage(stage.id, { status: 'removed' }, now)
          changes.push(`removed ${stage.title}`)
        }
      }
      const patch: Parameters<ProjectRepo['updateProject']>[1] = {}
      if (extra.title?.trim()) patch.title = extra.title.trim().slice(0, 160)
      if (typeof extra.summary === 'string') patch.summary = extra.summary.trim().slice(0, 600)
      if (Number.isInteger(extra.reviewDays) && extra.reviewDays! >= 1 && extra.reviewDays! <= 14 && extra.reviewDays !== project.review_days) { patch.review_days = extra.reviewDays; changes.push(`review window ${extra.reviewDays} days`) }
      if (Number.isInteger(extra.reviseDays) && extra.reviseDays! >= 1 && extra.reviseDays! <= 14 && extra.reviseDays !== project.revise_days) { patch.revise_days = extra.reviseDays; changes.push(`revision window ${extra.reviseDays} days`) }
      this.store.updateProject(projectId, patch, now)
      if (changes.length > 0) this.note(projectId, null, 'plan.edited', `Plan edited: ${changes.join(', ')}.`, now)
    })
    // An approved plan that changed goes back to the client.
    if (changes.length > 0 && project.plan_version > 0) this.sendPlan(projectId, who)
    return this.studioView(projectId)
  }

  private currentTerms(project: ProjectRow): PlanTerms {
    return planTerms({
      projectId: project.id, title: project.title, summary: project.summary, clientId: project.client_id, clientName: project.client_name, currency: project.currency, category: project.category, reviewDays: project.review_days, reviseDays: project.revise_days,
      stages: this.store.stages(project.id).filter((stage) => stage.status !== 'cancelled').map((stage) => ({ id: stage.id, title: stage.title, deliverables: JSON.parse(stage.deliverables_json) as string[], amountCents: stage.amount_cents, dueDate: stage.due_date })),
    })
  }

  /** Sends the plan as it stands: a new version, signed by the studio, waiting for the client. Returns the client's link. */
  sendPlan(projectId: string, who: Principal) {
    const project = this.require(projectId)
    if (project.status === 'cancelled' || project.status === 'done') throw new Problem(409, 'project.closed', 'This project is closed', `It is ${project.status}.`)
    const terms = this.currentTerms(project)
    const hash = termsHash(terms)
    const latest = project.plan_version > 0 ? this.store.plan(projectId, project.plan_version) : null
    if (latest && latest.terms_hash === hash && (latest.status === 'sent' || latest.status === 'agreed')) return { ...this.studioView(projectId), resent: false }
    const now = this.iso()
    const version = project.plan_version + 1
    const signature = this.deps.signer.sign(planMessage(projectId, version, hash))
    this.deps.repo.transaction(() => {
      if (latest && latest.status === 'sent') this.store.decidePlan(projectId, latest.version, { status: 'superseded' })
      this.store.insertPlan({ project_id: projectId, version, terms_json: JSON.stringify(terms), terms_hash: hash, status: 'sent', sent_by: actorLabel(who), sent_at: now, studio_sig: signature.signature, studio_key_id: signature.keyId, decided_at: null, client_note: null, client_sig: null, client_key_id: null, deal_id: null })
      this.store.updateProject(projectId, { status: 'sent', plan_version: version }, now)
      this.store.resolveRequests(projectId, null, now)
      if (!this.store.activeLink(projectId)) this.issueLink(projectId, now)
      this.note(projectId, null, 'plan.sent', version === 1 ? `Plan sent to ${project.client_name} for approval.` : `Plan version ${version} sent to ${project.client_name}. They approve it again before paying for an open stage.`, now)
    })
    return { ...this.studioView(projectId), resent: true }
  }

  // ---------- the client's link ----------

  /**
   * The link's secret is the server's Ed25519 signature over the project and link id. Ed25519 is deterministic, so the
   * studio can copy the link again at any time, yet the database alone (without the private key) cannot recreate it.
   */
  private secretFor(projectId: string, linkId: string): string {
    return this.deps.signer.sign(`mandate:portal:v1\n${projectId}\n${linkId}`).signature.slice(0, 43)
  }

  private issueLink(projectId: string, now: string) {
    const id = randomBytes(9).toString('base64url')
    const secret = this.secretFor(projectId, id)
    this.store.insertLink({ id, project_id: projectId, secret_hash: createHash('sha256').update(secret).digest('hex'), created_at: now, revoked_at: null, last_seen_at: null, views: 0 })
    return id
  }

  /** A new link; the old one stops working. */
  rotateLink(projectId: string) {
    this.require(projectId)
    const now = this.iso()
    this.deps.repo.transaction(() => {
      this.store.revokeLinks(projectId, now)
      this.issueLink(projectId, now)
      this.note(projectId, null, 'link.rotated', 'A new client link was made. The old one no longer works.', now)
    })
    return this.studioView(projectId)
  }

  private linkUrl(projectId: string): string | null {
    const link = this.store.activeLink(projectId)
    if (!link) return null
    const workspace = this.deps.workspaceId && this.deps.workspaceId !== 'ws_default' ? `?workspace=${encodeURIComponent(this.deps.workspaceId)}` : ''
    return `${this.deps.publicUrl.replace(/\/$/, '')}/app/c/${link.id}~${this.secretFor(projectId, link.id)}${workspace}`
  }

  /** Any problem with a link is the same 404, so a guesser learns nothing. */
  private resolve(token: string): { project: ProjectRow; linkId: string } {
    const gone = () => new Problem(404, 'portal.unknown', 'This link is not available', 'It may have been replaced. Ask the person who sent it for the current link.')
    const dot = token.indexOf('~')
    if (dot < 1 || token.length > 120) throw gone()
    const link = this.store.link(token.slice(0, dot))
    const presented = createHash('sha256').update(token.slice(dot + 1)).digest()
    const stored = Buffer.from(link?.secret_hash ?? '0'.repeat(64), 'hex')
    const same = presented.length === stored.length && timingSafeEqual(presented, stored)
    if (!link || !same || link.revoked_at) throw gone()
    const project = this.store.project(link.project_id)
    if (!project || project.status === 'draft') throw gone()
    return { project, linkId: link.id }
  }

  // ---------- the client approves the plan ----------

  agreePlan(token: string, version: number) {
    const { project } = this.resolve(token)
    const plan = this.store.plan(project.id, project.plan_version)
    if (!plan || plan.version !== version) throw new Problem(409, 'plan.changed', 'The plan changed', 'The studio sent a newer version. Reload to see it.')
    if (plan.status === 'agreed') return this.portalView(token)
    if (plan.status !== 'sent' && plan.status !== 'changes') throw new Problem(409, 'plan.state', 'This plan is not waiting for you', `It is ${plan.status}.`)
    // The terms the studio signed must still be the terms the server holds.
    if (!this.deps.signer.verify(planMessage(project.id, plan.version, plan.terms_hash), plan.studio_sig, plan.studio_key_id) || termsHash(JSON.parse(plan.terms_json) as PlanTerms) !== plan.terms_hash) {
      throw new Problem(409, 'plan.signature_invalid', 'This plan does not verify', 'Its terms were changed after the studio signed them. Ask the studio to send it again.')
    }
    const terms = JSON.parse(plan.terms_json) as PlanTerms
    const now = this.iso()
    const decision = this.deps.signer.sign(planDecisionMessage(project.id, plan.version, plan.terms_hash, 'agreed'))
    this.deps.repo.transaction(() => {
      const dealId = this.makeDeal(project, terms, plan, now)
      this.store.decidePlan(project.id, plan.version, { status: 'agreed', decidedAt: now, sig: decision.signature, keyId: decision.keyId, dealId })
      this.store.updateProject(project.id, { status: 'agreed', agreed_version: plan.version, deal_id: dealId }, now)
      terms.stages.forEach((stage, index) => this.store.updateStage(stage.id, { milestone: index }, now))
      this.store.resolveRequests(project.id, null, now)
      this.note(project.id, null, 'plan.agreed', `${project.client_name} approved the plan (version ${plan.version}): ${terms.stages.length} stages, ${money(terms.totalCents, terms.currency)}. It is now a signed deal.`, now)
    })
    return this.portalView(token)
  }

  /**
   * The approved plan becomes a signed deal on the project's job. The gate then holds every bill on the job to it: a
   * stage's bill must be one of its milestones, once, for exactly its price. An earlier version's deal is withdrawn;
   * bills already made under it stand.
   */
  private makeDeal(project: ProjectRow, terms: PlanTerms, plan: PlanRow, now: string): string {
    const dealTerms: DealTerms = DealTermsSchema.parse({ jobId: project.job_id, scope: `${project.title}`.slice(0, 300), category: project.category, currency: project.currency, totalCents: terms.totalCents, milestones: terms.stages.map((stage) => ({ title: stage.title, amountCents: stage.amountCents })), proofRequired: true, dueDate: terms.stages.map((stage) => stage.dueDate).sort().at(-1) })
    const previous = this.deps.repo.agreedDealByJob(project.job_id)
    if (previous) this.deps.repo.setDealStatus(previous.id, 'withdrawn')
    const id = randomUUID()
    const hash = stableHash({ terms: dealTerms, buyerId: project.client_id, sellerId: WARRANT_ID, buyerRules: 0, sellerRules: 0 })
    const signature = this.deps.signer.sign(dealMessage(id, hash))
    const row: DealRow = { id, thread_id: `prj_${project.id}`, buyer_id: project.client_id, seller_id: WARRANT_ID, offered_by: 'seller', actor: 'client:project-link', status: 'agreed', job_id: project.job_id, terms_json: JSON.stringify(dealTerms), verdict_json: JSON.stringify({ verdict: 'ACCEPT', violations: [], zone: null }), buyer_rules_version: 0, seller_rules_version: 0, terms_hash: hash, sig: signature.signature, key_id: signature.keyId, run_id: null, prompt: `Plan version ${plan.version} (${plan.terms_hash.slice(0, 12)}) approved by ${project.client_name} on their project page`, created_at: now }
    this.deps.repo.insertDeal(row)
    return id
  }

  askPlanChanges(token: string, note: string) {
    const { project } = this.resolve(token)
    const text = note.trim()
    if (text.length < 5) throw new Problem(422, 'request.short', 'Say what you would like changed', 'A sentence or two is enough.')
    const plan = this.store.plan(project.id, project.plan_version)
    if (!plan || plan.status !== 'sent') throw new Problem(409, 'plan.state', 'This plan is not waiting for you', 'It may already be approved.')
    const now = this.iso()
    const decision = this.deps.signer.sign(planDecisionMessage(project.id, plan.version, plan.terms_hash, 'changes'))
    this.deps.repo.transaction(() => {
      this.store.decidePlan(project.id, plan.version, { status: 'changes', decidedAt: now, note: text.slice(0, 1500), sig: decision.signature, keyId: decision.keyId })
      this.store.updateProject(project.id, { status: 'changes' }, now)
      this.store.insertRequest({ id: randomUUID(), project_id: project.id, stage_id: null, kind: 'plan_changes', note: text.slice(0, 1500), at: now, resolved_at: null })
      this.note(project.id, null, 'plan.changes', `${project.client_name} asked for changes to the plan: “${text.slice(0, 160)}”`, now)
    })
    return this.portalView(token)
  }

  // ---------- delivering ----------

  async upload(projectId: string, stageId: string, file: { name: string; bytes: Uint8Array }, who: Principal) {
    const project = this.require(projectId)
    const stage = this.requireStage(projectId, stageId)
    if (project.status !== 'agreed') throw new Problem(409, 'project.not_agreed', 'The client has not approved the plan yet', 'Deliver once the plan is approved, so the work is measured against terms they agreed to.')
    if (stage.status !== 'open' && stage.status !== 'changes') throw new Problem(409, 'stage.locked', 'These files are locked', stage.status === 'released' ? 'This stage is paid and finished.' : 'Files are locked while the client reviews them. If they ask for changes, you can upload a revision.')
    if (file.bytes.length === 0) throw new Problem(422, 'file.empty', 'The file is empty', 'Choose the file again.')
    if (file.bytes.length > MAX_FILE) throw new Problem(413, 'file.too_large', 'The file is too large', 'Each file can be up to 15 MB.')
    const round = this.roundFor(stage)
    if (this.store.filesForRound(stageId, round).length >= MAX_FILES_PER_ROUND) throw new Problem(422, 'file.too_many', 'Too many files', `A delivery can have up to ${MAX_FILES_PER_ROUND} files.`)
    const name = cleanName(file.name)
    const sniffed = sniff(file.bytes, name)
    if (!sniffed) throw new Problem(415, 'file.unsupported', 'That kind of file cannot be delivered here', 'Images, PDF, ZIP, MP4, PSD, SVG and text files are accepted.')
    let kind = sniffed.kind
    let size: { width: number | null; height: number | null } = { width: null, height: null }
    if (kind === 'image') {
      if (await readableImage(file.bytes)) size = await imageSize(file.bytes)
      else kind = 'file'
    }
    const sha256 = sha256Hex(file.bytes)
    const now = this.iso()
    const id = `fil_${randomBytes(8).toString('hex')}`
    this.deps.repo.transaction(() => {
      this.store.putBlob(sha256, file.bytes, now)
      this.store.insertFile({ id, project_id: projectId, stage_id: stageId, round, name, mime: sniffed.mime, size: file.bytes.length, sha256, width: size.width, height: size.height, kind, uploaded_by: actorLabel(who), uploaded_at: now, removed_at: null })
      this.note(projectId, stageId, 'file.added', `Added ${name} to ${stage.title}.`, now)
    })
    return this.studioView(projectId)
  }

  /** The round new files go into: the first delivery is round 1; a revision after changes is the next round. */
  private roundFor(stage: StageRow): number {
    if (stage.status !== 'open' && stage.status !== 'changes') return stage.round
    return (this.store.latestDelivery(stage.id)?.round ?? 0) + 1
  }

  removeFile(projectId: string, fileId: string) {
    this.require(projectId)
    const file = this.store.file(fileId)
    if (!file || file.project_id !== projectId || file.removed_at) throw new Problem(404, 'file.missing', 'No such file', 'It may already be removed.')
    const stage = this.requireStage(projectId, file.stage_id)
    if ((stage.status !== 'open' && stage.status !== 'changes') || file.round !== this.roundFor(stage)) throw new Problem(409, 'stage.locked', 'This file was already sent', 'Files that were delivered stay on record with their fingerprint.')
    this.store.removeFile(fileId, this.iso())
    this.note(projectId, stage.id, 'file.removed', `Removed ${file.name} from ${stage.title}.`)
    return this.studioView(projectId)
  }

  private facts(files: FileRow[]): FileFacts[] {
    return files.map((file) => ({ name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, width: file.width, height: file.height, kind: file.kind }))
  }

  /** The check, as it would run now on the files not yet sent: the rules' facts, and the model's look when there is one. */
  async check(projectId: string, stageId: string, useAi = true): Promise<DeliveryCheck> {
    this.require(projectId)
    const stage = this.requireStage(projectId, stageId)
    const files = this.store.filesForRound(stageId, this.roundFor(stage))
    return this.runCheck(stage, files, useAi)
  }

  private async runCheck(stage: StageRow, files: FileRow[], useAi: boolean): Promise<DeliveryCheck> {
    const deliverables = JSON.parse(stage.deliverables_json) as string[]
    const rules = ruleCheck(deliverables, this.facts(files))
    if (!useAi) return mergeCheck(rules, [], this.iso(), 'skipped', 'Only the file facts were checked.')
    const images: Array<{ name: string; jpeg: Buffer }> = []
    for (const file of files.filter((item) => item.kind === 'image').slice(0, 6)) {
      const bytes = this.store.blob(file.sha256)
      if (bytes) images.push({ name: file.name, jpeg: await forModel(bytes) })
    }
    const { primary, fallback } = this.models()
    const look = await lookAtDelivery({ deliverables, images, models: [primary, fallback] })
    return mergeCheck(rules, look.items, this.iso(), look.state, look.note)
  }

  /**
   * Sends a stage's files to the client, sealed. The files are fingerprinted into a manifest, checked, and, the first
   * time, the stage's bill is made through the gate with the manifest's hash as its proof. Nothing is charged: the bill
   * is what the client may pay into a hold. A revision (after the client asked for changes) is the next round: the
   * money stays held and a fresh review window opens.
   */
  async sendForReview(projectId: string, stageId: string, who: Principal) {
    const project = this.require(projectId)
    const stage = this.requireStage(projectId, stageId)
    if (project.status !== 'agreed') throw new Problem(409, 'project.not_agreed', 'The client has not approved the plan yet', 'They approve the current plan first.')
    if (stage.status !== 'open' && stage.status !== 'changes') throw new Problem(409, 'stage.state', 'This stage is not open for delivery', `It is ${stage.status}.`)
    if (stage.milestone === null) throw new Problem(409, 'stage.not_in_plan', 'This stage is not in the approved plan', 'Send the plan again so the client can approve it.')
    const round = this.roundFor(stage)
    const files = this.store.filesForRound(stageId, round)
    if (files.length === 0) throw new Problem(422, 'delivery.empty', 'Add the files first', 'A delivery needs at least one file.')
    const check = await this.runCheck(stage, files, true)
    const manifest = manifestFor(projectId, stageId, round, files.map((file) => ({ name: file.name, sha256: file.sha256, size: file.size, mime: file.mime })))
    const hash = manifestHash(manifest)
    const now = this.iso()
    const deliveryId = `dlv_${randomBytes(8).toString('hex')}`
    const fresh = this.store.stage(stageId)!
    if (fresh.status !== stage.status) throw new Problem(409, 'stage.state', 'This stage changed meanwhile', 'Reload and try again.')

    if (stage.status === 'changes') {
      // A revision: same bill, same hold. The client reviews again, with a fresh window.
      this.deps.repo.transaction(() => {
        this.store.insertDelivery({ id: deliveryId, project_id: projectId, stage_id: stageId, round, manifest_json: JSON.stringify(manifest), manifest_hash: hash, check_json: JSON.stringify(check), sent_by: actorLabel(who), sent_at: now, charge_id: stage.charge_id })
        this.store.updateStage(stageId, { status: 'held', round, review_ends_at: addDays(now, project.review_days), revise_by: null }, now)
        this.store.resolveRequests(projectId, stageId, now)
        this.note(projectId, stageId, 'delivery.revision', `Revision ${round - 1} of ${stage.title} sent: ${files.length} file${files.length === 1 ? '' : 's'}. ${project.client_name} has ${project.review_days} day${project.review_days === 1 ? '' : 's'} to review. ${check.summary}`, now)
      })
      return this.studioView(projectId)
    }

    // First delivery: the bill. Its proof is the manifest, so the lock names these exact files.
    this.store.insertDelivery({ id: deliveryId, project_id: projectId, stage_id: stageId, round, manifest_json: JSON.stringify(manifest), manifest_hash: hash, check_json: JSON.stringify(check), sent_by: actorLabel(who), sent_at: now, charge_id: null })
    const evidenceUrl = `${this.deps.publicUrl.replace(/^http:/, 'https:').replace(/\/$/, '')}/v1/manifests/${deliveryId}?sha256=${hash}`
    const input = ProposalCreateSchema.parse({
      kind: 'charge', payee: project.client_id, amountCents: stage.amount_cents, currency: project.currency, category: project.category,
      description: `${project.title}: ${stage.title}`.slice(0, 500), evidenceUrl, jobId: project.job_id, dealId: project.deal_id, milestone: stage.milestone,
      prompt: `Stage ${stage.position + 1} delivered sealed (${files.length} file${files.length === 1 ? '' : 's'}, manifest ${hash.slice(0, 12)}); the client pays it into a PayPal hold`,
    })
    const made = this.deps.mandate.propose(input, `project-${stageId}-${deliveryId}`, who.role === 'owner' ? 'owner' : actorLabel(who))
    const body = made.body as { id?: string; gate?: string; clause?: string; detail?: string; phase?: string }
    if (!body?.id || body.gate === 'DENY') {
      this.note(projectId, stageId, 'delivery.refused', `The rules refused the bill for ${stage.title}: ${body?.detail ?? body?.clause ?? 'refused'}. Nothing was sent to the client.`)
      throw new Problem(422, body?.clause ?? 'gate.denied', 'The rules refused this bill', body?.detail ?? 'Nothing was sent to the client.', { proposalId: body?.id ?? null })
    }
    // Synchronously, before anything else can touch it: this bill is paid into a hold, never invoiced or charged outright.
    this.deps.repo.setSettleMode(body.id, 'hold', now)
    this.deps.repo.transaction(() => {
      this.store.setDeliveryCharge(deliveryId, body.id!)
      this.store.updateStage(stageId, { status: 'delivered', round, charge_id: body.id! }, now)
      const waits = body.phase === 'pending_approval'
      this.note(projectId, stageId, 'delivery.sent', `${stage.title} sent sealed: ${files.length} file${files.length === 1 ? '' : 's'}. ${check.summary}${waits ? ' The bill waits for your tap before the client can pay.' : ` ${project.client_name} can now pay ${money(stage.amount_cents, project.currency)} into a PayPal hold.`}`, now)
    })
    return this.studioView(projectId)
  }

  // ---------- keeping stages in step with the money ----------

  /** A stage follows its bill: a hold placed makes it held, a capture makes it released, a void or a dead bill reopens or closes it. */
  private sync(stage: StageRow): StageRow {
    if (!stage.charge_id) return stage
    const charge = this.deps.repo.proposal(stage.charge_id)
    if (!charge) return stage
    const now = this.iso()
    const project = this.store.project(stage.project_id)!
    if (charge.phase === 'authorized' && stage.status === 'delivered') {
      const held = this.deps.mandate.holdFor(charge.id)
      const from = held?.authorized_at ?? now
      this.store.updateStage(stage.id, { status: 'held', review_ends_at: addDays(from, project.review_days) }, now)
      this.note(stage.project_id, stage.id, 'hold.placed', `${project.client_name} paid ${money(charge.amount_cents, charge.currency)} into a PayPal hold for ${stage.title}. It is theirs until they approve, or until the review window ends ${addDays(from, project.review_days).slice(0, 10)}.`, now)
    } else if (fullPhase(charge.phase) && stage.status !== 'released') {
      const release = this.store.release(stage.id)
      this.store.updateStage(stage.id, { status: 'released', review_ends_at: null, revise_by: null, released_by: release?.decided_by ?? 'client' }, now)
      this.note(stage.project_id, stage.id, 'stage.released', `${money(charge.amount_cents, charge.currency)} for ${stage.title} was captured${release?.decided_by === 'review_window' ? ' when the review window ended' : ` when ${project.client_name} approved it`}. The files are unlocked.`, now)
      if (this.store.stages(stage.project_id).every((item) => item.status === 'released' || item.status === 'cancelled')) this.store.updateProject(stage.project_id, { status: 'done' }, now)
    } else if (charge.phase === 'voided' && stage.status !== 'cancelled') {
      this.store.updateStage(stage.id, { status: 'cancelled', review_ends_at: null, revise_by: null }, now)
      this.note(stage.project_id, stage.id, 'hold.voided', `The hold for ${stage.title} was released back to ${project.client_name}. They were not charged.`, now)
    } else if ((DEAD_PHASES as readonly string[]).includes(charge.phase) && stage.status === 'delivered') {
      // The bill died before money was held (refused, declined, rejected): the stage is open again and can be re-sent.
      this.store.updateStage(stage.id, { status: 'open', charge_id: null }, now)
      // The same files carry over to the next send, so nothing has to be uploaded again.
      const last = this.store.latestDelivery(stage.id)
      if (last) {
        for (const file of this.store.filesForRound(stage.id, last.round)) {
          this.store.insertFile({ ...file, id: `fil_${randomBytes(8).toString('hex')}`, round: last.round + 1, uploaded_at: now })
        }
      }
      this.note(stage.project_id, stage.id, 'bill.closed', `The bill for ${stage.title} ended (${charge.phase.replace('_', ' ')}). Send the stage again to make a new one.`, now)
    }
    return this.store.stage(stage.id)!
  }

  private syncProject(projectId: string): void {
    for (const stage of this.store.stages(projectId)) this.sync(stage)
  }

  // ---------- the client pays, reviews, decides ----------

  private portalStage(token: string, stageId: string) {
    const { project, linkId } = this.resolve(token)
    this.syncProject(project.id)
    const stage = this.requireStage(project.id, stageId)
    return { project, stage, linkId }
  }

  /** Opens the payment form for a stage: an order made from the lock, opened to AUTHORIZE, so the money is only held. */
  async paySession(token: string, stageId: string, instrument: 'card' | 'paypal' | 'venmo' | 'paylater') {
    const { project, stage } = this.portalStage(token, stageId)
    if (project.status !== 'agreed') throw new Problem(409, 'plan.not_agreed', 'Approve the latest plan first', 'The studio changed the plan. Approve it, then pay.')
    if (stage.status !== 'delivered' || !stage.charge_id) throw new Problem(409, 'stage.not_payable', 'There is nothing to pay for this stage yet', stage.status === 'open' ? 'You pay once its work is delivered.' : `It is ${stage.status}.`)
    const charge = this.deps.repo.proposal(stage.charge_id)!
    if (charge.settle_mode !== 'hold') throw new Problem(409, 'stage.not_payable', 'This bill is not paid into a hold', 'Ask the studio.')
    if (charge.phase === 'pending_approval') throw new Problem(409, 'stage.awaiting_studio', 'The studio is confirming this bill', 'Try again shortly.')
    return this.deps.mandate.paySession(charge.id, instrument)
  }

  /** The client approved the payment in PayPal: the server re-reads the order against the lock and places the hold. */
  async payConfirm(token: string, stageId: string) {
    const { stage } = this.portalStage(token, stageId)
    if (!stage.charge_id || stage.status !== 'delivered') return this.portalView(token)
    const result = await this.deps.mandate.capture(stage.charge_id)
    if (result.status !== 200) throw new Problem(result.status, (result.body as { code?: string }).code ?? 'pay.failed', (result.body as { title?: string }).title ?? 'The payment did not go through', (result.body as { detail?: string }).detail ?? 'Nothing was held.')
    return this.portalView(token)
  }

  /**
   * The client approves a stage. Their decision is recorded and signed over the exact files of the latest delivery
   * before PayPal is called, so it stands even if PayPal is slow; then the hold is captured through the gate's capture
   * path. If PayPal fails, the decision is kept and the sweep finishes the capture.
   */
  async approveStage(token: string, stageId: string) {
    const { project, stage } = this.portalStage(token, stageId)
    if (stage.status === 'released') return this.portalView(token)
    if (stage.status === 'changes') throw new Problem(409, 'stage.waiting_revision', 'This stage is waiting on the revision you asked for', 'Approve it once the studio sends the revision.')
    if (stage.status !== 'held' || !stage.charge_id) throw new Problem(409, 'stage.not_held', 'Nothing is held for this stage', 'Pay into the hold first.')
    this.recordRelease(project, stage, 'client')
    await this.finishRelease(stage).catch(() => undefined)
    return this.portalView(token)
  }

  private recordRelease(project: ProjectRow, stage: StageRow, decidedBy: 'client' | 'review_window'): void {
    const delivery = this.store.latestDelivery(stage.id)
    if (!delivery || !stage.charge_id) throw new Problem(409, 'stage.not_held', 'Nothing to release', 'No delivery is on record.')
    const signature = this.deps.signer.sign(releaseMessage(stage.id, stage.charge_id, delivery.manifest_hash, decidedBy))
    const now = this.iso()
    this.store.insertRelease({ stage_id: stage.id, project_id: project.id, charge_id: stage.charge_id, manifest_hash: delivery.manifest_hash, decided_by: decidedBy, sig: signature.signature, key_id: signature.keyId, at: now })
    this.note(project.id, stage.id, 'stage.approved', decidedBy === 'client' ? `${project.client_name} approved ${stage.title} (round ${delivery.round}, manifest ${delivery.manifest_hash.slice(0, 12)}).` : `The review window for ${stage.title} ended with no answer from ${project.client_name}, so it is released as agreed in the plan.`, now)
  }

  private async finishRelease(stage: StageRow): Promise<void> {
    const release = this.store.release(stage.id)
    if (!release || !stage.charge_id) return
    try {
      await this.deps.mandate.releaseHold(stage.charge_id, release.decided_by)
    } finally {
      this.sync(this.store.stage(stage.id)!)
    }
  }

  requestStageChanges(token: string, stageId: string, note: string) {
    const { project, stage } = this.portalStage(token, stageId)
    const text = note.trim()
    if (text.length < 10) throw new Problem(422, 'request.short', 'Say what needs to change', 'A sentence or two, so the studio knows what to fix.')
    if (stage.status !== 'held') throw new Problem(409, 'stage.not_held', 'Changes are asked for while you review', stage.status === 'changes' ? 'You already asked; the studio is working on it.' : 'Pay into the hold to review the full work first.')
    if (this.store.release(stage.id)) throw new Problem(409, 'stage.released', 'You already approved this stage', 'It is being released.')
    const now = this.iso()
    const reviseBy = addDays(now, project.revise_days)
    this.deps.repo.transaction(() => {
      this.store.insertRequest({ id: randomUUID(), project_id: project.id, stage_id: stage.id, kind: 'stage_changes', note: text.slice(0, 2000), at: now, resolved_at: null })
      this.store.updateStage(stage.id, { status: 'changes', revise_by: reviseBy, review_ends_at: null }, now)
      this.note(project.id, stage.id, 'stage.changes', `${project.client_name} asked for changes to ${stage.title}: “${text.slice(0, 160)}”. The money stays held. The revision is due by ${reviseBy.slice(0, 10)}.`, now)
    })
    return this.portalView(token)
  }

  /** The studio missed the revision deadline: the client may cancel, and the hold is voided. They were never charged. */
  async cancelStage(token: string, stageId: string) {
    const { project, stage } = this.portalStage(token, stageId)
    if (stage.status !== 'changes' || !stage.revise_by || !stage.charge_id) throw new Problem(409, 'stage.not_cancellable', 'This stage cannot be cancelled now', 'You can cancel only if the studio misses the revision deadline.')
    if (Date.parse(stage.revise_by) > this.deps.now().getTime()) throw new Problem(409, 'stage.revision_time', 'The studio still has time to send the revision', `The deadline is ${stage.revise_by.slice(0, 16).replace('T', ' ')} UTC.`)
    await this.deps.mandate.voidHold(stage.charge_id, 'the studio missed the revision deadline and the client cancelled', 'client')
    this.sync(this.store.stage(stage.id)!)
    this.note(project.id, stage.id, 'stage.cancelled', `${project.client_name} cancelled ${stage.title} after the revision deadline passed.`)
    return this.portalView(token)
  }

  /** The studio gives the money back without capturing it: the client is never charged. */
  async studioCancelStage(projectId: string, stageId: string) {
    const project = this.require(projectId)
    const stage = this.requireStage(projectId, stageId)
    if ((stage.status !== 'held' && stage.status !== 'changes') || !stage.charge_id) throw new Problem(409, 'stage.not_held', 'No hold to release', 'Only a stage with money held can be released back.')
    if (this.store.release(stage.id)) throw new Problem(409, 'stage.released', 'The client already approved this stage', 'It is being captured.')
    await this.deps.mandate.voidHold(stage.charge_id, 'the studio released the hold back to the client', 'studio')
    this.sync(this.store.stage(stage.id)!)
    this.note(project.id, stage.id, 'stage.cancelled', `You released ${project.client_name}'s hold for ${stage.title}. They were not charged.`)
    return this.studioView(projectId)
  }

  // ---------- seeing the work ----------

  /** Starts a viewing session for one file. Its code is written across every copy made in it. */
  openSession(token: string, fileId: string) {
    const { project, linkId } = this.resolve(token)
    this.syncProject(project.id)
    const file = this.store.file(fileId)
    if (!file || file.project_id !== project.id || file.removed_at) throw new Problem(404, 'file.missing', 'No such file', 'It may have been replaced.')
    const stage = this.store.stage(file.stage_id)!
    if (stage.status !== 'held' && stage.status !== 'changes') throw new Problem(402, 'file.sealed', 'Pay into the hold to review the full work', 'Until then you can see sealed previews.')
    if (file.kind !== 'image') throw new Problem(415, 'file.no_preview', 'This file has no review copy', 'It unlocks with the stage. Its name, size and fingerprint are shown so you know exactly what you will receive.')
    const code = randomBytes(4).toString('hex').toUpperCase().slice(0, 6)
    this.sessions.set(code, { code, projectId: project.id, linkId, fileId, expiresAt: this.deps.now().getTime() + SESSION_MS, closeups: 0 })
    for (const [key, session] of this.sessions) if (session.expiresAt < this.deps.now().getTime()) this.sessions.delete(key)
    const at = this.iso()
    this.store.insertView({ id: randomUUID(), project_id: project.id, stage_id: stage.id, file_id: file.id, kind: 'open', session_code: code, at })
    return { session: code, expiresAt: new Date(this.deps.now().getTime() + SESSION_MS).toISOString(), closeupsLeft: CLOSEUPS_PER_SESSION, width: file.width, height: file.height, name: file.name }
  }

  private session(token: string, code: string): { session: Session; project: ProjectRow; file: FileRow } {
    const { project, linkId } = this.resolve(token)
    const session = this.sessions.get(code)
    if (!session || session.linkId !== linkId || session.expiresAt < this.deps.now().getTime()) throw new Problem(410, 'session.ended', 'This viewing session ended', 'Open the file again.')
    const file = this.store.file(session.fileId)!
    const stage = this.store.stage(file.stage_id)!
    if (stage.status !== 'held' && stage.status !== 'changes') throw new Problem(402, 'file.sealed', 'Pay into the hold to review the full work', 'Until then you can see sealed previews.')
    return { session, project, file }
  }

  private mark(project: ProjectRow, code: string) {
    return { client: project.client_name, email: project.client_email, at: `${this.iso().slice(0, 16).replace('T', ' ')} UTC`, code }
  }

  async reviewImage(token: string, code: string): Promise<Buffer> {
    const { project, file } = this.session(token, code)
    return reviewCopy(this.store.blob(file.sha256)!, this.mark(project, code))
  }

  async closeupImage(token: string, code: string, x: number, y: number): Promise<{ jpeg: Buffer; left: number }> {
    const { session, project, file } = this.session(token, code)
    if (session.closeups >= CLOSEUPS_PER_SESSION) throw new Problem(429, 'closeup.limit', 'That is all the close-ups for this session', 'Close the file and open it again for more.')
    session.closeups += 1
    this.store.insertView({ id: randomUUID(), project_id: project.id, stage_id: file.stage_id, file_id: file.id, kind: 'closeup', session_code: code, at: this.iso() })
    const nx = Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0.5))
    const ny = Math.min(1, Math.max(0, Number.isFinite(y) ? y : 0.5))
    return { jpeg: await closeup(this.store.blob(file.sha256)!, nx, ny, this.mark(project, code)), left: CLOSEUPS_PER_SESSION - session.closeups }
  }

  /** Before payment: a blurred, sealed thumbnail. After release: the client gets the original elsewhere. */
  private readonly thumbs = new Map<string, Buffer>()

  async thumbnail(token: string, fileId: string): Promise<Buffer> {
    const { project } = this.resolve(token)
    const file = this.store.file(fileId)
    if (!file || file.project_id !== project.id || file.removed_at || file.kind !== 'image') throw new Problem(404, 'file.missing', 'No preview', 'This file has no preview.')
    const cached = this.thumbs.get(file.sha256)
    if (cached) return cached
    const made = await sealedThumb(this.store.blob(file.sha256)!)
    if (this.thumbs.size > 200) this.thumbs.clear()
    this.thumbs.set(file.sha256, made)
    return made
  }

  /** The studio's own look at a file it delivered. */
  original(projectId: string, fileId: string): { bytes: Uint8Array; file: FileRow } {
    this.require(projectId)
    const file = this.store.file(fileId)
    if (!file || file.project_id !== projectId) throw new Problem(404, 'file.missing', 'No such file', 'It may have been removed.')
    return { bytes: this.store.blob(file.sha256)!, file }
  }

  /** The original bytes, only once the stage's money was captured. Before that this is a 402, whoever asks. */
  download(token: string, fileId: string, record = true): { bytes: Uint8Array; file: FileRow } {
    const { project } = this.resolve(token)
    this.syncProject(project.id)
    const file = this.store.file(fileId)
    if (!file || file.project_id !== project.id || file.removed_at) throw new Problem(404, 'file.missing', 'No such file', 'It may have been replaced.')
    const stage = this.store.stage(file.stage_id)!
    const charge = stage.charge_id ? this.deps.repo.proposal(stage.charge_id) : null
    if (stage.status !== 'released' || !charge || !fundedPhase(charge.phase)) throw new Problem(402, 'file.sealed', 'This file unlocks when you approve the stage', 'Approving captures the payment you put in the hold, and then every file of the stage can be downloaded.')
    const delivered = this.store.latestDelivery(stage.id)
    if (!delivered || !(JSON.parse(delivered.manifest_json) as Manifest).files.some((item) => item.sha256 === file.sha256)) throw new Problem(404, 'file.missing', 'This file was replaced by a later round', 'Download the files of the final round.')
    if (record) this.store.insertView({ id: randomUUID(), project_id: project.id, stage_id: stage.id, file_id: file.id, kind: 'download', session_code: '-', at: this.iso() })
    return { bytes: this.store.blob(file.sha256)!, file }
  }

  manifest(deliveryId: string) {
    const row = this.store.delivery(deliveryId)
    if (!row) throw new Problem(404, 'manifest.missing', 'No such delivery', 'No delivery has that id.')
    return { deliveryId: row.id, round: row.round, sentAt: row.sent_at, sha256: row.manifest_hash, manifest: JSON.parse(row.manifest_json) as Manifest, recomputed: manifestHash(JSON.parse(row.manifest_json) as Manifest) === row.manifest_hash }
  }

  // ---------- reviews and the public profile ----------

  /** Only a client who paid can review: at least one stage's money must have been captured. The review is signed with the captures that prove it. */
  leaveReview(token: string, input: { stars: number; text: string }) {
    const { project } = this.resolve(token)
    this.syncProject(project.id)
    if (this.store.review(project.id)) throw new Problem(409, 'review.exists', 'You already left a review', 'One review per project.')
    const stars = Math.round(Number(input.stars))
    if (!(stars >= 1 && stars <= 5)) throw new Problem(422, 'review.stars', 'Pick 1 to 5 stars', 'Stars are whole numbers from 1 to 5.')
    const text = String(input.text ?? '').trim()
    if (text.length < 10 || text.length > 1000) throw new Problem(422, 'review.text', 'Write a sentence or two', 'Between 10 and 1,000 characters.')
    const captures = this.store.stages(project.id).map((stage) => (stage.charge_id ? this.deps.repo.proposal(stage.charge_id) : null)).filter((row) => row && fundedPhase(row.phase) && row.capture_id).map((row) => row!.capture_id!)
    if (captures.length === 0) throw new Problem(403, 'review.unpaid', 'Reviews come from clients who paid', 'Approve a stage first; its PayPal capture is what makes your review verified.')
    const textHash = createHash('sha256').update(text).digest('hex')
    const signature = this.deps.signer.sign(reviewMessage(project.id, stars, textHash, captures))
    const now = this.iso()
    this.store.insertReview({ id: `rev_${randomBytes(6).toString('hex')}`, project_id: project.id, stars, text, capture_ids_json: JSON.stringify(captures), sig: signature.signature, key_id: signature.keyId, at: now })
    this.note(project.id, null, 'review.left', `${project.client_name} left a ${stars}-star review.`, now)
    return this.portalView(token)
  }

  profile() {
    return this.store.profile()
  }

  saveProfile(raw: { handle?: string; displayName?: string; headline?: string; bio?: string; website?: string | null; email?: string | null }) {
    const handle = String(raw.handle ?? '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(handle)) throw new Problem(422, 'profile.handle', 'Pick a handle', '2 to 40 letters, numbers or dashes.')
    const displayName = String(raw.displayName ?? '').trim()
    if (!displayName) throw new Problem(422, 'profile.name', 'Add your name', 'It is shown to clients.')
    let website: string | null = null
    if (raw.website) {
      try { const url = new URL(String(raw.website)); if (url.protocol === 'https:' || url.protocol === 'http:') website = url.toString() } catch { throw new Problem(422, 'profile.website', 'That website is not a link', 'Use a full https:// address.') }
    }
    const email = raw.email ? String(raw.email).trim().slice(0, 200) : null
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Problem(422, 'profile.email', 'That email does not look right', 'Check it.')
    this.store.saveProfile({ handle, display_name: displayName.slice(0, 120), headline: String(raw.headline ?? '').trim().slice(0, 160), bio: String(raw.bio ?? '').trim().slice(0, 1200), website, email, updated_at: this.iso() })
    return this.publicProfile(handle)
  }

  /** Numbers that come only from payments PayPal processed and signed reviews, never from what the studio typed. */
  publicProfile(handle: string) {
    const profile = this.store.profile()
    if (!profile || profile.handle !== handle.toLowerCase()) throw new Problem(404, 'profile.missing', 'No such profile', 'Check the address.')
    let stagesPaid = 0
    let onTime = 0
    const clients = new Set<string>()
    let projectsCompleted = 0
    for (const project of this.store.allProjects()) {
      const stages = this.store.stages(project.id)
      let paidHere = 0
      for (const stage of stages) {
        const charge = stage.charge_id ? this.deps.repo.proposal(stage.charge_id) : null
        if (!charge || !fundedPhase(charge.phase)) continue
        paidHere += 1
        const first = this.store.firstDelivery(stage.id)
        if (first && first.sent_at.slice(0, 10) <= stage.due_date) onTime += 1
      }
      stagesPaid += paidHere
      if (paidHere > 0) clients.add(project.client_id)
      if (stages.length > 0 && stages.every((stage) => stage.status === 'released' || stage.status === 'cancelled') && paidHere > 0) projectsCompleted += 1
    }
    const reviews = this.store.reviews().map((review) => {
      const project = this.store.project(review.project_id)
      const captures = JSON.parse(review.capture_ids_json) as string[]
      const valid = this.deps.signer.verify(reviewMessage(review.project_id, review.stars, createHash('sha256').update(review.text).digest('hex'), captures), review.sig, review.key_id)
        && captures.every((captureId) => { const row = this.deps.repo.proposalByCapture(captureId); return Boolean(row && row.kind === 'charge') })
      return { id: review.id, stars: review.stars, text: review.text, client: project?.client_name ?? 'A client', project: project?.title ?? '', at: review.at, verified: valid, captures: captures.length }
    }).filter((review) => review.verified)
    const rating = reviews.length > 0 ? Math.round((reviews.reduce((sum, review) => sum + review.stars, 0) / reviews.length) * 10) / 10 : null
    const since = this.store.allProjects().at(-1)?.created_at ?? profile.updated_at
    return {
      handle: profile.handle, displayName: profile.display_name, headline: profile.headline, bio: profile.bio, website: profile.website, email: profile.email, since,
      rating, reviewCount: reviews.length,
      track: { projectsCompleted, stagesPaid, clients: clients.size, onTimePercent: stagesPaid > 0 ? Math.round((onTime / stagesPaid) * 100) : null },
      reviews,
    }
  }

  // ---------- reminders ----------

  async remind(projectId: string, stageId: string, who: Principal) {
    const project = this.require(projectId)
    const stage = this.requireStage(projectId, stageId)
    if (stage.status === 'released' || stage.status === 'cancelled') throw new Problem(409, 'stage.closed', 'Nothing to chase', 'This stage is finished.')
    const sent = this.store.reminders(stageId).length
    const today = this.iso().slice(0, 10)
    const daysLate = Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${stage.due_date}T00:00:00Z`)) / DAY))
    const link = this.linkUrl(projectId) ?? ''
    const drafted = await draftReminder({ freelancer: this.studioName(), client: project.client_name, stage: stage.title, amount: money(stage.amount_cents, project.currency), dueDate: stage.due_date, daysLate, sent, link, model: this.models().primary })
    const now = this.iso()
    this.store.insertReminder({ id: randomUUID(), project_id: projectId, stage_id: stageId, n: sent + 1, tone: drafted.tone, text: drafted.text, written_by: drafted.source, at: now })
    this.note(projectId, stageId, 'reminder.drafted', `A ${drafted.tone} reminder for ${stage.title} was written${drafted.source === 'model' ? ' by the AI' : ''}${daysLate > 0 ? ` (${daysLate} day${daysLate === 1 ? '' : 's'} late)` : ''}.`, now)
    const subject = `${stage.title}: ${money(stage.amount_cents, project.currency)}${daysLate > 0 ? ' (overdue)' : ''}`
    return { text: drafted.text, tone: drafted.tone, source: drafted.source, n: sent + 1, mailto: project.client_email ? `mailto:${encodeURIComponent(project.client_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(drafted.text)}` : null, by: actorLabel(who) }
  }

  // ---------- the sweep ----------

  /**
   * Runs on the server's timer. Stages follow their bills; a release the client decided but PayPal has not finished is
   * finished; a stage whose review window ran out with no answer is released, as the signed plan says.
   */
  async sweep(): Promise<{ released: number; synced: number }> {
    let released = 0
    for (const stage of this.store.allStages()) if (stage.charge_id && ['delivered', 'held', 'changes'].includes(stage.status)) this.sync(stage)
    for (const pending of this.store.releasesPending()) {
      const stage = this.store.stage(pending.stage_id)
      if (stage) await this.finishRelease(stage).then(() => { released += 1 }).catch(() => undefined)
    }
    for (const stage of this.store.stagesDueForRelease(this.iso())) {
      if (this.store.release(stage.id)) continue
      if (this.store.openRequests(stage.project_id).some((request) => request.stage_id === stage.id)) continue
      const project = this.store.project(stage.project_id)
      if (!project) continue
      try {
        this.recordRelease(project, stage, 'review_window')
        await this.finishRelease(stage)
        released += 1
      } catch { /* the next sweep tries again */ }
    }
    return { released, synced: 0 }
  }

  /**
   * One edit from the ledger: an open stage's title, price or due date. It goes through the same plan edit as the plan
   * editor, so a plan the client already saw goes back to them with the change marked.
   */
  editStage(projectId: string, stageId: string, patch: { title?: string; amountCents?: number; dueDate?: string }, who: Principal) {
    this.require(projectId)
    const target = this.requireStage(projectId, stageId)
    if (target.status !== 'open') throw new Problem(409, 'stage.under_way', `${target.title} is under way`, 'Only a stage with nothing delivered can be edited.')
    const stages = this.store.stages(projectId).filter((stage) => stage.status !== 'cancelled').map((stage) => ({
      id: stage.id, title: stage.title, description: stage.description, deliverables: JSON.parse(stage.deliverables_json) as string[], amountCents: stage.amount_cents, dueDate: stage.due_date,
      ...(stage.id === stageId ? { ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.amountCents !== undefined ? { amountCents: patch.amountCents } : {}), ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}) } : {}),
    }))
    return this.editPlan(projectId, { stages }, who)
  }

  /** Every stage of every project, one row each, reconciled with PayPal's ids: the ledger a freelancer exports. */
  ledger() {
    const today = this.iso().slice(0, 10)
    const rows = []
    for (const project of this.store.projects()) {
      this.syncProject(project.id)
      for (const stage of this.store.stages(project.id)) {
        const { charge, held } = this.stageMoney(stage)
        const release = this.store.release(stage.id)
        const live = project.status === 'agreed' || project.status === 'done'
        const unpaid = stage.status !== 'released' && stage.status !== 'cancelled'
        const overdue = live && unpaid && stage.status !== 'held' && stage.status !== 'changes' && stage.due_date < today
        rows.push({
          projectId: project.id, stageId: stage.id, client: project.client_name, project: project.title, stage: stage.title, position: stage.position,
          amountCents: stage.amount_cents, currency: project.currency, dueDate: stage.due_date, status: stage.status, planStatus: project.status,
          bucket: stage.status === 'released' ? 'paid' : stage.status === 'held' || stage.status === 'changes' ? 'held' : stage.status === 'cancelled' ? 'cancelled' : overdue ? 'overdue' : 'unpaid',
          daysLate: overdue ? Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${stage.due_date}T00:00:00Z`)) / DAY) : 0,
          paidOn: stage.status === 'released' ? (release?.at ?? charge?.updated_at ?? null) : null,
          paypalId: charge?.capture_id ?? held?.authorization_id ?? null,
          paypalIdKind: charge?.capture_id ? 'capture' : held ? 'hold' : null,
          feeCents: charge?.capture_fee_cents ?? null,
          editable: stage.status === 'open' && project.status !== 'cancelled' && project.status !== 'done',
          reminders: this.store.reminders(stage.id).length,
        })
      }
    }
    return { data: rows }
  }

  // ---------- views ----------

  /** The freelancer's first screen: what they are owed, what is late, what is held, what is banked. */
  summary() {
    const today = this.iso().slice(0, 10)
    const monthStart = `${today.slice(0, 7)}-01T00:00:00.000Z`
    const rows = this.store.projects().map((project) => {
      this.syncProject(project.id)
      const stages = this.store.stages(project.id)
      const money = stages.map((stage) => {
        const charge = stage.charge_id ? this.deps.repo.proposal(stage.charge_id) : null
        return { amountCents: stage.amount_cents, status: project.status === 'agreed' || project.status === 'done' ? stage.status : 'draft', dueDate: stage.due_date, chargePhase: charge?.phase ?? null, capturedCents: charge && fundedPhase(charge.phase) ? charge.captured_amount_cents ?? charge.amount_cents : 0, capturedAt: charge && fundedPhase(charge.phase) ? charge.updated_at : null }
      })
      const counted = owedSummary(money.filter((item) => item.status !== 'draft'), today, monthStart)
      return { project, stages, counted }
    })
    const total = rows.reduce((sum, row) => ({ owedCents: sum.owedCents + row.counted.owedCents, overdueCents: sum.overdueCents + row.counted.overdueCents, heldCents: sum.heldCents + row.counted.heldCents, bankedCents: sum.bankedCents + row.counted.bankedCents, monthCents: sum.monthCents + row.counted.monthCents }), { owedCents: 0, overdueCents: 0, heldCents: 0, bankedCents: 0, monthCents: 0 })
    const worst = rows.filter((row) => row.counted.overdueCents > 0).sort((a, b) => b.counted.overdueCents - a.counted.overdueCents)[0]
    const currency = this.deps.repo.latestWarrant()?.body.currency ?? 'USD'
    return {
      currency,
      ...total,
      projectsWithMoney: rows.filter((row) => row.counted.bankedCents > 0).length,
      mostOverdue: worst ? { projectId: worst.project.id, client: worst.project.client_name, cents: worst.counted.overdueCents } : null,
      projects: rows.map((row) => ({
        id: row.project.id, title: row.project.title, client: row.project.client_name, status: row.project.status, currency: row.project.currency,
        totalCents: row.stages.filter((stage) => stage.status !== 'cancelled').reduce((sum, stage) => sum + stage.amount_cents, 0),
        owedCents: row.counted.owedCents, overdueCents: row.counted.overdueCents, heldCents: row.counted.heldCents, bankedCents: row.counted.bankedCents,
        stages: row.stages.map((stage) => ({ id: stage.id, title: stage.title, status: stage.status, overdue: stage.status !== 'released' && stage.status !== 'held' && stage.status !== 'changes' && stage.status !== 'cancelled' && stage.due_date < today && (row.project.status === 'agreed') })),
        updatedAt: row.project.updated_at,
      })),
      activity: this.store.activity(null, 12).map((item) => ({ projectId: item.project_id, stageId: item.stage_id, kind: item.kind, text: item.text, at: item.at })),
    }
  }

  private stageMoney(stage: StageRow) {
    const charge = stage.charge_id ? this.deps.repo.proposal(stage.charge_id) : null
    const held = charge ? this.deps.mandate.holdFor(charge.id) : null
    return { charge, held }
  }

  private deliveryView(delivery: DeliveryRow | null) {
    if (!delivery) return null
    return { id: delivery.id, round: delivery.round, manifestHash: delivery.manifest_hash, sentAt: delivery.sent_at, check: delivery.check_json ? JSON.parse(delivery.check_json) as DeliveryCheck : null, files: (JSON.parse(delivery.manifest_json) as Manifest).files }
  }

  studioView(projectId: string) {
    const project = this.require(projectId)
    this.syncProject(projectId)
    const fresh = this.require(projectId)
    const plans = this.store.plans(projectId)
    const latest = plans.at(-1) ?? null
    const lastSeen = plans.filter((plan) => plan.status === 'agreed').at(-1) ?? null
    const terms = latest ? JSON.parse(latest.terms_json) as PlanTerms : null
    const link = this.store.activeLink(projectId)
    const stages = this.store.stages(projectId).map((stage) => {
      const { charge, held } = this.stageMoney(stage)
      const round = this.roundFor(stage)
      const working = this.store.filesForRound(stage.id, round)
      const delivery = this.store.latestDelivery(stage.id)
      const views = this.store.views(stage.id)
      const opens = views.filter((view) => view.kind === 'open')
      const closeups = views.filter((view) => view.kind === 'closeup')
      const lastView = views.filter((view) => view.kind !== 'download').at(-1)
      const release = this.store.release(stage.id)
      const payouts = charge?.capture_id ? this.deps.repo.proposalsForJob(fresh.job_id).filter((row) => row.kind === 'payment' && row.funding_capture_id === charge.capture_id).map((row) => ({ id: row.id, payeeId: row.payee_id, amountCents: row.amount_cents, phase: row.phase, clause: row.clause })) : []
      const reminders = this.store.reminders(stage.id)
      const request = this.store.openRequests(projectId).find((item) => item.stage_id === stage.id) ?? null
      return {
        id: stage.id, position: stage.position, title: stage.title, description: stage.description, deliverables: JSON.parse(stage.deliverables_json) as string[], amountCents: stage.amount_cents, dueDate: stage.due_date, status: stage.status, milestone: stage.milestone, round: stage.round, reviewEndsAt: stage.review_ends_at, reviseBy: stage.revise_by, releasedBy: stage.released_by,
        workingRound: round,
        files: working.map(fileView),
        delivery: this.deliveryView(delivery),
        rounds: this.store.deliveries(stage.id).length,
        charge: charge ? { id: charge.id, phase: charge.phase, gate: charge.gate, clause: charge.clause, detail: charge.detail, cartHash: charge.cart_hash, lockValid: charge.cart_hash ? this.deps.mandate.lockValid(charge) : null, captureId: charge.capture_id, capturedCents: charge.captured_amount_cents, feeCents: charge.capture_fee_cents, netCents: charge.capture_net_cents, orderId: charge.order_id } : null,
        hold: held ? { authorizationId: held.authorization_id, status: held.status, authorizedAt: held.authorized_at, honorUntil: held.honor_until, expiresAt: held.expires_at, payerEmail: held.payer_email, reauthorizedAt: held.reauthorized_at, releasedBy: held.released_by, releasedAt: held.released_at, voidReason: held.void_reason } : null,
        release: release ? { decidedBy: release.decided_by, at: release.at, manifestHash: release.manifest_hash, signatureValid: this.deps.signer.verify(releaseMessage(release.stage_id, release.charge_id, release.manifest_hash, release.decided_by), release.sig, release.key_id) } : null,
        payouts,
        views: { opens: opens.length, closeups: closeups.length, last: lastView ? { file: this.store.file(lastView.file_id)?.name ?? '', at: lastView.at } : null, downloads: views.filter((view) => view.kind === 'download').length },
        reminders: { count: reminders.length, lastAt: reminders.at(-1)?.at ?? null },
        request: request ? { note: request.note, at: request.at } : null,
      }
    })
    const totalCents = stages.filter((stage) => stage.status !== 'cancelled').reduce((sum, stage) => sum + stage.amountCents, 0)
    const releasedCents = stages.filter((stage) => stage.status === 'released').reduce((sum, stage) => sum + stage.amountCents, 0)
    const heldCents = stages.filter((stage) => stage.status === 'held' || stage.status === 'changes').reduce((sum, stage) => sum + stage.amountCents, 0)
    return {
      id: fresh.id, jobId: fresh.job_id, title: fresh.title, summary: fresh.summary, status: fresh.status, currency: fresh.currency, category: fresh.category, reviewDays: fresh.review_days, reviseDays: fresh.revise_days,
      client: { id: fresh.client_id, name: fresh.client_name, email: fresh.client_email },
      brief: fresh.brief, briefSource: fresh.brief_source, questions: JSON.parse(fresh.questions_json) as string[],
      dealId: fresh.deal_id,
      plan: latest ? {
        version: latest.version, status: latest.status, sentAt: latest.sent_at, decidedAt: latest.decided_at, clientNote: latest.client_note, termsHash: latest.terms_hash,
        studioSignatureValid: this.deps.signer.verify(planMessage(projectId, latest.version, latest.terms_hash), latest.studio_sig, latest.studio_key_id),
        clientSignatureValid: latest.client_sig ? this.deps.signer.verify(planDecisionMessage(projectId, latest.version, latest.terms_hash, latest.status === 'changes' ? 'changes' : 'agreed'), latest.client_sig, latest.client_key_id) : null,
        diff: terms ? planDiff(lastSeen && lastSeen.version !== latest.version ? JSON.parse(lastSeen.terms_json) as PlanTerms : null, terms) : null,
        unsentChanges: terms ? termsHash(this.currentTerms(fresh)) !== latest.terms_hash : true,
      } : null,
      link: link ? { url: this.linkUrl(projectId), createdAt: link.created_at, lastSeenAt: link.last_seen_at, views: link.views } : null,
      money: { totalCents, releasedCents, heldCents, stillCents: totalCents - releasedCents - heldCents, percent: totalCents > 0 ? Math.round((releasedCents / totalCents) * 100) : 0 },
      stages,
      requests: this.store.requests(projectId).map((item) => ({ id: item.id, stageId: item.stage_id, kind: item.kind, note: item.note, at: item.at, resolvedAt: item.resolved_at })),
      activity: this.store.activity(projectId, 40).map((item) => ({ stageId: item.stage_id, kind: item.kind, text: item.text, at: item.at })),
      review: (() => { const review = this.store.review(projectId); return review ? { stars: review.stars, text: review.text, at: review.at } : null })(),
      createdAt: fresh.created_at,
      updatedAt: project.updated_at,
    }
  }

  /** What the client sees. Nothing of the studio's rules, notes, margins or other clients. */
  portalView(token: string) {
    const { project, linkId } = this.resolve(token)
    this.store.noteLinkSeen(linkId, this.iso())
    this.syncProject(project.id)
    const fresh = this.require(project.id)
    const plan = this.store.plan(fresh.id, fresh.plan_version)
    const plans = this.store.plans(fresh.id)
    const agreed = plans.filter((item) => item.status === 'agreed' && item.version !== plan?.version).at(-1) ?? null
    const terms = plan ? JSON.parse(plan.terms_json) as PlanTerms : null
    const nowMs = this.deps.now().getTime()
    const stages = this.store.stages(fresh.id).map((stage) => {
      const { charge, held } = this.stageMoney(stage)
      const delivery = this.store.latestDelivery(stage.id)
      const manifest = delivery ? JSON.parse(delivery.manifest_json) as Manifest : null
      const files = manifest ? manifest.files.map((item) => {
        const row = this.store.filesForRound(stage.id, delivery!.round).find((file) => file.sha256 === item.sha256 && file.name === item.name)
        return row ? { id: row.id, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256, kind: row.kind, width: row.width, height: row.height } : null
      }).filter(Boolean) : []
      const request = this.store.openRequests(fresh.id).find((item) => item.stage_id === stage.id) ?? null
      const payable = fresh.status === 'agreed' && stage.status === 'delivered' && Boolean(charge) && charge!.phase !== 'pending_approval'
      return {
        id: stage.id, title: stage.title, description: stage.description, deliverables: JSON.parse(stage.deliverables_json) as string[], amountCents: stage.amount_cents, dueDate: stage.due_date,
        status: stage.status, round: stage.round, reviewEndsAt: stage.review_ends_at, reviseBy: stage.revise_by,
        files, check: delivery?.check_json ? JSON.parse(delivery.check_json) as DeliveryCheck : null, manifestHash: delivery?.manifest_hash ?? null,
        awaitingStudio: stage.status === 'delivered' && charge?.phase === 'pending_approval',
        canPay: payable, canApprove: stage.status === 'held' && !this.store.release(stage.id), canRequestChanges: stage.status === 'held' && !this.store.release(stage.id),
        canCancel: stage.status === 'changes' && Boolean(stage.revise_by) && Date.parse(stage.revise_by!) <= nowMs,
        canDownload: stage.status === 'released',
        request: request ? { note: request.note, at: request.at } : null,
        hold: held ? { status: held.status, authorizedAt: held.authorized_at, honorUntil: held.honor_until } : null,
        receipt: charge && fundedPhase(charge.phase) ? { paidCents: charge.captured_amount_cents ?? charge.amount_cents, heldAt: held?.authorized_at ?? null, approvedAt: this.store.release(stage.id)?.at ?? null, approvedBy: this.store.release(stage.id)?.decided_by ?? null, paidWith: held?.payer_email ?? null, paypalCaptureId: charge.capture_id, paypalAuthorizationId: held?.authorization_id ?? null, manifestHash: this.store.release(stage.id)?.manifest_hash ?? null } : null,
      }
    })
    const totalCents = stages.filter((stage) => stage.status !== 'cancelled').reduce((sum, stage) => sum + stage.amountCents, 0)
    const releasedCents = stages.filter((stage) => stage.status === 'released').reduce((sum, stage) => sum + stage.amountCents, 0)
    const heldCents = stages.filter((stage) => stage.status === 'held' || stage.status === 'changes').reduce((sum, stage) => sum + stage.amountCents, 0)
    const profile = this.store.profile()
    let studio: { name: string; handle: string | null; headline: string; rating: number | null; reviewCount: number } = { name: this.studioName(), handle: null, headline: '', rating: null, reviewCount: 0 }
    if (profile) {
      const pub = this.publicProfile(profile.handle)
      studio = { name: pub.displayName, handle: pub.handle, headline: pub.headline, rating: pub.rating, reviewCount: pub.reviewCount }
    }
    const paid = stages.some((stage) => stage.status === 'released')
    return {
      project: { id: fresh.id, title: fresh.title, summary: fresh.summary, client: fresh.client_name, currency: fresh.currency, reviewDays: fresh.review_days, reviseDays: fresh.revise_days, status: fresh.status },
      studio,
      plan: plan && terms ? { version: plan.version, status: plan.status, sentAt: plan.sent_at, termsHash: plan.terms_hash, totalCents: terms.totalCents, stages: terms.stages, diff: agreed ? planDiff(JSON.parse(agreed.terms_json) as PlanTerms, terms) : null, note: plan.client_note } : null,
      money: { totalCents, releasedCents, heldCents, stillCents: totalCents - releasedCents - heldCents, approved: stages.filter((stage) => stage.status === 'released').length, stages: stages.filter((stage) => stage.status !== 'cancelled').length },
      stages,
      review: (() => { const review = this.store.review(fresh.id); return review ? { stars: review.stars, text: review.text, at: review.at } : null })(),
      canReview: paid && !this.store.review(fresh.id),
      paypal: { environment: this.deps.paypalEnvironment ?? 'sandbox' },
    }
  }
}

function fileView(file: FileRow) {
  return { id: file.id, name: file.name, mime: file.mime, size: file.size, sha256: file.sha256, kind: file.kind, width: file.width, height: file.height, round: file.round, uploadedAt: file.uploaded_at }
}

function slugOf(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'client'
}

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

export type { ProjectInput }
