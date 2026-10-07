import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Ed25519 signatures over locks and agreed deals.
 *
 * A hash alone proves nothing about who made it: anyone who can write the database can change the cents and
 * recompute the hash. A signature needs the server's private key, which is not in the database. Capture refuses
 * any lock whose signature does not verify, so editing a row after approval cannot make PayPal move other money.
 *
 * Messages are domain-separated (`mandate:lock:v1`, `mandate:deal:v1`) so a signature made for one purpose can
 * never be replayed as another. Every signature carries the id of the key that made it, and every public key the
 * server has ever used stays verifiable, so rotating the key does not invalidate history.
 */

export type Signature = { signature: string; keyId: string; algorithm: 'ed25519' }

export type PublicKeyInfo = { keyId: string; algorithm: 'ed25519'; publicKeyPem: string; publicKeyBase64Url: string; current: boolean }

export class Signer {
  readonly keyId: string
  private readonly privateKey: KeyObject
  private readonly keyring = new Map<string, KeyObject>()

  constructor(privateKey: KeyObject, previousPublicPems: string[] = []) {
    this.privateKey = privateKey
    const current = createPublicKey(privateKey)
    this.keyId = keyIdOf(current)
    this.keyring.set(this.keyId, current)
    for (const pem of previousPublicPems) {
      const key = createPublicKey(pem)
      this.keyring.set(keyIdOf(key), key)
    }
  }

  sign(message: string): Signature {
    return { signature: sign(null, Buffer.from(message, 'utf8'), this.privateKey).toString('base64url'), keyId: this.keyId, algorithm: 'ed25519' }
  }

  /** True only when the named key is known and the signature is valid for exactly this message. */
  verify(message: string, signature: string | null | undefined, keyId: string | null | undefined): boolean {
    if (!signature || !keyId) return false
    const key = this.keyring.get(keyId)
    if (!key) return false
    try {
      return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'))
    } catch {
      return false
    }
  }

  addPublicKey(pem: string): void {
    const key = createPublicKey(pem)
    this.keyring.set(keyIdOf(key), key)
  }

  publicKeys(): PublicKeyInfo[] {
    return [...this.keyring.entries()].map(([keyId, key]) => ({
      keyId,
      algorithm: 'ed25519' as const,
      publicKeyPem: key.export({ type: 'spki', format: 'pem' }).toString(),
      publicKeyBase64Url: (key.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64url'),
      current: keyId === this.keyId,
    }))
  }
}

function keyIdOf(publicKey: KeyObject): string {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
}

export const lockMessage = (proposalId: string, cartHash: string) => `mandate:lock:v1\n${proposalId}\n${cartHash}`
/** What the client's acceptance signs: this delivery, of this milestone of this deal, with exactly this proof, decided this way. */
export const acceptanceMessage = (row: { id: string; deal_id: string; milestone: number; proof_hash: string; status: string }) =>
  `mandate:accept:v1\n${row.id}\n${row.deal_id}\n${row.milestone}\n${row.proof_hash}\n${row.status}`
export const proofHash = (url: string) => createHash('sha256').update(url.trim()).digest('hex')
export const dealMessage = (dealId: string, termsHash: string) => `mandate:deal:v1\n${dealId}\n${termsHash}`

export function ephemeralSigner(): Signer {
  return new Signer(generateKeyPairSync('ed25519').privateKey)
}

/**
 * Production: SIGNING_KEY is a PKCS8 PEM (base64 of the PEM is also accepted, for hosts that dislike newlines).
 * Development: a key is created once and kept beside the database, so receipts stay verifiable across restarts.
 */
export function loadSigner(options: { pem?: string; previousPublicPems?: string[]; devKeyPath?: string | null; production: boolean }): Signer {
  if (options.pem) return new Signer(createPrivateKey(normalisePem(options.pem)), options.previousPublicPems)
  if (options.production) throw new Error('SIGNING_KEY (an Ed25519 private key in PKCS8 PEM) is required in production')
  const path = options.devKeyPath
  if (!path) return ephemeralSigner()
  if (existsSync(path)) return new Signer(createPrivateKey(readFileSync(path, 'utf8')), options.previousPublicPems)
  const { privateKey } = generateKeyPairSync('ed25519')
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return new Signer(privateKey, options.previousPublicPems)
}

function normalisePem(value: string): string {
  const trimmed = value.trim()
  if (trimmed.includes('BEGIN')) return trimmed.replaceAll('\\n', '\n')
  return Buffer.from(trimmed, 'base64').toString('utf8')
}
