import { live, stamp } from './live'
import { randomUUID } from 'node:crypto'
import type { DealRow, DeliveryRow, NegotiationRow, PartyRulesRecord, Repo } from '../db/repo'
import { checkDeal, DealClause, DealTermsSchema, PartyRulesSchema, scrubNote, secretsOf, verdictFor, type DealOffer, type DealOfferWithTerms, type DealTerms, type DealVerdict, type PartyRules, type Side } from '../domain/deal'
import { advise, checkOffer, DEFAULT_OFFERS_PER_SIDE, endedBy, fairness, insideMandate, MAX_OFFERS_PER_SIDE, offersLeft, outcomeFor, seatOf, splitMilestones, type Move, type Seat } from '../domain/negotiation'
import { resolveClient } from '../domain/gate'
import { stableHash } from '../domain/hash'
import { ProposalCreateSchema, WARRANT_ID } from '../domain/schemas'
import { acceptanceMessage, dealMessage, proofHash, type Signer } from '../domain/signing'
import { Problem } from '../http/problem'
import { runIdempotent } from './idempotency'
import type { HttpResult, MandateService } from './mandate'
import { actorLabel, type Principal } from './principal'

type StoredTerms = DealTerms & { jobId?: string }

/** Who made a move: a person, Mandate's hosted negotiator, or the company's own outside agent. */
export type MoveBy = 'person' | 'agent' | 'outside'

/** A negotiation nobody touches for a week ends by itself, so an old offer cannot be accepted out of the blue. */
const NEGOTIATION_TTL_MS = 7 * 86_400_000

/** How a negotiation ended, in words. */
export function endingWords(thread: Pick<NegotiationRow, 'status' | 'ended_by' | 'ended_reason'>): string {
  switch (thread.status) {
    case 'agreed': return `${thread.ended_by === 'buyer' ? 'the client' : 'the studio'} accepted the other side's offer`
    case 'walked_away': return `${thread.ended_by === 'buyer' ? 'the client' : 'the studio'} walked away`
    case 'expired': return thread.ended_reason === 'time' ? 'nobody answered in time' : 'the deadline passed with no offer both sides could accept'
    case 'stalled': return 'neither side moved for three rounds'
    default: return 'it is still open'
  }
}

/**
 * Deals: two companies' agents agree terms, and the terms only count if they fit both owners' rules.
 * An agreed deal is signed, names its job, and becomes the only thing a client charge on that job may bill.
 */
export class DealService {
  constructor(
    private readonly repo: Repo,
    private readonly signer: Signer,
    private readonly now: () => Date,
    private readonly mandate: MandateService,
  ) {}

  offer(input: DealOffer, idempotencyKey: string, who: Principal, runId: string | null = null, by: MoveBy = 'person'): HttpResult {
    const now = this.now().toISOString()
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const buyer = resolveClient(warrant.body, input.buyer)
    if (!buyer) throw new Problem(422, 'deal.buyer_unknown', 'Unknown buyer', 'That client is not on the warrant, so no deal can be made with them.')
    const side = this.sideFor(who, input.as, buyer.id)
    return runIdempotent(this.repo, idempotencyKey, stableHash({ input, side }), now, () => {
      // A counter-offer may send just a price: the terms come from the negotiation, and code splits the milestones.
      const terms = input.terms ?? this.termsFor(input.threadId!, input.totalCents!, input.milestoneCount)
      return this.offerNew({ ...input, terms }, side, buyer, who, runId, by, now)
    })
  }

  /**
   * Which chair the caller sits in. A client key is the client; the studio's keys and agents are the studio. The owner
   * is the studio, and may also speak for a client only while that client has not claimed its own seat — a demo, or a
   * client not yet on Mandate. Once a client has written its own numbers with its own key, only it speaks for itself.
   */
  private sideFor(who: Principal, requested: Side | undefined, buyerId: string): Side {
    if (who.side) {
      if (requested && requested !== who.side) {
        throw new Problem(403, 'deal.wrong_side', 'This key cannot speak for that party', `This key speaks for the ${who.side} only.`)
      }
      if (who.side === 'buyer' && who.buyerId !== buyerId) {
        throw new Problem(403, 'deal.wrong_side', 'This key cannot speak for that party', 'This key speaks for a different client.')
      }
      return who.side
    }
    const side = requested ?? 'seller'
    if (side === 'buyer') {
      if (who.role !== 'owner') throw new Problem(403, 'deal.wrong_side', 'This key cannot speak for the client', 'This key speaks for the studio. A client speaks for itself, with its own key.')
      if (this.repo.sheetClaimed(buyerId)) throw new Problem(403, 'deal.seat_claimed', 'The client speaks for itself', 'This client set its own numbers with its own key, so only it can make or accept offers for itself.')
    }
    return side
  }

  /** Whether the hosted negotiator may speak for this side: always for the studio; for a client, only if it never claimed its seat, or claimed it and delegated. */
  agentMaySpeakFor(side: Side, buyerId: string): boolean {
    if (side === 'seller') return true
    if (!this.repo.sheetClaimed(buyerId)) return true
    return this.repo.partyRules(buyerId)?.body.delegate === true
  }

  /** Opens a negotiation: the work, the milestones it is paid in, and a deadline both sides know. */
  openNegotiation(input: { id?: string; buyerId: string; scope: string; category: string; currency: string; milestones: string[]; offersPerSide?: number }, who: Principal, now = this.now().toISOString()): NegotiationRow {
    const perSide = Math.min(MAX_OFFERS_PER_SIDE, Math.max(2, input.offersPerSide ?? DEFAULT_OFFERS_PER_SIDE))
    const row: NegotiationRow = {
      id: input.id ?? randomUUID(),
      buyer_id: input.buyerId,
      seller_id: WARRANT_ID,
      status: 'open',
      scope: input.scope.slice(0, 300),
      category: input.category,
      currency: input.currency,
      milestones_json: JSON.stringify(input.milestones.slice(0, 12)),
      offers_per_side: perSide,
      started_by: actorLabel(who),
      ended_reason: null,
      ended_by: null,
      agreed_deal_id: null,
      debrief_json: null,
      created_at: now,
      updated_at: now,
      expires_at: new Date(Date.parse(now) + NEGOTIATION_TTL_MS).toISOString(),
      ended_at: null,
    }
    this.repo.insertNegotiation(row)
    return row
  }

  /** The full terms of an offer in a negotiation, from a price and (optionally) a milestone count. Code does the arithmetic, never a model. */
  termsFor(threadId: string, totalCents: number, milestoneCount?: number, dueDate?: string): DealTerms {
    const thread = this.requireNegotiation(threadId)
    const titles = JSON.parse(thread.milestones_json) as string[]
    const count = Math.min(12, Math.max(1, milestoneCount ?? titles.length))
    const names = Array.from({ length: count }, (_, index) => titles[index] ?? `Milestone ${index + 1}`)
    return DealTermsSchema.parse({ scope: thread.scope, category: thread.category, currency: thread.currency, totalCents, milestones: splitMilestones(totalCents, names), proofRequired: true, ...(dueDate ? { dueDate } : {}) })
  }

  private requireNegotiation(id: string): NegotiationRow {
    const row = this.repo.negotiation(id)
    if (!row) throw new Problem(404, 'negotiation.missing', 'No such negotiation', 'No negotiation matches that id.')
    return row
  }

  /** Ends a negotiation whose deadline in time has passed, so nobody can accept an offer that went stale. */
  private freshen(thread: NegotiationRow, now: string): NegotiationRow {
    if (thread.status === 'open' && thread.expires_at < now) {
      this.repo.endNegotiation(thread.id, 'expired', 'time', null, null, now)
      return this.requireNegotiation(thread.id)
    }
    return thread
  }

  private moveList(threadId: string): Move[] {
    return this.repo.moves(threadId).map((row) => ({ side: row.side, action: row.action, totalCents: row.total_cents ?? undefined, final: row.final === 1 }))
  }

  private seatFor(side: Side, buyerId: string): Seat & { targetChosen: boolean } {
    const sheet = this.repo.partyRules(side === 'seller' ? WARRANT_ID : buyerId)
    if (!sheet) throw new Problem(409, 'deal.rules_missing', 'Deal rules are missing', 'Both companies need deal rules before terms can be checked.')
    return seatOf(sheet.body)
  }

  private offerNew(input: DealOfferWithTerms, side: Side, buyer: { id: string; displayName: string }, who: Principal, runId: string | null, by: MoveBy, now: string): HttpResult {
    const { buyerRules, sellerRules } = this.keptSheets(buyer.id)
    if (input.threadId) {
      const closed = this.repo.agreedDealInThread(input.threadId)
      if (closed) throw new Problem(409, DealClause.threadClosed, 'This negotiation already has a deal', `Deal ${closed.id} was agreed in this thread.`, { dealId: closed.id })
    }
    let existing = input.threadId ? this.repo.negotiation(input.threadId) : null
    if (existing && existing.buyer_id !== buyer.id) throw new Problem(422, 'deal.wrong_client', 'That negotiation is with another client', 'Offer terms in a negotiation with this client.')
    if (existing) {
      existing = this.freshen(existing, now)
      if (existing.status !== 'open') throw new Problem(409, 'negotiation.ended', 'This negotiation has ended', `It ended: ${endingWords(existing)}. Open a new one to make another offer.`)
    }
    // A new negotiation is opened only by an offer that stands. An opening offer the offerer's own rules refuse is
    // recorded as refused and leaves no empty negotiation behind. A thread id the caller chose is kept.
    const threadId = existing?.id ?? input.threadId ?? randomUUID()
    const perSide = existing?.offers_per_side ?? Math.min(MAX_OFFERS_PER_SIDE, Math.max(2, input.offersPerSide ?? DEFAULT_OFFERS_PER_SIDE))
    const moves = existing ? this.moveList(existing.id) : []
    if (moves.at(-1)?.side === side) throw new Problem(409, 'negotiation.not_your_turn', 'It is not your turn', 'You made the last move. Wait for the other side to accept, counter or walk away.')
    const seat = this.seatFor(side, buyer.id)
    const protocol = checkOffer(seat, moves, perSide, input.terms.totalCents)
    if (!protocol.ok && protocol.code === 'negotiation.no_offers_left') throw new Problem(409, protocol.code, 'You have no offers left', protocol.detail)

    const id = randomUUID()
    const jobId = input.terms.jobId ?? `job_${slug(buyer.displayName)}_${id.slice(0, 6)}`
    const full = checkDeal({ ...input.terms, jobId }, buyerRules.body, sellerRules.body, now.slice(0, 10))
    // An offer is judged against the offerer's own rules and the terms themselves. The other side's limits are not
    // consulted: whether they can live with it is theirs to say, by accepting or not. Nothing about them leaks.
    const own = full.violations.filter((violation) => violation.side === side || violation.side === 'terms')
    if (!protocol.ok && !own.some((violation) => violation.code === protocol.code)) {
      own.push({ code: protocol.code, side, detail: protocol.detail, hint: protocol.code === 'negotiation.regressive' ? 'Offer no worse for them than your last offer.' : 'Stay inside your own rules.' })
    }
    if (input.terms.jobId && (this.repo.agreedDealByJob(jobId) || this.repo.proposalsForJob(jobId).length > 0)) {
      own.push({ code: DealClause.jobTaken, side: 'terms', detail: `job ${jobId} is already in use`, hint: 'Choose a different job id, or leave it out.' })
    }
    const stands = own.length === 0
    const verdict: DealVerdict = { verdict: stands ? 'ACCEPT' : 'REFUSE', violations: own, zone: full.zone }
    const terms: StoredTerms = { ...input.terms }
    const termsHash = stableHash({ terms, buyerId: buyer.id, sellerId: WARRANT_ID, buyerRules: buyerRules.version, sellerRules: sellerRules.version })
    const secrets = secretsOf(side === 'buyer' ? buyerRules.body : sellerRules.body)
    const message = input.prompt ? scrubNote(input.prompt, secrets, [terms.totalCents, ...moves.flatMap((move) => (move.totalCents === undefined ? [] : [move.totalCents]))]) : null
    const row: DealRow = {
      id,
      thread_id: threadId,
      buyer_id: buyer.id,
      seller_id: WARRANT_ID,
      offered_by: side,
      actor: actorLabel(who),
      status: stands ? 'open' : 'refused',
      job_id: null,
      terms_json: JSON.stringify(terms),
      verdict_json: JSON.stringify(verdict),
      buyer_rules_version: buyerRules.version,
      seller_rules_version: sellerRules.version,
      terms_hash: termsHash,
      sig: null,
      key_id: null,
      run_id: runId,
      // What a company says to the other side must not leak its own limits, whoever wrote the sentence.
      prompt: message,
      created_at: now,
    }
    this.repo.transaction(() => {
      const thread = stands && !existing
        ? this.openNegotiation({ id: threadId, buyerId: buyer.id, scope: input.terms.scope, category: input.terms.category, currency: input.terms.currency, milestones: input.terms.milestones.map((item) => item.title), offersPerSide: perSide }, who, now)
        : existing
      this.repo.insertDeal(row)
      if (!stands || !thread) return
      // A counter-offer answers the offer it was made against: that one no longer stands.
      for (const earlier of this.repo.dealsInThread(thread.id)) if (earlier.status === 'open' && earlier.id !== id) this.repo.setDealStatus(earlier.id, 'countered')
      this.repo.insertMove({ id: randomUUID(), negotiation_id: thread.id, seq: moves.length + 1, side, action: 'offer', deal_id: id, total_cents: terms.totalCents, final: input.final ? 1 : 0, message, assessment: input.assessment?.slice(0, 1000) ?? null, actor: actorLabel(who), by, run_id: runId, created_at: now })
      this.repo.touchNegotiation(thread.id, now)
      const ending = endedBy(this.moveList(thread.id), thread.offers_per_side, (next, cents) => insideMandate(this.seatFor(next, buyer.id), cents))
      if (ending === 'expired') this.repo.endNegotiation(thread.id, 'expired', 'deadline', null, null, now)
      if (ending === 'stalled') this.repo.endNegotiation(thread.id, 'stalled', 'stalemate', null, null, now)
    })
    return { status: 201, body: this.view(this.repo.deal(id)!, who) }
  }

  /**
   * Accepts the other side's standing offer. This is the only way a deal comes into being: one side says yes to the
   * other's exact offer. At that moment both companies' current rules are checked again — a sheet may have changed
   * since the offer — and only then is the deal signed and given its job.
   */
  accept(dealId: string, input: { message?: string; assessment?: string }, who: Principal, runId: string | null = null, by: MoveBy = 'person'): HttpResult {
    const now = this.now().toISOString()
    const row = this.repo.deal(dealId)
    if (!row || (who.buyerId && row.buyer_id !== who.buyerId)) throw new Problem(404, 'deal.missing', 'Offer not found', 'No offer matches that id.')
    const thread = this.freshen(this.repo.negotiation(row.thread_id) ?? this.legacyThread(row), now)
    // Accepting the same offer twice is a replay, not an error.
    if (row.status === 'agreed' && thread.agreed_deal_id === row.id) return { status: 200, body: this.view(row, who) }
    if (thread.status !== 'open') throw new Problem(409, 'negotiation.ended', 'This negotiation has ended', `It ended: ${endingWords(thread)}.`)
    if (row.status !== 'open') throw new Problem(409, 'deal.not_open', 'That offer is not open', row.status === 'countered' ? 'It was answered with a counter-offer. Only the latest offer can be accepted.' : `It is ${row.status}.`)
    const side = this.sideFor(who, row.offered_by === 'seller' ? 'buyer' : 'seller', row.buyer_id)
    if (side === row.offered_by) throw new Problem(409, 'deal.own_offer', 'You cannot accept your own offer', 'An offer is accepted by the other side.')
    const moves = this.moveList(thread.id)
    if (moves.at(-1)?.action !== 'offer' || this.repo.moves(thread.id).at(-1)?.deal_id !== row.id) throw new Problem(409, 'deal.not_open', 'That offer is not the standing one', 'Only the latest offer can be accepted.')

    const { buyerRules, sellerRules } = this.keptSheets(row.buyer_id)
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const jobId = terms.jobId ?? `job_${slug(this.buyerName(row.buyer_id))}_${row.id.slice(0, 6)}`
    const verdict = checkDeal({ ...terms, jobId }, buyerRules.body, sellerRules.body, now.slice(0, 10))
    if (this.repo.agreedDealByJob(jobId) || this.repo.proposalsForJob(jobId).length > 0) {
      verdict.violations.push({ code: DealClause.jobTaken, side: 'terms', detail: `job ${jobId} is already in use`, hint: 'Make a new offer without a job id.' })
    }
    const mine = verdict.violations.filter((violation) => violation.side === side || violation.side === 'terms')
    if (mine.length > 0) {
      throw new Problem(422, 'deal.outside_your_rules', 'Accepting this would break your own rules', mine.map((violation) => violation.detail).join('; ') + '. Counter-offer or walk away instead.', { violations: mine.map(({ code, detail, hint }) => ({ code, detail, hint })) })
    }
    if (verdict.violations.length > 0) {
      // The offerer's own rules changed since it made the offer, and they no longer allow it. It cannot be held to it.
      throw new Problem(409, 'deal.offer_stale', 'That offer no longer stands', 'The other side\'s rules changed since it was made. Ask them for a new offer.')
    }
    const agreedTerms: StoredTerms = { ...terms, jobId }
    const termsHash = stableHash({ terms: agreedTerms, buyerId: row.buyer_id, sellerId: row.seller_id, buyerRules: buyerRules.version, sellerRules: sellerRules.version })
    const signature = this.signer.sign(dealMessage(row.id, termsHash))
    const message = input.message ? scrubNote(input.message, secretsOf(side === 'buyer' ? buyerRules.body : sellerRules.body), moves.flatMap((move) => (move.totalCents === undefined ? [] : [move.totalCents]))) : null
    this.repo.transaction(() => {
      this.repo.agreeDeal(row.id, { jobId, termsJson: JSON.stringify(agreedTerms), verdictJson: JSON.stringify(verdict), buyerRulesVersion: buyerRules.version, sellerRulesVersion: sellerRules.version, termsHash, sig: signature.signature, keyId: signature.keyId })
      this.repo.insertMove({ id: randomUUID(), negotiation_id: thread.id, seq: moves.length + 1, side, action: 'accept', deal_id: row.id, total_cents: terms.totalCents, final: 0, message, assessment: input.assessment?.slice(0, 1000) ?? null, actor: actorLabel(who), by, run_id: runId, created_at: now })
      this.repo.endNegotiation(thread.id, 'agreed', 'accepted', side, row.id, now)
    })
    return { status: 200, body: this.view(this.repo.deal(row.id)!, who) }
  }

  /** Ends a negotiation with no deal. Either side may, at any time: walking away is always a move. */
  walkAway(threadId: string, input: { reason?: string; assessment?: string }, who: Principal, runId: string | null = null, by: MoveBy = 'person') {
    const now = this.now().toISOString()
    const thread = this.freshen(this.requireNegotiation(threadId), now)
    if (who.buyerId && thread.buyer_id !== who.buyerId) throw new Problem(404, 'negotiation.missing', 'No such negotiation', 'No negotiation matches that id.')
    const moves = this.repo.moves(thread.id)
    // Owner: the side whose turn it is, so a person playing both chairs walks away from the chair that must answer.
    const requested = who.side ?? (moves.at(-1)?.side === 'seller' && !this.repo.sheetClaimed(thread.buyer_id) ? 'buyer' : 'seller')
    const side = this.sideFor(who, requested, thread.buyer_id)
    if (thread.status === 'walked_away' && thread.ended_by === side) return this.negotiationView(thread.id, who)
    if (thread.status !== 'open') throw new Problem(409, 'negotiation.ended', 'This negotiation has ended', `It ended: ${endingWords(thread)}.`)
    const secrets = secretsOf(this.seatSheet(side, thread.buyer_id))
    const reason = input.reason ? scrubNote(input.reason.slice(0, 500), secrets, moves.flatMap((move) => (move.total_cents === null ? [] : [move.total_cents]))) : null
    this.repo.transaction(() => {
      this.repo.insertMove({ id: randomUUID(), negotiation_id: thread.id, seq: moves.length + 1, side, action: 'walk_away', deal_id: null, total_cents: null, final: 0, message: reason, assessment: input.assessment?.slice(0, 1000) ?? null, actor: actorLabel(who), by, run_id: runId, created_at: now })
      this.repo.endNegotiation(thread.id, 'walked_away', reason ?? 'walked away', side, null, now)
    })
    return this.negotiationView(thread.id, who)
  }

  private seatSheet(side: Side, buyerId: string): PartyRules {
    const sheet = this.repo.partyRules(side === 'seller' ? WARRANT_ID : buyerId)
    if (!sheet) throw new Problem(409, 'deal.rules_missing', 'Deal rules are missing', 'Both companies need deal rules first.')
    return sheet.body
  }

  /** A thread from before negotiations had their own record: its offers stand alone, and it is treated as open. */
  private legacyThread(row: DealRow): NegotiationRow {
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const now = this.now().toISOString()
    return { id: row.thread_id, buyer_id: row.buyer_id, seller_id: row.seller_id, status: row.status === 'agreed' ? 'agreed' : 'open', scope: terms.scope, category: terms.category, currency: terms.currency, milestones_json: JSON.stringify(terms.milestones.map((item) => item.title)), offers_per_side: DEFAULT_OFFERS_PER_SIDE, started_by: row.actor, ended_reason: null, ended_by: null, agreed_deal_id: row.status === 'agreed' ? row.id : null, debrief_json: null, created_at: row.created_at, updated_at: row.created_at, expires_at: new Date(Date.parse(now) + NEGOTIATION_TTL_MS).toISOString(), ended_at: null }
  }

  private buyerName(buyerId: string): string {
    return this.repo.latestWarrant()?.body.clients.find((client) => client.id === buyerId)?.displayName ?? buyerId
  }

  /** Which sides' private numbers this caller may see: its own; the owner also the client's while the client has not claimed its seat. */
  private visibleSides(who: Principal, buyerId: string): Side[] {
    if (who.side === 'buyer') return who.buyerId === buyerId ? ['buyer'] : []
    if (who.role === 'owner') return this.repo.sheetClaimed(buyerId) ? ['seller'] : ['seller', 'buyer']
    return ['seller']
  }

  /** Whether this caller may see one side's private numbers, reasoning and debrief. */
  canSee(who: Principal, side: Side, buyerId: string): boolean {
    return this.visibleSides(who, buyerId).includes(side)
  }

  /**
   * One negotiation as this caller may see it. The moves are public to both sides. Each side's private numbers, its
   * negotiator's private reasoning, its outcome and its debrief are shown only to that side.
   */
  negotiationView(id: string, who: Principal) {
    const now = this.now().toISOString()
    const thread = this.freshen(this.requireNegotiation(id), now)
    if (who.buyerId && thread.buyer_id !== who.buyerId) throw new Problem(404, 'negotiation.missing', 'No such negotiation', 'No negotiation matches that id.')
    const visible = this.visibleSides(who, thread.buyer_id)
    const rows = this.repo.moves(thread.id)
    const moves = this.moveList(thread.id)
    const last = moves.at(-1)
    const turn: Side | null = thread.status !== 'open' ? null : !last ? null : last.side === 'seller' ? 'buyer' : 'seller'
    const agreed = thread.agreed_deal_id ? this.repo.deal(thread.agreed_deal_id) : null
    const debriefs = thread.debrief_json ? JSON.parse(thread.debrief_json) as Record<string, unknown> : {}
    const seat = (side: Side) => {
      if (!visible.includes(side)) return { side, visible: false as const }
      const sheet = this.repo.partyRules(side === 'seller' ? WARRANT_ID : thread.buyer_id)
      if (!sheet) return { side, visible: false as const }
      const atDeal = agreed ? this.repo.partyRulesVersions(sheet.partyId).find((version) => version.version === (side === 'seller' ? agreed.seller_rules_version : agreed.buyer_rules_version))?.body ?? sheet.body : sheet.body
      const position = seatOf(atDeal)
      return {
        side,
        visible: true as const,
        reservationCents: position.reservationCents,
        targetCents: position.targetCents,
        targetChosen: position.targetChosen,
        style: position.style,
        offersLeft: offersLeft(moves, side, thread.offers_per_side),
        advice: thread.status === 'open' && (turn === side || (!last && side === 'seller')) ? advise(position, moves, thread.offers_per_side) : null,
        outcome: agreed ? outcomeFor(position, (JSON.parse(agreed.terms_json) as StoredTerms).totalCents, thread.currency, position.targetChosen) : null,
        debrief: debriefs[side] ?? null,
      }
    }
    const seller = seat('seller')
    const buyer = seat('buyer')
    const standing = last?.action === 'offer' && thread.status === 'open' ? rows.at(-1)! : null
    const canAct = (side: Side) => thread.status === 'open' && (turn === null || turn === side) && (who.side ? who.side === side : side === 'seller' || (who.role === 'owner' && !this.repo.sheetClaimed(thread.buyer_id)))
    return {
      id: thread.id,
      buyerId: thread.buyer_id,
      buyerName: this.buyerName(thread.buyer_id),
      sellerName: this.repo.partyRules(WARRANT_ID)?.body.displayName ?? 'The studio',
      status: thread.status,
      endedReason: thread.ended_reason,
      endedBy: thread.ended_by,
      ending: thread.status === 'open' ? null : endingWords(thread),
      agreedDealId: thread.agreed_deal_id,
      jobId: agreed?.job_id ?? null,
      scope: thread.scope,
      category: thread.category,
      currency: thread.currency,
      milestones: JSON.parse(thread.milestones_json) as string[],
      offersPerSide: thread.offers_per_side,
      startedBy: thread.started_by,
      createdAt: thread.created_at,
      updatedAt: thread.updated_at,
      expiresAt: thread.expires_at,
      endedAt: thread.ended_at,
      turn,
      standing: standing ? { dealId: standing.deal_id, side: standing.side, totalCents: standing.total_cents, final: standing.final === 1 } : null,
      moves: rows.map((move) => ({
        seq: move.seq,
        side: move.side,
        action: move.action,
        dealId: move.deal_id,
        totalCents: move.total_cents,
        final: move.final === 1,
        message: move.message,
        by: move.by,
        runId: visible.includes(move.side) ? move.run_id : null,
        // A negotiator's reasoning is its own company's business.
        assessment: visible.includes(move.side) ? move.assessment : null,
        createdAt: move.created_at,
      })),
      seats: { seller, buyer },
      // The seats the caller may answer for, and of those, the ones Mandate's negotiator may answer for on its behalf.
      you: { sides: (['seller', 'buyer'] as const).filter((side) => canAct(side)), agentMay: (['seller', 'buyer'] as const).filter((side) => canAct(side) && this.agentMaySpeakFor(side, thread.buyer_id)) },
      fairness: agreed && seller.visible && buyer.visible ? fairness(seatOf(this.seatSheet('seller', thread.buyer_id)), seatOf(this.seatSheet('buyer', thread.buyer_id)), (JSON.parse(agreed.terms_json) as StoredTerms).totalCents) : null,
    }
  }

  negotiations(who: Principal, limit = 30) {
    return { data: this.repo.listNegotiations(limit, who.buyerId).map((row) => this.negotiationView(row.id, who)) }
  }

  list(limit: number, who: Principal) {
    const rows = this.repo.listDeals(limit).filter((row) => !who.buyerId || row.buyer_id === who.buyerId)
    return { data: rows.map((row) => this.view(row, who)) }
  }

  get(id: string, who: Principal) {
    const row = this.repo.deal(id)
    if (!row || (who.buyerId && row.buyer_id !== who.buyerId)) throw new Problem(404, 'deal.missing', 'Deal not found', 'No deal matches that id.')
    return this.view(row, who)
  }

  /** Re-checks an agreed deal's signature against its stored terms. */
  verify(id: string) {
    const row = this.repo.deal(id)
    if (!row) throw new Problem(404, 'deal.missing', 'Deal not found', 'No deal matches that id.')
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const recomputed = stableHash({ terms, buyerId: row.buyer_id, sellerId: row.seller_id, buyerRules: row.buyer_rules_version, sellerRules: row.seller_rules_version })
    const hashMatches = recomputed === row.terms_hash
    const signatureValid = row.sig ? this.signer.verify(dealMessage(row.id, row.terms_hash), row.sig, row.key_id) : null
    return {
      dealId: row.id,
      status: row.status,
      termsHash: row.terms_hash,
      hashMatches,
      signature: row.sig,
      keyId: row.key_id,
      algorithm: 'ed25519' as const,
      signatureValid,
      verdict: row.status !== 'agreed' ? 'not_agreed' : hashMatches && signatureValid ? 'valid' : 'invalid',
      publicKeys: this.signer.publicKeys(),
    }
  }

  /** Bills one milestone of an agreed deal as a client charge. The gate still decides; this only fills in the request. */
  async bill(dealId: string, milestone: number, body: { evidenceUrl: string; prompt?: string }, who: Principal): Promise<HttpResult> {
    const row = this.repo.deal(dealId)
    if (!row || row.status !== 'agreed' || !row.job_id) throw new Problem(404, 'deal.missing', 'No agreed deal', 'Only an agreed deal can be billed.')
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const item = terms.milestones[milestone]
    if (!item) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', `The deal has ${terms.milestones.length} milestones.`)
    const input = ProposalCreateSchema.parse({
      kind: 'charge',
      payee: row.buyer_id,
      amountCents: item.amountCents,
      currency: terms.currency,
      category: terms.category,
      description: `${terms.scope}: ${item.title}`.slice(0, 500),
      evidenceUrl: body.evidenceUrl,
      prompt: body.prompt ?? `Bill for milestone ${milestone + 1} of deal ${row.id.slice(0, 8)}`,
      jobId: row.job_id,
      dealId: row.id,
      milestone,
    })
    // If the owner has switched on "bill signed deals when proof is attached", the rules answer AUTO and the invoice goes out now.
    return this.mandate.proposeAndDispatch(input, `bill-${row.id}-${milestone}-${stableHash(body).slice(0, 16)}`, actorLabel(who))
  }

  // ---------- delivery and the client's acceptance ----------

  /**
   * The studio says a milestone is delivered, with the proof. If the owner's rules ask for the client's acceptance
   * first, the delivery waits for the client's own agent. If not, it is billed straight away exactly as before.
   * Either way the deal checks and the gate decide whether a bill may exist.
   */
  async deliver(dealId: string, milestone: number, body: { evidenceUrl: string; prompt?: string }, who: Principal) {
    if (who.side === 'buyer') throw new Problem(403, 'auth.forbidden', 'Not available to a client agent', 'Only the studio says its work is delivered.')
    const row = this.repo.deal(dealId)
    if (!row || row.status !== 'agreed' || !row.job_id) throw new Problem(404, 'deal.missing', 'No agreed deal', 'Only an agreed deal can be delivered against.')
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const item = terms.milestones[milestone]
    if (!item) throw new Problem(404, 'deal.milestone_unknown', 'No such milestone', `The deal has ${terms.milestones.length} milestones.`)
    const automation = this.repo.latestWarrant()?.body.automation
    if (!automation?.requireAcceptance) {
      const billed = await this.bill(dealId, milestone, body, who)
      return { status: billed.status, body: { mode: 'billed' as const, charge: billed.body, delivery: null } }
    }
    if (this.repo.chargeForMilestone(dealId, milestone)) throw new Problem(409, 'deal.milestone_billed', 'Already billed', 'This milestone has already been billed.')
    let url: URL
    try { url = new URL(body.evidenceUrl) } catch { throw new Problem(422, 'evidence.missing', 'Proof is not a link', 'Give an https link to the delivered work.') }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Problem(422, 'evidence.missing', 'Proof must be an https link', 'Give an https link to the delivered work, with no user or password in it.')
    const now = this.now().toISOString()
    const hash = proofHash(body.evidenceUrl)
    return this.repo.transaction(() => {
      const current = this.repo.currentDelivery(dealId, milestone)
      if (current && current.proof_hash === hash && current.status !== 'rejected') return { status: 200, body: { mode: 'awaiting' as const, charge: null, delivery: this.deliveryView(current) } }
      this.repo.supersedeAwaiting(dealId, milestone)
      const made: DeliveryRow = { id: randomUUID(), deal_id: dealId, milestone, proof_url: body.evidenceUrl.trim(), proof_hash: hash, delivered_by: who.role, status: 'awaiting', note: null, decided_by: null, run_id: null, sig: null, key_id: null, proposal_id: null, created_at: now, decided_at: null }
      this.repo.insertDelivery(made)
      return { status: 201, body: { mode: 'awaiting' as const, charge: null, delivery: this.deliveryView(made) } }
    })
  }

  /**
   * The client's own agent decides. Only the key bound to that client can: not the studio, and not the owner. The
   * decision is signed over this exact proof, so an acceptance for one link can never bill another. An acceptance
   * then bills the milestone through the same gate as any bill; the owner's rules made it automatic, nothing else did.
   */
  async decide(dealId: string, milestone: number, input: { decision: 'accepted' | 'rejected'; note?: string }, who: Principal, runId: string | null = null) {
    const row = this.repo.deal(dealId)
    if (who.side !== 'buyer' || !row || row.buyer_id !== who.buyerId) throw new Problem(403, 'auth.forbidden', 'Only the client can decide this', 'A delivery is accepted or rejected by the client\'s own agent, using the key bound to that client.')
    if (row.status !== 'agreed') throw new Problem(404, 'deal.missing', 'No agreed deal', 'Only an agreed deal has deliveries.')
    const current = this.repo.currentDelivery(dealId, milestone)
    if (!current || current.status !== 'awaiting') throw new Problem(409, 'delivery.not_awaiting', 'Nothing is waiting for your decision', current ? `The latest delivery for this milestone is ${current.status}.` : 'The studio has not delivered this milestone.')
    if (this.repo.chargeForMilestone(dealId, milestone)) throw new Problem(409, 'deal.milestone_billed', 'Already billed', 'This milestone has already been billed.')
    const now = this.now().toISOString()
    const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null
    const signed = this.signer.sign(acceptanceMessage({ id: current.id, deal_id: dealId, milestone, proof_hash: current.proof_hash, status: input.decision }))
    this.repo.decideDelivery(current.id, input.decision, note, who.buyerId!, runId, signed.signature, signed.keyId, now)
    // The moment the client decides, whoever decided (the hosted stand-in or an outside agent), the console hears it.
    live.publish({ type: 'review', stage: 'decided', dealId, milestone, decision: input.decision, note, at: stamp() })
    let charge: unknown = null
    // Paused: the client's acceptance is kept, signed, and the invoice waits. Resuming bills what was accepted meanwhile.
    if (input.decision === 'accepted' && !this.mandate.isPaused()) charge = await this.billAccepted(row, current, signed.keyId, note, who.buyerId)
    return { status: 200, body: { delivery: this.deliveryView(this.repo.delivery(current.id)!), charge } }
  }

  /** Bills a delivery the client accepted, through the same gate as any bill. The owner's rules decide whether it needs a tap. */
  private async billAccepted(row: DealRow, current: DeliveryRow, keyId: string, note: string | null, decidedBy: string | null): Promise<unknown> {
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const item = terms.milestones[current.milestone]!
    const made = await this.mandate.proposeAndDispatch(ProposalCreateSchema.parse({
      kind: 'charge', payee: row.buyer_id, amountCents: item.amountCents, currency: terms.currency, category: terms.category,
      description: `${terms.scope}: ${item.title}`.slice(0, 500), evidenceUrl: current.proof_url,
      prompt: `Milestone ${current.milestone + 1} of deal ${row.id.slice(0, 8)} was accepted by the client's agent`, jobId: row.job_id!, dealId: row.id, milestone: current.milestone,
    }), `accept-${current.id}`, 'autopilot')
    const id = (made.body as { id?: string }).id
    if (id) {
      this.repo.linkDelivery(current.id, id)
      this.repo.insertEvent(randomUUID(), id, 'delivery.accepted', 'deal.accepted', { deliveryId: current.id, decidedBy, proofHash: current.proof_hash, keyId, note }, this.now().toISOString())
    }
    return made.body
  }

  /** After a resume: bill the milestones the client accepted while Mandate was paused. */
  async billAcceptedWhilePaused(): Promise<number> {
    let billed = 0
    for (const delivery of this.repo.allDeliveries()) {
      if (delivery.status !== 'accepted' || delivery.proposal_id) continue
      const deal = this.repo.deal(delivery.deal_id)
      if (!deal || deal.status !== 'agreed' || this.repo.chargeForMilestone(delivery.deal_id, delivery.milestone)) continue
      await this.billAccepted(deal, delivery, delivery.key_id ?? '', delivery.note, delivery.decided_by).catch(() => undefined)
      billed += 1
    }
    return billed
  }

  /** The deliveries a caller may see: a client sees its own, the owner and the studio see all. */
  deliveries(who: Principal, limit = 50) {
    return { data: this.repo.deliveriesFor(who.buyerId, limit).map((row) => this.deliveryView(row)) }
  }

  deliveryView(row: DeliveryRow) {
    const deal = this.repo.deal(row.deal_id)
    const terms = deal ? (JSON.parse(deal.terms_json) as StoredTerms) : null
    const item = terms?.milestones[row.milestone]
    const warrant = this.repo.latestWarrant()
    return {
      id: row.id,
      dealId: row.deal_id,
      jobId: deal?.job_id ?? null,
      milestone: row.milestone,
      title: item?.title ?? `Milestone ${row.milestone + 1}`,
      scope: terms?.scope ?? '',
      amountCents: item?.amountCents ?? 0,
      currency: terms?.currency ?? 'USD',
      buyerId: deal?.buyer_id ?? null,
      buyerName: warrant?.body.clients.find((client) => client.id === deal?.buyer_id)?.displayName ?? deal?.buyer_id ?? null,
      proofUrl: row.proof_url,
      status: row.status,
      note: row.note,
      decidedBy: row.decided_by,
      createdAt: row.created_at,
      decidedAt: row.decided_at,
      proposalId: row.proposal_id,
      signatureValid: row.sig ? this.signer.verify(acceptanceMessage(row), row.sig, row.key_id) : null,
      signature: row.sig,
      keyId: row.key_id,
    }
  }

  /** The next milestone of each agreed deal that has not been billed: work the studio can bill as soon as it is delivered. */
  readyToBill() {
    const warrant = this.repo.latestWarrant()
    const name = (id: string) => warrant?.body.clients.find((client) => client.id === id)?.displayName ?? id
    const out: Array<{ dealId: string; jobId: string; buyerId: string; buyerName: string; scope: string; milestone: number; title: string; amountCents: number; currency: string; billed: number; total: number; delivery: ReturnType<DealService['deliveryView']> | null }> = []
    for (const row of this.repo.agreedDeals()) {
      if (!row.job_id) continue
      const terms = JSON.parse(row.terms_json) as StoredTerms
      const next = terms.milestones.findIndex((_, index) => !this.repo.chargeForMilestone(row.id, index))
      if (next === -1) continue
      out.push({ dealId: row.id, jobId: row.job_id, buyerId: row.buyer_id, buyerName: name(row.buyer_id), scope: terms.scope, milestone: next, title: terms.milestones[next]!.title, amountCents: terms.milestones[next]!.amountCents, currency: terms.currency, billed: next, total: terms.milestones.length, delivery: (() => { const d = this.repo.currentDelivery(row.id, next); return d ? this.deliveryView(d) : null })() })
    }
    return out
  }

  /** The deal behind a job, with where each milestone stands. */
  summaryForJob(jobId: string) {
    const row = this.repo.agreedDealByJob(jobId)
    return row ? this.billing(row) : null
  }

  private billing(row: DealRow) {
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const charges = this.repo.chargesForDeal(row.id)
    return {
      dealId: row.id,
      totalCents: terms.totalCents,
      scope: terms.scope,
      signatureValid: this.verify(row.id).signatureValid === true,
      milestones: terms.milestones.map((item, index) => {
        const live = this.repo.chargeForMilestone(row.id, index)
        return { index, title: item.title, amountCents: item.amountCents, chargeId: live?.id ?? null, phase: live?.phase ?? null, attempts: charges.filter((c) => c.milestone === index).length }
      }),
    }
  }

  // ---------- rules ----------

  /** Every sheet in full. Internal: the server's own judgements need both companies' numbers. */
  private allSheets() {
    const warrant = this.repo.latestWarrant()
    const parties = [...(warrant?.body.clients.map((client) => client.id) ?? []), WARRANT_ID]
    return parties.flatMap((partyId) => {
      const latest = this.repo.partyRules(partyId)
      return latest ? [{ partyId, version: latest.version, createdAt: latest.createdAt, origin: latest.origin, writtenBy: latest.writtenBy, ...latest.body }] : []
    })
  }

  /**
   * Both parties' deal rules, for the owner. A client that wrote its own numbers with its own key has claimed its
   * seat: its sheet is listed as sealed, with its version and whether a limit is set, and none of its private numbers.
   * The studio owner cannot read a client's budget; the screen saying "sealed" is the server's word, not a costume.
   */
  rules() {
    return {
      data: this.allSheets().map((sheet) => {
        const claimed = sheet.partyId !== WARRANT_ID && this.repo.sheetClaimed(sheet.partyId)
        const limitSet = sheet.role === 'buyer' ? sheet.maxTotalCents !== undefined : sheet.minTotalCents !== undefined
        if (!claimed) return { ...sheet, claimed: false, sealed: false, limitSet }
        const { maxTotalCents: _max, maxMilestoneCents: _milestone, targetTotalCents: _target, style: _style, brief: _brief, ...open } = sheet
        return { ...open, claimed: true, sealed: true, limitSet }
      }),
    }
  }

  /** The caller's own rules. An agent may read its side's rules and never the other's. */
  rulesFor(who: Principal) {
    const partyId = who.side === 'buyer' ? who.buyerId : WARRANT_ID
    const latest = this.repo.partyRules(partyId)
    if (!latest) throw new Problem(404, 'deal.rules_missing', 'Deal rules are missing', 'No deal rules are set for this party.')
    return { partyId, version: latest.version, origin: latest.origin, writtenBy: latest.writtenBy, claimed: who.side === 'buyer' && this.repo.sheetClaimed(partyId), sealed: false, limitSet: true, ...latest.body }
  }

  /**
   * The sheets a deal with this buyer is judged against. They must exist and must be kept: a sheet that came with
   * the box stays an example until a key writes it, and until then there is nothing to judge against — so offers
   * and negotiations wait on the server, not only on a button in the console.
   */
  keptSheets(buyerId: string): { buyerRules: PartyRulesRecord; sellerRules: PartyRulesRecord } {
    const buyerRules = this.repo.partyRules(buyerId)
    const sellerRules = this.repo.partyRules(WARRANT_ID)
    if (!buyerRules || !sellerRules) throw new Problem(409, 'deal.rules_missing', 'Deal rules are missing', 'Both companies need deal rules before terms can be checked.')
    const examples = [...(sellerRules.origin === 'seed' ? [sellerRules.body.displayName] : []), ...(buyerRules.origin === 'seed' ? [buyerRules.body.displayName] : [])]
    if (examples.length > 0) throw new Problem(409, 'deal.rules_unconfirmed', 'The starting numbers are not kept yet', `${examples.join(' and ')} still show${examples.length === 1 ? 's' : ''} the sample numbers that came with the studio. Keep them, or write your own, on Deals — then terms can be judged.`)
    return { buyerRules, sellerRules }
  }

  /**
   * The price limits are set when the studio has said the least it takes and every client on the warrant has said the
   * most it pays — said, not seeded. A sheet that came with the box does not count until a key writes it.
   */
  priceLimitsSet(): boolean {
    const warrant = this.repo.latestWarrant()
    if (!warrant) return false
    const byId = new Map(this.allSheets().map((sheet) => [sheet.partyId, sheet]))
    const seller = byId.get(WARRANT_ID)
    if (seller?.origin !== 'written' || seller?.minTotalCents === undefined) return false
    return warrant.body.clients.every((client) => {
      const sheet = byId.get(client.id)
      return sheet?.origin === 'written' && sheet?.maxTotalCents !== undefined
    })
  }

  /**
   * Writes the next version of one company's price limits. `mine` is the caller's own party, so a company never has
   * to know the other side's id. Each company writes its own sheet and nobody else's: the owner may write either,
   * a client key only its own client, the studio key only the studio, and an agent never (its key may ask, not set
   * the terms its own company will accept). That rule is what keeps the limits private in both directions.
   */
  publishRules(partyId: string, input: unknown, who: Principal): HttpResult {
    const target = partyId === 'mine' ? (who.side === 'buyer' ? who.buyerId : WARRANT_ID) : partyId
    if (who.role !== 'owner') {
      if (who.role === 'agent') throw new Problem(403, 'auth.forbidden', 'An agent key cannot set price limits', 'An agent may read its company’s terms. Writing them is for the owner or the company’s own key.')
      const own = who.side === 'buyer' ? who.buyerId : WARRANT_ID
      if (target !== own) throw new Problem(403, 'auth.forbidden', 'Your own company only', 'Each company writes the least it will accept or the most it will pay. This key cannot change the other side.')
    }
    const warrant = this.repo.latestWarrant()
    const known = target === WARRANT_ID || warrant?.body.clients.some((client) => client.id === target)
    if (!known) throw new Problem(404, 'deal.party_unknown', 'Unknown party', 'Deal rules can only be written for the studio or a client on the warrant.')
    // A client that set its own numbers owns them. The studio's owner may not overwrite them, or read them back.
    if (who.role === 'owner' && target !== WARRANT_ID && this.repo.sheetClaimed(target)) {
      throw new Problem(403, 'deal.seat_claimed', 'This client set its own numbers', 'Only the client, with its own key, can change what it will pay. It is sealed from the studio.')
    }
    const expected = target === WARRANT_ID ? 'seller' : 'buyer'
    // A sheet is written as a whole but may be written in part: anything the caller leaves out keeps its current
    // value, or the warrant's own answer for a company that has never had a sheet. The price itself is never
    // inherited — a company that says nothing about what it will accept has not said anything, and the schema
    // makes that an error rather than a silent zero.
    const current = this.repo.partyRules(target)?.body
    const client = warrant?.body.clients.find((item) => item.id === target)
    // Origin is the server's own record of whether a person chose these numbers. A caller may send a sheet it read
    // back — which now carries that record — but it can never set it: every write through this route is a person
    // writing, so every write counts as written.
    const { origin: _ignored, writtenBy: _by, claimed: _claimed, sealed: _sealed, limitSet: _set, ...fields } = (input as Record<string, unknown>)
    const checked = PartyRulesSchema.safeParse({
      role: expected,
      displayName: current?.displayName ?? client?.displayName,
      currency: current?.currency ?? warrant?.body.currency,
      categories: current?.categories ?? warrant?.body.categories,
      maxMilestones: current?.maxMilestones ?? 4,
      requireProof: current?.requireProof ?? warrant?.body.evidenceRequired,
      maxTotalCents: current?.maxTotalCents,
      maxMilestoneCents: current?.maxMilestoneCents,
      minTotalCents: current?.minTotalCents,
      minMilestoneCents: current?.minMilestoneCents,
      targetTotalCents: current?.targetTotalCents,
      style: current?.style,
      delegate: current?.delegate,
      brief: current?.brief,
      ...fields,
      // A limit moved past the target the company had set: the old target no longer makes sense, so it is dropped
      // rather than refusing the new limit. A target the caller sends now is still checked against the limit.
      ...(!('targetTotalCents' in fields) && current?.targetTotalCents !== undefined && staleTarget(expected, current.targetTotalCents, fields) ? { targetTotalCents: undefined } : {}),
    })
    // The sheet is refused in the words a person would use to explain it: "a buyer must set the most a job may cost",
    // never a stack of schema paths the console would have to translate.
    if (!checked.success) {
      const issue = checked.error.issues[0]
      const where = issue?.path.join('.') || 'rules'
      throw new Problem(422, 'deal.rules_invalid', 'That price sheet is not complete', `${where}: ${issue?.message ?? 'Every field needs a value.'}`)
    }
    const parsed = checked.data
    if (parsed.role !== expected) throw new Problem(422, 'deal.role_mismatch', 'Wrong role', `${target} is the ${expected}.`)
    const now = this.now().toISOString()
    return this.repo.transaction(() => {
      const version = (this.repo.partyRules(target)?.version ?? 0) + 1
      this.repo.insertPartyRules(target, version, parsed, now, 'written', who.role === 'owner' ? 'owner' : 'party')
      return { status: 201, body: { partyId: target, version, createdAt: now, ...parsed } }
    })
  }

  // ---------- views ----------

  private view(row: DealRow, who: Principal) {
    const terms = JSON.parse(row.terms_json) as StoredTerms
    const verdict = JSON.parse(row.verdict_json) as DealVerdict
    const warrant = this.repo.latestWarrant()
    const buyerName = warrant?.body.clients.find((client) => client.id === row.buyer_id)?.displayName ?? row.buyer_id
    const base = {
      id: row.id,
      threadId: row.thread_id,
      buyerId: row.buyer_id,
      buyerName,
      sellerId: row.seller_id,
      offeredBy: row.offered_by,
      status: row.status,
      jobId: row.job_id,
      terms,
      termsHash: row.terms_hash,
      rulesVersions: { buyer: row.buyer_rules_version, seller: row.seller_rules_version },
      signature: row.sig,
      keyId: row.key_id,
      prompt: row.prompt,
      runId: row.run_id,
      createdAt: row.created_at,
    }
    const billing = row.status === 'agreed' ? this.billing(row) : null
    // The owner sees the whole judgement only while it may see both companies' numbers. Once the client has claimed
    // its seat, the owner is the studio and nothing more: the client's limit, in a detail or in the zone, stays sealed.
    if (who.role === 'owner' && !this.repo.sheetClaimed(row.buyer_id)) return { ...base, verdict, billing }
    return { ...base, verdict: verdictFor(verdict, who.side ?? 'seller'), billing }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'client'
}

/** True when a new limit makes an inherited target impossible: a floor raised above it, or a ceiling lowered under it. */
function staleTarget(role: 'buyer' | 'seller', target: number, fields: Record<string, unknown>): boolean {
  if (role === 'seller' && typeof fields.minTotalCents === 'number') return target < fields.minTotalCents
  if (role === 'buyer' && typeof fields.maxTotalCents === 'number') return target > fields.maxTotalCents
  return false
}
