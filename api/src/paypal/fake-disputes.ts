import { PayPalError } from './port'
import { disputeRequestFor, type DisputeDetail, type DisputePort, type DisputeRequest } from './disputes'

/**
 * A deterministic stand-in for PayPal's Customer Disputes API, for tests and the demo servers. It keeps disputes in
 * memory, remembers every request it was sent (so a test can read back the exact call), and, like a request id on a
 * real API would, answers a repeat of the same request id with the first answer instead of recording it twice.
 * It proves the desk's own behaviour. It proves nothing about how PayPal answers a live dispute.
 */
export class FakeDisputes implements DisputePort {
  readonly disputes = new Map<string, DisputeDetail>()
  /** Every call that left the desk, in order. */
  readonly requests: DisputeRequest[] = []
  readonly gets: string[] = []
  /** HTTP status to fail the next sends with, or 0 for none. */
  failStatus = 0
  private readonly answered = new Set<string>()

  add(detail: Partial<DisputeDetail> & { id: string }): DisputeDetail {
    const full: DisputeDetail = {
      status: 'WAITING_FOR_SELLER_RESPONSE',
      stage: 'CHARGEBACK',
      reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
      amountCents: null,
      currency: 'USD',
      createdAt: '2026-10-01T09:00:00Z',
      updatedAt: '2026-10-01T09:00:00Z',
      sellerResponseDueDate: null,
      transactionIds: [],
      messages: [],
      evidences: [],
      allowedResponseOptions: ['accept_claim'],
      linkRels: ['self', 'provide-evidence'],
      ...detail,
    }
    this.disputes.set(full.id, full)
    return full
  }

  async get(id: string): Promise<DisputeDetail> {
    this.gets.push(id)
    if (this.failStatus) throw new PayPalError(this.failStatus, 'UPSTREAM', null, 'down')
    const found = this.disputes.get(id)
    if (!found) throw new PayPalError(404, 'INVALID_RESOURCE_ID', null, 'Requested resource ID was not found.')
    return found
  }

  async sendMessage(id: string, message: string, requestId: string) {
    return this.record(disputeRequestFor('INQUIRY', id, message, requestId))
  }

  async provideEvidence(id: string, evidence: { evidenceType: 'OTHER'; notes: string }, requestId: string) {
    return this.record(disputeRequestFor('CHARGEBACK', id, evidence.notes, requestId))
  }

  private record(request: DisputeRequest) {
    if (this.failStatus) throw new PayPalError(this.failStatus, 'UPSTREAM', null, 'down')
    if (!this.answered.has(request.requestId)) {
      this.answered.add(request.requestId)
      this.requests.push(request)
    }
    return { linkRels: ['self'] }
  }
}
