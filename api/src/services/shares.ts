import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Repo, ShareRow } from '../db/repo'
import { Problem } from '../http/problem'
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

export type ShareSummary = { id: string; jobId: string; partyId: string; partyName: string; role: 'contractor' | 'client'; label: string; createdAt: string; expiresAt: string; revokedAt: string | null; lastSeenAt: string | null; views: number; active: boolean }

export type ShareView = {
  role: 'contractor' | 'client'
  who: string
  jobId: string
  /** The company on the other side of the job, when it is safe for this person to see it. */
  with: string | null
  asOf: string
  expiresAt: string
  contractor?: {
    clientPayment: { state: 'waiting' | 'clearing' | 'received'; clearsAt: string | null }
    payouts: Array<{ amountCents: number; state: PayoutState; label: string; at: string }>
  }
  client?: {
    invoices: Array<{ description: string; amountCents: number; state: 'due' | 'paid'; payUrl: string | null; at: string }>
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
  issue(input: { jobId: string; partyId: string; ttlDays?: number; label?: string }): { share: ShareSummary; token: string } {
    // Throws 404 if no proposal names the job.
    const job = this.mandate.job(input.jobId)
    const warrant = this.repo.latestWarrant()?.body
    const partyId = input.partyId.trim()
    const isClient = Boolean(job.charges.some((charge) => charge.payeeId === partyId))
    const isContractor = Boolean(warrant?.payees.some((payee) => payee.id === partyId))
    if (!isClient && !isContractor) throw new Problem(422, 'share.party_unknown', 'That person is not on this job', 'Pick the client billed on this job, or a contractor on the rules.')
    const role: ShareRow['role'] = isClient ? 'client' : 'contractor'
    const ttl = Math.min(SHARE_MAX_DAYS, Math.max(1, Math.round(input.ttlDays ?? SHARE_DEFAULT_DAYS)))
    const id = randomUUID()
    const secret = randomBytes(24).toString('base64url')
    const at = this.now()
    this.repo.createShare({
      id, job_id: input.jobId, party_id: partyId, role,
      label: (input.label?.trim() || `${this.nameOf(partyId)}'s link`).slice(0, 120),
      secret_hash: createHash('sha256').update(secret).digest('hex'),
      created_at: at.toISOString(), expires_at: new Date(at.getTime() + ttl * DAY_MS).toISOString(), revoked_at: null, last_seen_at: null, views: 0,
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
    const base = { jobId: row.job_id, asOf: nowIso, expiresAt: row.expires_at, who: this.nameOf(row.party_id) }
    if (row.role === 'client') {
      const mine = job.charges.filter((charge) => charge.payeeId === row.party_id)
      const invoices: NonNullable<ShareView['client']>['invoices'] = []
      for (const charge of mine) {
        if (charge.phase === 'captured') invoices.push({ description: charge.description, amountCents: charge.amountCents, state: 'paid', payUrl: null, at: charge.updatedAt })
        else if (['invoice_sent', 'order_created'].includes(charge.phase)) invoices.push({ description: charge.description, amountCents: charge.amountCents, state: 'due', payUrl: charge.invoiceUrl ?? charge.approveUrl ?? null, at: charge.updatedAt })
      }
      return { ...base, role: 'client', with: null, client: { invoices } }
    }
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
    return { id: row.id, jobId: row.job_id, partyId: row.party_id, partyName: this.nameOf(row.party_id), role: row.role as ShareSummary['role'], label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at, lastSeenAt: row.last_seen_at, views: row.views, active: row.revoked_at === null && !expired }
  }
}
