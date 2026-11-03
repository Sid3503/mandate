/** What the Breaks desk's routes return. The server writes the plain-English words; the screen shows them as they are. */
export type BreakSeverity = 'critical' | 'warning' | 'info'
export type BreakState = 'open' | 'resolved' | 'dismissed'

export type BreakRow = {
  key: string
  rule: string
  severity: BreakSeverity
  proposalId: string | null
  title: string
  detail: string
  expected: string
  observed: string
  deltaCents: number | null
  state: BreakState
  firstSeenAt: string
  lastSeenAt: string
  resolvedAt: string | null
  dismissedAt: string | null
  dismissedBy: string | null
  dismissNote: string | null
  waitingOnYou: boolean
  fix: { action: string; label: string; sentence: string } | null
}

export type BreaksList = {
  kpis: { open: number; moneyAtStakeCents: number; waitingOnYou: number; resolved: number; dismissed: number; attention: number; openCritical: number }
  data: BreakRow[]
  /** When the server last scanned the books. Null until the first scan after it started. */
  syncedAt: string | null
  /** When PayPal's own transaction list was last compared (Reconcile now). */
  paypalSyncedAt: string | null
}

export type BreakDetail = BreakRow & {
  history: Array<{ id: number; at: string; type: string; detail: string }>
  evidence: {
    request: { id: string; kind: string; phase: string; amountCents: number; currency: string; arrivedCents: number; jobId: string | null } | null
    receiptPath: string | null
    paypalIds: Array<{ label: string; id: string }>
    books: Array<{ seq: number; purpose: string; deltaCents: number; memo: string; at: string; postings: Array<{ account: string; amountCents: number }> }>
    events: Array<{ type: string; at: string }>
  }
}

export type ScanResult = { scannedAt: string; detected: number; opened: string[]; resolved: string[]; reopened: string[]; paypal: 'checked' | 'skipped' | 'unavailable'; paypalReason?: string }
export type FixResult = { action: string; statement: string; gate?: string; filedProposalId?: string; phase?: string; break: BreakRow | null }
export type AttemptRow = { id: string; op: string; requestIdPrefix: string; status: 'started' | 'succeeded' | 'failed' | 'unknown'; externalId: string | null; startedAt: string; finishedAt: string | null }
