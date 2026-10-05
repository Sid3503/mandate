import type { components } from './openapi'

export type Proposal = components['schemas']['Proposal']
export type Warrant = components['schemas']['Warrant']
export type Session = components['schemas']['Session']
export type Deal = components['schemas']['Deal']
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
  invoice: { id: string; status: string | null; url: string | null } | null
  lock: { hash: string; signature: string | null; keyId: string | null; algorithm: 'ed25519'; signatureValid: boolean } | null
  agentRun: { id: string; agent: string; model: string; status: string; input: string; output: string | null; createdAt: string } | null
  payout: {
    batchId: string
    itemId: string | null
    status: string | null
    transactionId: string | null
    feeCents: number | null
    receiver: string | null
  } | null
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
  deal: Deal['billing']
}

export type LockCheck = {
  proposalId: string
  locked: boolean
  cartHash: string | null
  hashMatches: boolean | null
  signature: string | null
  keyId: string | null
  algorithm: 'ed25519'
  signatureValid: boolean | null
  verdict: 'valid' | 'invalid' | 'not_locked'
  message: string | null
  publicKeys: SigningKey[]
}

export type DealCheck = {
  dealId: string
  status: string
  termsHash: string
  hashMatches: boolean
  signatureValid: boolean | null
  keyId: string | null
  verdict: 'valid' | 'invalid' | 'not_agreed'
  publicKeys: SigningKey[]
}

export type SigningKey = { keyId: string; algorithm: 'ed25519'; publicKeyPem: string; publicKeyBase64Url: string; current: boolean }

export type ClerkReply = {
  conversationId: string
  runId: string
  reply: string
  guarded: boolean
  outcomes: Array<{ tool: string; ok: boolean; data: Record<string, unknown> }>
  tools: Array<{ tool: string; ok: boolean }>
  model: string
  ms: number
}

export type AgentRun = {
  id: string
  agent: string
  actor: string
  model: string
  status: string
  input: string
  output: string | null
  error: string | null
  ms: number | null
  createdAt: string
  trace: Array<{ text: string; toolCalls: Array<{ tool: string; input: unknown }>; toolResults: Array<{ tool: string; ok: boolean; output: unknown }> }>
}

export type Negotiation = {
  threadId: string
  model: string
  agreed: boolean
  dealId: string | null
  turns: Array<{ turn: number; side: 'buyer' | 'seller'; runId: string; deal?: Deal; error?: string; ms?: number }>
}

export type PartyRulesView = {
  partyId: string
  version: number
  role: 'buyer' | 'seller'
  displayName: string
  currency: string
  categories: string[]
  maxMilestones: number
  requireProof: boolean
  maxTotalCents?: number
  maxMilestoneCents?: number
  minTotalCents?: number
  minMilestoneCents?: number
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
