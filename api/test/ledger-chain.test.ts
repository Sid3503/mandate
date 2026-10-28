import { describe, it, expect } from 'vitest'
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto'
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

describe('Hash-Chained Ledger Export & Integrity Verification', () => {
  it('generates a valid hash-chained export with authentic Ed25519 signature', async () => {
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

    // Create 3 proposals to build up an event chain
    for (let i = 1; i <= 3; i++) {
      const pRes = await app.request('/v1/proposals', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${KEY}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body: JSON.stringify({
          kind: 'payment',
          payee: 'Priya Shah',
          amountCents: 1000 * i,
          currency: 'USD',
          category: 'design',
          description: `Deliverable milestone #${i}`,
          evidenceUrl: `https://example.com/item-${i}.png`,
        }),
      })
      expect(pRes.status).toBe(201)
    }

    // Export the hash chain
    const res = await app.request('/v1/ledger/export', {
      headers: { authorization: `Bearer ${KEY}` },
    })
    expect(res.status).toBe(200)
    const exportBundle = await res.json() as any
    expect(exportBundle.format).toBe('mandate.ledger.v1')
    expect(exportBundle.entries.length).toBeGreaterThanOrEqual(3)

    // Fetch public keys
    const keysRes = await app.request('/.well-known/mandate-keys.json')
    expect(keysRes.status).toBe(200)
    const keysData = await keysRes.json() as any
    const pubKeyInfo = keysData.data.find((k: any) => k.keyId === exportBundle.signature.keyId)
    expect(pubKeyInfo).toBeDefined()

    // Verify Ed25519 signature on the bundle
    const key = createPublicKey(pubKeyInfo.publicKeyPem)
    const sigVerified = cryptoVerify(
      null,
      Buffer.from(exportBundle.signedMessage, 'utf8'),
      key,
      fromBase64Url(exportBundle.signature.signature),
    )
    expect(sigVerified).toBe(true)

    // Verify cryptographic hash chain integrity
    let prevHash = 'genesis'
    for (const entry of exportBundle.entries) {
      expect(entry.prevHash).toBe(prevHash)
      const expectedHash = createHash('sha256').update(JSON.stringify({
        seq: entry.seq,
        proposalId: entry.proposalId,
        eventType: entry.eventType,
        clause: entry.clause,
        at: entry.at,
        prevHash,
      })).digest('hex')
      expect(entry.hash).toBe(expectedHash)
      prevHash = entry.hash
    }
  })

  it('detects tampered entry in the hash chain', async () => {
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

    const pRes = await app.request('/v1/proposals', {
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
        description: 'Design mockups',
        evidenceUrl: 'https://example.com/logo.png',
      }),
    })
    expect(pRes.status).toBe(201)

    const res = await app.request('/v1/ledger/export', { headers: { authorization: `Bearer ${KEY}` } })
    const exportBundle = await res.json() as any

    // Tamper with one entry
    exportBundle.entries[0].clause = 'fake.clause'

    // Walk chain and verify tampering is detected
    let prevHash = 'genesis'
    let brokenAt = -1
    for (const entry of exportBundle.entries) {
      const expectedHash = createHash('sha256').update(JSON.stringify({
        seq: entry.seq,
        proposalId: entry.proposalId,
        eventType: entry.eventType,
        clause: entry.clause,
        at: entry.at,
        prevHash,
      })).digest('hex')
      if (entry.hash !== expectedHash) {
        brokenAt = entry.seq
        break
      }
      prevHash = entry.hash
    }

    expect(brokenAt).toBe(0)
  })
})
