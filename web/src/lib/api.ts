import { session } from './session'
import type { AgentHealth, ClientErrorRow, SystemStatus, AskRoute, ClerkStreamEvent, QuickId, Replay, Activity, AuditReport, Balance, Delivered, Delivery, RulesDraft, Today, ToolSummary, AgentRun, ClerkReply, Features, Deal, DealCheck, Health, Job, LedgerEvent, LockCheck, Negotiation, Packet, Page, PartyRulesView, Proposal, ProposalInput, Session, SigningKey, Warrant } from './types'

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

  /** The id the server gave this request. Quote it and the log line for it can be found. */
  get requestId(): string | null {
    return typeof this.body.requestId === 'string' ? this.body.requestId : null
  }

  /**
   * Is trying the same thing again a sensible next step? A refusal by the rules is not: it will say the same. A server that
   * did not answer is. For a button that moves money the screen still says "check Today first", because a dropped
   * connection does not say whether the server got the request.
   */
  get retryable(): boolean {
    return this.body.retryable === true || this.status === 0 || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504
  }
}

type Options = { method?: string; body?: unknown; idempotencyKey?: string; key?: string; headers?: Record<string, string> }

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = options.key ?? session.get()
  if (key) headers.authorization = `Bearer ${key}`
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
  if (options.headers) Object.assign(headers, options.headers)
  let response: Response
  try {
    // A server that does not answer in 30 seconds is treated as not answering, not waited on forever.
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    if ((error as Error)?.name === 'TimeoutError') {
      throw new ApiError(0, 'network.timeout', 'The server did not answer', 'No answer in 30 seconds. If you pressed a button that moves money, look at Today before pressing it again: the request may have gone through.', {})
    }
    throw new ApiError(0, 'network.offline', 'No connection', 'The server could not be reached. Nothing was sent.', {})
  }
  const text = await response.text()
  // A proxy or a crashed server can answer with a page of HTML. That is a failure to describe, not a crash to throw.
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    if (response.ok) throw new ApiError(502, 'response.unreadable', 'The answer could not be read', 'The server sent something that was not JSON. Reload and try again.', {})
    body = { detail: text.slice(0, 160).replace(/<[^>]+>/g, ' ').trim() }
  }
  if (!response.ok) {
    const id = response.headers.get('x-request-id')
    throw new ApiError(
      response.status,
      String(body.code ?? (response.status >= 500 ? 'server.error' : 'http.error')),
      String(body.title ?? response.statusText),
      String(body.detail ?? ''),
      id && !body.requestId ? { ...body, requestId: id } : body,
    )
  }
  return body as T
}

/** The stages of making a draft of new rules. Each is a step the server really took, in this order. */
export type DraftStage =
  | { stage: 'reading'; people: number; standing: number }
  | { stage: 'drafting'; attempt: number; model: string }
  | { stage: 'patch'; summary: string }
  | { stage: 'retry'; attempt: number; reason: string }
  | { stage: 'checking' }
  | { stage: 'replaying' }
  | { stage: 'reading_back' }
export type DraftStreamEvent = ({ type: 'stage' } & DraftStage) | { type: 'done'; draft: RulesDraft } | { type: 'error'; code: string; title: string; message: string }

export type NegotiationEvent =
  | { type: 'start'; threadId: string; model: string; maxOffers: number; studio: string; client: string }
  | { type: 'turn_start'; turn: number; side: 'buyer' | 'seller'; company: string }
  | { type: 'turn_tool'; turn: number; side: 'buyer' | 'seller'; phase: 'start' | 'call' | 'end'; id: string; tool: string; input?: unknown; ok?: boolean; ms?: number }
  | { type: 'turn'; turn: number; side: 'buyer' | 'seller'; runId: string; ms: number; deal: import('./types').Deal }
  | { type: 'turn_error'; turn: number; side: 'buyer' | 'seller'; runId: string; error: string }
  | { type: 'done'; threadId: string; agreed: boolean; dealId: string | null; stopped: boolean }
  | { type: 'error'; code: string; message: string }

/**
 * Watches a negotiation as it happens (server-sent events over a POST, because an EventSource cannot carry the key).
 * Resolves when the stream ends. Pressing Stop aborts the request, which also cancels the model call on the server.
 */
async function streamNegotiation(onEvent: (event: NegotiationEvent) => void, signal: AbortSignal): Promise<void> {
  const key = session.get()
  let response: Response
  try {
    response = await fetch('/v1/negotiations/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: '{}',
      cache: 'no-store',
      signal,
    })
  } catch (error) {
    if (signal.aborted) return
    throw new ApiError(0, 'network.offline', 'No connection', 'The server could not be reached. Nothing was sent.', {})
  }
  if (!response.ok || !response.body) {
    const text = await response.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    throw new ApiError(response.status, String(body.code ?? 'http.error'), String(body.title ?? response.statusText), String(body.detail ?? ''), body)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split !== -1) {
        const block = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const data = /^data: (.*)$/m.exec(block)?.[1]
        if (data) onEvent(JSON.parse(data) as NegotiationEvent)
        split = buffer.indexOf('\n\n')
      }
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
}

/**
 * POSTs and reads a server-sent-event stream (an EventSource cannot carry the key). Every event's data is JSON with a
 * `type`. Resolves when the stream ends; a problem before the stream opens is thrown as a normal ApiError.
 */
async function postStream<E>(path: string, body: unknown, onEvent: (event: E) => void, signal?: AbortSignal): Promise<void> {
  const key = session.get()
  let response: Response
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal,
    })
  } catch {
    if (signal?.aborted) return
    throw new ApiError(0, 'network.offline', 'No connection', 'The server could not be reached. Nothing was sent.', {})
  }
  if (!response.ok || !response.body) {
    const text = await response.text()
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    throw new ApiError(response.status, String(parsed.code ?? 'http.error'), String(parsed.title ?? response.statusText), String(parsed.detail ?? ''), parsed)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let split = buffer.indexOf('\n\n')
    while (split !== -1) {
      const block = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      const data = /^data: (.*)$/m.exec(block)?.[1]
      if (data) onEvent(JSON.parse(data) as E)
      split = buffer.indexOf('\n\n')
    }
  }
}

/** The clerk, told as it works: each tool call as it starts and ends, the words as they are written, then the whole reply. */
const streamClerk = (body: { message: string; conversationId?: string; context?: { jobId?: string; proposalId?: string } }, onEvent: (event: ClerkStreamEvent) => void, signal?: AbortSignal) => postStream('/v1/clerk/stream', body, onEvent, signal)

/** A draft of new rules, told as it is made: each stage is a real step the server took. */
const streamDraft = (instruction: string, onEvent: (event: DraftStreamEvent) => void, signal?: AbortSignal) => postStream('/v1/rules/draft/stream', { instruction }, onEvent, signal)

export const api = {
  streamNegotiation,
  streamClerk,
  streamDraft,
  agentHealth: () => request<AgentHealth>('/v1/agents/health'),
  status: () => request<SystemStatus>('/v1/status'),
  clientErrors: () => request<{ data: ClientErrorRow[] }>('/v1/client-errors'),
  ask: (input: { message?: string; quick?: QuickId; context?: { jobId?: string } }) => request<AskRoute>('/v1/ask', { method: 'POST', body: input }),
  replayRules: (rules: unknown) => request<Replay>('/v1/rules/replay', { method: 'POST', body: rules }),
  health: () => request<Health>('/health'),
  ready: () => request<Health>('/ready'),
  session: (key?: string) => request<Session>('/v1/session', { key }),
  warrant: () => request<Warrant>('/v1/warrant'),
  warrantVersions: () => request<{ data: Warrant[] }>('/v1/warrant/versions'),
  publishWarrant: (body: unknown, expectedVersion?: number) => request<Warrant>('/v1/warrant', { method: 'PUT', body, headers: expectedVersion === undefined ? undefined : { 'x-expected-version': String(expectedVersion) } }),
  proposals: (cursor?: string | null) => request<Page<Proposal>>(`/v1/proposals?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  proposal: (id: string) => request<Proposal>(`/v1/proposals/${id}`),
  packet: (id: string) => request<Packet>(`/v1/proposals/${id}/packet`),
  propose: (input: ProposalInput, idempotencyKey: string) => request<Proposal>('/v1/proposals', { method: 'POST', body: input, idempotencyKey }),
  approve: (id: string) => request<Proposal>(`/v1/proposals/${id}/approve`, { method: 'POST' }),
  reject: (id: string) => request<Proposal>(`/v1/proposals/${id}/reject`, { method: 'POST' }),
  cancelPayout: (id: string) => request<Proposal>(`/v1/proposals/${id}/cancel-payout`, { method: 'POST' }),
  remindInvoice: (id: string) => request<Proposal>(`/v1/proposals/${id}/remind-invoice`, { method: 'POST' }),
  cancelInvoice: (id: string) => request<Proposal>(`/v1/proposals/${id}/cancel-invoice`, { method: 'POST' }),
  features: () => request<Features>('/v1/paypal/features'),
  checkFeatures: () => request<Features>('/v1/paypal/features/check', { method: 'POST' }),
  today: () => request<Today>('/v1/today'),
  audit: (paypal = false) => request<AuditReport>(`/v1/audit${paypal ? '?paypal=1' : ''}`),
  draftRules: (instruction: string) => request<RulesDraft>('/v1/rules/draft', { method: 'POST', body: { instruction } }),
  balance: () => request<Balance>('/v1/paypal/balance'),
  tools: () => request<ToolSummary>('/v1/paypal/tools'),
  activity: () => request<Activity>('/v1/paypal/activity'),
  syncDisputes: () => request<{ checked: boolean; open: number }>('/v1/paypal/disputes/sync', { method: 'POST' }),
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
  deliverMilestone: (dealId: string, milestone: number, evidenceUrl: string) =>
    request<Delivered>(`/v1/deals/${dealId}/milestones/${milestone}/deliver`, { method: 'POST', body: { evidenceUrl } }),
  reviewDelivery: (dealId: string, milestone: number) =>
    request<{ runId: string; model: string; ms: number; delivery: Delivery; charge: Proposal | null }>(`/v1/deals/${dealId}/milestones/${milestone}/review`, { method: 'POST' }),
  partyRules: () => request<{ data: PartyRulesView[] }>('/v1/party-rules'),
  negotiate: (body: { buyerBrief?: string; sellerBrief?: string } = {}) => request<Negotiation>('/v1/negotiations', { method: 'POST', body }),
  clerk: (message: string, conversationId?: string) => request<ClerkReply>('/v1/clerk/messages', { method: 'POST', body: { message, conversationId } }),
  agentRuns: () => request<{ data: Array<{ id: string; agent: string; status: string; model: string; input: string; ms: number; createdAt: string }> }>('/v1/agent-runs'),
  agentRun: (id: string) => request<AgentRun>(`/v1/agent-runs/${id}`),
  ledger: (cursor?: string | null) => request<Page<LedgerEvent>>(`/v1/ledger?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
}
