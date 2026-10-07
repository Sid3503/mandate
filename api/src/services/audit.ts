import type { ProposalRow, Repo } from '../db/repo'
import { fundableCents } from '../domain/gate'
import { monthWindow } from '../domain/period'
import type { WarrantBody } from '../domain/schemas'
import { proofHash } from '../domain/signing'
import { toolSummary } from '../paypal/tiers'
import type { DealService } from './deals'
import type { MandateService } from './mandate'

/**
 * The audit: a stranger's checklist, run by the server over its own ledger. It does not trust any field it did not
 * recompute. Every check answers one question an auditor would ask, lists the exact requests that fail it, and can be
 * re-run at any time, so "nothing moved without a signed lock and a yes" is something to verify, not to believe.
 */

export type AuditCheck = {
  id: string
  title: string
  /** What this protects, in a sentence. */
  why: string
  status: 'pass' | 'fail' | 'info'
  /** How many things were looked at. */
  checked: number
  failures: Array<{ proposalId: string | null; detail: string }>
  note?: string
}

export type AuditReport = {
  ok: boolean
  ranAt: string
  totals: { requests: number; moved: number; locks: number; events: number; deals: number; jobs: number }
  checks: AuditCheck[]
  agentReach: { toolkitTools: number; agentCanCallDirectly: number; serverUses: number; mcpTools: number }
}

/** Phases in which PayPal has, or may have, moved the money. */
const MOVED = ['captured', 'refunded', 'payout_sent', 'payout_unclaimed', 'invoice_sent']
const APPROVING_CLAUSES = ['amount.auto', 'standing.matched', 'standing.billing']

export class AuditService {
  constructor(
    private readonly repo: Repo,
    private readonly mandate: MandateService,
    private readonly deals: DealService,
    private readonly now: () => Date,
  ) {}

  async run(options: { paypal?: boolean } = {}): Promise<AuditReport> {
    const proposals = this.repo.allProposals()
    const events = this.repo.allEvents()
    const byProposal = new Map<string, Array<{ type: string; clause: string | null; payload: Record<string, unknown> }>>()
    for (const event of events) {
      const list = byProposal.get(event.proposal_id) ?? []
      list.push({ type: event.type, clause: event.clause, payload: JSON.parse(event.payload_json) as Record<string, unknown> })
      byProposal.set(event.proposal_id, list)
    }
    const versions = new Map<number, WarrantBody>()
    for (const record of this.repo.warrantVersions()) versions.set(record.version, record.body)
    const latest = [...versions.entries()].sort((a, b) => b[0] - a[0])[0]?.[1] ?? null
    const moved = proposals.filter((row) => MOVED.includes(row.phase) || (row.phase === 'payout_failed' && row.payout_batch_id))
    const locked = proposals.filter((row) => row.cart_hash)
    const agreed = this.repo.agreedDeals()

    const checks: AuditCheck[] = [
      this.locks(locked),
      this.authorised(moved, byProposal),
      this.amounts(proposals),
      this.funded(proposals, versions),
      this.cap(proposals, versions, latest),
      this.jobs(proposals),
      this.history(proposals, byProposal),
      this.dealsCheck(agreed, proposals),
      this.acceptance(proposals, versions),
      this.reach(),
    ]
    if (options.paypal) checks.push(await this.paypalAgrees(proposals))

    const tools = toolSummary()
    return {
      ok: checks.every((check) => check.status !== 'fail'),
      ranAt: this.now().toISOString(),
      totals: { requests: proposals.length, moved: moved.length, locks: locked.length, events: events.length, deals: agreed.length, jobs: new Set(proposals.map((row) => row.job_id).filter(Boolean)).size },
      checks,
      agentReach: { toolkitTools: tools.total, agentCanCallDirectly: tools.agentCanCallDirectly, serverUses: tools.usedByMandate, mcpTools: 6 },
    }
  }

  private check(id: string, title: string, why: string, checked: number, failures: AuditCheck['failures'], note?: string): AuditCheck {
    return { id, title, why, status: failures.length === 0 ? 'pass' : 'fail', checked, failures, ...(note ? { note } : {}) }
  }

  /** Every lock is the hash of what it says, and was signed by this server's key. */
  private locks(locked: ProposalRow[]): AuditCheck {
    const failures: AuditCheck['failures'] = []
    for (const row of locked) {
      const result = this.mandate.verifyLock(row.id)
      if (result.verdict !== 'valid') failures.push({ proposalId: row.id, detail: !result.hashMatches ? 'the stored request no longer matches its lock (something was changed after approval)' : 'the lock was not signed by a key this server knows' })
    }
    return this.check('locks.valid', 'Every lock is intact and signed', 'A lock fixes payee, amount, proof, job and funding. If anything changed afterwards, or the server did not sign it, PayPal is never called.', locked.length, failures)
  }

  /** Nothing that moved money got there without a signed lock and a yes: the owner's tap, or a rule the owner signed. */
  private authorised(moved: ProposalRow[], events: Map<string, Array<{ type: string; clause: string | null; payload: Record<string, unknown> }>>): AuditCheck {
    const failures: AuditCheck['failures'] = []
    for (const row of moved) {
      const list = events.get(row.id) ?? []
      const tapped = list.some((event) => event.type === 'proposal.approved' && event.payload.cartHash === row.cart_hash)
      const byRule = row.gate === 'AUTO' && APPROVING_CLAUSES.includes(row.clause) && list.some((event) => event.type === 'proposal.created')
      if (!row.cart_hash || !row.lock_sig) failures.push({ proposalId: row.id, detail: 'money moved without a signed lock' })
      else if (!tapped && !byRule) failures.push({ proposalId: row.id, detail: 'money moved without the owner\'s tap or a rule the owner signed' })
    }
    return this.check('moved.authorised', 'Every payment had a yes', 'Money moves only after the owner taps, or when a rule the owner signed (the automatic line, a standing rule, billing a signed deal) covers it. Here is every request that moved money, re-checked.', moved.length, failures)
  }

  /** What PayPal settled is what was locked, to the cent. */
  private amounts(proposals: ProposalRow[]): AuditCheck {
    const failures: AuditCheck['failures'] = []
    let looked = 0
    for (const row of proposals) {
      if (row.phase !== 'captured' && row.phase !== 'refunded') continue
      looked += 1
      if (row.captured_amount_cents !== row.amount_cents) failures.push({ proposalId: row.id, detail: `locked ${row.amount_cents} cents but settled ${row.captured_amount_cents ?? 'nothing'}` })
    }
    return this.check('amounts.match', 'Settled to the cent', 'The amount PayPal confirmed equals the amount that was locked. A difference is refused at settlement; this proves none got through.', looked, failures)
  }

  /** A contractor is paid only from client money that settled on the same job, and never more than their share. */
  private funded(proposals: ProposalRow[], versions: Map<number, WarrantBody>): AuditCheck {
    const failures: AuditCheck['failures'] = []
    const reserved = proposals.filter((row) => row.kind === 'payment' && ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured'].includes(row.phase))
    const perCapture = new Map<string, { cents: number; share: number }>()
    for (const row of reserved) {
      const rules = versions.get(row.warrant_version)
      if (!rules?.fundingRequired) continue
      const funding = row.funding_capture_id ? proposals.find((item) => item.capture_id === row.funding_capture_id && item.kind === 'charge') : undefined
      if (!funding || funding.phase !== 'captured') { failures.push({ proposalId: row.id, detail: 'paid out with no settled client payment behind it' }); continue }
      if (funding.job_id !== row.job_id) failures.push({ proposalId: row.id, detail: 'paid out of a client payment that belongs to a different job' })
      if (funding.currency !== row.currency) failures.push({ proposalId: row.id, detail: 'paid out in a different currency than the client payment' })
      const seen = perCapture.get(funding.capture_id!) ?? { cents: 0, share: 0 }
      seen.cents += row.amount_cents
      seen.share = Math.max(seen.share, rules.contractorShareBps)
      perCapture.set(funding.capture_id!, seen)
    }
    for (const [captureId, seen] of perCapture) {
      const funding = proposals.find((item) => item.capture_id === captureId)!
      const refunded = proposals.filter((item) => item.kind === 'refund' && item.parent_capture_id === captureId && item.phase === 'refunded').reduce((sum, item) => sum + item.amount_cents, 0)
      const allowed = fundableCents({ contractorShareBps: seen.share } as WarrantBody, { kind: 'charge', phase: 'captured', jobId: funding.job_id, currency: funding.currency, capturedCents: funding.captured_amount_cents ?? 0, refundHeldCents: refunded, payoutHeldCents: 0 })
      if (seen.cents > allowed) failures.push({ proposalId: funding.id, detail: `${seen.cents} cents are promised out of a payment that can fund ${allowed}` })
    }
    return this.check('payouts.funded', 'Contractors were paid from money that had arrived', 'A payout must cite a settled client payment on the same job, in the same currency, and the total promised out of it never passes the contractor share.', reserved.length, failures)
  }

  /** In no month do the payouts that are still standing pass the cap the rules allowed. */
  private cap(proposals: ProposalRow[], versions: Map<number, WarrantBody>, latest: WarrantBody | null): AuditCheck {
    const failures: AuditCheck['failures'] = []
    const groups = new Map<string, { cents: number; cap: number; ids: string[] }>()
    const standing = proposals.filter((row) => row.kind === 'payment' && row.reserved_at && ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed', 'captured'].includes(row.phase))
    for (const row of standing) {
      const rules = versions.get(row.warrant_version) ?? latest
      if (!rules) continue
      const window = monthWindow(new Date(row.reserved_at!), rules.timezone)
      const key = `${rules.timezone}:${window.start}`
      const group = groups.get(key) ?? { cents: 0, cap: 0, ids: [] }
      group.cents += row.amount_cents
      group.cap = Math.max(group.cap, rules.monthlyCapCents)
      group.ids.push(row.id)
      groups.set(key, group)
    }
    for (const group of groups.values()) if (group.cents > group.cap) failures.push({ proposalId: group.ids[0] ?? null, detail: `${group.cents} cents are standing in one month against a cap of ${group.cap}` })
    return this.check('cap.respected', 'The monthly cap was never passed', 'Payouts that are locked, sent or paid in a month add up to no more than the cap in force when they were made.', standing.length, failures)
  }

  /** No job paid out more than came in. */
  private jobs(proposals: ProposalRow[]): AuditCheck {
    const failures: AuditCheck['failures'] = []
    const jobs = new Map<string, { in: number; out: number; refunded: number }>()
    for (const row of proposals) {
      if (!row.job_id) continue
      const job = jobs.get(row.job_id) ?? { in: 0, out: 0, refunded: 0 }
      if (row.kind === 'charge' && row.phase === 'captured') job.in += row.captured_amount_cents ?? 0
      if (row.kind === 'payment' && row.phase === 'captured') job.out += row.captured_amount_cents ?? 0
      if (row.kind === 'refund' && row.phase === 'refunded') job.refunded += row.amount_cents
      jobs.set(row.job_id, job)
    }
    for (const [jobId, job] of jobs) if (job.out > job.in - job.refunded) failures.push({ proposalId: null, detail: `job ${jobId} paid out ${job.out} cents but only ${job.in - job.refunded} came in` })
    return this.check('jobs.in_covers_out', 'No job paid out more than came in', 'For every job, what went to contractors is no more than what clients paid, after refunds. The studio keeps the rest.', jobs.size, failures)
  }

  /** Every request has its record, and every settlement has its PayPal event. */
  private history(proposals: ProposalRow[], events: Map<string, Array<{ type: string; clause: string | null; payload: Record<string, unknown> }>>): AuditCheck {
    const failures: AuditCheck['failures'] = []
    for (const row of proposals) {
      const list = (events.get(row.id) ?? []).map((event) => event.type)
      if (!list.includes('proposal.created')) failures.push({ proposalId: row.id, detail: 'there is no record of how this was asked' })
      const needs = row.phase === 'refunded' ? ['refund.completed'] : row.phase === 'captured' ? (row.kind === 'payment' && row.payout_batch_id ? ['payout.completed'] : ['capture.completed']) : []
      for (const type of needs) if (!list.includes(type)) failures.push({ proposalId: row.id, detail: `settled, but the ledger has no ${type} event` })
    }
    return this.check('history.complete', 'The ledger explains everything', 'Every request has an event for how it was asked, and every settlement has the event that recorded PayPal confirming it.', proposals.length, failures)
  }

  /** Signed deals are untouched, and every charge billed against one is for exactly its milestone. */
  private dealsCheck(agreed: ReturnType<Repo['agreedDeals']>, proposals: ProposalRow[]): AuditCheck {
    const failures: AuditCheck['failures'] = []
    let looked = 0
    for (const deal of agreed) {
      looked += 1
      const verdict = this.deals.verify(deal.id)
      if (verdict.verdict !== 'valid') failures.push({ proposalId: null, detail: `deal ${deal.id.slice(0, 8)} does not verify (${verdict.hashMatches ? 'signature' : 'terms changed'})` })
      const terms = JSON.parse(deal.terms_json) as { milestones: Array<{ amountCents: number }> }
      for (const charge of proposals.filter((row) => row.deal_id === deal.id && row.kind === 'charge' && row.gate !== 'DENY')) {
        looked += 1
        const expected = charge.milestone === null ? undefined : terms.milestones[charge.milestone]?.amountCents
        if (expected !== charge.amount_cents) failures.push({ proposalId: charge.id, detail: `billed ${charge.amount_cents} cents against a milestone the deal set at ${expected ?? 'nothing'}` })
        if (charge.payee_id !== deal.buyer_id) failures.push({ proposalId: charge.id, detail: 'billed a client other than the one who agreed the deal' })
      }
    }
    return this.check('deals.signed', 'Deals are signed, and billing followed them', 'An agreed deal\'s signature still verifies, and every charge on it is for exactly the agreed milestone, to the client who agreed.', looked, failures)
  }

  /**
   * When the owner's rules asked for the client's acceptance, no invoice went out on the rules' say-so without a signed
   * acceptance of exactly that proof. And no acceptance or rejection, anywhere, carries a signature that fails.
   */
  private acceptance(proposals: ProposalRow[], versions: Map<number, WarrantBody>): AuditCheck {
    const failures: AuditCheck['failures'] = []
    const deliveries = this.repo.allDeliveries()
    let looked = 0
    for (const row of deliveries) {
      if (!row.sig) continue
      looked += 1
      if (!this.deals.deliveryView(row).signatureValid) failures.push({ proposalId: row.proposal_id, detail: `the client's ${row.status === 'accepted' ? 'acceptance' : 'rejection'} of milestone ${row.milestone + 1} does not verify (it was changed after it was signed)` })
    }
    for (const charge of proposals) {
      if (charge.kind !== 'charge' || charge.clause !== 'standing.billing') continue
      if (!versions.get(charge.warrant_version)?.automation.requireAcceptance) continue
      looked += 1
      const accepted = deliveries.find((row) => row.proposal_id === charge.id)
      if (!accepted || accepted.status !== 'accepted') failures.push({ proposalId: charge.id, detail: 'billed without the tap because the client would accept, but there is no acceptance for it' })
      else if (accepted.proof_hash !== proofHash(charge.evidence_url ?? '')) failures.push({ proposalId: charge.id, detail: 'the client accepted a different proof link than the one billed' })
      else if (accepted.deal_id !== charge.deal_id || accepted.milestone !== charge.milestone) failures.push({ proposalId: charge.id, detail: 'the acceptance is for a different milestone than the one billed' })
    }
    return this.check('billing.accepted', 'Billing waited for the client when the rules said so', 'When the owner asked for the client\'s acceptance, every invoice sent without a tap has a signed acceptance of exactly that proof, for exactly that milestone, and no signed decision has been altered.', looked, failures)
  }

  /** The agents' reach is a fact about the code, listed here so it can be read next to the rest. */
  private reach(): AuditCheck {
    const tools = toolSummary()
    return {
      id: 'agents.no_reach',
      title: 'No AI can use PayPal\'s tools to move money',
      why: 'The agent door has six tools and none can approve, pay or change rules. Of PayPal\'s Agent Toolkit, the server runs only the few it names, and refuses the rest.',
      status: tools.agentCanCallDirectly === 0 ? 'pass' : 'fail',
      checked: tools.total,
      failures: tools.agentCanCallDirectly === 0 ? [] : [{ proposalId: null, detail: `${tools.agentCanCallDirectly} tools are reachable` }],
      note: `${tools.total} toolkit tools tiered (${tools.read} read, ${tools.propose} propose only, ${tools.outOfScope} not used); the server uses ${tools.usedByMandate}.`,
    }
  }

  /** Optional and live: PayPal's own account history should show what the ledger says moved. Its report lags, so the newest are not held against it. */
  private async paypalAgrees(proposals: ProposalRow[]): Promise<AuditCheck> {
    const activity = await this.mandate.activity(30).catch(() => null)
    if (!activity || !activity.available) {
      return { id: 'paypal.agrees', title: 'PayPal\'s own history agrees', why: 'Compare what the ledger says moved with PayPal\'s transaction report.', status: 'info', checked: 0, failures: [], note: activity ? activity.reason : 'PayPal could not be reached.' }
    }
    const seen = new Set(activity.rows.map((row) => row.id))
    const cutoff = this.now().getTime() - 24 * 3_600_000
    const failures: AuditCheck['failures'] = []
    let looked = 0
    let tooNew = 0
    for (const row of proposals) {
      const id = row.kind === 'payment' ? row.payout_txn_id : row.capture_id
      if (!id || !['captured'].includes(row.phase)) continue
      looked += 1
      if (seen.has(id)) continue
      if (Date.parse(row.updated_at) > cutoff) { tooNew += 1; continue }
      failures.push({ proposalId: row.id, detail: `PayPal's report does not list ${id}` })
    }
    return { ...this.check('paypal.agrees', 'PayPal\'s own history agrees', 'Every payment the ledger says settled appears in PayPal\'s transaction report for the account.', looked, failures, tooNew > 0 ? `${tooNew} settled in the last day are too new to be in PayPal's report, which refreshes every few hours.` : undefined) }
  }
}
