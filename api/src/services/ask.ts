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

export const QUICK_IDS = ['waiting', 'refused', 'month', 'inflight', 'ready', 'done', 'autopilot'] as const
export type QuickId = (typeof QUICK_IDS)[number]

const money = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const QUICK_WORDS: Array<[QuickId, RegExp]> = [
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
  constructor(private readonly today: TodayService) {}

  route(message: string, context?: { jobId?: string }): AskRoute {
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

  private deliveryAction(text: string, url: string | null, context?: { jobId?: string }): AskRoute | null {
    const data = this.today.build()
    let open = data.readyToBill.filter((item) => item.delivery?.status !== 'awaiting')
    if (context?.jobId) open = open.filter((item) => item.jobId === context.jobId)
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

  quick(id: QuickId): AskRoute {
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
