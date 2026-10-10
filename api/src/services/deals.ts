import { live, stamp } from './live'
import { randomUUID } from 'node:crypto'
import type { DealRow, DeliveryRow, PartyRulesRecord, Repo } from '../db/repo'
import { checkDeal, DealClause, PartyRulesSchema, scrubNote, secretsOf, verdictFor, type DealOffer, type DealTerms, type DealVerdict, type PartyRules, type Side } from '../domain/deal'
import { resolveClient } from '../domain/gate'
import { stableHash } from '../domain/hash'
import { ProposalCreateSchema, WARRANT_ID } from '../domain/schemas'
import { acceptanceMessage, dealMessage, proofHash, type Signer } from '../domain/signing'
import { Problem } from '../http/problem'
import { runIdempotent } from './idempotency'
import type { HttpResult, MandateService } from './mandate'
import { actorLabel, type Principal } from './principal'

type StoredTerms = DealTerms & { jobId?: string }

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

  offer(input: DealOffer, idempotencyKey: string, who: Principal, runId: string | null = null): HttpResult {
    const now = this.now().toISOString()
    const side = this.sideFor(who, input.as)
    return runIdempotent(this.repo, idempotencyKey, stableHash({ input, side }), now, () => this.offerNew(input, side, who, runId, now))
  }

  private sideFor(who: Principal, requested: Side | undefined): Side | 'owner' {
    if (who.side) {
      if (requested && requested !== who.side) {
        throw new Problem(403, 'deal.wrong_side', 'This key cannot speak for that party', `This key speaks for the ${who.side} only.`)
      }
      return who.side
    }
    return requested ?? 'owner'
  }

  private offerNew(input: DealOffer, side: Side | 'owner', who: Principal, runId: string | null, now: string): HttpResult {
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No warrant has been written.')
    const buyer = resolveClient(warrant.body, input.buyer)
    if (!buyer) throw new Problem(422, 'deal.buyer_unknown', 'Unknown buyer', 'That client is not on the warrant, so no deal can be made with them.')
    if (who.side === 'buyer' && who.buyerId !== buyer.id) {
      throw new Problem(403, 'deal.wrong_side', 'This key cannot speak for that party', 'This key speaks for a different client.')
    }
    const { buyerRules, sellerRules } = this.keptSheets(buyer.id)
    const threadId = input.threadId ?? randomUUID()
    const closed = this.repo.agreedDealInThread(threadId)
    if (closed) {
      throw new Problem(409, DealClause.threadClosed, 'This negotiation already has a deal', `Deal ${closed.id} was agreed in this thread.`, { dealId: closed.id })
    }

    const id = randomUUID()
    const jobId = input.terms.jobId ?? `job_${slug(buyer.displayName)}_${id.slice(0, 6)}`
    const verdict = checkDeal({ ...input.terms, jobId }, buyerRules.body, sellerRules.body, now.slice(0, 10))
    if (this.repo.agreedDealByJob(jobId) || this.repo.proposalsForJob(jobId).length > 0) {
      verdict.verdict = 'REFUSE'
      verdict.violations.push({
        code: DealClause.jobTaken,
        side: 'terms',
        detail: `job ${jobId} is already in use`,
        hint: 'Choose a different job id, or leave it out.',
      })
    }
    const agreed = verdict.verdict === 'ACCEPT'
    const terms: StoredTerms = { ...input.terms, ...(agreed ? { jobId } : {}) }
    const termsHash = stableHash({ terms, buyerId: buyer.id, sellerId: WARRANT_ID, buyerRules: buyerRules.version, sellerRules: sellerRules.version })
    const signature = agreed ? this.signer.sign(dealMessage(id, termsHash)) : null
    const row: DealRow = {
      id,
      thread_id: threadId,
      buyer_id: buyer.id,
      seller_id: WARRANT_ID,
      offered_by: side,
      actor: actorLabel(who),
      status: agreed ? 'agreed' : 'refused',
      job_id: agreed ? jobId : null,
      terms_json: JSON.stringify(terms),
      verdict_json: JSON.stringify(verdict),
      buyer_rules_version: buyerRules.version,
      seller_rules_version: sellerRules.version,
      terms_hash: termsHash,
      sig: signature?.signature ?? null,
      key_id: signature?.keyId ?? null,
      run_id: runId,
      // What a company says to the other side must not leak its own limits, whoever wrote the sentence.
      prompt: input.prompt ? scrubNote(input.prompt, secretsOf(side === 'buyer' ? buyerRules.body : sellerRules.body)) : null,
      created_at: now,
    }
    this.repo.insertDeal(row)
    return { status: 201, body: this.view(row, who) }
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

  /** Both parties' deal rules. Private: owner only. */
  rules() {
    const warrant = this.repo.latestWarrant()
    const parties = [...(warrant?.body.clients.map((client) => client.id) ?? []), WARRANT_ID]
    return {
      data: parties.flatMap((partyId) => {
        const latest = this.repo.partyRules(partyId)
        return latest ? [{ partyId, version: latest.version, createdAt: latest.createdAt, origin: latest.origin, ...latest.body }] : []
      }),
    }
  }

  /** The caller's own rules. An agent may read its side's rules and never the other's. */
  rulesFor(who: Principal) {
    const partyId = who.side === 'buyer' ? who.buyerId : WARRANT_ID
    const latest = this.repo.partyRules(partyId)
    if (!latest) throw new Problem(404, 'deal.rules_missing', 'Deal rules are missing', 'No deal rules are set for this party.')
    return { partyId, version: latest.version, origin: latest.origin, ...latest.body }
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
    const byId = new Map(this.rules().data.map((sheet) => [sheet.partyId, sheet]))
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
    const { origin: _ignored, ...fields } = (input as Record<string, unknown>)
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
      ...fields,
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
      this.repo.insertPartyRules(target, version, parsed, now, 'written')
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
    if (who.role === 'owner') return { ...base, verdict, billing: row.status === 'agreed' ? this.billing(row) : null }
    return { ...base, verdict: verdictFor(verdict, who.side), billing: row.status === 'agreed' ? this.billing(row) : null }
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'client'
}
