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
}

export type Check = { id: 'hash' | 'lock' | 'acceptance'; label: string; ok: boolean; detail: string }

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

export async function verifyReceipt(receipt: Receipt, keys: PublicKey[]): Promise<Verdict> {
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
  if (checks.length === 0) checks.push({ id: 'lock', label: 'Something to check', ok: false, detail: 'This does not look like a Mandate receipt. Paste the JSON from a receipt’s Download button.' })
  return { ok: checks.every((check) => check.ok), checks, recomputed }
}

/** Public keys from `/.well-known/mandate-keys.json`, or from a pasted copy of it. */
export function parseKeys(input: unknown): PublicKey[] {
  const list = Array.isArray(input) ? input : (input as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  return list.filter((item): item is PublicKey => Boolean(item) && typeof item.keyId === 'string' && typeof item.publicKeyBase64Url === 'string')
}
