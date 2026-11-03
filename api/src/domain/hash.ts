import { createHash } from 'node:crypto'

/** One line of a bill. Whole numbers only, so the same bill always hashes the same. */
export type LineItem = { description: string; quantity: number; unitCents: number }

export type CartFields = {
  proposalId: string
  warrantId: string
  warrantVersion: number
  payeeId: string
  amountCents: number
  currency: string
  category: string
  evidenceUrl: string
  kind: 'payment' | 'charge' | 'refund'
  parentCaptureId: string | null
  jobId?: string | null
  fundingCaptureId?: string | null
  /** The agreed deal and milestone this charge bills. Present only on deal-linked charges (cart v3). */
  dealId?: string | null
  milestone?: number | null
  /** What the owner approved beyond the total: the items, the due date and the note the client sees. Absent or null leaves the hash exactly as it was before these existed. */
  lineItems?: LineItem[] | null
  dueDate?: string | null
  customerNote?: string | null
}

/**
 * The bill's terms as they enter the hash, or null when the bill has none. Key order is fixed and an item is rebuilt
 * from its three named fields, so a stray extra property on a stored row can never change a hash.
 */
function termsPart(fields: CartFields): Record<string, unknown> | null {
  const terms: Record<string, unknown> = {}
  if (fields.lineItems && fields.lineItems.length > 0) {
    terms.lineItems = fields.lineItems.map((item) => ({ description: item.description, quantity: item.quantity, unitCents: item.unitCents }))
  }
  if (fields.dueDate) terms.dueDate = fields.dueDate
  if (fields.customerNote) terms.customerNote = fields.customerNote
  return Object.keys(terms).length > 0 ? terms : null
}

export function canonicalCart(fields: CartFields): string {
  const terms = termsPart(fields)
  // The terms are added last and only when present: a cart without them serialises byte for byte as it always did.
  return JSON.stringify(withTerms(JSON.parse(baseCart(fields)) as Record<string, unknown>, terms))
}

function withTerms(base: Record<string, unknown>, terms: Record<string, unknown> | null): Record<string, unknown> {
  return terms ? { ...base, terms } : base
}

function baseCart(fields: CartFields): string {
  const jobId = fields.jobId ?? null
  const fundingCaptureId = fields.fundingCaptureId ?? null
  if (fields.dealId) {
    return JSON.stringify({
      v: 3,
      proposalId: fields.proposalId,
      warrantId: fields.warrantId,
      warrantVersion: fields.warrantVersion,
      payeeId: fields.payeeId,
      amountCents: fields.amountCents,
      currency: fields.currency,
      category: fields.category,
      evidenceUrl: fields.evidenceUrl,
      kind: fields.kind,
      parentCaptureId: fields.parentCaptureId,
      jobId,
      fundingCaptureId,
      dealId: fields.dealId,
      milestone: fields.milestone ?? null,
    })
  }
  if (jobId !== null || fundingCaptureId !== null || fields.kind === 'charge') {
    return JSON.stringify({
      v: 2,
      proposalId: fields.proposalId,
      warrantId: fields.warrantId,
      warrantVersion: fields.warrantVersion,
      payeeId: fields.payeeId,
      amountCents: fields.amountCents,
      currency: fields.currency,
      category: fields.category,
      evidenceUrl: fields.evidenceUrl,
      kind: fields.kind,
      parentCaptureId: fields.parentCaptureId,
      jobId,
      fundingCaptureId,
    })
  }
  return JSON.stringify({
    v: 1,
    proposalId: fields.proposalId,
    warrantId: fields.warrantId,
    warrantVersion: fields.warrantVersion,
    payeeId: fields.payeeId,
    amountCents: fields.amountCents,
    currency: fields.currency,
    category: fields.category,
    evidenceUrl: fields.evidenceUrl,
    kind: fields.kind,
    parentCaptureId: fields.parentCaptureId,
  })
}

export function cartHash(fields: CartFields): string {
  return createHash('sha256').update(canonicalCart(fields)).digest('hex')
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stable((value as Record<string, unknown>)[key])])
    return Object.fromEntries(entries)
  }
  return value
}

export function paypalRequestId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
