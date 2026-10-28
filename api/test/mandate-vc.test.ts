import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOSED_MANDATE_VCT, decodeMandate, mintClosedMandate, mintOpenMandate, OPEN_MANDATE_VCT, verifyMandate } from '../src/domain/mandate-vc'
import { ephemeralSigner, proofHash } from '../src/domain/signing'
import { agree, call, closeAll, EVIDENCE, harness, idem, NOW, OWNER_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]

const closedInput = {
  proposalId: 'prop_1',
  cartHash: 'cart_abc',
  warrantId: 'wnt_line_studio',
  warrantVersion: 1,
  kind: 'payment' as const,
  payee: { id: 'payee_priya', displayName: 'Priya Shah', email: 'priya.shah@example.com' },
  amountCents: 1500,
  currency: 'USD',
  category: 'design',
  evidenceUrl: EVIDENCE,
  evidenceHash: proofHash(EVIDENCE),
  jobId: 'job_northwind_logo',
  fundingCaptureId: 'CAP-1',
  lockKeyId: 'k_1',
  askedBy: 'proposer',
  issuedAtIso: NOW.toISOString(),
}

describe('the mandate token itself', () => {
  it('mints a closed mandate that verifies, carrying exactly what was authorized', () => {
    const signer = ephemeralSigner()
    const token = mintClosedMandate(signer, closedInput)
    const verdict = verifyMandate(token, signer)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.payload).toMatchObject({
      vct: CLOSED_MANDATE_VCT,
      iss: 'mandate',
      jti: 'prop_1',
      sub: 'cart_abc',
      kind: 'payment',
      amountCents: 1500,
      currency: 'USD',
      payee: { id: 'payee_priya', email: 'priya.shah@example.com' },
      evidenceHash: proofHash(EVIDENCE),
      warrant: { id: 'wnt_line_studio', version: 1 },
      askedBy: 'proposer',
      ap2: { role: 'payment_mandate', form: 'closed' },
    })
    const decoded = decodeMandate(token)
    expect(decoded?.header).toMatchObject({ alg: 'EdDSA', typ: 'JWT' })
  })

  it('mints an open mandate for a standing rule, with its limits inside', () => {
    const signer = ephemeralSigner()
    const token = mintOpenMandate(signer, {
      ruleId: 'priya_from_northwind',
      warrantId: 'wnt_line_studio',
      warrantVersion: 3,
      payee: { id: 'payee_priya', displayName: 'Priya Shah', email: 'priya.shah@example.com' },
      clients: [{ id: 'client_northwind', displayName: 'Northwind' }],
      requireDeal: true,
      shareBps: 5000,
      contractorShareBps: 6000,
      monthlyCapCents: 18000,
      currency: 'USD',
      issuedAtIso: NOW.toISOString(),
    })
    const verdict = verifyMandate(token, signer)
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.payload).toMatchObject({
      vct: OPEN_MANDATE_VCT,
      jti: 'wnt_line_studio:3:priya_from_northwind',
      payee: { id: 'payee_priya' },
      funding: { clients: [{ id: 'client_northwind' }], requireDeal: true },
      limits: { shareBps: 5000, monthlyCapCents: 18000, currency: 'USD' },
      ap2: { role: 'payment_mandate', form: 'open' },
    })
  })

  it('refuses a tampered payload: editing one cent breaks the signature', () => {
    const signer = ephemeralSigner()
    const token = mintClosedMandate(signer, closedInput)
    const [head, bodyPart, sig] = token.split('.') as [string, string, string]
    const payload = JSON.parse(Buffer.from(bodyPart, 'base64url').toString('utf8')) as Record<string, unknown>
    payload.amountCents = 990_000
    const forged = `${head}.${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${sig}`
    expect(verifyMandate(forged, signer)).toMatchObject({ ok: false, reason: expect.stringContaining('signature') })
  })

  it('refuses a signature from a key the server does not hold', () => {
    const token = mintClosedMandate(ephemeralSigner(), closedInput)
    expect(verifyMandate(token, ephemeralSigner())).toMatchObject({ ok: false })
  })

  it('refuses garbage without pretending to check it', () => {
    const signer = ephemeralSigner()
    expect(verifyMandate('not-a-jws', signer)).toMatchObject({ ok: false, reason: 'not a compact JWS' })
    expect(verifyMandate('a.b.c', signer)).toMatchObject({ ok: false })
    expect(decodeMandate('a.b.c')).toBeNull()
    const token = mintClosedMandate(signer, closedInput)
    const [head, body, sig] = token.split('.') as [string, string, string]
    expect(verifyMandate(`${head}.${body}.${sig}x`, signer)).toMatchObject({ ok: false }) // damaged signature
    const header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) as Record<string, unknown>
    header.alg = 'none'
    const algNone = `${Buffer.from(JSON.stringify(header), 'utf8').toString('base64url')}.${body}.${sig}`
    expect(verifyMandate(algNone, signer)).toMatchObject({ ok: false, reason: expect.stringContaining('alg') })
  })
})

describe('mandates out of the ledger', () => {
  /** The frozen first act: a deal agreed, its first milestone billed, approved, and settled. */
  async function worked() {
    const h = harness()
    const deal = await agree(h.app)
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const chargeId = billed.json.id as string
    await call(h.app, 'POST', `/v1/proposals/${chargeId}/approve`)
    const captured = await call(h.app, 'POST', `/v1/proposals/${chargeId}/capture`)
    return { ...h, deal, chargeId, captureId: captured.json.captureId as string }
  }

  it('mints the closed mandate of a locked payment, and the server verifies its own token', async () => {
    const h = await worked()
    const mandate = await call(h.app, 'GET', `/v1/proposals/${h.chargeId}/mandate`)
    expect(mandate.status).toBe(200)
    expect(mandate.json).toMatchObject({ vct: CLOSED_MANDATE_VCT })
    const checked = await call(h.app, 'POST', '/v1/mandates/verify', { body: { mandate: mandate.json.mandate } })
    expect(checked.json.ok).toBe(true)
    expect(checked.json.payload).toMatchObject({
      vct: CLOSED_MANDATE_VCT,
      sub: mandate.json.cartHash,
      jti: h.chargeId,
      kind: 'charge',
      amountCents: 15000,
      payee: { id: 'client_northwind', displayName: 'Northwind' },
      askedBy: 'owner',
    })
  })

  it('refuses to mint a mandate for a payment the rules have not locked', async () => {
    const h = await worked()
    // A payout still waiting for the owner has no lock, so it has no mandate: nothing has been authorized.
    const payout = await call(h.app, 'POST', '/v1/proposals', {
      idem: idem('mandate'),
      body: { kind: 'payment', payee: 'Priya', amountCents: 9000, currency: 'USD', category: 'design', description: 'northwind milestone 1', evidenceUrl: EVIDENCE, jobId: 'job_northwind_logo', fundingCaptureId: h.captureId },
    })
    const missing = await call(h.app, 'GET', `/v1/proposals/${payout.json.id}/mandate`)
    expect(missing.status).toBe(409)
    expect(missing.json.code).toBe('mandate.not_locked')
    const absent = await call(h.app, 'GET', '/v1/proposals/prop_nope/mandate')
    expect(absent.status).toBe(404)
  })

  it('mints the open mandate of a standing rule, and refuses an unknown one', async () => {
    const h = await worked()
    const rule = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true, shareBps: 5000 }
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, standing: [rule] } })
    const mandate = await call(h.app, 'GET', `/v1/standing/${rule.id}/mandate`)
    expect(mandate.status).toBe(200)
    expect(mandate.json).toMatchObject({ vct: OPEN_MANDATE_VCT, warrantVersion: expect.any(Number) })
    const checked = await call(h.app, 'POST', '/v1/mandates/verify', { body: { mandate: mandate.json.mandate } })
    expect(checked.json.ok).toBe(true)
    expect(checked.json.payload).toMatchObject({
      vct: OPEN_MANDATE_VCT,
      payee: { id: 'payee_priya', displayName: 'Priya Shah' },
      funding: { clients: [{ id: 'client_northwind', displayName: 'Northwind' }], requireDeal: true },
      limits: { shareBps: 5000, monthlyCapCents: 18000, currency: 'USD' },
    })
    const unknown = await call(h.app, 'GET', '/v1/standing/no_such_rule/mandate')
    expect(unknown.status).toBe(404)
    expect(unknown.json.code).toBe('standing.unknown')
  })

  it('verifies nothing when the body carries no mandate', async () => {
    const h = harness()
    const empty = await call(h.app, 'POST', '/v1/mandates/verify', { body: {} })
    expect(empty.status).toBe(400)
    expect(empty.json.code).toBe('mandate.missing')
    const broken = await call(h.app, 'POST', '/v1/mandates/verify', { body: { mandate: 'garbage' } })
    expect(broken.json).toMatchObject({ ok: false })
  })
})

describe('the refusal export', () => {
  it('lists every refusal with the rule that said it, and signs the bundle so anyone can check it', async () => {
    const h = harness()
    // Two refusals: a stranger the rules refuse, and an over-ceiling ask.
    for (const payee of ['Stranger One', 'Stranger Two']) {
      await call(h.app, 'POST', '/v1/proposals', {
        idem: idem('refuse'),
        body: { kind: 'payment', payee, amountCents: 9000, currency: 'USD', category: 'design', description: 'northwind work', evidenceUrl: EVIDENCE, jobId: 'job_northwind_logo' },
      })
    }
    const exported = await call(h.app, 'GET', '/v1/refusals/export')
    expect(exported.status).toBe(200)
    expect(exported.json).toMatchObject({ format: 'mandate.refusals.v1', count: 2, refusedCents: 18000, countsByClause: { 'payee.unknown': 2 } })
    const first = exported.json.refusals.find((refusal: { payeeName: string }) => refusal.payeeName === 'Stranger One')
    expect(first).toMatchObject({ clause: 'payee.unknown', amountCents: 9000, currency: 'USD', kind: 'payment' })
    // Anyone with the public key can check the signature over the exact message the server says it signed.
    const keys = (await call(h.app, 'GET', '/.well-known/mandate-keys.json')).json
    const current = keys.data.find((key: { current: boolean }) => key.current)
    const key = createPublicKey(current.publicKeyPem)
    const signature = Buffer.from(exported.json.signature.signature, 'base64url')
    expect(cryptoVerify(null, Buffer.from(exported.json.signedMessage, 'utf8'), key, signature)).toBe(true)
    // The message commits to the bundle: change one refusal and the signature no longer fits.
    const tampered = exported.json.signedMessage.replace(exported.json.count.toString(), '999')
    expect(cryptoVerify(null, Buffer.from(tampered, 'utf8'), key, signature)).toBe(false)
    expect(exported.json.signature).toMatchObject({ keyId: current.keyId, algorithm: 'ed25519' })
  })

  it('is empty but still signed when nothing has been refused', async () => {
    const h = harness()
    const exported = await call(h.app, 'GET', '/v1/refusals/export')
    expect(exported.json).toMatchObject({ format: 'mandate.refusals.v1', count: 0, refusedCents: 0, warrant: { id: 'wnt_line_studio', version: 1 } })
    const keys = (await call(h.app, 'GET', '/.well-known/mandate-keys.json')).json
    const current = keys.data.find((key: { current: boolean }) => key.current)
    expect(cryptoVerify(null, Buffer.from(exported.json.signedMessage, 'utf8'), createPublicKey(current.publicKeyPem), Buffer.from(exported.json.signature.signature, 'base64url'))).toBe(true)
  })

  it('needs the owner or studio key: the export is a studio artifact, not agent fodder', async () => {
    const h = harness()
    const anonymous = await call(h.app, 'GET', '/v1/refusals/export', { key: 'wrong-key-entirely' })
    expect(anonymous.status).toBe(401)
    void OWNER_KEY
  })
})
