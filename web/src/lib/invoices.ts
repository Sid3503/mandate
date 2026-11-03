/** What the Invoices desk's routes return. The server writes the plain-English words; the screen shows them as they are. */
export type InvoiceStatus = 'draft' | 'approved' | 'sent' | 'part_paid' | 'paid' | 'overdue' | 'cancelled' | 'declined' | 'reversed'

export type InvoiceRow = {
  id: string
  clientId: string | null
  clientName: string
  jobId: string | null
  description: string
  lineItems: Array<{ description: string; quantity: number; unitCents: number }> | null
  amountCents: number
  paidCents: number
  remainingCents: number
  currency: string
  status: InvoiceStatus
  sentAt: string
  sentSource: 'event' | 'created'
  dueDate: string
  dueSource: 'invoice' | 'default'
  dueNote: string
  daysOverdue: number
  invoiceUrl: string | null
  payerUrl: string | null
  payInstrument: 'invoice' | 'checkout' | null
  remindersSent: number
  paidAt: string | null
  createdAt: string
  canRemind: boolean
  canCancel: boolean
}

type Bucket = { count: number; cents: number }

export type InvoicesList = {
  asOf: string
  data: InvoiceRow[]
  counts: Record<InvoiceStatus | 'all', number>
  kpis: { currency: string; invoicedCents: number; invoicedCount: number; paidCents: number; outstandingCents: number; outstandingCount: number; overdueCount: number; overdueCents: number; avgDaysToPay: number | null; paidSample: number }
  outlook: {
    currency: string
    balanceCents: number | null
    balanceAsOf: string | null
    balanceNote: string | null
    outstandingCents: number
    committedPayoutsCents: number
    projectedCents: number | null
    netOfBooksCents: number
    buckets: { overdue: Bucket; thisWeek: Bucket; nextWeek: Bucket; later: Bucket }
    bucketLabels: { overdue: string; thisWeek: string; nextWeek: string; later: string }
    disclaimer: string
  }
  guardrails: { lines: Array<{ id: string; text: string }>; link: string; hasRules: boolean }
}

export type DraftField = 'client' | 'price' | 'description' | 'dueDate' | 'jobId' | 'category' | 'evidenceUrl'

export type InvoiceDraft = {
  client: { id: string; name: string; matchedBy: 'email' | 'name' } | null
  lineItems: Array<{ description: string; quantity: number; unitCents: number | null }>
  totalCents: number | null
  dueDate: string | null
  currency: string
  customerNote: string | null
  jobId: string | null
  category: string | null
  evidenceUrl: string | null
  missing: DraftField[]
  warnings: string[]
  verdict: { gate: 'AUTO' | 'NEEDS_APPROVAL' | 'DENY' | 'DUAL_TAP'; clause: string; detail: string; complete: boolean } | null
  source: 'model' | 'rules'
  nothingSent: true
}
