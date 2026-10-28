/**
 * Checks a Mandate receipt without asking Mandate.
 *
 * Everything here runs in the browser (or any JavaScript runtime with WebCrypto). It needs two things: the receipt,
 * and the server's public keys. It recomputes the lock from the fields on the receipt, checks the signature with
 * the key the receipt names, and does the same for the client's signed acceptance of a delivery. It is deliberately
 * small, so a person can read all of it. It must stay byte-for-byte compatible with api/src/domain/hash.ts and
 * api/src/domain/signing.ts; api/test/verify.test.ts runs this file against real receipts to make sure it does.
 */

export type PublicKey = { keyId: string; publicKeyBase64Url: string }

export type Receipt = {
  proposal?: Record<string, unknown>
  lock?: { hash?: string | null; signature?: string | null; keyId?: string | null } | null
  acceptance?: {
    id: string
    dealId: string
    milestone: number
    proofUrl: string
    status: string
    signature: string | null
    keyId: string | null
  } | null
  approval?: { payload?: PasskeyMaterial } | null
}

export type Check = { id: 'hash' | 'lock' | 'acceptance' | 'passkey' | 'mandate'; label: string; ok: boolean; detail: string }

export type PasskeyMaterial = {
  method?: string
  fingerprint?: string
  rpId?: string
  origin?: string
  challenge?: string
  publicKey?: { kty?: string; crv?: string; alg?: number; x?: string; y?: string }
  assertion?: { type?: string; response?: { authenticatorData?: string; clientDataJSON?: string; signature?: string } }
}

export type Verdict = { ok: boolean; checks: Check[]; recomputed: string | null }

const encoder = new TextEncoder()

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)))

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The same canonical text the server hashes. Key order matters; it is part of the format. */
export function canonicalCart(p: Record<string, unknown>): string {
  const jobId = (p.jobId as string | null | undefined) ?? null
  const fundingCaptureId = (p.fundingCaptureId as string | null | undefined) ?? null
  const base = {
    proposalId: p.id,
    warrantId: p.warrantId,
    warrantVersion: p.warrantVersion,
    payeeId: p.payeeId,
    amountCents: p.amountCents,
    currency: p.currency,
    category: p.category,
    evidenceUrl: p.evidenceUrl,
    kind: p.kind,
    parentCaptureId: (p.parentCaptureId as string | null | undefined) ?? null,
  }
  if (p.dealId) return JSON.stringify({ v: 3, ...base, jobId, fundingCaptureId, dealId: p.dealId, milestone: (p.milestone as number | null | undefined) ?? null })
  if (jobId !== null || fundingCaptureId !== null || p.kind === 'charge') return JSON.stringify({ v: 2, ...base, jobId, fundingCaptureId })
  return JSON.stringify({ v: 1, ...base })
}

export const lockMessage = (proposalId: string, cartHash: string) => `mandate:lock:v1\n${proposalId}\n${cartHash}`

export const acceptanceMessage = (row: { id: string; dealId: string; milestone: number; proofHash: string; status: string }) =>
  `mandate:accept:v1\n${row.id}\n${row.dealId}\n${row.milestone}\n${row.proofHash}\n${row.status}`

async function verifyEd25519(message: string, signature: string | null | undefined, keyId: string | null | undefined, keys: PublicKey[]): Promise<{ ok: boolean; detail: string }> {
  if (!signature || !keyId) return { ok: false, detail: 'There is no signature on this.' }
  const known = keys.find((key) => key.keyId === keyId)
  if (!known) return { ok: false, detail: `The receipt names key ${keyId}, which is not among the public keys you gave. Nothing can be said about it.` }
  try {
    const key = await crypto.subtle.importKey('raw', fromBase64Url(known.publicKeyBase64Url), { name: 'Ed25519' }, false, ['verify'])
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, fromBase64Url(signature), encoder.encode(message))
    return ok ? { ok, detail: `Signed by key ${keyId}.` } : { ok, detail: `The signature does not match the message under key ${keyId}. Something was changed after it was signed.` }
  } catch {
    return { ok: false, detail: 'This browser cannot check Ed25519 signatures. Use a current Chrome, Edge, Safari or Firefox.' }
  }
}

/** DER SEQUENCE of two INTEGERs becomes the 32-byte r || s WebCrypto expects. A 64-byte signature is already raw. */
export function derToRaw(signature: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (signature.length === 64) return copyBytes(signature)
  const sequenceLength = signature[1]
  if (signature[0] !== 0x30 || sequenceLength === undefined || signature.length < 8) return null
  let offset = 2
  if ((sequenceLength & 0x80) !== 0) return null
  const read = (): Uint8Array | null => {
    if (signature[offset] !== 0x02) return null
    const length = signature[offset + 1]
    if (length === undefined) return null
    offset += 2
    const bytes = signature.slice(offset, offset + length)
    offset += length
    if (bytes.length < 32) {
      const padded = new Uint8Array(new ArrayBuffer(32))
      padded.set(bytes, 32 - bytes.length)
      return padded
    }
    if (bytes.length === 32) return bytes
    const lead = bytes[0]
    const high = bytes[1]
    if (bytes.length === 33 && lead === 0 && high !== undefined && (high & 0x80) === 0x80) return bytes.slice(1)
    return null
  }
  const r = read()
  const s = read()
  if (!r || !s) return null
  const raw = new Uint8Array(new ArrayBuffer(64))
  raw.set(r, 0)
  raw.set(s, 32)
  return raw
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0)
  return diff === 0
}

/**
 * Checks the passkey assertion on a receipt. An algorithm other than ES256 is "cannot verify here" and is never called valid.
 * The success words are "valid signature by this key". They name the fingerprint, the RP ID, and the origin.
 */
export async function verifyPasskey(material: PasskeyMaterial, typedFingerprint = ''): Promise<Check> {
  const label = 'The passkey signature'
  const cannot = (detail = 'cannot verify here'): Check => ({ id: 'passkey', label, ok: false, detail })
  const key = material.publicKey
  if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || key.alg !== -7 || !key.x || !key.y) return cannot()
  const response = material.assertion?.response
  if (!response?.authenticatorData || !response.clientDataJSON || !response.signature) return cannot('The passkey signature is missing.')
  if (!material.rpId || !material.origin || !material.challenge) return cannot('The receipt does not name the site this signature was for.')
  let authData: Uint8Array<ArrayBuffer>
  let clientBytes: Uint8Array<ArrayBuffer>
  let signature: Uint8Array<ArrayBuffer>
  try {
    authData = fromBase64Url(response.authenticatorData)
    clientBytes = fromBase64Url(response.clientDataJSON)
    signature = fromBase64Url(response.signature)
  } catch {
    return cannot()
  }
  if (authData.length < 37) return cannot('The authenticator data is too short.')
  const flags = authData[32] ?? 0
  if ((flags & 0x01) === 0) return cannot('The user-presence flag is off.')
  if ((flags & 0x04) === 0) return cannot('The user-verification flag is off.')
  const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(material.rpId)))
  if (!sameBytes(authData.slice(0, 32), rpHash)) return cannot(`The relying party hash does not match ${material.rpId}.`)
  let client: { type?: string; challenge?: string; origin?: string }
  try {
    client = JSON.parse(new TextDecoder().decode(clientBytes)) as { type?: string; challenge?: string; origin?: string }
  } catch {
    return cannot()
  }
  if (client.type !== 'webauthn.get') return cannot('The signature type is not a login assertion.')
  if (client.challenge !== material.challenge) return cannot('The challenge does not match the one on the receipt.')
  if (client.origin !== material.origin) return cannot(`The origin does not match ${material.origin}.`)
  const raw = derToRaw(signature)
  if (!raw) return cannot()
  const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientBytes))
  const signed = new Uint8Array(new ArrayBuffer(authData.length + clientHash.length))
  signed.set(authData, 0)
  signed.set(clientHash, authData.length)
  try {
    const cryptoKey = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, raw, signed)
    if (!ok) return cannot('The signature does not match this key.')
  } catch {
    return cannot()
  }
  const fingerprint = material.fingerprint ?? ''
  const typed = typedFingerprint.trim().toLowerCase()
  if (typed && typed !== fingerprint.toLowerCase()) return cannot('The signature is by a different key than the fingerprint you typed.')
  const matched = typed ? ' It matches the fingerprint you typed.' : ''
  return {
    id: 'passkey',
    label,
    ok: true,
    detail: `valid signature by this key. Fingerprint ${fingerprint}. RP ID ${material.rpId}. Origin ${material.origin}.${matched}`,
  }
}

export async function verifyReceipt(receipt: Receipt, keys: PublicKey[], options: { fingerprint?: string } = {}): Promise<Verdict> {
  const checks: Check[] = []
  let recomputed: string | null = null
  const proposal = receipt.proposal
  const lock = receipt.lock
  if (proposal && lock?.hash) {
    recomputed = await sha256(canonicalCart(proposal))
    const same = recomputed === lock.hash
    checks.push({ id: 'hash', label: 'The request on this receipt is the one that was locked', ok: same, detail: same ? 'Recomputing the lock from the fields gives the same hash.' : 'Recomputing the lock from the fields gives a different hash, so the request was changed after it was locked.' })
    const signed = await verifyEd25519(lockMessage(String(proposal.id), lock.hash), lock.signature, lock.keyId, keys)
    checks.push({ id: 'lock', label: 'The lock was signed by the server', ok: signed.ok, detail: signed.detail })
  } else if (proposal) {
    checks.push({ id: 'lock', label: 'The lock was signed by the server', ok: false, detail: 'This request was never locked, so there is no signature to check (a refused or pending request has none).' })
  }
  const acceptance = receipt.acceptance
  if (acceptance) {
    const signed = await verifyEd25519(acceptanceMessage({ id: acceptance.id, dealId: acceptance.dealId, milestone: acceptance.milestone, proofHash: await sha256(acceptance.proofUrl.trim()), status: acceptance.status }), acceptance.signature, acceptance.keyId, keys)
    const linked = !proposal || String(proposal.evidenceUrl ?? '').trim() === acceptance.proofUrl.trim()
    checks.push({
      id: 'acceptance',
      label: `The client’s ${acceptance.status === 'rejected' ? 'rejection' : 'acceptance'} is signed, for exactly the proof that was billed`,
      ok: signed.ok && linked,
      detail: !linked ? 'The client accepted a different proof link than the one on this receipt.' : signed.detail,
    })
  }
  const passkey = receipt.approval?.payload
  if (passkey && (passkey.method === 'passkey' || passkey.assertion)) checks.push(await verifyPasskey(passkey, options.fingerprint))
  if (checks.length === 0) checks.push({ id: 'lock', label: 'Something to check', ok: false, detail: 'This does not look like a Mandate receipt. Paste the JSON from a receipt’s Download button.' })
  return { ok: checks.every((check) => check.ok), checks, recomputed }
}

/** Public keys from `/.well-known/mandate-keys.json`, or from a pasted copy of it. */
export function parseKeys(input: unknown): PublicKey[] {
  const list = Array.isArray(input) ? input : (input as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  return list.filter((item): item is PublicKey => Boolean(item) && typeof item.keyId === 'string' && typeof item.publicKeyBase64Url === 'string')
}

/**
 * Checks a mandate token (a compact JWS over EdDSA) against the public keys, in the browser. A mandate is the
 * signed statement of what was authorized: a closed mandate is one exact locked payment, an open mandate is a
 * standing rule with its limits. The signature is checked the same way as a lock's; the claims are returned so the
 * page can show what the mandate authorizes. This must stay compatible with api/src/domain/mandate-vc.ts.
 */
export type MandateVerdict = { ok: boolean; check: Check; payload: Record<string, unknown> | null }

export const CLOSED_MANDATE_VCT = 'mandate.payment.closed.1'
export const OPEN_MANDATE_VCT = 'mandate.payment.open.1'

export async function verifyMandateToken(token: string, keys: PublicKey[]): Promise<MandateVerdict> {
  const parts = token.trim().split('.')
  if (parts.length !== 3) {
    return { ok: false, payload: null, check: { id: 'mandate', label: 'This is a mandate token', ok: false, detail: 'A mandate is three dot-separated parts (header.payload.signature). This is not one.' } }
  }
  const [head, body, signature] = parts as [string, string, string]
  let header: Record<string, unknown>
  let payload: Record<string, unknown>
  try {
    header = JSON.parse(new TextDecoder().decode(fromBase64Url(head))) as Record<string, unknown>
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as Record<string, unknown>
  } catch {
    return { ok: false, payload: null, check: { id: 'mandate', label: 'This is a mandate token', ok: false, detail: 'The header or payload is not readable JSON.' } }
  }
  if (header.alg !== 'EdDSA') {
    return { ok: false, payload, check: { id: 'mandate', label: 'This is a mandate token', ok: false, detail: `This mandate asks for the ${String(header.alg)} algorithm, and only EdDSA is checked here.` } }
  }
  const vct = payload.vct
  const form = vct === CLOSED_MANDATE_VCT
    ? 'closed mandate (one exact payment)'
    : vct === OPEN_MANDATE_VCT
      ? 'open mandate (a standing rule)'
      : null
  if (!form) {
    return { ok: false, payload, check: { id: 'mandate', label: 'This is a mandate token', ok: false, detail: 'The vct claim does not name a Mandate payment mandate, so this is not one.' } }
  }
  const signed = await verifyEd25519(`${head}.${body}`, signature, typeof header.kid === 'string' ? header.kid : null, keys)
  return {
    ok: signed.ok,
    payload,
    check: { id: 'mandate', label: `The ${form} was signed by the server`, ok: signed.ok, detail: signed.detail },
  }
}
