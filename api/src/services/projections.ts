import { createHash } from 'node:crypto'
import type { Repo } from '../db/repo'
import { proofHash, type Signer } from '../domain/signing'
import { mintClosedMandate, mintOpenMandate, verifyMandate, CLOSED_MANDATE_VCT, OPEN_MANDATE_VCT } from '../domain/mandate-vc'
import { stableHash } from '../domain/hash'
import { fundedPhase } from '../domain/phases'
import { Problem } from '../http/problem'

/**
 * Projections: read-only artifacts minted from the ledger, each one signed so it can leave the server and still
 * prove itself. Nothing here writes, nothing here calls PayPal, and nothing here decides anything - the gate did
 * that already, and these files carry its answer.
 *
 *   closedMandate  one locked payment, as a verifiable credential (the AP2 "payment mandate" shape)
 *   openMandate    one standing rule, as a verifiable credential (the AP2 "open payment mandate" shape)
 *   verify         check any mandate token against the server's keyring
 *   refusalExport  every refusal in the ledger, signed, as the corpus artifact others can inspect
 */

export class ProjectionService {
  constructor(
    private readonly repo: Repo,
    private readonly signer: Signer,
    private readonly now: () => Date,
  ) {}

  /** The closed mandate for one locked payment. A request the rules refused has no mandate: there is nothing to authorize. */
  closedMandate(proposalId: string) {
    const row = this.repo.proposal(proposalId)
    if (!row) throw new Problem(404, 'proposal.missing', 'No such proposal', 'No request has that id.')
    if (!row.cart_hash) {
      throw new Problem(409, 'mandate.not_locked', 'Not locked yet', 'A mandate exists only for a payment the rules approved and locked. This one has no lock.')
    }
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'The rules this request was judged under are gone.')
    const parties = [...warrant.body.payees, ...warrant.body.clients]
    const party = parties.find((item) => item.id === row.payee_id)
    const payeeEmail = party?.email ?? this.repo.payeeRow(row.payee_id ?? '')?.email ?? 'unknown'
    const askedBy = this.repo.eventsFor(row.id)
      .filter((event) => event.type === 'proposal.created')
      .map((event) => (JSON.parse(event.payload_json) as { actor?: string }).actor)
      .find((actor) => Boolean(actor)) ?? 'unknown'
    const token = mintClosedMandate(this.signer, {
      proposalId: row.id,
      cartHash: row.cart_hash,
      warrantId: row.warrant_id,
      warrantVersion: row.warrant_version,
      kind: row.kind as 'payment' | 'charge' | 'refund',
      payee: { id: row.payee_id ?? 'unknown', displayName: party?.displayName ?? row.payee_id ?? 'unknown', email: payeeEmail },
      amountCents: row.amount_cents,
      currency: row.currency,
      category: row.category,
      evidenceUrl: row.evidence_url,
      evidenceHash: row.evidence_url ? proofHash(row.evidence_url) : null,
      jobId: row.job_id,
      fundingCaptureId: row.funding_capture_id,
      lockKeyId: row.lock_key_id,
      askedBy,
      issuedAtIso: this.now().toISOString(),
    })
    return {
      proposalId: row.id,
      vct: CLOSED_MANDATE_VCT,
      mandate: token,
      cartHash: row.cart_hash,
      signed: fundedPhase(row.phase) ? 'the payment this authorizes has settled' : 'the payment this authorizes is locked, not yet paid',
      verify: 'POST the token to /v1/mandates/verify, or check it at /app/verify with the public keys at /.well-known/mandate-keys.json',
    }
  }

  /** The open mandate for one standing rule: whom, from whose money, within which share and cap, signed once. */
  openMandate(ruleId: string) {
    const warrant = this.repo.latestWarrant()
    if (!warrant) throw new Problem(404, 'warrant.missing', 'Warrant is missing', 'No rules have been written.')
    const rule = warrant.body.standing.find((item) => item.id === ruleId)
    if (!rule) throw new Problem(404, 'standing.unknown', 'No such standing rule', `No standing rule with id ${ruleId} is in the live rules (version ${warrant.version}).`)
    const payee = warrant.body.payees.find((item) => item.id === rule.payeeId)
    const clients = rule.clientIds.map((id) => {
      const client = warrant.body.clients.find((item) => item.id === id)
      return { id, displayName: client?.displayName ?? id }
    })
    const token = mintOpenMandate(this.signer, {
      ruleId: rule.id,
      warrantId: warrant.id,
      warrantVersion: warrant.version,
      payee: { id: rule.payeeId, displayName: payee?.displayName ?? rule.payeeId, email: payee?.email ?? 'unknown' },
      clients,
      requireDeal: rule.requireDeal,
      shareBps: rule.shareBps ?? null,
      contractorShareBps: warrant.body.contractorShareBps,
      monthlyCapCents: warrant.body.monthlyCapCents,
      currency: warrant.body.currency,
      issuedAtIso: this.now().toISOString(),
    })
    return {
      ruleId: rule.id,
      vct: OPEN_MANDATE_VCT,
      mandate: token,
      warrantVersion: warrant.version,
      verify: 'POST the token to /v1/mandates/verify, or check it at /app/verify with the public keys at /.well-known/mandate-keys.json',
    }
  }

  /** Check a mandate token against the server's keyring. Pure checking: no state, no PayPal, no decision. */
  verifyMandate(token: string) {
    const verdict = verifyMandate(token, this.signer)
    if (!verdict.ok) return { ok: false as const, reason: verdict.reason }
    return {
      ok: true as const,
      vct: verdict.payload.vct,
      keyId: verdict.keyId,
      payload: verdict.payload,
      note: verdict.payload.vct === CLOSED_MANDATE_VCT
        ? 'A closed mandate authorizes exactly one payment. Match its sub (the cart hash) against the receipt before trusting it.'
        : 'An open mandate is a standing rule: it authorizes a kind of payout, inside the limits it carries, and every other rule still applies at payment time.',
    }
  }

  /**
   * The refusal corpus, signed. Every ask the rules said no to, with the rule that said it and the server's own
   * sentence - the record that PayPal was never called for any of them. This is the artifact a bank, a client or
   * another agent can inspect without trusting this server: the signature is over the canonical bundle.
   */
  refusalExport() {
    const warrant = this.repo.latestWarrant()
    const parties = [...(warrant?.body.payees ?? []), ...(warrant?.body.clients ?? [])]
    const name = (id: string | null) => parties.find((party) => party.id === id)?.displayName ?? id
    const refusals = this.repo.allProposals()
      .filter((row) => row.gate === 'DENY')
      .map((row) => {
        // The name as it was asked: the warrant's display name for a party on the rules, the raw words otherwise
        // (a refused stranger is not on the rules, so the ledger's own record of the ask is the only name there is).
        const created = this.repo.eventsFor(row.id).find((event) => event.type === 'proposal.created')
        const asked = created ? (JSON.parse(created.payload_json) as { payee?: string }).payee ?? null : null
        return {
          id: row.id,
          at: row.created_at,
          kind: row.kind,
          payeeId: row.payee_id,
          payeeName: name(row.payee_id) ?? asked,
          amountCents: row.amount_cents,
          currency: row.currency,
          category: row.category,
          description: row.description,
          clause: row.clause,
          detail: row.detail,
        }
      })
    const countsByClause: Record<string, number> = {}
    for (const refusal of refusals) countsByClause[refusal.clause] = (countsByClause[refusal.clause] ?? 0) + 1
    const generatedAt = this.now().toISOString()
    const bundle = {
      format: 'mandate.refusals.v1',
      generatedAt,
      warrant: warrant ? { id: warrant.id, version: warrant.version } : null,
      count: refusals.length,
      refusedCents: refusals.reduce((sum, row) => sum + row.amountCents, 0),
      countsByClause,
      refusals,
    }
    const message = `mandate:refusals:v1\n${generatedAt}\n${stableHash(bundle)}`
    const signature = this.signer.sign(message)
    return {
      ...bundle,
      signature: { signature: signature.signature, keyId: signature.keyId, algorithm: signature.algorithm },
      signedMessage: message,
      verify: 'Recompute stableHash of the bundle without the signature fields, hash it, and check the Ed25519 signature with the public keys at /.well-known/mandate-keys.json. /app/verify does this in the browser.',
    }
  }

  /**
   * The full event log, hash-chained and signed.
   *
   * Each entry's hash covers: seq, proposalId, eventType, clause, at, prevHash.
   * Verifying the chain requires recomputing each hash and checking it matches.
   * The bundle is signed so the chain itself is authentic.
   */
  ledgerExport() {
    const events = this.repo.allEvents()
    let prevHash = 'genesis'
    const entries = events.map((event, seq) => {
      const entryFields = {
        seq,
        proposalId: event.proposal_id,
        eventType: event.type,
        clause: event.clause ?? '',
        at: event.created_at,
        prevHash,
      }
      const hash = createHash('sha256').update(JSON.stringify(entryFields)).digest('hex')
      prevHash = hash
      return { ...entryFields, hash }
    })
    const generatedAt = this.now().toISOString()
    const bundle = {
      format: 'mandate.ledger.v1',
      generatedAt,
      count: entries.length,
      entries,
    }
    const message = `mandate:ledger:v1\n${generatedAt}\n${stableHash(bundle)}`
    const signature = this.signer.sign(message)
    return {
      ...bundle,
      signature: { signature: signature.signature, keyId: signature.keyId, algorithm: signature.algorithm },
      signedMessage: message,
      verify: 'Verify bundle signature with /.well-known/mandate-keys.json, then walk entries verifying entry.hash = sha256(JSON.stringify({seq,proposalId,eventType,clause,at,prevHash})).',
    }
  }
}
