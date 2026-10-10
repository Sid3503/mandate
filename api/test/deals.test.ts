import { afterEach, describe, expect, it } from 'vitest'
import { Signer } from '../src/domain/signing'
import { agree, BUYER_KEY, call, closeAll, collect, confirmPrices, EVIDENCE, harness, idem, JOB, OWNER_KEY, STUDIO_KEY, terms } from './support'
import { generateKeyPairSync } from 'node:crypto'
import { Repo } from '../src/db/repo'
import { cartHash } from '../src/domain/hash'

afterEach(closeAll)

const offer = async (app: Parameters<typeof call>[0], total: number, key = OWNER_KEY, extra: Record<string, unknown> = {}) => {
  await confirmPrices(app)
  return call(app, 'POST', '/v1/deals/offers', { key, idem: idem('offer'), body: { buyer: 'Northwind', terms: terms(total), ...extra } })
}

describe('the deal check', () => {
  it('refuses $450 and $200 and agrees $300, as the frozen story says', async () => {
    const { app } = harness()
    const high = await offer(app, 45_000, OWNER_KEY, { as: 'seller' })
    expect(high.status).toBe(201)
    expect(high.json.status).toBe('refused')
    expect(high.json.verdict.violations.map((v: { code: string }) => v.code)).toEqual(['deal.over_buyer_limit'])

    const low = await offer(app, 20_000, OWNER_KEY, { as: 'buyer' })
    expect(low.json.status).toBe('refused')
    expect(low.json.verdict.violations.map((v: { code: string }) => v.code)).toEqual(['deal.under_seller_minimum'])

    const fair = await offer(app, 30_000, OWNER_KEY, { as: 'seller' })
    expect(fair.json).toMatchObject({ status: 'agreed', buyerName: 'Northwind' })
    expect(fair.json.jobId).toMatch(/^job_northwind_[0-9a-f]{6}$/)
    expect(fair.json.signature).toBeTruthy()
    expect(fair.json.verdict.zone).toEqual({ minCents: 25_000, maxCents: 40_000 })
  })

  it('keeps each side\'s limit private from the other side\'s agent', async () => {
    const { app } = harness()
    // The studio's agent asks too much. It learns the buyer refused and which way to move, but not the number.
    const seller = await offer(app, 45_000, STUDIO_KEY)
    const text = JSON.stringify(seller.json)
    expect(seller.json.verdict.violations[0]).toMatchObject({ code: 'deal.over_buyer_limit', hint: 'Lower the total.' })
    expect(text).not.toContain('40000')
    expect(text).not.toContain('400.00')
    expect(seller.json.verdict.zone).toBeUndefined()

    // The client's agent asks too little. It is told its own rule in full and the studio's only as "private".
    const buyer = await offer(app, 20_000, BUYER_KEY)
    expect(buyer.status).toBe(201)
    expect(JSON.stringify(buyer.json)).not.toContain('250.00')
    expect(buyer.json.verdict.violations[0].detail).toContain('private')
    expect(buyer.json.offeredBy).toBe('buyer')

    // An agent sees its own side's broken rule with the number.
    const own = await offer(app, 50_000, BUYER_KEY)
    expect(own.json.verdict.violations[0].detail).toContain('400.00')
  })

  it('binds a key to one side: a client agent cannot speak for the studio or read its rules', async () => {
    const { app } = harness()
    const wrong = await offer(app, 30_000, BUYER_KEY, { as: 'seller' })
    expect(wrong.status).toBe(403)
    expect(wrong.json.code).toBe('deal.wrong_side')
    const rules = await call(app, 'GET', '/v1/party-rules/mine', { key: BUYER_KEY })
    expect(rules.json).toMatchObject({ partyId: 'client_northwind', role: 'buyer' })
    expect(JSON.stringify(rules.json)).not.toContain('minTotalCents')
    expect((await call(app, 'GET', '/v1/party-rules', { key: BUYER_KEY })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/party-rules', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/party-rules')).json.data).toHaveLength(2)
    for (const path of ['/v1/proposals', '/v1/ledger', '/v1/warrant', '/v1/jobs/x']) {
      expect((await call(app, 'GET', path, { key: BUYER_KEY })).status, path).toBe(403)
    }
  })

  it('refuses terms that contradict themselves or sit outside either rule set', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['milestones that do not add up', { milestones: [{ title: 'a', amountCents: 10_000 }, { title: 'b', amountCents: 10_000 }] }, 'deal.shape'],
      ['work the buyer does not buy', { category: 'production' }, 'deal.category_buyer'],
      ['work nobody sells', { category: 'lunch' }, 'deal.category_seller'],
      ['no proof at each milestone', { proofRequired: false }, 'deal.proof_required'],
      ['a due date in the past', { dueDate: '2026-01-01' }, 'deal.due_date_past'],
      ['a currency neither side uses', { currency: 'EUR' }, 'deal.currency'],
    ]
    for (const [label, overrides, code] of cases) {
      const response = await call(app, 'POST', '/v1/deals/offers', { idem: idem('bad'), body: { buyer: 'Northwind', terms: terms(30_000, overrides), as: 'seller' } })
      expect(response.json.status, label).toBe('refused')
      expect(response.json.verdict.violations.map((v: { code: string }) => v.code), label).toContain(code)
    }
    const stranger = await call(app, 'POST', '/v1/deals/offers', { idem: idem('bad'), body: { buyer: 'Acme', terms: terms(30_000) } })
    expect(stranger.status).toBe(422)
    expect(stranger.json.code).toBe('deal.buyer_unknown')
  })

  it('closes a negotiation thread once a deal is agreed, and replays a repeated offer', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const threadId = crypto.randomUUID()
    const first = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(30_000), threadId } })
    const replay = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(30_000), threadId } })
    expect(replay.json.id).toBe(first.json.id)
    const again = await call(app, 'POST', '/v1/deals/offers', { idem: idem('late'), body: { buyer: 'Northwind', terms: terms(32_000), threadId } })
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('deal.thread_closed')
    const changed = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(32_000), threadId } })
    expect(changed.status).toBe(422)
  })

  it('uses the latest rules a company has written', async () => {
    const { app } = harness()
    expect((await offer(app, 45_000)).json.status).toBe('refused')
    const rules = (await call(app, 'GET', '/v1/party-rules')).json.data.find((r: { partyId: string }) => r.partyId === 'client_northwind')
    const { partyId: _p, version: _v, createdAt: _c, ...body } = rules
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { key: STUDIO_KEY, body: { ...body, maxTotalCents: 50_000 } })).status).toBe(403)
    const published = await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { ...body, maxTotalCents: 50_000 } })
    expect(published.json.version).toBe(3)
    const accepted = await offer(app, 45_000)
    expect(accepted.json).toMatchObject({ status: 'agreed', rulesVersions: { buyer: 3, seller: 2 } })
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { ...body, role: 'seller', minTotalCents: 1 } })).json.code).toBe('deal.role_mismatch')
  })

  it('refuses offers against sample numbers nobody kept, until both companies keep them', async () => {
    const { app } = harness()
    const sheets = (await call(app, 'GET', '/v1/party-rules')).json.data
    expect(sheets.every((row: { origin: string }) => row.origin === 'seed')).toBe(true)
    // Refused on the server, before any term is judged: there is nothing to judge against yet.
    const refused = await call(app, 'POST', '/v1/deals/offers', { idem: idem('kept'), body: { buyer: 'Northwind', terms: terms(30_000) } })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'deal.rules_unconfirmed' })
    expect(refused.json.detail).toContain('Northwind')
    // Keeping only one side still waits: both companies must keep.
    await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { maxTotalCents: 40_000 } })
    expect((await call(app, 'POST', '/v1/deals/offers', { idem: idem('kept2'), body: { buyer: 'Northwind', terms: terms(30_000) } })).status).toBe(409)
    // Kept on both sides: the same terms are judged, and agree.
    await call(app, 'PUT', '/v1/party-rules/wnt_line_studio', { body: { minTotalCents: 25_000 } })
    const agreed = await call(app, 'POST', '/v1/deals/offers', { idem: idem('kept3'), body: { buyer: 'Northwind', terms: terms(30_000) } })
    expect(agreed.json.status).toBe('agreed')
    expect(agreed.json.rulesVersions).toEqual({ buyer: 2, seller: 2 })
  })

  it('lets each company write its own price sheet, and nobody else’s', async () => {
    const { app } = harness()
    const sheets = (await call(app, 'GET', '/v1/party-rules')).json.data as Array<Record<string, unknown>>
    const seller = sheets.find((row) => row.partyId === 'wnt_line_studio')!
    const buyer = sheets.find((row) => row.partyId === 'client_northwind')!
    const sheet = (row: Record<string, unknown>) => {
      const { partyId: _p, version: _v, createdAt: _c, ...body } = row
      return body
    }

    // The client writes its own ceiling through `mine`: it never sees or names the studio's id.
    const clientSheet = await call(app, 'PUT', '/v1/party-rules/mine', { key: BUYER_KEY, body: { ...sheet(buyer), maxTotalCents: 48_000 } })
    expect(clientSheet.status).toBe(201)
    expect(clientSheet.json).toMatchObject({ partyId: 'client_northwind', version: 2, maxTotalCents: 48_000 })
    expect(JSON.stringify(clientSheet.json)).not.toContain('minTotalCents')
    // The other side's sheet is out of reach, by id and by `mine`.
    expect((await call(app, 'PUT', '/v1/party-rules/wnt_line_studio', { key: BUYER_KEY, body: sheet(seller) })).status).toBe(403)
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { key: BUYER_KEY, body: { ...sheet(buyer), maxTotalCents: 1 } })).status).toBe(403)

    // The studio writes its own floor the same way. Its write left the client's sheet where it was.
    const studioSheet = await call(app, 'PUT', '/v1/party-rules/mine', { key: STUDIO_KEY, body: { ...sheet(seller), minTotalCents: 26_000 } })
    expect(studioSheet.json).toMatchObject({ partyId: 'wnt_line_studio', version: 2, minTotalCents: 26_000 })
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { key: STUDIO_KEY, body: sheet(buyer) })).status).toBe(403)
    const after = (await call(app, 'GET', '/v1/party-rules')).json.data as Array<Record<string, unknown>>
    expect(after.find((row) => row.partyId === 'client_northwind')).toMatchObject({ version: 2, maxTotalCents: 48_000 })

    // An agent key may read its company's terms through `mine`; setting them is not its move.
    const created = await call(app, 'POST', '/v1/agents', { body: { name: 'negotiator', scopes: ['deals'] } })
    expect(created.status).toBe(201)
    expect((await call(app, 'PUT', '/v1/party-rules/mine', { key: created.json.apiKey, body: sheet(seller) })).status).toBe(403)
    expect((await call(app, 'GET', '/v1/party-rules/mine', { key: created.json.apiKey })).status).toBe(200)
  })

  it('keeps every number a company did not mention, and starts a new sheet from the warrant alone', async () => {
    const { app } = harness()
    // A partial write changes the ceiling and nothing else about the company.
    const kept = await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { maxTotalCents: 47_000 } })
    expect(kept.status).toBe(201)
    expect(kept.json).toMatchObject({ version: 2, maxTotalCents: 47_000, displayName: 'Northwind', categories: ['design'], maxMilestones: 4, requireProof: true })

    // A client newly added to the warrant has no sheet. Its name and its company's currency come from the warrant;
    // the one thing it must say is the number.
    const current = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    const harbor = { id: 'client_harbor', displayName: 'Harbor Foods', email: 'ap@harbor.example', aliases: [] }
    expect((await call(app, 'PUT', '/v1/warrant', { body: { ...body, clients: [...body.clients, harbor] } })).status).toBe(201)
    // With no price at all, it is not a sheet: the rules say so rather than silently accepting an open budget.
    const empty = await call(app, 'PUT', '/v1/party-rules/client_harbor', { body: {} })
    expect(empty.status).toBe(422)
    expect(empty.json).toMatchObject({ code: 'deal.rules_invalid' })
    expect(empty.json.detail).toContain('maxTotalCents')
    const created = await call(app, 'PUT', '/v1/party-rules/client_harbor', { body: { maxTotalCents: 12_000 } })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ partyId: 'client_harbor', version: 1, displayName: 'Harbor Foods', currency: 'USD', categories: ['design', 'production'], maxTotalCents: 12_000 })
    expect((await call(app, 'GET', '/v1/party-rules')).json.data).toHaveLength(3)
  })
})

describe('an agreed deal is the only thing a client charge may bill', () => {
  it('bills milestones at exactly their agreed amount, once each, and the job totals follow', async () => {
    const { app } = harness()
    const deal = await agree(app)
    expect(deal.jobId).toBe(JOB)

    const freestyle = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'side invoice', evidenceUrl: EVIDENCE, jobId: JOB } })
    expect(freestyle.json).toMatchObject({ gate: 'DENY', clause: 'deal.required' })

    const wrongAmount = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 20_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, jobId: JOB, dealId: deal.id, milestone: 0 } })
    expect(wrongAmount.json).toMatchObject({ gate: 'DENY', clause: 'deal.milestone_mismatch' })

    const unknown = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, jobId: JOB, dealId: deal.id, milestone: 5 } })
    expect(unknown.json.clause).toBe('deal.milestone_unknown')

    const fake = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, jobId: JOB, dealId: crypto.randomUUID(), milestone: 0 } })
    expect(fake.json.clause).toBe('deal.unknown')

    const first = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    expect(first.json).toMatchObject({ gate: 'NEEDS_APPROVAL', amountCents: 15_000, dealId: deal.id, milestone: 0, jobId: JOB })
    const twice = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: 'https://www.figma.com/file/other' } })
    expect(twice.json).toMatchObject({ gate: 'DENY', clause: 'deal.milestone_billed' })
    const summary = (await call(app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(summary.deal.milestones[0]).toMatchObject({ index: 0, amountCents: 15_000, chargeId: first.json.id })
    expect(summary.deal.milestones[1]).toMatchObject({ index: 1, chargeId: null })
    expect(summary.deal.signatureValid).toBe(true)
  })

  it('carries the whole money loop: milestone 1 paid in, Priya\'s $90 paid out, $60 kept', async () => {
    const { app } = harness()
    const deal = await agree(app)
    const { captureId } = await collect(app, deal.id, 0)
    const payout = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Milestone 1 share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: captureId } })
    expect(payout.json.gate).toBe('NEEDS_APPROVAL')
    await call(app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
    const paid = await call(app, 'POST', `/v1/proposals/${payout.json.id}/capture`)
    expect(paid.json.phase).toBe('captured')
    expect((await call(app, 'GET', `/v1/jobs/${JOB}`)).json.totals).toEqual({ inCents: 15_000, outCents: 9_000, heldCents: 0, keptCents: 6_000 })
  })

  it('refuses to bill a refused deal or a milestone that does not exist', async () => {
    const { app } = harness()
    const refused = await offer(app, 45_000)
    expect((await call(app, 'POST', `/v1/deals/${refused.json.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })).status).toBe(404)
    const deal = await agree(app)
    expect((await call(app, 'POST', `/v1/deals/${deal.id}/milestones/9/bill`, { body: { evidenceUrl: EVIDENCE } })).json.code).toBe('deal.milestone_unknown')
    expect((await call(app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { key: BUYER_KEY, body: { evidenceUrl: EVIDENCE } })).status).toBe(403)
  })
})

describe('signed locks', () => {
  async function approved() {
    const h = harness()
    const deal = await agree(h.app)
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const locked = await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/approve`)
    return { ...h, id: billed.json.id as string, locked: locked.json, deal }
  }

  it('signs the lock when the owner taps, and the receipt verifies it', async () => {
    const { app, id, locked } = await approved()
    expect(locked.lockSignature).toMatch(/^[A-Za-z0-9_-]{86}$/)
    expect(locked.lockKeyId).toHaveLength(16)
    const verify = (await call(app, 'GET', `/v1/proposals/${id}/verify`)).json
    expect(verify).toMatchObject({ verdict: 'valid', hashMatches: true, signatureValid: true, algorithm: 'ed25519' })
    expect(verify.message).toContain(id)
    const packet = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json
    expect(packet.lock).toMatchObject({ signatureValid: true, algorithm: 'ed25519' })
    const keys = await app.request('http://mandate.test/.well-known/mandate-keys.json')
    expect((await keys.json()).data[0]).toMatchObject({ keyId: locked.lockKeyId, algorithm: 'ed25519', current: true })
  })

  it('signs an automatic lock at creation, with no tap', async () => {
    const { app } = harness()
    const small = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 1_500, currency: 'USD', category: 'design', description: 'font licence', evidenceUrl: EVIDENCE } })
    expect(small.json).toMatchObject({ gate: 'DENY', clause: 'funding.missing' })
    const refund = await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 1_500, currency: 'USD', category: 'design', description: 'x', evidenceUrl: EVIDENCE, jobId: 'job_small' } })
    expect(refund.json).toMatchObject({ gate: 'AUTO', phase: 'locked' })
    expect(refund.json.lockSignature).toBeTruthy()
  })

  it('refuses to settle a row edited in the database even when the attacker recomputes the hash', async () => {
    const { app, db, paypal, id, locked } = await approved()
    const repo = new Repo(db)
    const row = repo.proposal(id)!
    const forged = { ...row, amount_cents: 1_500_000 }
    // The attacker is thorough: new amount and a matching new hash. Only the signature can tell.
    const fields = {
      proposalId: row.id, warrantId: row.warrant_id, warrantVersion: row.warrant_version, payeeId: row.payee_id!, amountCents: forged.amount_cents,
      currency: row.currency, category: row.category!, evidenceUrl: row.evidence_url!, kind: row.kind, parentCaptureId: row.parent_capture_id,
      jobId: row.job_id, fundingCaptureId: row.funding_capture_id, dealId: row.deal_id, milestone: row.milestone,
    }
    db.prepare('UPDATE proposals SET amount_cents = ?, cart_hash = ? WHERE id = ?').run(forged.amount_cents, cartHash(fields), id)
    expect(locked.cartHash).not.toBe(cartHash(fields))
    const verify = (await call(app, 'GET', `/v1/proposals/${id}/verify`)).json
    expect(verify).toMatchObject({ hashMatches: true, signatureValid: false, verdict: 'invalid' })
    const before = paypal!.orders.size
    const settle = await call(app, 'POST', `/v1/proposals/${id}/capture`)
    expect(settle.status).toBe(409)
    expect(settle.json.code).toBe('lock.signature_invalid')
    expect(paypal!.orders.size).toBe(before)
  })

  it('refuses a lock whose stored hash no longer matches its fields', async () => {
    const { app, db, id } = await approved()
    db.prepare('UPDATE proposals SET amount_cents = 1 WHERE id = ?').run(id)
    expect((await call(app, 'POST', `/v1/proposals/${id}/capture`)).json.code).toBe('cart.immutable')
  })

  it('signs old unsigned locks at boot only if their hash is still intact', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const a = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const b = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/1/bill`, { body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', `/v1/proposals/${a.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${b.json.id}/approve`)
    h.db.prepare('UPDATE proposals SET lock_sig = NULL, lock_key_id = NULL WHERE id IN (?, ?)').run(a.json.id, b.json.id)
    h.db.prepare('UPDATE proposals SET amount_cents = 1 WHERE id = ?').run(b.json.id)
    const app = h.rebuild()
    expect((await call(app, 'GET', `/v1/proposals/${a.json.id}/verify`)).json.verdict).toBe('valid')
    expect((await call(app, 'GET', `/v1/proposals/${b.json.id}/verify`)).json.verdict).toBe('invalid')
  })

  it('keeps old receipts verifiable after the key is rotated', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const billed = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const locked = (await call(h.app, 'POST', `/v1/proposals/${billed.json.id}/approve`)).json
    // The same database, booted with a brand-new key that has never heard of the old one.
    const rotated = new Signer(generateKeyPairSync('ed25519').privateKey)
    const app = h.rebuild(rotated)
    const verify = (await call(app, 'GET', `/v1/proposals/${billed.json.id}/verify`)).json
    expect(verify).toMatchObject({ verdict: 'valid', keyId: locked.lockKeyId })
    expect(verify.publicKeys.map((k: { keyId: string }) => k.keyId)).toEqual(expect.arrayContaining([locked.lockKeyId, rotated.keyId]))
    // New locks are signed with the new key.
    const second = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/1/bill`, { body: { evidenceUrl: EVIDENCE } })
    expect((await call(app, 'POST', `/v1/proposals/${second.json.id}/approve`)).json.lockKeyId).toBe(rotated.keyId)
  })

  it('verifies an agreed deal, and notices tampered terms', async () => {
    const { app, db } = harness()
    const deal = await agree(app)
    expect((await call(app, 'GET', `/v1/deals/${deal.id}/verify`)).json).toMatchObject({ verdict: 'valid', signatureValid: true, hashMatches: true })
    const row = db.prepare('SELECT terms_json FROM deals WHERE id = ?').get(deal.id) as { terms_json: string }
    const edited = JSON.parse(row.terms_json)
    edited.totalCents = 99_999_999
    db.prepare('UPDATE deals SET terms_json = ? WHERE id = ?').run(JSON.stringify(edited), deal.id)
    expect((await call(app, 'GET', `/v1/deals/${deal.id}/verify`)).json).toMatchObject({ verdict: 'invalid', hashMatches: false })
  })
})
