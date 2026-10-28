import { describe, it, expect } from 'vitest'
import { createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto'
import { migrate, openDatabase, seed } from '../src/db/database'
import { createApp } from '../src/app'
import { LINE_STUDIO_WARRANT, WARRANT_ID } from '../src/domain/schemas'
import { Repo } from '../src/db/repo'

const NOW = new Date('2026-10-28T12:00:00Z')
const KEY = 'test-mandate-key-32chars'

function fromBase64Url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64')
}

describe('Receipt Artifact & Refusal Proof Verification', () => {
  it('mints signed receipt for approved proposal carrying key fingerprint, not raw key', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    seed(db, NOW)

    new Repo(db).insertWarrant(WARRANT_ID, 2, {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
      autoSettleUnderCents: 5000,
      frictionBudget: { modelFloor: 'auto' }, // Allow AUTO for test
    }, NOW.toISOString())

    const app = createApp({
      db,
      paypal: null,
      now: () => NOW,
      config: { apiKey: KEY, proposerKey: 'test_proposer', rateLimitPerMinute: 1000, paypalConfigured: false, log: false, publicUrl: 'http://localhost:3000' },
    })

    // Create AUTO proposal ($15)
    const createRes = await app.request('/v1/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        kind: 'payment',
        payee: 'Priya Shah',
        amountCents: 1500,
        currency: 'USD',
        category: 'design',
        description: 'Auto settled task',
        evidenceUrl: 'https://example.com/asset.png',
      }),
    })
    expect(createRes.status).toBe(201)
    const proposal = await createRes.json() as any
    expect(proposal.gate).toBe('AUTO')

    // Fetch receipt artifact
    const receiptRes = await app.request(`/v1/proposals/${proposal.id}/receipt`, {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(receiptRes.status).toBe(200)
    const receipt = await receiptRes.json() as any
    expect(receipt.format).toBe('mandate.receipt.v1')
    expect(receipt.lockKeyId).toBeDefined()
    expect(receipt.lockKeyId.length).toBe(16)
    // Key MUST NOT be embedded in the receipt
    expect((receipt as any).publicKeyPem).toBeUndefined()
    expect(receipt.publicKeysUrl).toBe('http://localhost:3000/.well-known/mandate-keys.json')

    // Verify signature using the key from the well-known keys endpoint
    const keysRes = await app.request('/.well-known/mandate-keys.json')
    const keysData = await keysRes.json() as any
    const pubKey = keysData.data.find((k: any) => k.keyId === receipt.lockKeyId)
    expect(pubKey).toBeDefined()

    const verified = cryptoVerify(
      null,
      Buffer.from(receipt.lockMessage, 'utf8'),
      createPublicKey(pubKey.publicKeyPem),
      fromBase64Url(receipt.lockSignature),
    )
    expect(verified).toBe(true)
  })

  it('mints signed refusal receipt when proposal is DENIED', async () => {
    const db = openDatabase(':memory:')
    migrate(db)
    seed(db, NOW)

    new Repo(db).insertWarrant(WARRANT_ID, 2, {
      ...LINE_STUDIO_WARRANT,
      fundingRequired: false,
    }, NOW.toISOString())

    const app = createApp({
      db,
      paypal: null,
      now: () => NOW,
      config: { apiKey: KEY, proposerKey: 'test_proposer', rateLimitPerMinute: 1000, paypalConfigured: false, log: false, publicUrl: 'http://localhost:3000' },
    })

    // Submit invalid payee (stranger) -> DENY
    const createRes = await app.request('/v1/proposals', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({
        kind: 'payment',
        payee: 'Mallory Hacker',
        amountCents: 5000,
        currency: 'USD',
        category: 'design',
        description: 'Unauthorized drain attempt',
        evidenceUrl: 'https://example.com/fake.png',
      }),
    })
    expect(createRes.status).toBe(201)
    const denied = await createRes.json() as any
    expect(denied.gate).toBe('DENY')

    // Fetch refusal receipt
    const refusalRes = await app.request(`/v1/proposals/${denied.id}/refusal-receipt`, {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(refusalRes.status).toBe(200)
    const refusal = await refusalRes.json() as any
    expect(refusal.format).toBe('mandate.refusal-receipt.v1')
    expect(refusal.clause).toBe('payee.unknown')
    expect(refusal.rawPayee).toBe('Mallory Hacker')

    // Verify refusal signature
    const keysRes = await app.request('/.well-known/mandate-keys.json')
    const keysData = await keysRes.json() as any
    const pubKey = keysData.data.find((k: any) => k.keyId === refusal.signature.keyId)
    expect(pubKey).toBeDefined()

    const verified = cryptoVerify(
      null,
      Buffer.from(refusal.signedMessage, 'utf8'),
      createPublicKey(pubKey.publicKeyPem),
      fromBase64Url(refusal.signature.signature),
    )
    expect(verified).toBe(true)
  })
})
