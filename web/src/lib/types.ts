import type { components } from './openapi'

export type Proposal = components['schemas']['Proposal']
export type Warrant = components['schemas']['Warrant']
export type SessionRole = 'owner' | 'approver' | 'proposer' | 'viewer' | 'payee'
export type Session = Omit<components['schemas']['Session'], 'role'> & { role: SessionRole }
/** Planned switches from GET /v1/flags. Off means that feature is not active. */
export type ServerFlags = {
  tenancy: boolean
  demoEnabled: boolean
  demoTtlHours: number
  demoMaxActive: number
  demoMaxPerIpHour: number
  passkeys: boolean
  requirePasskeyForMoney: boolean
  legacyOwnerKeyEnabled: boolean
  invites: boolean
  inviteTtlHours: number
  safetyBreaker: boolean
  payeeBook: boolean
  newPayeeWaitHours: number
  policyPaste: boolean
  secondReader: boolean
  mcpExposeReadTools: boolean
  paypalLogin: boolean
  modelEnabled: boolean
}
export type Deal = components['schemas']['Deal']
export type Kind = Proposal['kind']
export type Gate = Proposal['gate']
export type Party = Warrant['payees'][number]

export type PayeeBookEntry = {
  id: string
  name: string
  email: string
  status: 'active' | 'pending' | 'disabled'
  verified_method: string
  first_seen: string
  total_paid_cents: number
  change_pending: boolean
  change_email: string | null
  cooling: boolean
  waitUntil: string | null
  diagnostics: {
    canPay: boolean
    reason: string
    clause: string | null
  }
  history?: Array<{
    id: string
    kind: string
    amountCents: number
    currency: string
    phase: string
    clause: string | null
    description: string
    createdAt: string
  }>
}

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
  warrant: { id: string; version: number; currency: string; monthlyCapCents: number; autoSettleUnderCents: number; signed: boolean } | null
  approvalProof: {
    method: 'passkey' | 'owner-key' | 'demo' | 'legacy' | 'rule'
    tone: 'red' | 'amber' | 'grey' | 'ink'
    who: string
    how: string
    at: string | null
    fingerprint: string | null
  } | null
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
  whatWouldPass?: Array<{ text: string; tested: boolean }>
  dispute?: { id: string; status: string; reason: string | null; amountCents: number | null } | null
  acceptance?: { id: string; dealId: string; milestone: number; proofUrl: string; status: string; note: string | null; decidedBy: string | null; decidedAt: string | null; signature: string | null; keyId: string | null; signatureValid: boolean | null } | null
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
  charges: Array<Proposal & { fundableCents: number; clearing?: { pending: boolean; clearsAt: string | null } }>
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
  /** True when the main model failed or was cooling off and the fallback answered. */
  fellBack?: boolean
  ms: number
}

export type Safety = {
  paused: boolean
  reason: string | null
  since: string | null
  by: 'owner' | 'breaker' | null
  epoch: number
  breaker: { tripAfter: number; windowSeconds: number }
  events: Array<{ id: string; at: string; type: 'paused' | 'resumed' | 'agent_suspended'; by: 'owner' | 'breaker'; reason: string | null; detail: string | null; signed: boolean }>
}

export type AgentScope = 'read' | 'propose' | 'stream' | 'mcp' | 'deals'
export type AgentScorecard = {
  agentId: string
  name: string
  status: 'active' | 'suspended' | 'revoked'
  requests: number
  refusals: number
  auto: number
  needsTap: number
  lastSeenAt: string | null
  breakerTripped: boolean
}
export type AgentRow = { id: string; name: string; scopes: AgentScope[]; limits: { proposalsPerHour: number; centsPerHour: number; proposalsPerDay?: number; centsPerDay?: number }; status: 'active' | 'suspended' | 'revoked'; keyPrefix?: string; createdAt: string; lastSeenAt: string | null; lastUsedAt?: string | null; expiresAt?: string | null; scorecard?: AgentScorecard }
export type ClientKeyRow = { id: string; name: string; partyId: string; status: 'active' | 'revoked'; keyPrefix?: string; createdAt: string; lastSeenAt: string | null; lastUsedAt?: string | null; expiresAt?: string | null }

export type Suggestion = { id: string; payeeId: string; payeeName: string; clientId: string; clientName: string; approved: number; totalCents: number; largestCents: number; firstAt: string; draft: string }
export type Suggestions = { suggestions: Suggestion[]; taps: { thisMonth: number; lastMonth: number; byRule: number } }
export type TryVerdict = { gate: Gate; clause: string; detail: string }
export type TryFunding = { captureId: string; jobId: string | null; canStillFundCents: number } | null
export type TryCaseResult = { id: string; label: string; request: Record<string, unknown>; live: TryVerdict | null; draft: TryVerdict | null }
export type TryCases = { cases: TryCaseResult[]; funding: TryFunding }
export type TryOne = { live: TryVerdict | null; draft: TryVerdict | null; funding: TryFunding }

export type Guarantees = {
  guarantees: Array<{ id: string; promise: string; audit?: string; tests: string[]; random?: boolean }>
  deepRun: { months: number; stepsPerMonth: number; violations: number; recordedOn: string }
  everyChange: { months: number; stepsPerMonth: number }
}

export type SystemStatus = {
  time: string
  paused: { reason: string | null; since: string | null; by: 'owner' | 'breaker' | null } | null
  degraded: Array<'paypal' | 'ai'>
  paypal: { circuit: 'closed' | 'open' | 'half_open'; consecutiveFailures: number; lastError: string | null; lastOkAt: string | null; openUntil: string | null } | null
  /** Null for a client's key: how the studio's systems are doing is the studio's business. */
  ai: { enabled: boolean; primary: string | null; fallback: string | null; circuit: 'closed' | 'open' | 'half_open' } | null
}

export type ClientErrorRow = { id: string; at: string; role: string; scope: string; message: string; stack: string | null; url: string | null; agent: string | null; release: string | null }

export type AgentHealth = {
  enabled: boolean
  primary: string | null
  drafter: string | null
  fallback: string | null
  prompts: Record<string, number>
  models: Array<{ name: string; calls: number; failures: number; consecutiveFailures: number; p50Ms: number | null; p95Ms: number | null; circuit: 'closed' | 'open' | 'half_open'; openUntil: string | null; lastError: string | null; lastAt: string | null; inputTokens: number; outputTokens: number }>
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
  status: NegotiationView['status']
  ending: string | null
  turns: Array<{ turn: number; side: 'buyer' | 'seller'; runId: string; action?: 'offer' | 'accept' | 'walk_away'; deal?: Deal; error?: string; ms?: number }>
  negotiation: NegotiationView
}

export type PartyRulesView = {
  partyId: string
  version: number
  /** Whether a person chose these numbers. `seed` came with the sample studio and stays an example until a key writes it. */
  origin: 'seed' | 'written'
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
  /** What the company hopes for. Private like its limit. */
  targetTotalCents?: number
  style?: NegotiationStyle
  /** A client that set its own numbers lets Mandate's negotiator speak for it. */
  delegate?: boolean
  /** The company's standing instructions to its negotiator. */
  brief?: string
  /** Who wrote the latest version: the studio's owner, or the company itself with its own key. */
  writtenBy?: 'owner' | 'party' | null
  /** A client that wrote its own numbers owns its seat: the studio sees only that a limit is set. */
  claimed?: boolean
  sealed?: boolean
  limitSet?: boolean
}

export type NegotiationStyle = 'firm' | 'balanced' | 'flexible'
export type Side = 'buyer' | 'seller'

/** How good an agreed price was for one side, against its own walk-away and target. Shown only to that side. */
export type NegotiationOutcome = {
  side: Side
  priceCents: number
  marginCents: number
  towardTargetPct: number
  verdict: 'beat_target' | 'met_target' | 'good' | 'fair' | 'at_limit'
  summary: string
}

/** A negotiator's debrief for its own company, after the end. */
export type NegotiationDebrief = {
  satisfaction: 'satisfied' | 'acceptable' | 'dissatisfied'
  ratings: { outcome: number; process: number; relationship: number; self: number }
  wouldSignAgain: boolean
  summary: string
  lesson: string
  model: string
  at: string
}

export type NegotiationAdvice = {
  action: 'offer' | 'accept' | 'walk_away'
  offerCents: number | null
  range: { fromCents: number; toCents: number } | null
  mayAccept: boolean
  offersLeftAfter: number
  why: string
}

export type NegotiationSeat =
  | { side: Side; visible: false }
  | {
      side: Side
      visible: true
      reservationCents: number
      targetCents: number
      targetChosen: boolean
      style: NegotiationStyle
      offersLeft: number
      advice: NegotiationAdvice | null
      outcome: NegotiationOutcome | null
      debrief: NegotiationDebrief | null
    }

export type NegotiationMove = {
  seq: number
  side: Side
  action: 'offer' | 'accept' | 'walk_away'
  dealId: string | null
  totalCents: number | null
  final: boolean
  message: string | null
  /** `agent` (Mandate's negotiator), `person`, or `outside` (the company's own agent). */
  by: string
  runId: string | null
  /** The mover's private reasoning. Present only for the caller's own side. */
  assessment: string | null
  createdAt: string
}

export type NegotiationView = {
  id: string
  buyerId: string
  buyerName: string
  sellerName: string
  status: 'open' | 'agreed' | 'walked_away' | 'expired' | 'stalled'
  endedReason: string | null
  endedBy: Side | null
  ending: string | null
  agreedDealId: string | null
  jobId: string | null
  scope: string
  category: string
  currency: string
  milestones: string[]
  offersPerSide: number
  startedBy: string
  createdAt: string
  updatedAt: string
  expiresAt: string
  endedAt: string | null
  turn: Side | null
  standing: { dealId: string | null; side: Side; totalCents: number | null; final: boolean } | null
  moves: NegotiationMove[]
  seats: { seller: NegotiationSeat; buyer: NegotiationSeat }
  you: { sides: Side[]; agentMay: Side[] }
  fairness: { zone: { minCents: number; maxCents: number }; sellerSharePct: number; nashCents: number } | null
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

export type Feature = {
  id: string
  label: string
  enabled: boolean
  core: boolean
  usedFor: string
  without: string
  steps: string[]
}

export type Features = { configured: boolean; checkedAt: string; features: Feature[] }

export type ActivityRow = {
  id: string
  date: string
  cents: number
  currency: string
  status: string
  eventCode: string | null
  subject: string | null
  counterparty: string | null
  proposalId: string | null
  matchedBy: string | null
  /** Signed cents the ledger holds for the matched request, or null when nothing matched. */
  expectedCents: number | null
  /** Currency the ledger holds for the matched request, or null. */
  expectedCurrency: string | null
  /** This row's cents minus what the ledger holds. Null when unmatched or when the request was paid in parts. */
  deltaCents: number | null
  /** Whether the matched request's money lines up. Null when nothing was compared. */
  balanced: boolean | null
}

export type Activity =
  | { available: false; reason: string }
  | { available: true; from: string; to: string; rows: ActivityRow[]; matched: number; unmatched: number; unmatchedNetCents: number; mismatched: number; mismatchedNetCents: number }

export type ToolSummary = {
  total: number
  read: number
  propose: number
  outOfScope: number
  usedByMandate: number
  agentCanCallDirectly: number
  tools: Array<{ name: string; area: string; tier: 'read' | 'propose' | 'out_of_scope'; usedByMandate: boolean; note: string }>
}

export type Balance =
  | { available: false; reason: string }
  | { available: true; availableCents: number; withheldCents: number; asOf: string | null; currency: string }

export type TodayAction = 'approve' | 'reject' | 'settle' | 'check' | 'remind' | 'cancel_payout' | 'open'

export type TodayItem = {
  id: string
  kind: 'approval' | 'ready' | 'unclaimed' | 'held' | 'overdue' | 'autopilot_blocked' | 'dispute' | 'in_flight' | 'done' | 'stopped'
  proposalId: string
  proposalKind: Kind
  title: string
  detail: string
  amountCents: number
  currency: string
  phase: string
  clause: string
  at: string
  how?: 'tap' | 'standing' | 'billing' | 'autopilot' | 'auto'
  actions: TodayAction[]
}

export type Delivery = {
  id: string
  dealId: string
  jobId: string | null
  milestone: number
  title: string
  scope: string
  amountCents: number
  currency: string
  buyerId: string | null
  buyerName: string | null
  proofUrl: string
  status: 'awaiting' | 'accepted' | 'rejected' | 'superseded'
  note: string | null
  decidedBy: string | null
  createdAt: string
  decidedAt: string | null
  proposalId: string | null
  signatureValid: boolean | null
  keyId: string | null
}

export type Delivered = { mode: 'billed'; charge: Proposal; delivery: null } | { mode: 'awaiting'; charge: null; delivery: Delivery }

export type Today = {
  asOf: string
  month: { label: string; inCents: number; outCents: number; keptCents: number; refundedCents: number; reservedCents: number; capCents: number; currency: string } | null
  automation: { billSignedDeals: boolean; requireAcceptance: boolean; payOnSettle: boolean; remindUnpaidAfterDays: number | null; maxReminders: number; standingRules: number; any: boolean } | null
  waiting: TodayItem[]
  inFlight: TodayItem[]
  done: TodayItem[]
  stopped: { count: number; cents: number; recent: TodayItem[] }
  readyToBill: Array<{ dealId: string; jobId: string; buyerId: string; buyerName: string; scope: string; milestone: number; title: string; amountCents: number; currency: string; billed: number; total: number; delivery: Delivery | null }>
  /** The one next step of the frozen Northwind job. `rules` is a second sentence, only after milestone 0 is captured. */
  next: { step: string | null; rules: string | null }
  clientAgent: { mode: 'auto' | 'manual'; ready: boolean }
  watcher: { everySeconds: number; lastLook: { at: string; payouts: number; invoices: number; reminded: number } | null }
  stats: { last30Days: { requests: number; refused: number; automatic: number; tapped: number; automaticShare: number | null } }
  setup: { complete: boolean; steps: Array<{ id: string; label: string; hint: string; href: string; done: boolean }> }
}

export type AuditCheck = {
  id: string
  title: string
  why: string
  status: 'pass' | 'fail' | 'info'
  checked: number
  failures: Array<{ proposalId: string | null; detail: string }>
  note?: string
}

export type AuditReport = {
  ok: boolean
  ranAt: string
  totals: { requests: number; moved: number; locks: number; events: number; deals: number; jobs: number }
  checks: AuditCheck[]
  agentReach: { toolkitTools: number; agentCanCallDirectly: number; serverUses: number; mcpTools: number }
}

export type Replay = {
  checked: number
  changed: Array<{ proposalId: string; title: string; amountCents: number; before: { gate: string; clause: string; words: string }; after: { gate: string; clause: string; words: string } }>
  nowNoTap: number
  nowTap: number
  nowRefused: number
  nowAllowed: number
}

export type IntentFlag = { phrase: string; why: string }

export type RulesDraft = {
  draft: Omit<Warrant, 'id' | 'version' | 'createdAt'>
  summary: string
  /** Who wrote the summary: the model, or the code, when the model's contradicted the code's own list. */
  summaryBy: 'model' | 'code'
  loosens: string[]
  tightens: string[]
  notes: string[]
  ignored: IntentFlag[]
  added: IntentFlag[]
  untrusted: string[]
  readBack: string[]
  readBackBy: 'model' | 'code'
  replay: Replay
  changed: boolean
  model: string
  ms: number
  runId: string
  /** A different model's reading of the draft against the owner's words. `unavailable` means it did not happen: never a pass. */
  secondReader?: { model: string; status: 'agreed' | 'concerns' | 'unavailable'; agreed: boolean | null; verdict: string; concerns: Array<{ change: number; text: string; why: string }>; missing?: string }
}

export type SentenceStatus = 'covered' | 'partly' | 'not_covered' | 'unenforceable' | 'context' | 'untrusted' | 'skipped' | 'unchecked'
export type PolicySentence = { id: number; text: string; start: number; end: number; line: number; status: SentenceStatus; reasons: string[]; carriedBy: string[]; already: boolean }
export type PolicyResult = { sentences: PolicySentence[]; counts: Record<SentenceStatus, number>; audit: 'ok' | 'failed' | 'none'; draft: RulesDraft | null }

export type AskRoute =
  | { kind: 'answer'; id: string; title: string; lines: string[]; links: Array<{ label: string; to: string }> }
  | { kind: 'action'; type: 'deliver'; text: string; proofUrl: string | null; note: string | null; choices: Array<{ dealId: string; milestone: number; jobId: string; buyerName: string; title: string; amountCents: number; currency: string }> }
  | { kind: 'handoff'; to: 'rules'; text: string }
  | { kind: 'clerk' }

export type QuickId = 'waiting' | 'refused' | 'month' | 'inflight' | 'ready' | 'done' | 'autopilot'

export type ClerkStreamEvent =
  | { type: 'step'; tools: Array<{ tool: string; ok: boolean }>; outcomes: Array<Record<string, any>> }
  | { type: 'text'; delta: string }
  | { type: 'retract'; reason: 'money_claim' | 'unsupported_amount' }
  | { type: 'tool_start'; id: string; tool: string }
  | { type: 'tool_call'; id: string; tool: string; input?: unknown }
  | { type: 'tool_end'; id: string; tool: string; ok: boolean; output?: unknown; ms?: number }
  | { type: 'done'; reply: ClerkReply }
  | { type: 'error'; code: string; message: string }

/** A read-only link to one job for one person, as the owner sees it in a list. The secret is never part of it. */
export type ShareSummary = { id: string; jobId: string; partyId: string; partyName: string; role: 'contractor' | 'client'; label: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastSeenAt: string | null; views: number; active: boolean; canPay: boolean }

/** What the holder of a link sees. */
export type ShareView = {
  role: 'contractor' | 'client'
  who: string
  jobId: string
  with: string | null
  asOf: string
  expiresAt: string
  /** True when this link may pay what is due, not only look at it. */
  canPay: boolean
  contractor?: {
    clientPayment: { state: 'waiting' | 'clearing' | 'received'; clearsAt: string | null }
    payouts: Array<{ amountCents: number; state: 'asked' | 'approved' | 'sending' | 'unclaimed' | 'paid' | 'failed'; label: string; at: string }>
  }
  client?: {
    invoices: Array<{
      description: string
      amountCents: number
      state: 'due' | 'paid'
      payUrl: string | null
      at: string
      /** When the client may pay this on our own page instead of leaving for PayPal. */
      payable: { proposalId: string; amountCents: number; currency: string; description: string; instrument: 'checkout' } | null
    }>
  }
}

/** What a browser needs to open a card form against a locked bill. It cannot capture and cannot change an amount. */
export type PaySession = {
  proposalId: string
  orderId: string
  clientToken: string
  amountCents: number
  currency: string
  description: string
  environment: 'sandbox' | 'live'
}
