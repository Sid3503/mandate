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

const accept = (app: Parameters<typeof call>[0], dealId: string, key = OWNER_KEY) => call(app, 'POST', `/v1/deals/${dealId}/accept`, { key, body: {} })
const counter = (app: Parameters<typeof call>[0], threadId: string, total: number, key = OWNER_KEY, extra: Record<string, unknown> = {}) =>
  call(app, 'POST', '/v1/deals/offers', { key, idem: idem('counter'), body: { buyer: 'Northwind', terms: terms(total), threadId, ...extra } })

describe('a negotiation', () => {
  it('makes a deal only when one side accepts the other side\'s exact standing offer', async () => {
    const { app } = harness()
    // The studio opens above the client's ceiling. That is a legal offer: whether the client can live with it is
    // the client's to say. Nothing about the client's limit comes back.
    const high = await offer(app, 45_000, OWNER_KEY, { as: 'seller' })
    expect(high.status).toBe(201)
    expect(high.json).toMatchObject({ status: 'open', offeredBy: 'seller', jobId: null, signature: null })
    const threadId = high.json.threadId as string

    // The client cannot accept it: it is past the client's own ceiling, and the client is told so in its own numbers.
    const tooHigh = await accept(app, high.json.id, BUYER_KEY)
    expect(tooHigh.status).toBe(422)
    expect(tooHigh.json.code).toBe('deal.outside_your_rules')
    expect(tooHigh.json.detail).toContain('400.00')

    // So it counters. The counter answers the studio's offer, which no longer stands.
    const low = await counter(app, threadId, 20_000, BUYER_KEY)
    expect(low.json).toMatchObject({ status: 'open', offeredBy: 'buyer' })
    expect((await call(app, 'GET', `/v1/deals/${high.json.id}`)).json.status).toBe('countered')
    expect((await accept(app, high.json.id, BUYER_KEY)).status).toBe(409)
    // The studio cannot accept $200 either: it is under its own floor.
    expect((await accept(app, low.json.id)).json.code).toBe('deal.outside_your_rules')

    const studio = await counter(app, threadId, 35_000)
    const client = await counter(app, threadId, 30_000, BUYER_KEY)
    expect(studio.json.status).toBe('open')
    // The studio accepts the client's $300: now, and only now, there is a deal.
    const agreed = await accept(app, client.json.id)
    expect(agreed.status).toBe(200)
    expect(agreed.json).toMatchObject({ status: 'agreed', offeredBy: 'buyer', buyerName: 'Northwind' })
    expect(agreed.json.jobId).toMatch(/^job_northwind_[0-9a-f]{6}$/)
    expect(agreed.json.signature).toBeTruthy()
    expect((await call(app, 'GET', `/v1/deals/${agreed.json.id}/verify`)).json.verdict).toBe('valid')

    const view = (await call(app, 'GET', `/v1/negotiations/${threadId}`)).json
    expect(view).toMatchObject({ status: 'agreed', endedBy: 'seller', agreedDealId: agreed.json.id, turn: null })
    expect(view.moves.map((move: { side: string; action: string; totalCents: number }) => `${move.side}:${move.action}:${move.totalCents}`)).toEqual([
      'seller:offer:45000', 'buyer:offer:20000', 'seller:offer:35000', 'buyer:offer:30000', 'seller:accept:30000',
    ])
    // Each side is told how good the price was for it, against its own walk-away and target.
    expect(view.seats.seller.outcome).toMatchObject({ marginCents: 5_000, towardTargetPct: 33, verdict: 'fair' })
    expect(view.seats.buyer.outcome).toMatchObject({ marginCents: 10_000, towardTargetPct: 50, verdict: 'good' })
    // A repeated accept is a replay, not a second deal.
    expect((await accept(app, client.json.id)).json.id).toBe(agreed.json.id)
  })

  it('keeps each side\'s limit private from the other side', async () => {
    const { app } = harness()
    const seller = await offer(app, 45_000, STUDIO_KEY)
    const text = JSON.stringify(seller.json)
    expect(seller.json.status).toBe('open')
    expect(seller.json.verdict.violations).toEqual([])
    expect(text).not.toContain('40000')
    expect(text).not.toContain('400.00')
    expect(seller.json.verdict.zone).toBeUndefined()

    // The client's own offer past its own ceiling is refused, in its own numbers. It is not a move.
    const own = await counter(app, seller.json.threadId, 50_000, BUYER_KEY)
    expect(own.json.status).toBe('refused')
    expect(own.json.verdict.violations[0].detail).toContain('400.00')
    const buyer = await counter(app, seller.json.threadId, 20_000, BUYER_KEY)
    expect(buyer.json.status).toBe('open')
    expect(JSON.stringify(buyer.json)).not.toContain('250.00')

    // Each side reads the table and its own seat; the other seat shows nothing but that it exists.
    const asClient = (await call(app, 'GET', `/v1/negotiations/${seller.json.threadId}`, { key: BUYER_KEY })).json
    expect(asClient.seats.seller).toEqual({ side: 'seller', visible: false })
    expect(asClient.seats.buyer).toMatchObject({ visible: true, reservationCents: 40_000 })
    expect(JSON.stringify(asClient)).not.toContain('25000')
    const asStudio = (await call(app, 'GET', `/v1/negotiations/${seller.json.threadId}`, { key: STUDIO_KEY })).json
    expect(asStudio.seats.buyer).toEqual({ side: 'buyer', visible: false })
    expect(asStudio.seats.seller).toMatchObject({ visible: true, reservationCents: 25_000 })
  })

  it('binds a key to one side: a client agent cannot speak for the studio or read its rules', async () => {
    const { app } = harness()
    const wrong = await offer(app, 30_000, BUYER_KEY, { as: 'seller' })
    expect(wrong.status).toBe(403)
    expect(wrong.json.code).toBe('deal.wrong_side')
    // The studio's key cannot speak for the client either.
    expect((await offer(app, 30_000, STUDIO_KEY, { as: 'buyer' })).json.code).toBe('deal.wrong_side')
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

  it('refuses terms that contradict themselves or break the offerer\'s own rules, and leaves the rest to the other side', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['milestones that do not add up', { milestones: [{ title: 'a', amountCents: 10_000 }, { title: 'b', amountCents: 10_000 }] }, 'deal.shape'],
      ['work the studio does not sell', { category: 'lunch' }, 'deal.category_seller'],
      ['no proof at each milestone', { proofRequired: false }, 'deal.proof_required'],
      ['a due date in the past', { dueDate: '2026-01-01' }, 'deal.due_date_past'],
      ['a currency neither side uses', { currency: 'EUR' }, 'deal.currency'],
    ]
    for (const [label, overrides, code] of cases) {
      const response = await call(app, 'POST', '/v1/deals/offers', { idem: idem('bad'), body: { buyer: 'Northwind', terms: terms(30_000, overrides), as: 'seller' } })
      expect(response.json.status, label).toBe('refused')
      expect(response.json.verdict.violations.map((v: { code: string }) => v.code), label).toContain(code)
    }
    // Work the studio sells but the client does not buy is a legal offer. The client simply cannot accept it.
    const production = await call(app, 'POST', '/v1/deals/offers', { idem: idem('prod'), body: { buyer: 'Northwind', terms: terms(30_000, { category: 'production' }), as: 'seller' } })
    expect(production.json.status).toBe('open')
    const refused = await accept(app, production.json.id, BUYER_KEY)
    expect(refused.status).toBe(422)
    expect(refused.json.violations.map((v: { code: string }) => v.code)).toContain('deal.category_buyer')
    const stranger = await call(app, 'POST', '/v1/deals/offers', { idem: idem('bad'), body: { buyer: 'Acme', terms: terms(30_000) } })
    expect(stranger.status).toBe(422)
    expect(stranger.json.code).toBe('deal.buyer_unknown')
  })

  it('opens a negotiation only with an offer that stands: a refused opening leaves nothing waiting', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const refused = await offer(app, 20_000, STUDIO_KEY)
    expect(refused.json.status).toBe('refused')
    expect((await call(app, 'GET', '/v1/negotiations')).json.data).toEqual([])
    const stands = await offer(app, 30_000, STUDIO_KEY)
    expect(stands.json.status).toBe('open')
    expect((await call(app, 'GET', '/v1/negotiations')).json.data).toHaveLength(1)
  })

  it('keeps turns, replays a repeated offer, and closes the thread once a deal is agreed', async () => {
    const { app } = harness()
    await confirmPrices(app)
    const threadId = crypto.randomUUID()
    const first = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(30_000), threadId } })
    const replay = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(30_000), threadId } })
    expect(replay.json.id).toBe(first.json.id)
    expect(first.json.threadId).toBe(threadId)
    const twice = await call(app, 'POST', '/v1/deals/offers', { idem: idem('again'), body: { buyer: 'Northwind', terms: terms(31_000), threadId } })
    expect(twice.status).toBe(409)
    expect(twice.json.code).toBe('negotiation.not_your_turn')
    const changed = await call(app, 'POST', '/v1/deals/offers', { idem: 'same-offer-key-1', body: { buyer: 'Northwind', terms: terms(32_000), threadId } })
    expect(changed.status).toBe(422)
    expect((await accept(app, first.json.id, BUYER_KEY)).json.status).toBe('agreed')
    const late = await call(app, 'POST', '/v1/deals/offers', { key: BUYER_KEY, idem: idem('late'), body: { buyer: 'Northwind', terms: terms(32_000), threadId } })
    expect(late.status).toBe(409)
    expect(late.json.code).toBe('deal.thread_closed')
  })

  it('ends with no deal when a side walks away, at the deadline, or when neither side moves', async () => {
    const { app } = harness()
    await confirmPrices(app)
    // Walking away is always a move, and it ends the negotiation. The offer that was standing is withdrawn.
    const opening = await offer(app, 45_000, STUDIO_KEY)
    const walked = await call(app, 'POST', `/v1/negotiations/${opening.json.threadId}/walk-away`, { key: BUYER_KEY, body: { reason: 'Too far apart this time.' } })
    expect(walked.json).toMatchObject({ status: 'walked_away', endedBy: 'buyer' })
    expect((await call(app, 'GET', `/v1/deals/${opening.json.id}`)).json.status).toBe('withdrawn')
    expect((await counter(app, opening.json.threadId, 44_000, STUDIO_KEY)).json.code).toBe('negotiation.ended')

    // The deadline: two offers each. The studio's second offer is its last, and the client's last is under its floor.
    const short = await call(app, 'POST', '/v1/deals/offers', { key: STUDIO_KEY, idem: idem('short'), body: { buyer: 'Northwind', terms: terms(45_000), offersPerSide: 2 } })
    const t = short.json.threadId as string
    await counter(app, t, 20_000, BUYER_KEY)
    await counter(app, t, 44_000, STUDIO_KEY)
    const last = await counter(app, t, 21_000, BUYER_KEY)
    expect(last.json.status).toBe('expired')
    expect((await call(app, 'GET', `/v1/negotiations/${t}`)).json).toMatchObject({ status: 'expired', ending: 'the deadline passed with no offer both sides could accept' })

    // A concession is never taken back.
    const third = await offer(app, 40_000, STUDIO_KEY)
    await counter(app, third.json.threadId, 20_000, BUYER_KEY)
    const back = await counter(app, third.json.threadId, 41_000, STUDIO_KEY)
    expect(back.json.status).toBe('refused')
    expect(back.json.verdict.violations[0].code).toBe('negotiation.regressive')

    // A stalemate: both sides hold their price for three rounds.
    const stuck = await offer(app, 45_000, STUDIO_KEY)
    const s = stuck.json.threadId as string
    for (const [total, key] of [[20_000, BUYER_KEY], [45_000, STUDIO_KEY], [20_000, BUYER_KEY], [45_000, STUDIO_KEY], [20_000, BUYER_KEY]] as const) await counter(app, s, total, key)
    expect((await call(app, 'GET', `/v1/negotiations/${s}`)).json.status).toBe('stalled')
  })

  it('uses the latest rules a company has written', async () => {
    const { app } = harness()
    const first = await offer(app, 45_000)
    expect((await accept(app, first.json.id)).json.code).toBe('deal.outside_your_rules')
    const rules = (await call(app, 'GET', '/v1/party-rules')).json.data.find((r: { partyId: string }) => r.partyId === 'client_northwind')
    const { partyId: _p, version: _v, createdAt: _c, ...body } = rules
    expect((await call(app, 'PUT', '/v1/party-rules/client_northwind', { key: STUDIO_KEY, body: { ...body, maxTotalCents: 50_000 } })).status).toBe(403)
    const published = await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { ...body, maxTotalCents: 50_000 } })
    expect(published.json.version).toBe(3)
    const accepted = await accept(app, first.json.id)
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
    // Kept on both sides: the offer stands, and the client's acceptance makes the deal.
    await call(app, 'PUT', '/v1/party-rules/wnt_line_studio', { body: { minTotalCents: 25_000 } })
    const made = await call(app, 'POST', '/v1/deals/offers', { idem: idem('kept3'), body: { buyer: 'Northwind', terms: terms(30_000) } })
    expect(made.json.status).toBe('open')
    const agreed = await accept(app, made.json.id, BUYER_KEY)
    expect(agreed.json.status).toBe('agreed')
    expect(agreed.json.rulesVersions).toEqual({ buyer: 2, seller: 2 })
  })

  it('lets each company write its own price sheet; a client that wrote its own is sealed from the studio', async () => {
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

    // The client has claimed its seat. The studio's owner now sees that a ceiling is set, and nothing of it, and
    // can neither overwrite it nor speak for the client.
    const after = (await call(app, 'GET', '/v1/party-rules')).json.data as Array<Record<string, unknown>>
    const sealed = after.find((row) => row.partyId === 'client_northwind')!
    expect(sealed).toMatchObject({ version: 2, claimed: true, sealed: true, limitSet: true })
    expect(sealed.maxTotalCents).toBeUndefined()
    expect(JSON.stringify(after)).not.toContain('48000')
    const overwrite = await call(app, 'PUT', '/v1/party-rules/client_northwind', { body: { maxTotalCents: 60_000 } })
    expect(overwrite.status).toBe(403)
    expect(overwrite.json.code).toBe('deal.seat_claimed')
    expect((await offer(app, 30_000, OWNER_KEY, { as: 'buyer' })).json.code).toBe('deal.seat_claimed')

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
