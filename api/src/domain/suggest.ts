import type { WarrantBody } from './schemas'

/**
 * "You keep saying yes. Make it a rule."
 *
 * Looks at what the owner actually did and offers a standing rule only when the history is unambiguous: the same
 * contractor, paid from the same client's money, approved by the owner's tap at least three times in the last 60 days,
 * never rejected, and not already covered by a rule. The suggestion is only words for the rules drafter: it is not a rule,
 * the drafter makes a draft from it, the code lists what the draft loosens, and the owner signs. Pure and deterministic.
 */
export type SuggestInput = {
  warrant: WarrantBody
  now: Date
  proposals: Array<{ id: string; kind: string; gate: string; clause: string; phase: string; payeeId: string | null; amountCents: number; fundingCaptureId: string | null; captureId: string | null; createdAt: string }>
  /** Who approved or rejected what. `actor` is who pressed the button. */
  decisions: Array<{ proposalId: string; type: 'approved' | 'rejected'; actor: string; at: string }>
}

export type Suggestion = {
  id: string
  payeeId: string
  payeeName: string
  clientId: string
  clientName: string
  approved: number
  totalCents: number
  largestCents: number
  firstAt: string
  /** What would be sent to the drafter. */
  draft: string
}

export type Taps = { thisMonth: number; lastMonth: number; byRule: number }

const WINDOW_DAYS = 60
const MIN_APPROVALS = 3
const SENT = new Set(['captured', 'payout_sent', 'payout_unclaimed', 'locked', 'order_created'])

export function suggestRules(input: SuggestInput): Suggestion[] {
  const since = input.now.getTime() - WINDOW_DAYS * 86_400_000
  const clientOfCapture = new Map(input.proposals.filter((row) => row.kind === 'charge' && row.captureId).map((row) => [row.captureId!, row.payeeId]))
  const approvals = new Map<string, number>()
  const rejected = new Set<string>()
  for (const item of input.decisions) {
    if (item.actor !== 'owner') continue
    if (item.type === 'approved') approvals.set(item.proposalId, Date.parse(item.at))
    else rejected.add(item.proposalId)
  }
  const groups = new Map<string, { rows: SuggestInput['proposals']; rejected: number }>()
  for (const row of input.proposals) {
    if (row.kind !== 'payment' || !row.payeeId || !row.fundingCaptureId) continue
    const client = clientOfCapture.get(row.fundingCaptureId)
    if (!client) continue
    const key = `${row.payeeId}:${client}`
    const group = groups.get(key) ?? { rows: [], rejected: 0 }
    if (rejected.has(row.id)) group.rejected += 1
    else if (row.clause === 'amount.needs_approval' && SENT.has(row.phase) && (approvals.get(row.id) ?? 0) >= since) group.rows.push(row)
    groups.set(key, group)
  }
  const out: Suggestion[] = []
  for (const [key, group] of groups) {
    const [payeeId, clientId] = key.split(':') as [string, string]
    const covered = input.warrant.standing.some((rule) => rule.payeeId === payeeId && rule.clientIds.includes(clientId))
    const payee = input.warrant.payees.find((item) => item.id === payeeId)
    const client = input.warrant.clients.find((item) => item.id === clientId)
    if (covered || !payee || !client || group.rejected > 0 || group.rows.length < MIN_APPROVALS) continue
    const amounts = group.rows.map((row) => row.amountCents)
    out.push({
      id: key,
      payeeId,
      payeeName: payee.displayName,
      clientId,
      clientName: client.displayName,
      approved: group.rows.length,
      totalCents: amounts.reduce((sum, cents) => sum + cents, 0),
      largestCents: Math.max(...amounts),
      firstAt: group.rows.map((row) => row.createdAt).sort()[0]!,
      draft: `Pay ${payee.displayName} automatically from ${client.displayName}'s signed-deal payments, with no tap, as soon as ${client.displayName} pays.`,
    })
  }
  return out.sort((a, b) => b.approved - a.approved)
}

/** How many times the owner had to tap, this month and last, and how many requests the owner's rules approved without one. */
export function countTaps(input: Pick<SuggestInput, 'proposals' | 'decisions' | 'now'>): Taps {
  const month = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  const thisMonth = month(input.now)
  const last = month(new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() - 1, 1)))
  const taps = input.decisions.filter((item) => item.actor === 'owner' && item.type === 'approved')
  return {
    thisMonth: taps.filter((item) => item.at.startsWith(thisMonth)).length,
    lastMonth: taps.filter((item) => item.at.startsWith(last)).length,
    byRule: input.proposals.filter((row) => row.gate === 'AUTO' && row.createdAt.startsWith(thisMonth) && row.phase !== 'denied').length,
  }
}
