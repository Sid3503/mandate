import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Repo, ShareRow } from '../db/repo'
import { Problem } from '../http/problem'
import { paidPhase } from '../domain/phases'
import type { MandateService } from './mandate'

/**
 * Status links: the owner gives one person a read-only page about one job. A contractor sees only their own payouts and
 * whether the client's money has arrived. A client sees only their own invoices. Nobody sees the studio's totals, margin,
 * rules or anyone else.
 *
 * A link is a capability: whoever holds it can look, so it is long and random, only its hash is stored, it expires, and
 * the owner can revoke it. It can only read. It cannot ask, approve, pay or change anything. Every way a link can be
 * wrong (unknown, expired, revoked, malformed) answers with the same 404, so nobody can tell which.
 */

const DAY_MS = 86_400_000
export const SHARE_DEFAULT_DAYS = 30
export const SHARE_MAX_DAYS = 90

export type ShareSummary = { id: string; jobId: string; partyId: string; partyName: string; role: 'contractor' | 'client'; label: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastSeenAt: string | null; views: number; active: boolean; canPay: boolean }

/** What a client may pay on our page, when the owner gave this link the right to pay. */
export type PayableBill = { proposalId: string; amountCents: number; currency: string; description: string; instrument: 'checkout' }

export type ShareView = {
  role: 'contractor' | 'client'
  who: string
  jobId: string
  /** The company on the other side of the job, when it is safe for this person to see it. */
  with: string | null
  asOf: string
  expiresAt: string
  /** True when this link may pay what is due, not only look at it. */
  canPay: boolean
  contractor?: {
    clientPayment: { state: 'waiting' | 'clearing' | 'received'; clearsAt: string | null }
    payouts: Array<{ amountCents: number; state: PayoutState; label: string; at: string }>
  }
  client?: {
    invoices: Array<{ description: string; amountCents: number; state: 'due' | 'paid'; payUrl: string | null; at: string; payable: PayableBill | null }>
  }
}

type PayoutState = 'asked' | 'approved' | 'sending' | 'unclaimed' | 'paid' | 'failed'

const PAYOUT_STATE: Record<string, PayoutState> = {
  pending_approval: 'asked',
  locked: 'approved',
  order_created: 'approved',
  capture_inflight: 'sending',
  payout_sent: 'sending',
  payout_unclaimed: 'unclaimed',
  captured: 'paid',
  payout_failed: 'failed',
}

export class ShareService {
  constructor(private readonly repo: Repo, private readonly mandate: MandateService, private readonly now: () => Date) {}

  /** Issues a link. The full link is returned once; afterwards only a hash exists. */
  issue(input: { jobId: string; partyId: string; ttlDays?: number; label?: string; canPay?: boolean }): { share: ShareSummary; token: string } {
    // Throws 404 if no proposal names the job.
    const job = this.mandate.job(input.jobId)
    const warrant = this.repo.latestWarrant()?.body
    const partyId = input.partyId.trim()
    const isClient = Boolean(job.charges.some((charge) => charge.payeeId === partyId))
    const isContractor = Boolean(warrant?.payees.some((payee) => payee.id === partyId))
    if (!isClient && !isContractor) throw new Problem(422, 'share.party_unknown', 'That person is not on this job', 'Pick the client billed on this job, or a contractor on the rules.')
    const role: ShareRow['role'] = isClient ? 'client' : 'contractor'
    // Only a client is ever asked to pay, so only a client may be given the right to pay.
    const canPay = role === 'client' && input.canPay === true
    const ttl = Math.min(SHARE_MAX_DAYS, Math.max(1, Math.round(input.ttlDays ?? SHARE_DEFAULT_DAYS)))
    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const at = this.now()
    this.repo.createShare({
      id, job_id: input.jobId, party_id: partyId, role,
      label: (input.label?.trim() || `${this.nameOf(partyId)}'s link`).slice(0, 120),
      secret_hash: createHash('sha256').update(secret).digest('hex'),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + ttl * DAY_MS).toISOString(), revoked_at: null, last_seen_at: null, views: 0,
      can_pay: canPay ? 1 : 0,
    })
    return { share: this.summary(this.repo.getShare(id)!), token: `${id}~${secret}` }
  }

  list(jobId: string): ShareSummary[] {
    return this.repo.sharesForJob(jobId).map((row) => this.summary(row))
  }

  revoke(id: string): ShareSummary {
    const row = this.repo.getShare(id)
    if (!row) throw new Problem(404, 'share.unknown', 'No such link', 'Check the job\'s links for the id.')
    this.repo.revokeShare(id, this.now().toISOString())
    return this.summary(this.repo.getShare(id)!)
  }

  /** What the holder of a link may see. Any problem with the link is one and the same 404. */
  view(token: string): ShareView {
    const row = this.resolve(token)
    const nowIso = this.now().toISOString()
    this.repo.noteShareSeen(row.id, nowIso)
    const job = this.mandate.job(row.job_id)
    const base = { jobId: row.job_id, asOf: nowIso, expiresAt: row.expires_at, who: this.nameOf(row.party_id), canPay: row.can_pay === 1 }
    if (row.role === 'client') {
      const mine = job.charges.filter((charge) => charge.payeeId === row.party_id)
      const invoices: NonNullable<ShareView['client']>['invoices'] = []
      for (const charge of mine) {
        // A bill the client may pay here: the owner locked it, it is not settled, and PayPal did not invoice it.
        // A charge that already has an invoice is paid through that invoice, so it is never also payable here.
        const payable: PayableBill | null = base.canPay && charge.payInstrument === 'checkout' && ['locked', 'order_created'].includes(charge.phase)
          ? { proposalId: charge.id, amountCents: charge.amountCents, currency: charge.currency, description: charge.description, instrument: 'checkout' }
          : null        // phase-compare-ok: the client's own invoice reads "paid" only when the lock was paid in full. A part
        // payment is shown as still due, which is what the client still owes on it.
        if (charge.phase === 'captured') invoices.push({ description: charge.description, amountCents: charge.amountCents, state: 'paid', payUrl: null, at: charge.updatedAt, payable: null })
        else if (paidPhase(charge.phase)) invoices.push({ description: charge.description, amountCents: charge.amountCents, state: 'due', payUrl: charge.invoiceUrl ?? charge.approveUrl ?? null, at: charge.updatedAt, payable: null })
        else if (['invoice_sent', 'order_created', 'locked'].includes(charge.phase)) invoices.push({ description: charge.description, amountCents: charge.amountCents, state: 'due', payUrl: charge.invoiceUrl ?? charge.approveUrl ?? null, at: charge.updatedAt, payable })
      }
      return { ...base, role: 'client', with: null, client: { invoices } }
    }
    // phase-compare-ok: the contractor's "has the client's money arrived" line reports only a full settlement.
    // A part payment leaves it waiting, rather than telling a contractor they are about to be paid.
    const captured = job.charges.filter((charge) => charge.phase === 'captured')
    const clearing = captured.find((charge) => charge.clearing?.pending)
    const payouts: NonNullable<ShareView['contractor']>['payouts'] = []
    for (const payout of job.payouts) {
      const state = PAYOUT_STATE[payout.phase]
      if (payout.payeeId !== row.party_id || !state) continue
      payouts.push({ amountCents: payout.amountCents, state, label: payout.description, at: payout.updatedAt })
    }
    return {
      ...base,
      role: 'contractor',
      with: job.client?.displayName ?? null,
      contractor: { clientPayment: { state: captured.length === 0 ? 'waiting' : clearing ? 'clearing' : 'received', clearsAt: clearing?.clearing?.clearsAt ?? null }, payouts },
    }
  }

  /**
   * The request a link may pay. The link must have been given the right to pay, the request must be one of this
   * client's bills on this job, and everything else answers with the same 404 as a bad link: a holder of a link
   * learns nothing about what they may not touch.
   */
  payable(token: string, proposalId: string, stage: 'session' | 'capture' = 'session'): { proposalId: string } {
    const row = this.resolve(token)
    const gone = () => new Problem(404, 'share.unknown', 'This link is not available', 'It may have expired or been withdrawn. Ask the person who sent it for a new one.')
    if (row.can_pay !== 1 || row.role !== 'client') throw gone()
    const job = this.mandate.job(row.job_id)
    const charge = job.charges.find((item) => item.id === proposalId)
    if (!charge || charge.payeeId !== row.party_id) throw gone()
    // A link pays only a bill the owner chose to have paid on our page. A bill going out as a PayPal invoice is paid
    // on that invoice: letting a link "capture" it would have the link send the invoice, which is the owner's act.
    const proposal = this.repo.proposal(charge.id)
    if (!proposal || proposal.kind !== 'charge') throw gone()
    if (proposal.invoice_id) throw new Problem(409, 'pay.invoice_open', 'This bill is on its way by email', 'PayPal invoiced you for it, so pay that invoice. The studio can cancel the invoice to let you pay here instead.')
    if (proposal.pay_instrument === 'invoice') throw new Problem(409, 'pay.not_on_page', 'This bill is paid on its PayPal invoice', 'The studio sends this bill as a PayPal invoice. Pay it there; this page shows when it is paid.')
    // A link settles only a card the payer handed over on this page: the card order must exist. Settling a bill with
    // no order would have the server invoice it instead, and sending an invoice is the owner's act, never a link's.
    if (stage === 'capture' && !(proposal.order_id && proposal.order_kind === 'card')) throw new Problem(409, 'pay.no_card', 'Open the card form first', 'Nothing has been paid by card on this page yet, so there is nothing to settle.')
    return { proposalId: charge.id }
  }

  private resolve(token: string): ShareRow {
    const gone = () => new Problem(404, 'share.unknown', 'This link is not available', 'It may have expired or been withdrawn. Ask the person who sent it for a new one.')
    const dot = token.indexOf('~')
    if (dot < 1 || token.length > 200) throw gone()
    const row = this.repo.getShare(token.slice(0, dot))
    // Compare in constant time even when the row is missing, so the timing does not say which half was wrong.
    const presented = createHash('sha256').update(token.slice(dot + 1)).digest()
    const stored = Buffer.from(row?.secret_hash ?? '0'.repeat(64), 'hex')
    const same = presented.length === stored.length && timingSafeEqual(presented, stored)
    if (!row || !same || row.revoked_at !== null || Date.parse(row.expires_at) <= this.now().getTime()) throw gone()
    return row
  }

  private nameOf(partyId: string): string {
    const body = this.repo.latestWarrant()?.body
    return [...(body?.payees ?? []), ...(body?.clients ?? [])].find((party) => party.id === partyId)?.displayName ?? partyId
  }

  private summary(row: ShareRow): ShareSummary {
    const expired = Date.parse(row.expires_at) <= this.now().getTime()
    return { id: row.id, jobId: row.job_id, partyId: row.party_id, partyName: this.nameOf(row.party_id), role: row.role as ShareSummary['role'], label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastSeenAt: row.last_seen_at, views: row.views, active: row.revoked_at === null && !expired, canPay: row.can_pay === 1 }
  }
}
