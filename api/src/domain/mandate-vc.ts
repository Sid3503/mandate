import { Signer } from './signing'

/**
 * The mandate projection: every signed lock and every standing rule, expressed as a verifiable credential.
 *
 * The shape follows the Agent Payments Protocol (AP2) idea of a mandate - a cryptographically signed object that
 * carries exactly what was authorized, so anyone can check it later without asking the server. A closed mandate
 * (one exact payment, minted from a proposal's lock) mirrors AP2's payment mandate; an open mandate (a standing
 * rule: payee, funding clients, share, recurrence through the monthly cap) mirrors AP2's open payment mandate,
 * which is where pre-authorized spend limits live.
 *
 * The token is a compact JWS over EdDSA (Ed25519), signed with the same server key that signs locks, so the same
 * public key at `/.well-known/mandate-keys.json` verifies both. The claims carry a `vct` (verifiable credential
 * type) naming which mandate schema they follow, and `sub` is the cart hash, so a mandate and the receipt it came
 * from cannot be separated. Nothing here ever moves money: minting is a pure projection of data the ledger already
 * holds, and verifying is pure checking.
 *
 * Deliberately not implemented yet (v2): binding the agent's own public key into a `cnf` claim. Agent keys today
 * are opaque bearer tokens with no registered public key, so there is nothing honest to pin. When agent keys gain
 * a registered pubkey, the closed mandate gains `cnf` and AP2's autonomous mode is fully expressed.
 */

export const CLOSED_MANDATE_VCT = 'mandate.payment.closed.1'
export const OPEN_MANDATE_VCT = 'mandate.payment.open.1'

const b64u = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')
const fromB64u = (value: string): string => Buffer.from(value, 'base64url').toString('utf8')

export type ClosedMandateInput = {
  proposalId: string
  cartHash: string
  warrantId: string
  warrantVersion: number
  kind: 'payment' | 'charge' | 'refund'
  payee: { id: string; displayName: string; email: string }
  amountCents: number
  currency: string
  category: string | null
  evidenceUrl: string | null
  evidenceHash: string | null
  jobId: string | null
  fundingCaptureId: string | null
  lockKeyId: string | null
  /** How the request was filed, from the ledger's own record of who asked. */
  askedBy: string
  issuedAtIso: string
}

export type OpenMandateInput = {
  ruleId: string
  warrantId: string
  warrantVersion: number
  payee: { id: string; displayName: string; email: string }
  /** The client payments that may fund it, with their display names. */
  clients: Array<{ id: string; displayName: string }>
  requireDeal: boolean
  shareBps: number | null
  contractorShareBps: number
  monthlyCapCents: number
  currency: string
  issuedAtIso: string
}

export type DecodedMandate = { header: Record<string, unknown>; payload: Record<string, unknown> }

export type MandateVerdict =
  | { ok: true; payload: Record<string, unknown>; keyId: string }
  | { ok: false; reason: string }

function signingInputOf(header: Record<string, unknown>, payload: Record<string, unknown>): string {
  return `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`
}

function mint(signer: Signer, header: Record<string, unknown>, payload: Record<string, unknown>): string {
  const signingInput = signingInputOf(header, payload)
  const signature = signer.sign(signingInput)
  return `${signingInput}.${signature.signature}`
}

/** A closed mandate: this exact payment, locked and signed, and nothing else. */
export function mintClosedMandate(signer: Signer, input: ClosedMandateInput): string {
  const payload: Record<string, unknown> = {
    vct: CLOSED_MANDATE_VCT,
    iss: 'mandate',
    iat: Math.floor(Date.parse(input.issuedAtIso) / 1000),
    jti: input.proposalId,
    sub: input.cartHash,
    payee: input.payee,
    kind: input.kind,
    amountCents: input.amountCents,
    currency: input.currency,
    ...(input.category ? { category: input.category } : {}),
    ...(input.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
    ...(input.evidenceHash ? { evidenceHash: input.evidenceHash } : {}),
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.fundingCaptureId ? { fundingCaptureId: input.fundingCaptureId } : {}),
    warrant: { id: input.warrantId, version: input.warrantVersion },
    lock: { hash: input.cartHash, keyId: input.lockKeyId },
    askedBy: input.askedBy,
    ap2: { role: 'payment_mandate', form: 'closed' },
  }
  return mint(signer, { alg: 'EdDSA', typ: 'JWT', kid: signer.keyId }, payload)
}

/** An open mandate: a standing rule the owner signed once - whom, from whose money, within which share and cap. */
export function mintOpenMandate(signer: Signer, input: OpenMandateInput): string {
  const payload: Record<string, unknown> = {
    vct: OPEN_MANDATE_VCT,
    iss: 'mandate',
    iat: Math.floor(Date.parse(input.issuedAtIso) / 1000),
    jti: `${input.warrantId}:${input.warrantVersion}:${input.ruleId}`,
    payee: input.payee,
    funding: {
      clients: input.clients,
      requireDeal: input.requireDeal,
    },
    limits: {
      shareBps: input.shareBps ?? input.contractorShareBps,
      contractorShareBps: input.contractorShareBps,
      monthlyCapCents: input.monthlyCapCents,
      currency: input.currency,
    },
    warrant: { id: input.warrantId, version: input.warrantVersion },
    ap2: { role: 'payment_mandate', form: 'open' },
  }
  return mint(signer, { alg: 'EdDSA', typ: 'JWT', kid: signer.keyId }, payload)
}

/** Decode without verifying. For showing the claims; never for trusting them. */
export function decodeMandate(token: string): DecodedMandate | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [head, body, signature] = parts as [string, string, string]
  try {
    const header = JSON.parse(fromB64u(head)) as Record<string, unknown>
    const payload = JSON.parse(fromB64u(body)) as Record<string, unknown>
    return { header, payload }
  } catch {
    return null
  }
}

/** Verify a mandate against the server's keyring: same key that signs locks, historical keys included. */
export function verifyMandate(token: string, signer: Signer): MandateVerdict {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'not a compact JWS' }
  const decoded = decodeMandate(token)
  if (!decoded) return { ok: false, reason: 'header or payload is not valid JSON' }
  const header = decoded.header
  if (header.alg !== 'EdDSA') return { ok: false, reason: `unexpected alg ${String(header.alg)}` }
  if (typeof header.kid !== 'string') return { ok: false, reason: 'header has no kid' }
  const vct = decoded.payload.vct
  if (vct !== CLOSED_MANDATE_VCT && vct !== OPEN_MANDATE_VCT) return { ok: false, reason: `unknown vct ${String(vct)}` }
  const signature = parts[2]
  if (!signer.verify(parts[0] + '.' + parts[1], signature, header.kid)) {
    return { ok: false, reason: 'signature does not verify against any known server key' }
  }
  return { ok: true, payload: decoded.payload, keyId: header.kid }
}
