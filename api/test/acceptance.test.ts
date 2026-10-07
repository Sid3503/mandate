import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { scriptedModel } from './mockModel'
import { agree, BUYER_KEY, call, closeAll, EVIDENCE, harness, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const ON = { billSignedDeals: true, requireAcceptance: true, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 }

async function publish(app: App, patch: Record<string, unknown>) {
  const current = (await call(app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  return call(app, 'PUT', '/v1/warrant', { body: { ...body, ...patch } })
}

async function world(options: Parameters<typeof harness>[0] = {}) {
  const invoices = new FakeInvoices()
  const h = harness({ ...options, invoices })
  const deal = await agree(h.app)
  await publish(h.app, { automation: ON })
  return { ...h, deal, invoices }
}

const deliver = (h: { app: App; deal: { id: string } }, milestone = 0, evidenceUrl = EVIDENCE, key?: string) =>
  call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/${milestone}/deliver`, { key, body: { evidenceUrl } })
const decide = (h: { app: App; deal: { id: string } }, decision: 'accepted' | 'rejected', milestone = 0, key = BUYER_KEY, note?: string) =>
  call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/${milestone}/decision`, { key, body: { decision, note } })
const types = async (app: App, id: string) => (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((event: { type: string }) => event.type) as string[]

describe('billing after the client accepts', () => {
  it('waits for the client, then bills the exact milestone when the client\'s agent accepts, with nobody tapping', async () => {
    const h = await world()
    const sent = await deliver(h, 0, EVIDENCE, STUDIO_KEY)
    expect(sent.status).toBe(201)
    expect(sent.json).toMatchObject({ mode: 'awaiting', charge: null, delivery: { status: 'awaiting', milestone: 0, amountCents: 15_000, buyerName: 'Northwind' } })
    // Nothing has been billed: the client has not spoken.
    expect(h.invoices.createCalls).toBe(0)
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toHaveLength(0)

    const accepted = await decide(h, 'accepted', 0, BUYER_KEY, 'The link is the concept file.')
    expect(accepted.status).toBe(200)
    expect(accepted.json.delivery).toMatchObject({ status: 'accepted', signatureValid: true, note: 'The link is the concept file.' })
    expect(accepted.json.charge).toMatchObject({ gate: 'AUTO', clause: 'standing.billing', phase: 'invoice_sent', amountCents: 15_000, evidenceUrl: EVIDENCE })
    expect(h.invoices.createCalls).toBe(1)
    const id = accepted.json.charge.id as string
    const events = await types(h.app, id)
    expect(events).toContain('delivery.accepted')
    expect(events).not.toContain('proposal.approved')
    expect((await call(h.app, 'GET', `/v1/proposals/${id}/packet`)).json.lock.signatureValid).toBe(true)
  })

  it('a rejection bills nothing, is signed, and lets the studio deliver again with a new link', async () => {
    const h = await world()
    await deliver(h)
    const rejected = await decide(h, 'rejected', 0, BUYER_KEY, 'That is a receipt, not a logo.')
    expect(rejected.json).toMatchObject({ delivery: { status: 'rejected', signatureValid: true }, charge: null })
    expect(h.invoices.createCalls).toBe(0)
    const again = await deliver(h, 0, 'https://www.figma.com/file/northwind-logo-v2')
    expect(again.status).toBe(201)
    expect((await call(h.app, 'GET', '/v1/deliveries')).json.data.map((d: { status: string }) => d.status)).toEqual(['awaiting', 'superseded'])
    expect((await decide(h, 'accepted')).json.charge.evidenceUrl).toBe('https://www.figma.com/file/northwind-logo-v2')
  })

  it('an acceptance covers only the proof it was given for: a different link still needs the owner', async () => {
    const h = await world()
    await deliver(h)
    await decide(h, 'accepted')
    // The milestone is billed. Billing the next one with a link nobody accepted is not covered.
    const unaccepted = await call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/1/bill`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    expect(unaccepted.json).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', phase: 'pending_approval' })
    expect(h.invoices.createCalls).toBe(1)
  })

  it('an acceptance for one link cannot be used to bill another, even if the row is edited', async () => {
    const h = await world()
    await deliver(h, 0, EVIDENCE)
    await decide(h, 'accepted')
    // Undo the billing in the test by using a fresh milestone with a different link but a copied acceptance row.
    await deliver(h, 1, 'https://www.figma.com/file/final-files')
    h.db.prepare(`UPDATE deliveries SET status = 'accepted', sig = (SELECT sig FROM deliveries WHERE milestone = 0 AND status = 'accepted'), key_id = (SELECT key_id FROM deliveries WHERE milestone = 0 AND status = 'accepted'), decided_by = 'client_northwind' WHERE milestone = 1`).run()
    const bill = await call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/1/bill`, { key: STUDIO_KEY, body: { evidenceUrl: 'https://www.figma.com/file/final-files' } })
    expect(bill.json).toMatchObject({ gate: 'NEEDS_APPROVAL' })
    expect(h.invoices.createCalls).toBe(1)
  })

  it('only the client\'s own key can decide: not the studio, not the owner, and not another client', async () => {
    const h = await world()
    await deliver(h)
    for (const key of [STUDIO_KEY, OWNER_KEY]) {
      const refused = await decide(h, 'accepted', 0, key)
      expect(refused.status).toBe(403)
    }
    expect((await call(h.app, 'GET', '/v1/deliveries', { key: STUDIO_KEY })).status).toBe(200)
    expect(h.invoices.createCalls).toBe(0)
    expect((await deliver(h, 0, EVIDENCE, BUYER_KEY)).status).toBe(403)
  })

  it('cannot be decided twice, decided when nothing was delivered, or decided after the milestone was billed', async () => {
    const h = await world()
    expect((await decide(h, 'accepted')).status).toBe(409)
    await deliver(h)
    expect((await decide(h, 'accepted')).status).toBe(200)
    expect((await decide(h, 'accepted')).status).toBe(409)
    expect((await decide(h, 'rejected')).status).toBe(409)
    expect(h.invoices.createCalls).toBe(1)
  })

  it('refuses a proof that is not an https link before it ever reaches the client', async () => {
    const h = await world()
    for (const bad of ['http://example.com/work', 'javascript:alert(1)', 'not a link', 'https://user:pass@evil.example/x']) {
      expect((await deliver(h, 0, bad)).status, bad).toBe(422)
    }
  })

  it('does nothing different when the owner has not asked for acceptance: delivering bills as before', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    await publish(h.app, { automation: { ...ON, requireAcceptance: false } })
    const sent = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    expect(sent.json).toMatchObject({ mode: 'billed', charge: { gate: 'AUTO', clause: 'standing.billing', phase: 'invoice_sent' } })
  })

  it('refuses to publish "wait for the client" when nothing is billed automatically', async () => {
    const h = harness()
    expect((await publish(h.app, { automation: { ...ON, billSignedDeals: false } })).status).toBe(400)
  })

  it('the client\'s agent does all of it over MCP, with nothing that can pay', async () => {
    const h = await world()
    await deliver(h)
    const transport = new StreamableHTTPClientTransport(new URL('http://mandate.test/mcp'), {
      fetch: (input, init) => Promise.resolve(h.app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${BUYER_KEY}`, 'x-mandate-run': crypto.randomUUID() } },
    })
    const client = new Client({ name: 'northwind-agent', version: '1.0.0' })
    await client.connect(transport)
    const waiting = (await client.callTool({ name: 'get_deliveries', arguments: {} })).structuredContent as { waiting: Array<{ dealId: string; milestone: number; proofUrl: string; amount: string }> }
    expect(waiting.waiting).toEqual([expect.objectContaining({ dealId: h.deal.id, milestone: 0, amount: '$150.00', proofUrl: EVIDENCE })])
    const done = await client.callTool({ name: 'decide_delivery', arguments: { dealId: h.deal.id, milestone: 0, decision: 'accepted', note: 'Looks right.' } })
    expect((done.structuredContent as { result: string }).result).toBe('ACCEPTED')
    expect(h.invoices.createCalls).toBe(1)
    await client.close()
  })

  it('a studio agent is given no way to accept its own delivery', async () => {
    const h = await world()
    const transport = new StreamableHTTPClientTransport(new URL('http://mandate.test/mcp'), {
      fetch: (input, init) => Promise.resolve(h.app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${STUDIO_KEY}`, 'x-mandate-run': crypto.randomUUID() } },
    })
    const client = new Client({ name: 'studio-agent', version: '1.0.0' })
    await client.connect(transport)
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('decide_delivery')
    await client.close()
  })
})

describe('the client\'s reviewer agent', () => {
  const reviewer = (decision: 'accepted' | 'rejected') => scriptedModel(({ round, system }) => {
    if (round > 0) return { text: 'Decided.' }
    return { tool: 'decide_delivery', input: { dealId: /The deal is ([0-9a-f-]{36})/.exec(system)?.[1], milestone: Number(/milestone number (\d+)/.exec(system)?.[1]), decision, note: 'Reviewed.' } }
  })

  it('reviews a waiting delivery for the owner, with only the client\'s tools, and the rules do the rest', async () => {
    const model = reviewer('accepted')
    const h = await world({ model })
    await deliver(h)
    const run = await call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/0/review`)
    expect(run.status).toBe(200)
    expect(run.json).toMatchObject({ delivery: { status: 'accepted', signatureValid: true }, charge: { clause: 'standing.billing', phase: 'invoice_sent' } })
    const system = model.prompts[0]!
    expect(system).toContain('You review deliveries for Northwind')
    expect(system).toContain(EVIDENCE)
    // The reviewer is told nothing about the studio's private limits.
    expect(system).not.toMatch(/minTotalCents|Priya/)
    expect((await call(h.app, 'GET', `/v1/agent-runs`)).json.data[0]).toMatchObject({ agent: 'reviewer', status: 'ok' })
  })

  it('a rejecting reviewer bills nothing; a reviewer that decides nothing changes nothing; and only the owner can start it', async () => {
    const h = await world({ model: reviewer('rejected') })
    await deliver(h)
    expect((await call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/0/review`)).json.delivery.status).toBe('rejected')
    expect(h.invoices.createCalls).toBe(0)
    expect((await call(h.app, 'POST', `/v1/deals/${h.deal.id}/milestones/0/review`)).status).toBe(409)
    closeAll()
    const silent = await world({ model: scriptedModel(() => ({ text: 'Looks fine to me!' })) })
    await deliver(silent)
    const none = await call(silent.app, 'POST', `/v1/deals/${silent.deal.id}/milestones/0/review`)
    expect(none.status).toBe(422)
    expect(none.json.code).toBe('delivery.no_decision')
    expect((await call(silent.app, 'GET', '/v1/deliveries')).json.data[0].status).toBe('awaiting')
    expect((await call(silent.app, 'POST', `/v1/deals/${silent.deal.id}/milestones/0/review`, { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(silent.app, 'POST', `/v1/deals/${silent.deal.id}/milestones/0/review`, { key: BUYER_KEY })).status).toBe(403)
  })
})

describe('the client\'s stand-in answers by itself when it is on auto', () => {
  const accepting = () => scriptedModel(({ round, system }) => round > 0 ? { text: 'Decided.' } : { tool: 'decide_delivery', input: { dealId: /The deal is ([0-9a-f-]{36})/.exec(system)?.[1], milestone: 0, decision: 'accepted', note: 'Fits.' } })

  it('reviews the delivery as soon as it arrives, with nobody pressing anything, and the invoice goes out', async () => {
    const h = await world({ model: accepting(), clientAgent: 'auto' })
    expect((await deliver(h)).status).toBe(201)
    for (let i = 0; i < 50 && h.invoices.createCalls === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.invoices.createCalls).toBe(1)
    expect((await call(h.app, 'GET', '/v1/deliveries')).json.data[0]).toMatchObject({ status: 'accepted', signatureValid: true })
  })

  it('does nothing on its own when it is on manual', async () => {
    const h = await world({ model: accepting(), clientAgent: 'manual' })
    await deliver(h)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.invoices.createCalls).toBe(0)
    expect((await call(h.app, 'GET', '/v1/today')).json.clientAgent).toEqual({ mode: 'manual', ready: true })
  })
})

describe('proof of the acceptance', () => {
  it('passes the audit, and the audit catches an acceptance that was edited, removed, or pointed at another proof', async () => {
    const h = await world()
    await deliver(h)
    const accepted = await decide(h, 'accepted')
    const id = accepted.json.charge.id as string
    const report = (await call(h.app, 'GET', '/v1/audit')).json
    expect(report.checks.find((c: { id: string }) => c.id === 'billing.accepted')).toMatchObject({ status: 'pass', checked: 2 })
    expect(report.ok).toBe(true)

    h.db.prepare(`UPDATE deliveries SET note = 'edited', proof_hash = 'deadbeef' WHERE proposal_id = ?`).run(id)
    const edited = (await call(h.app, 'GET', '/v1/audit')).json
    const check = edited.checks.find((c: { id: string }) => c.id === 'billing.accepted')
    expect(check.status).toBe('fail')
    expect(check.failures.map((f: { detail: string }) => f.detail).join(' ')).toMatch(/does not verify|different proof/)

    h.db.prepare(`DELETE FROM deliveries WHERE proposal_id = ?`).run(id)
    expect((await call(h.app, 'GET', '/v1/audit')).json.checks.find((c: { id: string }) => c.id === 'billing.accepted').status).toBe('fail')
  })
})
