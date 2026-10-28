import { createHash } from 'node:crypto'
import type { Repo } from '../db/repo'
import { lockMessage, type Signer } from '../domain/signing'
import { Problem } from '../http/problem'
import { fundedPhase } from '../domain/phases'

/**
 * ReceiptService: mints the one artifact that leaves the server and travels with the payment.
 *
 * Design rule: the receipt carries only the key FINGERPRINT (lockKeyId), never the public key itself.
 * Anyone who embeds the public key in the receipt can re-sign a tampered version with their own key
 * and embed theirs. The fingerprint is meaningless without the canonical key at /.well-known/mandate-keys.json,
 * which is the single source of truth. The verifier fetches the key from there, matches fingerprints,
 * and only then checks the signature — so the trust anchor is always external to the artifact.
 *
 * Two artifact types:
 *   mandate.receipt.v1       — a locked (approved) payment, with Ed25519 lock signature verifiable offline
 *   mandate.refusal-receipt.v1 — a DENY decision, signed so the refusal itself is provable and exportable
 */

export type ReceiptArtifact = {
  format: 'mandate.receipt.v1'
  proposalId: string
  /** sha256 of the canonical cart JSON. The lock signature is over mandate:lock:v1\n{proposalId}\n{cartHash} */
  cartHash: string
  /** 16-char hex fingerprint of the signing key's DER public key. Match against /.well-known/mandate-keys.json. */
  lockKeyId: string
  /** base64url Ed25519 signature over lockMessage. Verify with the key at publicKeysUrl, not from this document. */
  lockSignature: string
  /** The exact string that was signed. Recompute as: "mandate:lock:v1\n{proposalId}\n{cartHash}" */
  lockMessage: string
  issuedAt: string
  payee: { id: string; displayName: string; email: string }
  amountCents: number
  currency: string
  category: string | null
  gate: 'AUTO' | 'NEEDS_APPROVAL'
  clause: string
  detail: string
  /** URL to open the interactive verifier in a browser. Fetches the key from publicKeysUrl automatically. */
  verifyUrl: string
  /** URL of the public key set. Download this and match lockKeyId to verify completely offline. */
  publicKeysUrl: string
}

export type RefusalReceiptArtifact = {
  format: 'mandate.refusal-receipt.v1'
  proposalId: string
  refusedAt: string
  clause: string
  detail: string
  amountCents: number
  currency: string
  payee: { id: string; displayName: string; email: string } | null
  rawPayee: string | null
  /** The exact string that was signed. Verify with the key at publicKeysUrl. */
  signedMessage: string
  signature: { signature: string; keyId: string; algorithm: 'ed25519' }
  /** URL of the public key set. The keyId in signature.keyId must be among them. */
  publicKeysUrl: string
  verifyUrl: string
}

export class ReceiptService {
  constructor(
    private readonly repo: Repo,
    private readonly signer: Signer,
    private readonly now: () => Date,
    private readonly publicUrl: string,
  ) {}

  /**
   * The signed receipt for one locked payment.
   * Only locked proposals (AUTO or approved NEEDS_APPROVAL) have a receipt.
   * A DENY proposal has a refusal receipt instead — use refusalReceipt().
   */
  receiptArtifact(proposalId: string): ReceiptArtifact {
    const row = this.repo.proposal(proposalId)
    if (!row) throw new Problem(404, 'proposal.missing', 'No such proposal', 'No request has that id.')
    if (row.gate === 'DENY' || row.phase === 'denied') {
      throw new Problem(409, 'receipt.denied', 'No receipt for a refused request',
        'This request was refused by the rules. Use GET /v1/proposals/:id/refusal-receipt for a signed proof of the refusal.')
    }
    if (!row.cart_hash || !row.lock_sig || !row.lock_key_id) {
      throw new Problem(409, 'receipt.not_locked', 'Not locked yet',
        'A receipt is only issued for a payment the rules have approved and locked. This one is still pending approval.')
    }
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    const parties = [...(warrant?.body.payees ?? []), ...(warrant?.body.clients ?? [])]
    const party = parties.find((p) => p.id === row.payee_id)
    const payeeEmail = party?.email ?? this.repo.payeeRow(row.payee_id ?? '')?.email ?? 'unknown'
    const msg = lockMessage(row.id, row.cart_hash)
    return {
      format: 'mandate.receipt.v1',
      proposalId: row.id,
      cartHash: row.cart_hash,
      lockKeyId: row.lock_key_id,
      lockSignature: row.lock_sig,
      lockMessage: msg,
      issuedAt: this.now().toISOString(),
      payee: {
        id: row.payee_id ?? 'unknown',
        displayName: party?.displayName ?? row.payee_id ?? 'unknown',
        email: payeeEmail,
      },
      amountCents: row.amount_cents,
      currency: row.currency,
      category: row.category,
      gate: row.gate as 'AUTO' | 'NEEDS_APPROVAL',
      clause: row.clause,
      detail: row.detail,
      verifyUrl: `${this.publicUrl}/app/verify?proposal=${row.id}`,
      publicKeysUrl: `${this.publicUrl}/.well-known/mandate-keys.json`,
    }
  }

  /**
   * A signed proof that this proposal was refused. The signature is over:
   *   mandate:refusal:v1\n{proposalId}\n{clause}\n{refusedAt}
   * Anyone with the public key can verify it without asking this server.
   *
   * Why sign refusals? A "refused asks this period" metric backed by verifiable artifacts is
   * more valuable than a log entry: a CFO or counterparty can audit it without trusting the server.
   */
  refusalReceipt(proposalId: string): RefusalReceiptArtifact {
    const row = this.repo.proposal(proposalId)
    if (!row) throw new Problem(404, 'proposal.missing', 'No such proposal', 'No request has that id.')
    if (row.gate !== 'DENY') {
      throw new Problem(409, 'refusal_receipt.not_denied', 'Not a refusal',
        'A refusal receipt is only issued for a request the rules denied. This one was not.')
    }
    const warrant = this.repo.warrant(row.warrant_id, row.warrant_version)
    const parties = [...(warrant?.body.payees ?? []), ...(warrant?.body.clients ?? [])]
    const party = row.payee_id ? parties.find((p) => p.id === row.payee_id) : null
    const created = this.repo.eventsFor(row.id).find((e) => e.type === 'proposal.created')
    const rawPayee = created ? (JSON.parse(created.payload_json) as { payee?: string }).payee ?? null : null
    const refusedAt = row.created_at
    const signedMessage = `mandate:refusal:v1\n${row.id}\n${row.clause}\n${refusedAt}`
    const sig = this.signer.sign(signedMessage)
    const payeeEmail = party?.email ?? (row.payee_id ? this.repo.payeeRow(row.payee_id)?.email ?? 'unknown' : 'unknown')
    return {
      format: 'mandate.refusal-receipt.v1',
      proposalId: row.id,
      refusedAt,
      clause: row.clause,
      detail: row.detail,
      amountCents: row.amount_cents,
      currency: row.currency,
      payee: party ? { id: party.id, displayName: party.displayName, email: payeeEmail } : null,
      rawPayee,
      signedMessage,
      signature: { signature: sig.signature, keyId: sig.keyId, algorithm: sig.algorithm },
      publicKeysUrl: `${this.publicUrl}/.well-known/mandate-keys.json`,
      verifyUrl: `${this.publicUrl}/app/verify?proposal=${row.id}`,
    }
  }
}

