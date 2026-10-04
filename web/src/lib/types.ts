import type { components } from './openapi'

export type Proposal = components['schemas']['Proposal']
export type Warrant = components['schemas']['Warrant']
export type Session = components['schemas']['Session']
export type Kind = Proposal['kind']
export type Gate = Proposal['gate']
export type Party = Warrant['payees'][number]

export type Page<T> = { data: T[]; nextCursor: string | null }

export type LedgerEvent = {
  id: string
  proposalId: string
  type: string
  clause: string | null
  payload: Record<string, unknown>
  createdAt: string
}

export type Packet = {
  proposal: Proposal
  payee: Party | null
  warrant: { id: string; version: number; currency: string; monthlyCapCents: number; autoSettleUnderCents: number } | null
  prompt: string | null
  clause: string
  approval: LedgerEvent | null
  amounts: { approvedCents: number | null; capturedCents: number | null; match: boolean | null }
  orderId: string | null
  captureId: string | null
  job: string | null
  funding: {
    captureId: string
    proposalId: string | null
    clientId: string | null
    jobId?: string | null
    capturedCents: number | null
    orderId?: string | null
    phase: string
  } | null
  events: LedgerEvent[]
}

export type Job = {
  jobId: string
  client: Party | null
  contractorShareBps: number | null
  charges: Array<Proposal & { fundableCents: number }>
  payouts: Proposal[]
  refunds: Proposal[]
  totals: { inCents: number; outCents: number; heldCents: number; keptCents: number }
}

export type Health = {
  status: 'pass' | 'fail' | 'warn'
  version: string
  checks: Record<string, Array<{ status: string; componentType: string; time: string; observedValue?: string }>>
}

export type ProposalInput = {
  kind: Kind
  payee: string
  amountCents: number
  currency: string
  category?: string
  description: string
  evidenceUrl?: string
  prompt?: string
  parentCaptureId?: string
  jobId?: string
  fundingCaptureId?: string
}
