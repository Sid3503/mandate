import type { InvoiceDeskService, InvoiceRow } from './invoiceDesk'
import type { TodayService } from './today'

/**
 * Where a sentence typed into Ask should go, decided by code before any model is involved.
 *
 *   answer   a question the ledger can answer: no model, no key, no rate limit
 *   action   "the work is delivered": the app prepares a card and the OWNER presses the button
 *   handoff  it sounds like a rule, not a request: the rules drafter gets the words
 *   clerk    everything else: the clerk, which can only ask the rules
 *
 * Nothing here moves money or changes anything. The most it does is read the ledger and prepare a button.
 */

export type AskRoute =
  | { kind: 'answer'; id: string; title: string; lines: string[]; links: Array<{ label: string; to: string }> }
  | { kind: 'action'; type: 'deliver'; text: string; proofUrl: string | null; note: string | null; choices: Array<{ dealId: string; milestone: number; jobId: string; buyerName: string; title: string; amountCents: number; currency: string }> }
  | { kind: 'handoff'; to: 'rules'; text: string }
  | { kind: 'clerk' }

export const QUICK_IDS = ['waiting', 'refused', 'month', 'inflight', 'ready', 'done', 'autopilot', 'overdue', 'outstanding', 'received', 'forecast'] as const
export type QuickId = (typeof QUICK_IDS)[number]

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const QUICK_WORDS: Array<[QuickId, RegExp]> = [
  // The money questions come first: "who owes me" and "what has been paid this month" would otherwise fall into the older, wider patterns.
  ['overdue', /overdue|past due|late (invoices?|payments?|clients?)|who is late|haven'?t paid on time/i],
  ['forecast', /forecast|project(ion|ed) (cash|balance)|cash (outlook|flow|position)|how much .{0,30}(will|would) (i|we) have/i],
  ['received', /(payments?|money|invoices?)\s+(received|collected|paid)|summari[sz]e (the )?payments|(received|paid|collected) (this|last) month|what (has|have) (been )?(paid|received)\b.{0,30}month|how much (have (we|i)|did (we|i)) (been )?(collected|received|get paid)/i],
  ['outstanding', /outstanding|who owes|what (am i|are we|is) (still )?owed|owed to (me|us)|receivables?|how much .{0,30}(owed|owe me)/i],
  ['waiting', /what('s| is| are)? (is |are )?(waiting|pending|needs? me|left for me)|waiting for me|anything (for me|to approve|to do)|needs? (my|a) (tap|approval)/i],
  ['refused', /(what|which).{0,40}(refus\w*|rejected|stopped|blocked|denied)|refus\w* (this|last)|why .{0,20}refus\w*/i],
  ['month', /this month|month so far|how much .{0,30}(came in|have we|did we|went out|kept)|in, out|money in and out/i],
  ['inflight', /in flight|where is (the|my)|what('s| is) (pending|outstanding|unpaid)|who (has not|hasn't|owes)|unpaid invoices?/i],
  ['ready', /ready to bill|what can i bill|next milestone|what('s| is) left to bill|to bill\b/i],
  ['done', /what (was|got|has been) (done|paid|settled)|done for me|settled (this|last) week|what happened/i],
  ['autopilot', /is autopilot|what('s| is) autopilot|what runs (by itself|automatically)|what is on\b/i],
]

// Delivery verbs only. Words like "ready" or "invoice" are too common (and "invoice" is in many links) to mean "the work is delivered".
const DELIVERED = /\b(deliver(ed|y)?|finished|completed?|done|handed (it )?over)\b/i
const BILL_IT = /\bbill\b[^.]{0,40}\b(milestone|concepts?|final files|for the (work|logo))\b/i
const RULE_WORDS = /\b(from now on|always|never|whenever|automatically|every time|standing rule|no tap|without (a |any )?(tap|approval)|change the rules?|set up a rule|at most|no more than|cap\b.{0,25}\b(at|to)|limit\b.{0,25}\bto|remind (clients|them|customers)|allow|let \w+ be paid)\b|\d+\s?%/i
const ONE_OFF = /^\s*(please\s+)?(pay|bill|refund|send)\b/i

export class AskService {
  constructor(private readonly today: TodayService, private readonly desk: InvoiceDeskService | null = null) {}

  route(message: string, context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string }): AskRoute {
    const text = message.trim()
    const url = /https:\/\/[^\s)]+/i.exec(text)?.[0] ?? null
    const quick = this.quickFor(text)
    if (quick && !url) return this.quick(quick)
    const bare = text.replace(/https:\/\/[^\s)]+/gi, ' ')
    if ((DELIVERED.test(bare) || BILL_IT.test(bare)) && !/\b(ignore|disregard|override)\b/i.test(bare) && !/\b(pay|refund)\b.*\bshare\b/i.test(bare)) {
      const action = this.deliveryAction(text, url, context)
      if (action) return action
    }
    if (RULE_WORDS.test(text) && !(ONE_OFF.test(text) && !/\d+\s?%|automatically|from now on|always|never|standing rule|no tap|whenever|every time/i.test(text))) {
      return { kind: 'handoff', to: 'rules', text }
    }
    return { kind: 'clerk' }
  }

  private quickFor(text: string): QuickId | null {
    return QUICK_WORDS.find(([, pattern]) => pattern.test(text))?.[0] ?? null
  }

  private deliveryAction(text: string, url: string | null, context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string }): AskRoute | null {
    const data = this.today.build()
    let open = data.readyToBill.filter((item) => item.delivery?.status !== 'awaiting')
    if (context?.jobId) open = open.filter((item) => item.jobId === context.jobId)
    if (context?.dealId) open = open.filter((item) => item.dealId === context.dealId)
    if (open.length === 0) return null
    const lower = text.toLowerCase()
    const byName = open.filter((item) => lower.includes(item.buyerName.toLowerCase()))
    if (byName.length > 0) open = byName
    // Several deals can be open for one client. The job's name and the milestone's title narrow it when the owner used them.
    const byScope = open.filter((item) => lower.includes(item.scope.toLowerCase()))
    if (byScope.length > 0) open = byScope
    const byTitle = open.filter((item) => lower.includes(item.title.toLowerCase()))
    if (byTitle.length > 0) open = byTitle
    const number = /milestone\s+(\d+)|(\d+)(?:st|nd|rd|th)\s+milestone/i.exec(text)
    let note: string | null = null
    if (number) {
      const wanted = Number(number[1] ?? number[2]) - 1
      const exact = open.filter((item) => item.milestone === wanted)
      if (exact.length > 0) open = exact
      else note = `You said milestone ${wanted + 1}, but the next one that can be delivered is milestone ${open[0]!.milestone + 1}. Earlier ones come first.`
    }
    return {
      kind: 'action',
      type: 'deliver',
      text,
      proofUrl: url,
      note,
      choices: open.map((item) => ({ dealId: item.dealId, milestone: item.milestone, jobId: item.jobId, buyerName: item.buyerName, title: item.title, amountCents: item.amountCents, currency: item.currency })),
    }
  }

  /**
   * Money questions, answered from the Invoices desk's numbers. Plain arithmetic over the books: no model, no PayPal call.
   * Every answer lists the invoices it is made from, each with its id and a link to its receipt.
   */
  private money(id: 'overdue' | 'outstanding' | 'received' | 'forecast'): AskRoute {
    const links: Array<{ label: string; to: string }> = []
    const from = (rows: InvoiceRow[], note: (row: InvoiceRow) => string) => {
      for (const row of rows.slice(0, 8)) links.push({ label: `${row.clientName} ${money(row.amountCents)} (${row.id.slice(0, 8)})`, to: `/p/${row.id}` })
      return rows.slice(0, 8).map((row) => `${row.clientName}, ${money(row.amountCents)}: ${note(row)} (invoice ${row.id.slice(0, 8)}).`)
    }
    if (!this.desk) return { kind: 'answer', id, title: 'Invoices are not available', lines: ['The Invoices desk is not wired on this server.'], links }
    const rows = this.desk.rows()
    const none = rows.length === 0 ? 'There are no invoices yet.' : null
    let title = ''
    let lines: string[] = []
    if (id === 'overdue') {
      const late = rows.filter((row) => row.status === 'overdue').sort((a, b) => b.daysOverdue - a.daysOverdue)
      title = late.length === 0 ? 'No invoice is overdue' : `${late.length} invoice${late.length === 1 ? ' is' : 's are'} overdue, ${money(late.reduce((sum, row) => sum + row.remainingCents, 0))} owed`
      lines = late.length === 0 ? [none ?? 'Nothing sent or part-paid is past its due date.'] : from(late, (row) => `${money(row.remainingCents)} still owed, ${row.daysOverdue} day${row.daysOverdue === 1 ? '' : 's'} past ${row.dueDate}${row.dueSource === 'default' ? ' (a date Mandate worked out, none was on the bill)' : ''}`)
    } else if (id === 'outstanding') {
      const open = rows.filter((row) => ['sent', 'part_paid', 'overdue'].includes(row.status))
      const total = open.reduce((sum, row) => sum + row.remainingCents, 0)
      title = open.length === 0 ? 'Nobody owes you anything right now' : `${money(total)} is outstanding across ${open.length} invoice${open.length === 1 ? '' : 's'}`
      lines = open.length === 0 ? [none ?? 'Every invoice that went out has been paid, cancelled or declined.'] : from(open, (row) => `owes ${money(row.remainingCents)}${row.paidCents > 0 ? ` (${money(row.paidCents)} already paid)` : ''}, due ${row.dueDate}${row.status === 'overdue' ? `, ${row.daysOverdue} day${row.daysOverdue === 1 ? '' : 's'} overdue` : ''}`)
    } else if (id === 'received') {
      const got = this.desk.receivedThisMonth()
      title = got.invoices.length === 0 ? `Nothing has been paid in ${got.label}` : `${money(got.cents)} received in ${got.label} across ${got.invoices.length} invoice${got.invoices.length === 1 ? '' : 's'}`
      lines = got.invoices.length === 0 ? [none ?? 'No payment PayPal confirmed landed this month.'] : from(got.invoices, (row) => `paid ${row.paidAt ? row.paidAt.slice(0, 10) : 'this month'}`)
      if (got.invoices.length > 0) lines.push('These are payments PayPal confirmed, before any refunds.')
    } else {
      const o = this.desk.outlookWithoutBalance()
      const open = rows.filter((row) => ['sent', 'part_paid', 'overdue'].includes(row.status))
      title = open.length === 0 && o.committedPayoutsCents === 0 ? 'Nothing is expected to come in or go out' : `${money(o.outstandingCents)} expected in, ${money(o.committedPayoutsCents)} promised out`
      lines = [
        ...(none ? [none] : []),
        `Overdue: ${money(o.buckets.overdue.cents)} (${o.buckets.overdue.count}). Due in the next 7 days: ${money(o.buckets.thisWeek.cents)} (${o.buckets.thisWeek.count}). Due in 8 to 14 days: ${money(o.buckets.nextWeek.cents)} (${o.buckets.nextWeek.count}). Due later: ${money(o.buckets.later.cents)} (${o.buckets.later.count}).`,
        `By two weeks from now, at most ${money(o.buckets.overdue.cents + o.buckets.thisWeek.cents + o.buckets.nextWeek.cents)} of that could arrive, if every client pays by its due date.`,
        `Approved payouts not yet paid: ${money(o.committedPayoutsCents)}. Expected in less promised out: ${money(o.netOfBooksCents)}.`,
        'This leaves out your PayPal balance (open Invoices to see it added). It is arithmetic, not a promise: clients can pay late or not at all, and PayPal’s balance report lags by hours.',
        ...from(open, (row) => `${money(row.remainingCents)} due ${row.dueDate}`),
      ]
    }
    links.push({ label: 'Open Invoices', to: '/invoices' })
    return { kind: 'answer', id, title, lines, links }
  }

  quick(id: QuickId): AskRoute {
    if (id === 'overdue' || id === 'outstanding' || id === 'received' || id === 'forecast') return this.money(id)
    const d = this.today.build()
    const links: Array<{ label: string; to: string }> = []
    let title = ''
    let lines: string[] = []
    switch (id) {
      case 'waiting':
        title = d.waiting.length === 0 ? 'Nothing needs you' : `${d.waiting.length} thing${d.waiting.length === 1 ? '' : 's'} need${d.waiting.length === 1 ? 's' : ''} you`
        lines = d.waiting.length === 0 ? ['No approval, no held payout, no overdue invoice and no dispute.'] : d.waiting.slice(0, 6).map((item) => `${item.title}. ${item.detail}`)
        links.push({ label: 'Open Today', to: '/' })
        break
      case 'refused':
        title = d.stopped.count === 0 ? 'Nothing was refused in the last 30 days' : `${d.stopped.count} refused in 30 days, ${money(d.stopped.cents)} kept safe`
        lines = d.stopped.recent.map((item) => `${item.title}. ${item.detail}`)
        links.push({ label: 'See them in the Ledger', to: '/ledger' })
        break
      case 'month':
        title = d.month ? `${d.month.label}: ${money(d.month.inCents)} in, ${money(d.month.outCents)} out, ${money(d.month.keptCents)} kept` : 'No rules yet'
        lines = d.month ? [`Contractor cap: ${money(d.month.reservedCents)} of ${money(d.month.capCents)} used.`, d.stats.last30Days.automaticShare === null ? 'No decisions yet in the last 30 days.' : `${d.stats.last30Days.automaticShare}% of the last ${d.stats.last30Days.requests} requests needed no tap.`] : []
        links.push({ label: 'Open Jobs', to: '/jobs' })
        break
      case 'inflight':
        title = d.inFlight.length === 0 ? 'Nothing is in flight' : `${d.inFlight.length} in flight`
        lines = d.inFlight.length === 0 ? ['No invoice is waiting on a client and no payout is processing.'] : d.inFlight.map((item) => `${item.title}. ${item.detail}`)
        if (d.watcher.lastLook) lines.push(`Mandate last asked PayPal at ${new Date(d.watcher.lastLook.at).toLocaleTimeString('en-US')} and asks every minute.`)
        links.push({ label: 'Open Today', to: '/' })
        break
      case 'ready':
        title = d.readyToBill.length === 0 ? 'Nothing is ready to bill' : `${d.readyToBill.length} milestone${d.readyToBill.length === 1 ? '' : 's'} ready to bill`
        lines = d.readyToBill.map((item) => `${item.buyerName}: milestone ${item.milestone + 1} of ${item.total}, ${item.title}, ${money(item.amountCents)}${item.delivery ? ` (${item.delivery.status === 'awaiting' ? 'waiting for the client to accept' : item.delivery.status})` : ''}.`)
        links.push({ label: 'Open Today', to: '/' })
        break
      case 'done':
        title = d.done.length === 0 ? 'Nothing has settled this week' : `${d.done.length} settled in the last 7 days`
        lines = d.done.map((item) => `${item.title}. ${item.detail}`)
        links.push({ label: 'Open the Ledger', to: '/ledger' })
        break
      case 'autopilot': {
        const a = d.automation
        title = a?.any ? 'Autopilot is on' : 'Autopilot is off'
        lines = a ? [
          `Bill signed-deal milestones: ${a.billSignedDeals ? (a.requireAcceptance ? 'yes, after the client’s agent accepts' : 'yes, when proof is attached') : 'no'}.`,
          `Pay contractors when the client pays: ${a.payOnSettle ? 'yes' : 'no'} (${a.standingRules} standing rule${a.standingRules === 1 ? '' : 's'}).`,
          `Remind unpaid invoices: ${a.remindUnpaidAfterDays ? `after ${a.remindUnpaidAfterDays} days, up to ${a.maxReminders} times` : 'no'}.`,
        ] : []
        links.push({ label: 'Change it in Rules', to: '/rules' })
        break
      }
    }
    return { kind: 'answer', id, title, lines, links }
  }
}
