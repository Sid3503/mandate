import { afterEach, describe, expect, it } from 'vitest'
import { live, type LiveEvent } from '../src/services/live'
import { FakeInvoices } from '../src/paypal/fake'
import { agree, BUYER_KEY, call, closeAll, EVIDENCE, harness, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

const AUTOMATION = { billSignedDeals: true, requireAcceptance: false, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 }

async function automate(h: ReturnType<typeof harness>) {
  const current = (await call(h.app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, automation: AUTOMATION } })
}

describe('the live stream', () => {
  it('tells the console what changed, the moment it is written', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const seen: LiveEvent[] = []
    const off = live.subscribe((event) => seen.push(event))
    const deal = await agree(h.app)
    await automate(h)
    await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    off()
    expect(seen.some((event) => event.type === 'changed' && event.scope === 'deal')).toBe(true)
    expect(seen.some((event) => event.type === 'changed' && event.scope === 'rules')).toBe(true)
    expect(seen.some((event) => event.type === 'changed' && event.scope === 'ledger' && event.what === 'invoice.sent')).toBe(true)
  })

  it('serves the owner an event stream, and keeps it from the client\'s key', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    expect((await call(h.app, 'GET', '/v1/stream', { key: BUYER_KEY })).status).toBe(403)
    const response = await h.app.request('http://mandate.test/v1/stream', { headers: { authorization: `Bearer ${OWNER_KEY}` } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    const until = async (needle: string) => {
      const deadline = Date.now() + 3000
      while (!text.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        text += decoder.decode(value, { stream: true })
      }
    }
    await until('event: hello')
    expect(text).toContain('event: hello')
    await agree(h.app)
    await until('"scope":"deal"')
    expect(text).toContain('event: changed')
    expect(text).toContain('"scope":"deal"')
    await reader.cancel()
  })
})

describe('how often the server looks at PayPal', () => {
  it('looks every few seconds while an invoice is out, and once a minute when nothing is', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    expect(h.services.mandate.nextSweepMs()).toBe(60_000)
    const deal = await agree(h.app)
    await automate(h)
    const sent = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/deliver`, { key: STUDIO_KEY, body: { evidenceUrl: EVIDENCE } })
    expect(sent.status).toBe(201)
    expect(h.services.mandate.inFlightCount()).toBe(1)
    expect(h.services.mandate.nextSweepMs()).toBe(5_000)
    expect(h.services.mandate.watcher().everySeconds).toBe(5)
  })
})
