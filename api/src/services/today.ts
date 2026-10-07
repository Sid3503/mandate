import type { ProposalRow, Repo } from '../db/repo'
import { explainClause } from '../domain/explain'
import { monthWindow } from '../domain/period'
import type { WarrantBody } from '../domain/schemas'
import type { DealService } from './deals'
import type { MandateService } from './mandate'

/**
 * "Today": everything the owner needs on one page, worked out from the ledger alone (no PayPal call), so it is fast
 * and always answers. It sorts every request into one of four honest places:
 *
 *   waiting   needs the owner: an approval, a payout to send, an unclaimed payout, a held payout, an overdue invoice,
 *             something autopilot could not do, an open dispute
 *   inFlight  nobody needs to do anything: an invoice out, a payout processing, Mandate sending it
 *   done      settled in the last week, and how: a tap, a standing rule, autopilot, or under the automatic line
 *   stopped   refused by the rules
 *
 * Words are composed here, in one place, so the page and the tests agree on what is said.
 */

export type TodayAction = 'approve' | 'reject' | 'settle' | 'check' | 'remind' | 'cancel_payout' | 'open'

export type TodayItem = {
  id: string
  kind: 'approval' | 'ready' | 'unclaimed' | 'held' | 'overdue' | 'autopilot_blocked' | 'dispute' | 'in_flight' | 'done' | 'stopped'
  proposalId: string
  proposalKind: 'charge' | 'payment' | 'refund'
  title: string
  detail: string
  amountCents: number
  currency: string
  phase: string
  clause: string
  at: string
  how?: 'tap' | 'standing' | 'billing' | 'autopilot' | 'auto'
  actions: TodayAction[]
}

const DAY = 86_400_000
/** How long an invoice may sit unpaid before the page calls it overdue, when the owner has set no schedule. */
const DEFAULT_OVERDUE_DAYS = 3

export class TodayService {
  constructor(
    private readonly repo: Repo,
    private readonly deals: DealService,
    private readonly mandate: MandateService,
    private readonly now: () => Date,
    private readonly paypalConfigured: () => boolean,
  ) {}

  build() {
    const now = this.now()
    const warrant = this.repo.latestWarrant()
    const body = warrant?.body ?? null
    const names = (id: string | null) => (id && [...(body?.payees ?? []), ...(body?.clients ?? [])].find((party) => party.id === id)?.displayName) || 'Unknown'
    const since7 = new Date(now.getTime() - 7 * DAY).toISOString()
    const since30 = new Date(now.getTime() - 30 * DAY).toISOString()

    const createdBy = new Map<string, string>()
    for (const event of this.repo.eventsOfTypes(['proposal.created'], since30, new Date(now.getTime() + DAY).toISOString())) {
      createdBy.set(event.proposal_id, (JSON.parse(event.payload_json) as { actor?: string }).actor ?? 'owner')
    }

    const open = this.repo.openProposals(100)
    const waiting: TodayItem[] = []
    const inFlight: TodayItem[] = []

    for (const row of open) {
      const who = names(row.payee_id)
      const money = dollars(row.amount_cents)
      const base = { proposalId: row.id, proposalKind: row.kind, amountCents: row.amount_cents, currency: row.currency, phase: row.phase, clause: row.clause, at: row.updated_at }
      const events = this.repo.eventsFor(row.id)
      const standing = row.clause === 'standing.matched' || row.clause === 'standing.billing'

      if (row.phase === 'pending_approval' && row.gate === 'NEEDS_APPROVAL') {
        waiting.push({ ...base, id: `${row.id}:approval`, kind: 'approval', at: row.created_at, title: `${verb(row.kind)} ${who} ${money}`, detail: body ? explainClause({ clause: row.clause, kind: row.kind, amountCents: row.amount_cents, category: row.category, payeeName: who, warrant: body }) : row.detail, actions: ['approve', 'reject', 'open'] })
      } else if (row.phase === 'payout_unclaimed') {
        waiting.push({ ...base, id: `${row.id}:unclaimed`, kind: 'unclaimed', title: `${who} has no PayPal account for this ${money}`, detail: 'PayPal is holding the money. Correct the email in the rules and ask again, or cancel to get it back. It is not counted as paid.', actions: ['check', 'cancel_payout', 'open'] })
      } else if ((row.phase === 'locked' || row.phase === 'order_created') && standing) {
        const wait = [...events].reverse().find((event) => event.type === 'standing.waiting')
        const code = wait ? (JSON.parse(wait.payload_json) as { code?: string }).code ?? '' : ''
        if (code === 'paypal.buyer_pending') {
          inFlight.push({ ...base, id: `${row.id}:checkout`, kind: 'in_flight', title: `Waiting for ${who} to approve the ${money} checkout`, detail: 'The invoice could not be used, so PayPal checkout was opened. It settles by itself once they approve it.', actions: ['open'] })
        } else if (code) {
          waiting.push({ ...base, id: `${row.id}:held`, kind: 'held', title: `${verb(row.kind)} ${who} ${money} is on hold`, detail: HELD[code] ?? 'Something outside Mandate is in the way. It will retry every minute.', actions: ['settle', 'open'] })
        } else {
          inFlight.push({ ...base, id: `${row.id}:sending`, kind: 'in_flight', title: `Mandate is ${row.kind === 'charge' ? 'sending the invoice to' : 'paying'} ${who} ${money}`, detail: 'Covered by a rule you signed. It should be out within a minute.', actions: ['open'] })
        }
      } else if (row.phase === 'locked' || row.phase === 'order_created') {
        if (row.kind === 'charge' && row.phase === 'order_created') {
          inFlight.push({ ...base, id: `${row.id}:checkout`, kind: 'in_flight', title: `Waiting for ${who} to approve the ${money} checkout`, detail: 'Open the PayPal link, approve it as the buyer, then check PayPal.', actions: ['check', 'open'] })
        } else {
          waiting.push({ ...base, id: `${row.id}:ready`, kind: 'ready', title: `${row.kind === 'payment' ? 'Send' : row.kind === 'refund' ? 'Send the refund of' : 'Settle'} ${money} ${row.kind === 'payment' ? 'to' : row.kind === 'refund' ? 'to' : 'with'} ${who}`, detail: 'You approved it and it is locked. Nothing moves until it is sent.', actions: ['settle', 'open'] })
        }
      } else if (row.phase === 'invoice_draft' || row.phase === 'invoice_sent') {
        const sent = events.find((event) => event.type === 'invoice.sent')?.created_at ?? row.updated_at
        const days = Math.floor((now.getTime() - Date.parse(sent)) / DAY)
        const limit = body?.automation.remindUnpaidAfterDays ?? DEFAULT_OVERDUE_DAYS
        const reminders = events.filter((event) => event.type === 'invoice.reminded').length
        const item = { ...base, at: sent }
        if (days >= limit) {
          waiting.push({ ...item, id: `${row.id}:overdue`, kind: 'overdue', title: `${who} has not paid ${money}`, detail: `The invoice went out ${days} day${days === 1 ? '' : 's'} ago${reminders > 0 ? ` and ${reminders} reminder${reminders === 1 ? ' has' : 's have'} been sent` : ''}. ${body?.automation.remindUnpaidAfterDays ? 'Mandate chases it on your schedule; you can also nudge now.' : 'Nudge them through PayPal.'}`, actions: ['remind', 'check', 'open'] })
        } else {
          inFlight.push({ ...item, id: `${row.id}:invoice`, kind: 'in_flight', title: `Waiting for ${who} to pay ${money}`, detail: `The invoice went out ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}. It settles only when PayPal says it was paid.`, actions: ['check', 'remind', 'open'] })
        }
      } else if (row.phase === 'payout_sent') {
        inFlight.push({ ...base, id: `${row.id}:payout`, kind: 'in_flight', title: `PayPal is sending ${money} to ${who}`, detail: 'It is not counted as paid until PayPal says so. Mandate asks PayPal every minute.', actions: ['check', 'open'] })
      } else if (row.phase === 'capture_inflight') {
        inFlight.push({ ...base, id: `${row.id}:settling`, kind: 'in_flight', title: `Settling ${money} with ${who}`, detail: 'A PayPal call is in progress.', actions: ['open'] })
      }
    }

    // A payout autopilot asked for and the rules refused is the owner's business: the client has paid and nobody got their share.
    for (const row of this.repo.proposalsSince(since30, 200)) {
      if (row.gate === 'DENY' && createdBy.get(row.id) === 'autopilot') {
        waiting.push({ id: `${row.id}:blocked`, kind: 'autopilot_blocked', proposalId: row.id, proposalKind: row.kind, title: `Autopilot could not pay ${names(row.payee_id)} ${dollars(row.amount_cents)}`, detail: body ? explainClause({ clause: row.clause, kind: row.kind, amountCents: row.amount_cents, category: row.category, payeeName: names(row.payee_id), warrant: body }) : row.detail, amountCents: row.amount_cents, currency: row.currency, phase: row.phase, clause: row.clause, at: row.created_at, actions: ['open'] })
      }
    }
    for (const dispute of this.repo.listDisputes(50)) {
      if (dispute.status === 'RESOLVED') continue
      const charge = this.repo.paymentByCapture(dispute.transactionId)
      if (!charge) continue
      waiting.push({ id: `${charge.id}:dispute:${dispute.disputeId}`, kind: 'dispute', proposalId: charge.id, proposalKind: charge.kind, title: `${names(charge.payee_id)} disputed ${dollars(charge.amount_cents)} with PayPal`, detail: 'Payouts funded by this payment are held until PayPal resolves the dispute.', amountCents: dispute.amountCents ?? charge.amount_cents, currency: charge.currency, phase: charge.phase, clause: 'funding.disputed', at: dispute.updatedAt, actions: ['open'] })
    }

    const done: TodayItem[] = this.repo.settledProposals(since7, 12).map((row) => {
      const who = names(row.payee_id)
      const money = dollars(row.amount_cents)
      const events = this.repo.eventsFor(row.id)
      const how = howItWent(row, createdBy.get(row.id), events.some((event) => event.type === 'proposal.approved'))
      const byServer = events.some((event) => ['capture.completed', 'payout.completed'].includes(event.type) && (JSON.parse(event.payload_json) as { by?: string }).by === 'server')
      return {
        id: `${row.id}:done`, kind: 'done' as const, proposalId: row.id, proposalKind: row.kind,
        title: row.kind === 'charge' ? `${who} paid ${money}` : row.kind === 'refund' ? `Refunded ${money} to ${who}` : `${who} was paid ${money}`,
        detail: `${HOW[how] ?? ''}${byServer ? ' PayPal’s answer was found by Mandate’s own check, with nobody pressing anything.' : ''}`, amountCents: row.amount_cents, currency: row.currency, phase: row.phase, clause: row.clause, at: row.updated_at, how, actions: ['open'] as TodayAction[],
      }
    })

    const recent = this.repo.proposalsSince(since30, 500)
    const refused = recent.filter((row) => row.gate === 'DENY' && createdBy.get(row.id) !== 'autopilot')
    const stopped = {
      count: refused.length,
      cents: refused.reduce((sum, row) => sum + row.amount_cents, 0),
      recent: refused.slice(0, 5).map((row): TodayItem => ({
        id: `${row.id}:stopped`, kind: 'stopped', proposalId: row.id, proposalKind: row.kind,
        title: `${verb(row.kind)} ${names(row.payee_id)} ${dollars(row.amount_cents)} was refused`,
        detail: body ? explainClause({ clause: row.clause, kind: row.kind, amountCents: row.amount_cents, category: row.category, payeeName: names(row.payee_id), warrant: body }) : row.detail,
        amountCents: row.amount_cents, currency: row.currency, phase: row.phase, clause: row.clause, at: row.created_at, actions: ['open'],
      })),
    }
    const decided = recent.filter((row) => row.gate !== 'DENY')
    const automatic = decided.filter((row) => row.gate === 'AUTO').length

    return {
      asOf: now.toISOString(),
      month: body ? this.month(body, warrant!.id, now) : null,
      automation: body ? { ...body.automation, standingRules: body.standing.length, any: body.automation.billSignedDeals || body.automation.payOnSettle || body.automation.remindUnpaidAfterDays !== null || body.standing.length > 0 } : null,
      waiting: waiting.sort((a, b) => b.at.localeCompare(a.at)),
      inFlight: inFlight.sort((a, b) => b.at.localeCompare(a.at)),
      done,
      stopped,
      readyToBill: this.deals.readyToBill(),
      watcher: this.mandate.watcher(),
      stats: { last30Days: { requests: recent.length, refused: refused.length + recent.filter((row) => row.gate === 'DENY' && createdBy.get(row.id) === 'autopilot').length, automatic, tapped: decided.length - automatic, automaticShare: decided.length === 0 ? null : Math.round((automatic / decided.length) * 100) } },
      setup: this.setup(body),
    }
  }

  /** The month in money that PayPal confirmed: taken from the settle events, not from requests. */
  private month(body: WarrantBody, warrantId: string, now: Date) {
    const window = monthWindow(now, body.timezone)
    const kinds = new Map<string, ProposalRow>()
    for (const row of this.repo.allProposals()) kinds.set(row.id, row)
    let inCents = 0
    let outCents = 0
    let refundedCents = 0
    for (const event of this.repo.eventsOfTypes(['capture.completed', 'payout.completed', 'refund.completed'], window.start, window.end)) {
      const row = kinds.get(event.proposal_id)
      const cents = (JSON.parse(event.payload_json) as { amountCents?: number }).amountCents ?? 0
      if (!row) continue
      if (event.type === 'refund.completed') refundedCents += cents
      else if (row.kind === 'charge') inCents += cents
      else outCents += cents
    }
    const reserved = this.repo.reservations(warrantId, window.start, window.end).reduce((sum, row) => sum + Math.max(0, row.amountCents - (row.captureId ? this.repo.refundedCents(row.captureId) : 0)), 0)
    const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: body.timezone }).format(now)
    return { label, inCents: inCents - refundedCents, outCents, keptCents: inCents - refundedCents - outCents, refundedCents, reservedCents: reserved, capCents: body.monthlyCapCents, currency: body.currency }
  }

  private setup(body: WarrantBody | null) {
    const steps = [
      { id: 'paypal', label: 'Connect PayPal', hint: 'Add the sandbox app credentials to the server, then check System.', href: '/system', done: this.paypalConfigured() },
      { id: 'people', label: 'Add the people you bill and pay', hint: 'A client and a contractor on the rules.', href: '/rules', done: Boolean(body && body.payees.length > 0 && body.clients.length > 0) },
      { id: 'deal', label: 'Agree a deal with a client', hint: 'Let the two agents negotiate, or offer terms yourself.', href: '/deals', done: this.repo.countAgreedDeals() > 0 },
      { id: 'rule', label: 'Sign a standing rule for a contractor', hint: 'Say yes once to a kind of payout, so it needs no tap.', href: '/rules', done: Boolean(body && body.standing.length > 0) },
      { id: 'autopilot', label: 'Switch on autopilot', hint: 'Bill on delivery, pay when the client pays, chase unpaid invoices.', href: '/rules', done: Boolean(body && (body.automation.billSignedDeals || body.automation.payOnSettle || body.automation.remindUnpaidAfterDays !== null)) },
      { id: 'first', label: 'Get the first client payment through', hint: 'Bill a milestone and have the client pay it.', href: '/jobs', done: this.repo.settledProposals('1970-01-01T00:00:00.000Z', 500).some((row) => row.kind === 'charge') },
    ]
    return { complete: steps.every((step) => step.done), steps }
  }
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const verb = (kind: string) => (kind === 'charge' ? 'Bill' : kind === 'refund' ? 'Refund' : 'Pay')

const HELD: Record<string, string> = {
  'funding.disputed': 'The client has an open PayPal dispute on the payment that funds it. It goes out by itself when PayPal resolves the dispute.',
  'funding.unverifiable': 'PayPal could not say whether the client payment is disputed, so it is waiting. Mandate asks again every minute.',
  'paypal.upstream': 'PayPal could not be reached. Mandate tries again every minute.',
  'paypal.unavailable': 'PayPal is not answering. The request keeps its place and Mandate tries again by itself.',
  'paypal.unconfigured': 'PayPal is not configured on this server.',
  'capture.inflight': 'A PayPal call is already in progress.',
}

const HOW: Record<string, string> = {
  tap: 'You approved it.',
  standing: 'Sent under your standing rule. No tap.',
  billing: 'Billed under your rule for signed-deal milestones. No tap.',
  autopilot: 'Autopilot asked, and your standing rule covered it. No tap.',
  auto: 'Under the automatic line. No tap.',
}

function howItWent(row: ProposalRow, actor: string | undefined, approved: boolean): 'tap' | 'standing' | 'billing' | 'autopilot' | 'auto' {
  if (actor === 'autopilot') return 'autopilot'
  if (row.clause === 'standing.billing') return 'billing'
  if (row.clause === 'standing.matched') return 'standing'
  if (approved || row.gate === 'NEEDS_APPROVAL') return 'tap'
  return 'auto'
}
