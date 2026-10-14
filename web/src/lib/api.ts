import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { session } from './session'
import type { ShareSummary, ShareView, Activity, AgentHealth, AgentRow, AgentRun, AgentScope, AgentScorecard, AskRoute, AuditReport, Balance, ClerkReply, ClerkStreamEvent, ClientErrorRow, ClientKeyRow, Deal, DealCheck, Delivered, Delivery, Features, Guarantees, Health, Job, LedgerEvent, LockCheck, Negotiation, Packet, Page, PartyRulesView, PayeeBookEntry, Proposal, ProposalInput, QuickId, Replay, RulesDraft, Safety, ServerFlags, Session, SigningKey, SystemStatus, Today, ToolSummary, TryCases, TryOne, Warrant, Suggestions } from './types'

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

/** Prefix tenant routes only. Public doors (/demo/start, /workspaces, /join) stay on the outer server. */
function scopePath(path: string): { path: string; credentials: RequestCredentials; client: boolean } {
  const workspace = session.workspace()
  const tenant = Boolean(workspace) && (path.startsWith('/v1/') || path.startsWith('/auth/') || path.startsWith('/mcp'))
  return { path: tenant && workspace ? `/w/${workspace}${path}` : path, credentials: workspace ? 'include' : 'same-origin', client: Boolean(workspace) }
}

async function request<T>(path: string, options: Options = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = options.key ?? session.get()
  if (key) headers.authorization = `Bearer ${key}`
  const scoped = scopePath(path)
  if (scoped.client) headers['x-mandate-client'] = 'web'
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey
  if (options.headers) Object.assign(headers, options.headers)
  let response: Response
  try {
    // A server that does not answer in 30 seconds is treated as not answering, not waited on forever.
    response = await fetch(scoped.path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      credentials: scoped.credentials,
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
  | { stage: 'second_reading'; model: string }
  | { stage: 'reading_policy'; sentences: number; parts: number }
  | { stage: 'classified'; rules: number; setAside: number }
  | { stage: 'auditing'; sentences: number; changes: number }
export type PolicyStreamEvent = ({ type: 'stage' } & DraftStage) | { type: 'done'; policy: import('./types').PolicyResult } | { type: 'error'; code: string; title: string; message: string }
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
  const scoped = scopePath('/v1/negotiations/stream')
  let response: Response
  try {
    response = await fetch(scoped.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(scoped.client ? { 'x-mandate-client': 'web' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: '{}',
      cache: 'no-store',
      credentials: scoped.credentials,
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
  const scoped = scopePath(path)
  let response: Response
  try {
    response = await fetch(scoped.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...(scoped.client ? { 'x-mandate-client': 'web' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: scoped.credentials,
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
const streamClerk = (body: { message: string; conversationId?: string; context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string } }, onEvent: (event: ClerkStreamEvent) => void, signal?: AbortSignal) => postStream('/v1/clerk/stream', body, onEvent, signal)

/** A draft of new rules, told as it is made: each stage is a real step the server took. */
const streamDraft = (instruction: string, onEvent: (event: DraftStreamEvent) => void, signal?: AbortSignal) => postStream('/v1/rules/draft/stream', { instruction }, onEvent, signal)

const streamPolicy = (text: string, onEvent: (event: PolicyStreamEvent) => void, signal?: AbortSignal) => postStream('/v1/rules/policy/stream', { text }, onEvent, signal)

async function approveWithPasskey(id: string): Promise<Proposal> {
  const optionsFor = () => request<{ challengeId: string; options: { allowCredentials?: unknown[] } }>('/auth/stepup/options', { method: 'POST', body: { kind: 'approve', proposalId: id } })
  let started = await optionsFor()
  if (!started.options.allowCredentials || started.options.allowCredentials.length === 0) {
    const reg = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/register/options', { method: 'POST', body: {} })
    const registered = await startRegistration({ optionsJSON: reg.options as never })
    await request('/auth/register/verify', { method: 'POST', body: { challengeId: reg.challengeId, response: registered } })
    started = await optionsFor()
  }
  const signed = await startAuthentication({ optionsJSON: started.options as never })
  const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
  return request<Proposal>(`/v1/proposals/${id}/approve`, { method: 'POST', headers: { 'x-mandate-stepup': verified.grant } })
}

export const api = {
  streamNegotiation,
  streamPolicy,
  streamClerk,
  streamDraft,
  agentHealth: () => request<AgentHealth>('/v1/agents/health'),
  status: () => request<SystemStatus>('/v1/status'),
  safety: () => request<Safety>('/v1/safety'),
  suggestions: () => request<Suggestions>('/v1/suggestions'),
  guarantees: () => request<Guarantees>('/v1/guarantees'),
  demoStart: () => request<{ workspaceId: string; expiresAt: string; role: string; mode: string }>('/demo/start', { method: 'POST', body: {} }),
  createStudio: (name: string) => request<{ workspaceId: string; memberId: string; challengeId: string; options: Record<string, unknown>; paypal: string }>('/workspaces', { method: 'POST', body: { name } }),
  passkeyRegisterVerify: (body: { challengeId: string; response: unknown }) => request<{ credentialId: string; fingerprint: string }>('/auth/register/verify', { method: 'POST', body }),
  passkeyLoginOptions: () => request<{ challengeId: string; options: Record<string, unknown> }>('/auth/login/options', { method: 'POST', body: {} }),
  passkeyLoginVerify: (body: { challengeId: string; response: unknown }) => request<{ workspaceId: string; role: string; displayName: string }>('/auth/login/verify', { method: 'POST', body }),
  signInWithPasskey: async () => {
    const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/login/options', { method: 'POST', body: {} })
    const signed = await startAuthentication({ optionsJSON: started.options as never })
    return request<{ workspaceId: string; role: string; displayName: string }>('/auth/login/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
  },
  authMe: () => request<{ role: string; displayName: string; method: string }>('/auth/me'),
  sessions: () => request<{ sessions: Array<{ publicId: string; at: string; lastSeen: string; method: string; revoked: boolean; current: boolean }> }>('/auth/sessions'),
  authEvents: () => request<{ events: Array<{ at: string; event: string; result: string }> }>('/auth/events'),
  revokeSession: (publicId: string) => request<{ ok: boolean }>('/auth/sessions/revoke', { method: 'POST', body: { publicId } }),
  revokeOtherSessions: () => request<{ ended: number }>('/auth/sessions/revoke-others', { method: 'POST', body: {} }),
  credentials: () => request<{ credentials: Array<{ id: string; fingerprint: string; revoked: boolean }> }>('/auth/credentials'),
  revokeCredential: (id: string) => request<{ ok: boolean }>('/auth/credentials/revoke', { method: 'POST', body: { id } }),
  addCredential: async () => {
    const reg = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/register/options', { method: 'POST', body: {} })
    const registered = await startRegistration({ optionsJSON: reg.options as never })
    return request<{ credentialId: string; fingerprint: string }>('/auth/register/verify', { method: 'POST', body: { challengeId: reg.challengeId, response: registered } })
  },
  issueRecovery: () => request<{ codes: string[]; saved: boolean }>('/auth/recovery/issue', { method: 'POST', body: {} }),
  ackRecovery: () => request<{ saved: boolean }>('/auth/recovery/ack', { method: 'POST', body: { saved: true } }),
  regenerateRecovery: async () => {
    const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'recovery' } })
    const signed = await startAuthentication({ optionsJSON: started.options as never })
    const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
    return request<{ codes: string[]; saved: boolean }>('/auth/recovery/regenerate', { method: 'POST', body: {}, headers: { 'x-mandate-stepup': verified.grant } })
  },
  joinPreview: (token: string) => request<{ workspaceId: string; name: string; role: string; inviter: string | null }>('/join/preview', { method: 'POST', body: { token } }),
  createInvite: async (role: 'approver' | 'proposer' | 'viewer' | 'payee') => {
    const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'invite', role, label: null } })
    const signed = await startAuthentication({ optionsJSON: started.options as never })
    const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
    return request<{ token: string; join: string }>('/v1/invites', { method: 'POST', body: { role, label: null }, headers: { 'x-mandate-stepup': verified.grant } })
  },
  revokeInvite: (token: string) => request<{ ok: boolean }>('/v1/invites/revoke', { method: 'POST', body: { token } }),
  members: () => request<{ members: Array<{ id: string; name: string; role: string; status: string; expiresAt?: string | null }> }>('/v1/members'),
  setMemberRole: async (id: string, role: string, expiresAt?: string | null) => {
    const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'member-role', memberId: id, role } })
    const signed = await startAuthentication({ optionsJSON: started.options as never })
    const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
    return request<{ ok: boolean; role: string; expiresAt?: string | null }>(`/v1/members/${encodeURIComponent(id)}/role`, { method: 'POST', body: { role, expiresAt }, headers: { 'x-mandate-stepup': verified.grant } })
  },
  revokeMember: async (id: string) => {
    const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'member-revoke', memberId: id } })
    const signed = await startAuthentication({ optionsJSON: started.options as never })
    const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
    return request<{ ok: boolean; openRequests: string[] }>(`/v1/members/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: {}, headers: { 'x-mandate-stepup': verified.grant } })
  },
  join: (workspaceId: string, token: string, name: string) => request<{ memberId: string; role: string; workspaceId: string }>(workspaceId === 'ws_default' ? '/join' : `/w/${workspaceId}/join`, { method: 'POST', body: { token, name } }),
  tryRequest: (requestBody: Record<string, unknown>, rules?: unknown) => request<TryOne>('/v1/rules/try', { method: 'POST', body: { request: requestBody, ...(rules ? { rules } : {}) } }),
  tryCases: (rules?: unknown) => request<TryCases>('/v1/rules/cases', { method: 'POST', body: rules ? { rules } : {} }),
  pause: (reason: string) => request<Safety>('/v1/safety/pause', { method: 'POST', body: { reason } }),
  resume: () => request<Safety>('/v1/safety/resume', { method: 'POST' }),
  clientErrors: () => request<{ data: ClientErrorRow[] }>('/v1/client-errors'),
  ask: (input: { message?: string; quick?: QuickId; context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string } }) => request<AskRoute>('/v1/ask', { method: 'POST', body: input }),
  replayRules: (rules: unknown) => request<Replay>('/v1/rules/replay', { method: 'POST', body: rules }),
  replayHistory: (rules?: unknown) => request<Replay>('/v1/replay', { method: 'POST', body: rules ?? {} }),
  agents: () => request<AgentRow[]>('/v1/agents'),
  createAgent: async (input: { name: string; scopes: AgentScope[]; limits?: { proposalsPerHour?: number; centsPerHour?: number }; expiryDays?: number | null }) => {
    try {
      return await request<{ agent: AgentRow; apiKey: string }>('/v1/agents', { method: 'POST', body: input })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'agent.issue', input } })
      const signed = await startAuthentication({ optionsJSON: started.options as never })
      const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
      return request<{ agent: AgentRow; apiKey: string }>('/v1/agents', { method: 'POST', body: input, headers: { 'x-mandate-stepup': verified.grant } })
    }
  },
  revokeAgent: (id: string) => request<AgentRow>(`/v1/agents/${id}/revoke`, { method: 'POST' }),
  resumeAgent: (id: string) => request<AgentRow>(`/v1/agents/${id}/resume`, { method: 'POST' }),
  agentScorecard: (id: string) => request<AgentScorecard>(`/v1/agents/${id}/scorecard`),
  /** Asks the MCP door which tools a key may use. The console is served by the same server, so this needs no CORS. */
  mcpTools: async (key: string) => {
    const answer = await request<{ result?: { tools?: Array<{ name: string }> } }>('/mcp', { method: 'POST', key, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers: { accept: 'application/json, text/event-stream' } })
    return (answer.result?.tools ?? []).map((tool) => tool.name)
  },
  shares: (jobId: string) => request<{ data: ShareSummary[] }>(`/v1/jobs/${encodeURIComponent(jobId)}/shares`),
  createShare: (jobId: string, input: { partyId: string; ttlDays?: number; label?: string }) => request<{ share: ShareSummary; token: string; url: string }>(`/v1/jobs/${encodeURIComponent(jobId)}/shares`, { method: 'POST', body: input }),
  revokeShare: (id: string) => request<ShareSummary>(`/v1/shares/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  /** Opened by someone who holds a link and no key. It sends no key even if this browser has one. */
  shareView: (token: string) => request<ShareView>(`/v1/share/${encodeURIComponent(token)}`, { key: '' }),
  notify: () => request<{ enabled: boolean; lastSentAt: string | null; lastError: string | null; sent: number }>('/v1/notify'),
  notifyTest: () => request<{ enabled: boolean; lastSentAt: string | null; lastError: string | null; sent: number }>('/v1/notify/test', { method: 'POST' }),
  resetDemo: () => request<{ reset: true }>('/v1/demo/reset', { method: 'POST', body: { confirm: 'reset the demo' } }),
  switchDemoRole: (role: 'owner' | 'approver' | 'proposer' | 'viewer' | 'payee') => request<{ role: string }>('/v1/demo/switch', { method: 'POST', body: { role } }),
  liveProof: () => request<{ files: Array<{ name: string; content: unknown }> }>('/v1/live-proof'),
  clientKeys: () => request<ClientKeyRow[]>('/v1/client-keys'),
  createClientKey: (input: { name: string; partyId: string }) => request<{ key: ClientKeyRow; apiKey: string }>('/v1/client-keys', { method: 'POST', body: input }),
  revokeClientKey: (id: string) => request<ClientKeyRow>(`/v1/client-keys/${id}/revoke`, { method: 'POST' }),
  rotateClientKey: (id: string) => request<{ key: ClientKeyRow; apiKey: string }>(`/v1/client-keys/${id}/rotate`, { method: 'POST' }),
  health: () => request<Health>('/health'),
  ready: () => request<Health>('/ready'),
  session: (key?: string) => request<Session>('/v1/session', { key }),
  flags: () => request<ServerFlags>('/v1/flags'),
  warrant: () => request<Warrant>('/v1/warrant'),
  warrantVersions: () => request<{ data: Warrant[] }>('/v1/warrant/versions'),
  publishWarrant: async (body: unknown, expectedVersion?: number) => {
    try {
      return await request<Warrant>('/v1/warrant', { method: 'PUT', body, headers: expectedVersion === undefined ? undefined : { 'x-expected-version': String(expectedVersion) } })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'rules', rules: body } })
      const signed = await startAuthentication({ optionsJSON: started.options as never })
      const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
      return request<Warrant>('/v1/warrant', {
        method: 'PUT',
        body,
        headers: {
          ...(expectedVersion === undefined ? {} : { 'x-expected-version': String(expectedVersion) }),
          'x-mandate-stepup': verified.grant,
        },
      })
    }
  },
  proposals: (cursor?: string | null) => request<Page<Proposal>>(`/v1/proposals?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  proposal: (id: string) => request<Proposal>(`/v1/proposals/${id}`),
  packet: (id: string) => request<Packet>(`/v1/proposals/${id}/packet`),
  propose: (input: ProposalInput, idempotencyKey: string) => request<Proposal>('/v1/proposals', { method: 'POST', body: input, idempotencyKey }),
  approve: async (id: string, how: 'auto' | 'demo' | 'passkey' = 'auto') => {
    if (how === 'demo') return request<Proposal>(`/v1/proposals/${id}/approve`, { method: 'POST', headers: { 'x-mandate-demo-tap': '1' } })
    if (how === 'passkey') return approveWithPasskey(id)
    try {
      return await request<Proposal>(`/v1/proposals/${id}/approve`, { method: 'POST' })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      return approveWithPasskey(id)
    }
  },
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
  // The caller's own sheet: a client key may read this and never the studio's, and the owner's own is the studio's.
  myPartyRules: () => request<PartyRulesView>('/v1/party-rules/mine'),
  // Write one company's sheet. Only the price fields are sent; everything else about the company is kept.
  putPartyRules: (partyId: string, body: Record<string, unknown>) => request<PartyRulesView>(`/v1/party-rules/${encodeURIComponent(partyId)}`, { method: 'PUT', body }),
  negotiate: (body: { buyerBrief?: string; sellerBrief?: string } = {}) => request<Negotiation>('/v1/negotiations', { method: 'POST', body }),
  clerk: (message: string, conversationId?: string, context?: { jobId?: string; proposalId?: string; receiptId?: string; dealId?: string }) => request<ClerkReply>('/v1/clerk/messages', { method: 'POST', body: { message, conversationId, context } }),
  agentRuns: () => request<{ data: Array<{ id: string; agent: string; status: string; model: string; input: string; ms: number; createdAt: string }> }>('/v1/agent-runs'),
  agentRun: (id: string) => request<AgentRun>(`/v1/agent-runs/${id}`),
  ledger: (cursor?: string | null) => request<Page<LedgerEvent>>(`/v1/ledger?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
  payees: () => request<{ payees: PayeeBookEntry[] }>('/v1/payees'),
  payee: (id: string) => request<{ payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}`),
  changePayee: (id: string, email: string) => request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/change`, { method: 'POST', body: { email } }),
  confirmPayeeChange: async (id: string) => {
    try {
      return await request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/confirm-change`, { method: 'POST' })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'payee.change', payeeId: id } })
      const signed = await startAuthentication({ optionsJSON: started.options as never })
      const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
      return request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/confirm-change`, { method: 'POST', headers: { 'x-mandate-stepup': verified.grant } })
    }
  },
  cancelPayeeChange: (id: string) => request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/cancel-change`, { method: 'POST' }),
  attestPayee: async (id: string) => {
    try {
      return await request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/attest`, { method: 'POST' })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'auth/stepup-required') throw error
      const started = await request<{ challengeId: string; options: Record<string, unknown> }>('/auth/stepup/options', { method: 'POST', body: { kind: 'payee.attest', payeeId: id } })
      const signed = await startAuthentication({ optionsJSON: started.options as never })
      const verified = await request<{ grant: string }>('/auth/stepup/verify', { method: 'POST', body: { challengeId: started.challengeId, response: signed } })
      return request<{ ok: boolean; payee: PayeeBookEntry }>(`/v1/payees/${encodeURIComponent(id)}/attest`, { method: 'POST', headers: { 'x-mandate-stepup': verified.grant } })
    }
  },
}
