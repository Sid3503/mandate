import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config'
import { Notifier } from '../src/services/notify'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

const URL_SECRET = 'https://hooks.example.test/services/T000/B000/SECRETTOKEN'
const later = () => new Promise((resolve) => setTimeout(resolve, 30))

function setup(fetchImpl?: ConstructorParameters<typeof Notifier>[0]['fetch']) {
  const h = harness()
  const calls: Array<{ url: string; body: Record<string, any> }> = []
  const fetch: NonNullable<ConstructorParameters<typeof Notifier>[0]['fetch']> = fetchImpl ?? (async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 } })
  const notifier = new Notifier({ url: URL_SECRET, repo: h.services.repo, consoleUrl: 'https://mandate.example/app', now: () => NOW, fetch })
  notifier.start()
  return { h, calls, notifier }
}

describe('telling the owner when something needs them', () => {
  it('is off unless an https webhook is given', () => {
    const base = { PORT: '8787', API_KEY: 'a'.repeat(20), PROPOSER_KEY: 'b'.repeat(20) }
    expect(loadConfig(base).notifyWebhookUrl).toBeNull()
    expect(loadConfig({ ...base, NOTIFY_WEBHOOK_URL: URL_SECRET }).notifyWebhookUrl).toBe(URL_SECRET)
    expect(() => loadConfig({ ...base, NOTIFY_WEBHOOK_URL: 'http://hooks.example.test/x' })).toThrow()
    expect(() => loadConfig({ ...base, NOTIFY_WEBHOOK_URL: 'not a url' })).toThrow()
  })

  it('says a request needs a tap, once, with a link and no secret, and says nothing about requests that need nobody', async () => {
    const { h, calls, notifier } = setup()
    const deal = await agree(h.app)
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Milestone', evidenceUrl: EVIDENCE, jobId: JOB, dealId: deal.id, milestone: 0 } })
    expect(asked.json.gate).toBe('NEEDS_APPROVAL')
    await later()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL_SECRET)
    expect(calls[0]!.body.text).toContain('billing Northwind $150.00 needs your tap')
    expect(calls[0]!.body.text).toContain(`https://mandate.example/app/p/${asked.json.id}`)
    // Slack, Discord and Zapier each find their own field.
    expect(calls[0]!.body.content).toBe(calls[0]!.body.text)
    expect(calls[0]!.body.mandate.url).toContain('/app/p/')
    // Asking again is the same request, and nothing new is said.
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Milestone', evidenceUrl: EVIDENCE, jobId: JOB, dealId: deal.id, milestone: 0 } })
    await later()
    expect(calls).toHaveLength(1)
    // A refusal needs nobody, so it says nothing.
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'payment', payee: 'P. Shah', amountCents: 48_000, currency: 'USD', category: 'design', description: 'Fake', evidenceUrl: EVIDENCE } })
    await later()
    expect(calls).toHaveLength(1)
    expect(notifier.status()).toMatchObject({ enabled: true, sent: 1, lastError: null })
    notifier.close()
  })

  it('remembers a failure without the address, and never lets it touch the request', async () => {
    const { h, notifier } = setup(async () => { throw new Error(`could not reach ${URL_SECRET}`) })
    const deal = await agree(h.app)
    const asked = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design', description: 'Milestone', evidenceUrl: EVIDENCE, jobId: JOB, dealId: deal.id, milestone: 0 } })
    expect(asked.status).toBe(201)
    await later()
    const status = notifier.status()
    expect(status.sent).toBe(0)
    expect(status.lastError).toContain('[address]')
    expect(JSON.stringify(status)).not.toContain('SECRETTOKEN')
    notifier.close()
  })

  it('has an owner-only status and test route that never return the address', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/notify')).json).toEqual({ enabled: false, lastSentAt: null, lastError: null, sent: 0 })
    expect((await call(h.app, 'POST', '/v1/notify/test')).status).toBe(409)
    expect((await call(h.app, 'GET', '/v1/notify', { key: STUDIO_KEY })).status).toBe(403)
  })
})
