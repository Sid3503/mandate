import { itemsOf, type ProposalRow, type Repo } from '../db/repo'
import { monthWindow } from '../domain/period'
import { arrivedCents } from '../domain/phases'
import type { WarrantBody } from '../domain/schemas'
import { Problem } from '../http/problem'
import type { MandateService } from './mandate'
import { overdueDays } from './today'

/**
 * The Invoices desk: every client charge read as an invoice, worked out from the ledger alone.
 *
 * Nothing is stored here and nothing is invented. A status is DERIVED from the request's phase, its events and the
 * date, so the desk can never disagree with the receipt. The desk reads; it never approves, sends, captures or
 * cancels. Those still go through the gate and the existing buttons.
 *
 *   draft      asked for, waiting for the owner's tap (pending_approval)
 *   approved   locked, not yet out (locked, an invoice still a draft at PayPal, an order about to be opened)
 *   sent       out and unpaid (an invoice sent, a checkout opened, a payment PayPal has not finished moving)
 *   part_paid  PayPal says less than the lock arrived (settled_short)
 *   paid       captured in full
 *   overdue    sent or part_paid, and past its due date
 *   cancelled  voided before it was paid
 *   declined   the rules refused it, the owner rejected it, or PayPal declined or refused the payment
 *   reversed   was paid, then taken back (a chargeback, a refund made at PayPal)
 */

export type InvoiceStatus = 'draft' | 'approved' | 'sent' | 'part_paid' | 'paid' | 'overdue' | 'cancelled' | 'declined' | 'reversed'
export const INVOICE_STATUSES: readonly InvoiceStatus[] = ['draft', 'approved', 'sent', 'part_paid', 'paid', 'overdue', 'cancelled', 'declined', 'reversed']

/** How many days after sending a bill with no due date is treated as due, when the rules set no reminder schedule. */
export const DEFAULT_DUE_DAYS = 14

const DAY = 86_400_000

export type InvoiceRow = {
  id: string
  clientId: string | null
  clientName: string
  jobId: string | null
  description: string
  lineItems: Array<{ description: string; quantity: number; unitCents: number }> | null
  amountCents: number
  /** What PayPal reports actually arrived. Zero until a payment is seen. */
  paidCents: number
  /** The part still owed: the lock less what arrived, never below zero. Zero for a bill that is not live. */
  remainingCents: number
  currency: string
  status: InvoiceStatus
  /** The moment the invoice went out (the invoice.sent event), else when it was asked for. */
  sentAt: string
  sentSource: 'event' | 'created'
  /** YYYY-MM-DD. */
  dueDate: string
  /** `invoice`: the due date written on the bill. `default`: not on the bill, so sent plus the reminder days (or 14). */
  dueSource: 'invoice' | 'default'
  /** Plain words saying where the due date came from, so a derived date is never mistaken for one the client was shown. */
  dueNote: string
  daysOverdue: number
  invoiceUrl: string | null
  /** What the client opens to pay: PayPal's invoice page, else the PayPal checkout link of an open order. Null when there is none yet. */
  payerUrl: string | null
  payInstrument: 'invoice' | 'checkout' | null
  remindersSent: number
  /** When PayPal reported it paid (the capture event), for a paid bill. */
  paidAt: string | null
  createdAt: string
  /** Whether the owner may still nudge, show the QR or cancel it: it is out at PayPal and unpaid. */
  canRemind: boolean
  canCancel: boolean
}

export type Bucket = { count: number; cents: number }

export type Outlook = {
  currency: string
  /** PayPal's own number, which lags by hours. Null when it could not be read. */
  balanceCents: number | null
  balanceAsOf: string | null
  balanceNote: string | null
  outstandingCents: number
  /** Payouts the owner approved that PayPal has not yet been told to pay. They will leave the account. */
  committedPayoutsCents: number
  /** Balance plus outstanding minus committed payouts. Null when the balance is unknown. */
  projectedCents: number | null
  /** Outstanding minus committed payouts, without the balance. Always known. */
  netOfBooksCents: number
  buckets: { overdue: Bucket; thisWeek: Bucket; nextWeek: Bucket; later: Bucket }
  bucketLabels: { overdue: string; thisWeek: string; nextWeek: string; later: string }
  disclaimer: string
}

export type Guardrail = { id: string; text: string }

export type DeskFilter = { status?: InvoiceStatus; q?: string; jobId?: string }

const money = (cents: number, currency = 'USD') => `${currency === 'USD' ? '$' : `${currency} `}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** The payout phases that are approved but have not been paid out: the money is spoken for and still in the account. */
const COMMITTED_PAYOUT_PHASES = ['locked', 'order_created', 'capture_inflight', 'payout_sent', 'payout_unclaimed']

const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)

export class InvoiceDeskService {
  /** The last balance read, kept for a minute: the number lags by hours at PayPal, so asking more often learns nothing. */
  private balanceCache: { at: number; value: Awaited<ReturnType<MandateService['balance']>> } | null = null

  constructor(
    private readonly repo: Repo,
    private readonly mandate: MandateService,
    private readonly now: () => Date,
  ) {}

  /** Every charge as an invoice row, newest first. */
  rows(): InvoiceRow[] {
    const warrant = this.repo.latestWarrant()?.body ?? null
    const now = this.now()
    const events = this.eventsByProposal()
    const reminderDays = warrant?.automation.remindUnpaidAfterDays ?? DEFAULT_DUE_DAYS
    const names = new Map((warrant?.clients ?? []).map((client) => [client.id, client.displayName]))
    return this.repo.allProposals()
      .filter((row) => row.kind === 'charge')
      .map((row) => this.rowOf(row, events.get(row.id) ?? [], names, reminderDays, now))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  }

  /** One row by id, or null when the id is not a charge. Used by Ask and tests. */
  row(id: string): InvoiceRow | null {
    return this.rows().find((item) => item.id === id) ?? null
  }

  /** The list, filtered, with the KPIs over ALL rows (a filter narrows the table, never the totals) and the status counts. */
  list(filter: DeskFilter = {}) {
    const all = this.rows()
    const q = filter.q?.trim().toLowerCase() ?? ''
    const data = all.filter((item) => {
      if (filter.status && item.status !== filter.status) return false
      if (filter.jobId && item.jobId !== filter.jobId) return false
      if (q) {
        const haystack = [item.clientName, item.jobId ?? '', item.description, item.id, ...(item.lineItems ?? []).map((line) => line.description)].join(' ').toLowerCase()
        if (!haystack.includes(q)) return false
      }
      return true
    })
    const counts: Record<InvoiceStatus | 'all', number> = { all: all.length, draft: 0, approved: 0, sent: 0, part_paid: 0, paid: 0, overdue: 0, cancelled: 0, declined: 0, reversed: 0 }
    for (const item of all) counts[item.status] += 1
    return { data, counts, kpis: this.kpis(all) }
  }

  kpis(rows: InvoiceRow[] = this.rows()) {
    const live = rows.filter((item) => ['approved', 'sent', 'part_paid', 'overdue', 'paid'].includes(item.status))
    const open = rows.filter((item) => ['sent', 'part_paid', 'overdue'].includes(item.status))
    const overdue = rows.filter((item) => item.status === 'overdue')
    // Days from the invoice going out to PayPal reporting it paid, for bills where both moments are on record.
    const spans = rows.filter((item) => item.status === 'paid' && item.paidAt).map((item) => (Date.parse(item.paidAt!) - Date.parse(item.sentAt)) / DAY).filter((days) => Number.isFinite(days))
    return {
      currency: rows[0]?.currency ?? this.repo.latestWarrant()?.body.currency ?? 'USD',
      invoicedCents: live.reduce((sum, item) => sum + item.amountCents, 0),
      invoicedCount: live.length,
      paidCents: live.reduce((sum, item) => sum + item.paidCents, 0),
      outstandingCents: open.reduce((sum, item) => sum + item.remainingCents, 0),
      outstandingCount: open.length,
      overdueCount: overdue.length,
      overdueCents: overdue.reduce((sum, item) => sum + item.remainingCents, 0),
      avgDaysToPay: spans.length === 0 ? null : Math.round((spans.reduce((sum, days) => sum + days, 0) / spans.length) * 10) / 10,
      paidSample: spans.length,
    }
  }

  /**
   * Projected cash: what PayPal says the account holds, plus what clients still owe, minus payouts already approved.
   * It is arithmetic over the books and one lagging number from PayPal. It is never a promise that anyone will pay,
   * or pay on time, so the desk says so beside the number.
   */
  async outlook(): Promise<Outlook> {
    const balance = await this.readBalance()
    return this.outlookFrom(this.rows(), balance)
  }

  /** The same arithmetic with no PayPal call. Ask uses this because answering a question never waits on PayPal. */
  outlookWithoutBalance(): Outlook {
    return this.outlookFrom(this.rows(), null)
  }

  private outlookFrom(rows: InvoiceRow[], balance: Awaited<ReturnType<MandateService['balance']>> | null): Outlook {
    const warrant = this.repo.latestWarrant()?.body ?? null
    const currency = warrant?.currency ?? 'USD'
    const today = this.now().toISOString().slice(0, 10)
    const open = rows.filter((item) => ['sent', 'part_paid', 'overdue'].includes(item.status))
    const buckets = { overdue: { count: 0, cents: 0 }, thisWeek: { count: 0, cents: 0 }, nextWeek: { count: 0, cents: 0 }, later: { count: 0, cents: 0 } }
    for (const item of open) {
      const ahead = Math.round((Date.parse(`${item.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY)
      const bucket = ahead < 0 ? buckets.overdue : ahead < 7 ? buckets.thisWeek : ahead < 14 ? buckets.nextWeek : buckets.later
      bucket.count += 1
      bucket.cents += item.remainingCents
    }
    const outstandingCents = open.reduce((sum, item) => sum + item.remainingCents, 0)
    const committedPayoutsCents = this.repo.allProposals()
      .filter((row) => row.kind === 'payment' && COMMITTED_PAYOUT_PHASES.includes(row.phase) && row.currency === currency)
      .reduce((sum, row) => sum + row.amount_cents, 0)
    const known = balance && balance.available ? balance : null
    const balanceCents = known ? known.availableCents : null
    return {
      currency,
      balanceCents,
      balanceAsOf: known?.asOf ?? null,
      balanceNote: known ? 'PayPal’s own number. Its report lags by hours, so it can be behind what just happened.' : balance && !balance.available ? balance.reason : 'PayPal’s balance was not read, so the projection below leaves it out.',
      outstandingCents,
      committedPayoutsCents,
      projectedCents: balanceCents === null ? null : balanceCents + outstandingCents - committedPayoutsCents,
      netOfBooksCents: outstandingCents - committedPayoutsCents,
      buckets,
      bucketLabels: { overdue: 'Overdue', thisWeek: 'Due in the next 7 days', nextWeek: 'Due in 8 to 14 days', later: 'Due later' },
      disclaimer: 'This is arithmetic, not a promise. It assumes every client pays what they owe, and that PayPal’s balance is current. Neither is guaranteed.',
    }
  }

  private async readBalance() {
    const nowMs = this.now().getTime()
    if (this.balanceCache && nowMs - this.balanceCache.at < 60_000 && nowMs >= this.balanceCache.at) return this.balanceCache.value
    try {
      const value = await this.mandate.balance()
      this.balanceCache = { at: nowMs, value }
      return value
    } catch (error) {
      // A PayPal outage must not take the desk down: the projection says it left the balance out.
      return { available: false as const, reason: error instanceof Problem ? `PayPal’s balance could not be read: ${error.detail}` : 'PayPal’s balance could not be read.' }
    }
  }

  /** What the owner's rules allow for bills, in plain English, from the live warrant. Never from a model. */
  guardrails(): { lines: Guardrail[]; link: string; hasRules: boolean } {
    const warrant = this.repo.latestWarrant()?.body ?? null
    if (!warrant) return { lines: [], link: '/rules', hasRules: false }
    return { lines: guardrailLines(warrant), link: '/rules', hasRules: true }
  }

  /** Where this month's money in came from: PayPal-confirmed charge payments, in the month in the rules' time zone. */
  receivedThisMonth(): { label: string; cents: number; invoices: InvoiceRow[] } {
    const warrant = this.repo.latestWarrant()?.body ?? null
    const timezone = warrant?.timezone ?? 'UTC'
    const window = monthWindow(this.now(), timezone)
    const label = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: timezone }).format(this.now())
    const byId = new Map(this.rows().map((item) => [item.id, item]))
    const seen = new Map<string, number>()
    for (const event of this.repo.eventsOfTypes(['capture.completed'], window.start, window.end)) {
      if (!byId.has(event.proposal_id)) continue
      const cents = (JSON.parse(event.payload_json) as { amountCents?: number }).amountCents ?? 0
      seen.set(event.proposal_id, (seen.get(event.proposal_id) ?? 0) + cents)
    }
    return { label, cents: [...seen.values()].reduce((sum, cents) => sum + cents, 0), invoices: [...seen.keys()].map((id) => byId.get(id)!) }
  }

  private eventsByProposal(): Map<string, Array<{ type: string; created_at: string }>> {
    const map = new Map<string, Array<{ type: string; created_at: string }>>()
    for (const event of this.repo.eventsOfTypes(['invoice.sent', 'invoice.reminded', 'capture.completed'], '0000-01-01', '9999-12-31')) {
      const list = map.get(event.proposal_id) ?? []
      list.push({ type: event.type, created_at: event.created_at })
      map.set(event.proposal_id, list)
    }
    return map
  }

  private rowOf(row: ProposalRow, events: Array<{ type: string; created_at: string }>, names: Map<string, string>, reminderDays: number, now: Date): InvoiceRow {
    const sentEvent = events.find((event) => event.type === 'invoice.sent')
    const sentAt = sentEvent?.created_at ?? row.created_at
    const dueFromRow = row.due_date
    const dueDate = dueFromRow ?? addDays(sentAt.slice(0, 10), reminderDays)
    const dueSource: 'invoice' | 'default' = dueFromRow ? 'invoice' : 'default'
    const dueNote = dueFromRow ? `Due ${dueFromRow}, the date on the bill.` : `No due date is on this bill, so it counts as due ${reminderDays} days after it was sent (${dueDate}).`
    const base = statusOf(row.phase)
    const open = base === 'sent' || base === 'part_paid'
    const late = open ? overdueDays(dueDate, now) : 0
    const status: InvoiceStatus = open && late > 0 ? 'overdue' : base
    const paidCents = base === 'paid' || base === 'part_paid' || base === 'reversed' ? arrivedCents(row) : 0
    const live = open
    const payInstrument = row.pay_instrument === 'checkout' ? 'checkout' : row.pay_instrument === 'invoice' ? 'invoice' : null
    return {
      id: row.id,
      clientId: row.payee_id,
      clientName: (row.payee_id ? names.get(row.payee_id) : null) ?? row.payee_id ?? 'Unknown client',
      jobId: row.job_id,
      description: row.description,
      lineItems: itemsOf(row),
      amountCents: row.amount_cents,
      paidCents,
      remainingCents: live ? Math.max(0, row.amount_cents - paidCents) : 0,
      currency: row.currency,
      status,
      sentAt,
      sentSource: sentEvent ? 'event' : 'created',
      dueDate,
      dueSource,
      dueNote,
      daysOverdue: late,
      invoiceUrl: row.invoice_url,
      payerUrl: row.invoice_url ?? (base === 'sent' ? row.approve_url : null),
      payInstrument,
      remindersSent: events.filter((event) => event.type === 'invoice.reminded').length,
      paidAt: events.filter((event) => event.type === 'capture.completed').at(-1)?.created_at ?? null,
      createdAt: row.created_at,
      // The same condition the receipt's buttons use: an invoice PayPal has out and the client can still pay.
      canRemind: Boolean(row.invoice_id) && (row.phase === 'invoice_sent' || row.phase === 'settled_short'),
      canCancel: Boolean(row.invoice_id) && row.phase === 'invoice_sent',
    }
  }
}

/** A phase, read as an invoice status (before the due date is considered). */
function statusOf(phase: string): InvoiceStatus {
  switch (phase) {
    case 'pending_approval': return 'draft'
    case 'locked': case 'invoice_draft': case 'capture_inflight': return 'approved'
    // An order opened for the client, an invoice out, a payment PayPal has accepted but not finished, a payment held on a mismatch: all unpaid so far.
    case 'order_created': case 'invoice_sent': case 'capture_pending': case 'mismatch_hold': return 'sent'
    // Paid into a hold: reserved on the client's side, not yet the studio's money.
    case 'authorized': return 'sent'
    case 'voided': return 'cancelled'
    case 'settled_short': return 'part_paid'
    case 'captured': return 'paid'
    case 'invoice_cancelled': return 'cancelled'
    case 'capture_reversed': return 'reversed'
    default: return 'declined' // denied, rejected, capture_refused, capture_failed
  }
}

/** The rules a bill meets, in plain English. Exported so tests can read the sentences for several warrants. */
export function guardrailLines(warrant: WarrantBody): Guardrail[] {
  const c = warrant.currency
  const lines: Guardrail[] = []
  lines.push({ id: 'auto', text: `A bill under ${money(warrant.autoSettleUnderCents, c)} can go out without your tap. At or above that, you tap to approve it.` })
  lines.push({ id: 'ceiling', text: `Nothing over ${money(warrant.perPaymentCeilingCents, c)} in one payment is accepted. It is refused, not sent for a tap.` })
  lines.push({ id: 'cap', text: `Payouts to contractors are capped at ${money(warrant.monthlyCapCents, c)} a month.` })
  const days = warrant.automation.remindUnpaidAfterDays
  lines.push({ id: 'reminders', text: days === null ? 'Mandate sends no reminders on its own. You can nudge an invoice by hand.' : warrant.automation.maxReminders === 0 ? `An invoice unpaid after ${days} day${days === 1 ? '' : 's'} is flagged, but no reminders are sent.` : `An invoice unpaid after ${days} day${days === 1 ? '' : 's'} gets a PayPal reminder, up to ${warrant.automation.maxReminders} time${warrant.automation.maxReminders === 1 ? '' : 's'}.` })
  lines.push({ id: 'clearing', text: warrant.clearingDays === 0 ? 'A contractor can be paid from a client payment as soon as it settles.' : `A client payment must be settled ${warrant.clearingDays} day${warrant.clearingDays === 1 ? '' : 's'} before a rule pays a contractor from it with no tap.` })
  lines.push({ id: 'acceptance', text: warrant.automation.billSignedDeals ? (warrant.automation.requireAcceptance ? 'Milestones of a signed deal are billed automatically, but only after the client’s agent has accepted the delivery.' : 'Milestones of a signed deal are billed automatically once proof of the work is attached.') : 'Milestones of a signed deal are not billed automatically. Each bill needs your tap.' })
  lines.push({ id: 'proof', text: warrant.evidenceRequired ? 'Every bill must carry an https link to the work.' : 'A bill does not need a link to the work.' })
  lines.push({ id: 'currency', text: `Mandate bills in ${c} only.` })
  return lines
}
