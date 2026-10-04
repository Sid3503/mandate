import { createHash } from 'node:crypto'

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
}

export function canonicalCart(fields: CartFields): string {
  const jobId = fields.jobId ?? null
  const fundingCaptureId = fields.fundingCaptureId ?? null
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
