import { session } from './session'
import type { AgentRun, ClerkReply, Deal, DealCheck, Health, Job, LedgerEvent, LockCheck, Negotiation, Packet, Page, PartyRulesView, Proposal, ProposalInput, Session, SigningKey, Warrant } from './types'

/** An RFC 9457 problem from the server, kept whole so screens can show the exact words. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail: string,
    readonly body: Record<string, unknown>,
  ) {
    super(detail || title)
    this.name = 'ApiError'
  }
}

type Options = { method?: string; body?: unknown; idempotencyKey?: string; key?: string }

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = options.key ?? session.get()
  if (key) headers.authorization = `Bearer ${key}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'network.offline', 'No connection', 'The server could not be reached. Nothing was sent.', {})
  }
  const text = await response.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!response.ok) {
    throw new ApiError(
      response.status,
      String(body.code ?? 'http.error'),
      String(body.title ?? response.statusText),
      String(body.detail ?? ''),
      body,
    )
  }
  return body as T
}

export const api = {
  health: () => request<Health>('/health'),
  ready: () => request<Health>('/ready'),
  session: (key?: string) => request<Session>('/v1/session', { key }),
  warrant: () => request<Warrant>('/v1/warrant'),
  warrantVersions: () => request<{ data: Warrant[] }>('/v1/warrant/versions'),
  publishWarrant: (body: unknown) => request<Warrant>('/v1/warrant', { method: 'PUT', body }),
  proposals: (cursor?: string | null) => request<Page<Proposal>>(`/v1/proposals?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  proposal: (id: string) => request<Proposal>(`/v1/proposals/${id}`),
  packet: (id: string) => request<Packet>(`/v1/proposals/${id}/packet`),
  propose: (input: ProposalInput, idempotencyKey: string) => request<Proposal>('/v1/proposals', { method: 'POST', body: input, idempotencyKey }),
  approve: (id: string) => request<Proposal>(`/v1/proposals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => request<Proposal>(`/v1/proposals/${id}/reject`, { method: 'POST' }),
  capture: (id: string, claimedAmountCents?: number) =>
    request<Proposal>(`/v1/proposals/${id}/capture`, { method: 'POST', body: claimedAmountCents === undefined ? undefined : { claimedAmountCents } }),
  job: (jobId: string) => request<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`),
  verifyLock: (id: string) => request<LockCheck>(`/v1/proposals/${id}/verify`),
  signingKeys: () => request<{ data: SigningKey[] }>('/.well-known/mandate-keys.json'),
  deals: () => request<{ data: Deal[] }>('/v1/deals?limit=50'),
  verifyDeal: (id: string) => request<DealCheck>(`/v1/deals/${id}/verify`),
  offerDeal: (body: { buyer: string; as?: 'buyer' | 'seller'; threadId?: string; prompt?: string; terms: Record<string, unknown> }, idempotencyKey: string) =>
    request<Deal>('/v1/deals/offers', { method: 'POST', body, idempotencyKey }),
  billMilestone: (dealId: string, milestone: number, evidenceUrl: string) =>
    request<Proposal>(`/v1/deals/${dealId}/milestones/${milestone}/bill`, { method: 'POST', body: { evidenceUrl } }),
  partyRules: () => request<{ data: PartyRulesView[] }>('/v1/party-rules'),
  negotiate: (body: { buyerBrief?: string; sellerBrief?: string } = {}) => request<Negotiation>('/v1/negotiations', { method: 'POST', body }),
  clerk: (message: string, conversationId?: string) => request<ClerkReply>('/v1/clerk/messages', { method: 'POST', body: { message, conversationId } }),
  agentRun: (id: string) => request<AgentRun>(`/v1/agent-runs/${id}`),
  ledger: (cursor?: string | null) => request<Page<LedgerEvent>>(`/v1/ledger?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
}
