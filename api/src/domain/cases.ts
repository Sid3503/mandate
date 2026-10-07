import type { WarrantBody } from './schemas'

/**
 * Test cases made from the rules themselves, so that a rule can be checked against what its writer meant before it goes live.
 * Each case sits on a boundary: just under the no-tap line, exactly on it, a cent over the ceiling, work that is not allowed,
 * someone who is not on the list, a missing proof link. They are made by code from the numbers in the rules, never by a model.
 */
export type TryRequest = {
  kind: 'payment'
  payee: string
  amountCents: number
  currency: string
  category: string
  description: string
  evidenceUrl?: string
  jobId?: string
  fundingCaptureId?: string
}

export type TryCase = { id: string; label: string; request: TryRequest }

const usd = (cents: number) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`

export function generateCases(body: WarrantBody, funding: { captureId: string; jobId: string | null } | null): TryCase[] {
  const first = body.payees[0]
  if (!first) return []
  const work = body.categories[0] ?? 'design'
  const unlisted = ['lunch', 'travel', 'gifts', 'software'].find((item) => !body.categories.includes(item)) ?? 'lunch'
  const base = (over: Partial<TryRequest>): TryRequest => ({
    kind: 'payment', payee: first.displayName, amountCents: 5_000, currency: body.currency, category: work,
    description: 'Try-it request', evidenceUrl: 'https://www.figma.com/file/try-it',
    ...(funding ? { fundingCaptureId: funding.captureId, ...(funding.jobId ? { jobId: funding.jobId } : {}) } : {}), ...over,
  })
  const line = body.autoSettleUnderCents
  const cases: TryCase[] = []
  // The gate asks for client money first, so a case about a small or unproven payout can only be tried against a real payment.
  const canTryPayouts = !body.fundingRequired || funding !== null
  if (canTryPayouts && line > 1) cases.push({ id: 'under-line', label: `${first.displayName}, ${usd(line - 1)} of ${work}, one cent under the no-tap line`, request: base({ amountCents: line - 1 }) })
  if (canTryPayouts && line > 0) cases.push({ id: 'on-line', label: `${first.displayName}, ${usd(line)} of ${work}, exactly on the no-tap line`, request: base({ amountCents: line }) })
  if (canTryPayouts) cases.push({ id: 'over-ceiling', label: `${first.displayName}, ${usd(body.perPaymentCeilingCents + 1)}, one cent over the per-payment ceiling`, request: base({ amountCents: body.perPaymentCeilingCents + 1 }) })
  cases.push({ id: 'not-allowed', label: `${first.displayName}, $18 of ${unlisted}, work the rules do not list`, request: base({ amountCents: 1_800, category: unlisted }) })
  cases.push({ id: 'stranger', label: 'Someone who is not on the rules, $50', request: base({ payee: 'A. Stranger', amountCents: 5_000 }) })
  if (canTryPayouts) cases.push({ id: 'no-proof', label: `${first.displayName}, $50 of ${work}, with no link to the work`, request: base({ evidenceUrl: undefined }) })
  for (const rule of body.standing.slice(0, 1)) {
    const person = body.payees.find((item) => item.id === rule.payeeId)
    if (person && funding) cases.push({ id: 'standing', label: `${person.displayName}, ${usd(Math.max(1, Math.min(body.perPaymentCeilingCents, 9_000)))} from a settled client payment, covered by a standing rule`, request: base({ payee: person.displayName, amountCents: Math.max(1, Math.min(body.perPaymentCeilingCents, 9_000)) }) })
  }
  return cases
}
