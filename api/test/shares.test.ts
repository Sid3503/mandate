import { afterEach, describe, expect, it } from 'vitest'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const DAY = 86_400_000

/** A request with no key at all: this is what the holder of a link sends. */
const anonymous = async (app: App, path: string, method = 'GET') => {
  const response = await app.request(`http://mandate.test${path}`, { method })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null, text }
}

async function funded() {
  const h = harness()
  const deal = await agree(h.app)
  const charge = await collect(h.app, deal.id, 0)
  return { ...h, deal, ...charge }
}
const issue = (app: App, partyId: string, extra: Record<string, unknown> = {}) => call(app, 'POST', `/v1/jobs/${JOB}/shares`, { body: { partyId, ...extra } })
const tokenOf = (made: { json: { token: string } }) => made.json.token

describe('status links: a read-only page about one job, for one person', () => {
  it('shows a contractor only their own payouts and whether the client has paid, never the studio totals or rules', async () => {
    const h = await funded()
    await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Share of logo', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: h.captureId } })
    const made = await issue(h.app, 'payee_priya')
    expect(made.status).toBe(201)
    expect(made.json.url).toContain('/app/s/')
    const seen = await anonymous(h.app, `/v1/share/${tokenOf(made)}`)
    expect(seen.status).toBe(200)
    expect(seen.json).toMatchObject({ role: 'contractor', who: 'Priya Shah', with: 'Northwind', jobId: JOB })
    expect(seen.json.contractor.clientPayment).toEqual({ state: 'received', clearsAt: null })
    expect(seen.json.contractor.payouts).toEqual([expect.objectContaining({ amountCents: 9_000, state: 'asked', label: 'Share of logo' })])
    // Nothing the studio keeps private is in the page: no totals, no margin, no rules, no emails, no ids of PayPal objects.
    for (const secret of ['keptCents', 'totals', 'monthlyCap', 'contractorShare', '@example.com', '@northwind', 'captureId', 'cartHash', 'lockSignature']) expect(seen.text).not.toContain(secret)
  })

  it('shows a client only their own invoices, with a way to pay the one that is due', async () => {
    const h = await funded()
    const made = await issue(h.app, 'client_northwind')
    const seen = await anonymous(h.app, `/v1/share/${tokenOf(made)}`)
    expect(seen.json).toMatchObject({ role: 'client', who: 'Northwind', with: null })
    expect(seen.json.client.invoices).toEqual([expect.objectContaining({ amountCents: 15_000, state: 'paid', payUrl: null })])
    expect(seen.text).not.toContain('Priya')
    expect(seen.text).not.toContain('payee_')
  })

  it('answers every kind of wrong, expired or withdrawn link with the same 404, and never accepts a guess', async () => {
    const h = await funded()
    const made = await issue(h.app, 'payee_priya', { ttlDays: 2 })
    const token = tokenOf(made)
    const [id, secret] = token.split('~') as [string, string]
    const bodies = new Set<string>()
    for (const bad of ['nonsense', `${id}~wrong${secret}`, `${id}~`, `~${secret}`, `${id}`, `00000000-0000-0000-0000-000000000000~${secret}`, `${id}~${secret}x`, 'x'.repeat(500)]) {
      const response = await anonymous(h.app, `/v1/share/${encodeURIComponent(bad)}`)
      expect(response.status).toBe(404)
      bodies.add(JSON.stringify(response.json.code))
    }
    expect([...bodies]).toEqual(['"share.unknown"'])
    expect((await anonymous(h.app, `/v1/share/${token}`)).status).toBe(200)
    // Expiry: after the days are up it is the same 404.
    h.setNow(new Date(NOW.getTime() + 3 * DAY))
    const expired = await anonymous(h.app, `/v1/share/${token}`)
    expect(expired.status).toBe(404)
    expect(expired.json.code).toBe('share.unknown')
  })

  it('can be withdrawn by the owner, and only the owner can issue, list or withdraw', async () => {
    const h = await funded()
    expect((await call(h.app, 'POST', `/v1/jobs/${JOB}/shares`, { key: STUDIO_KEY, body: { partyId: 'payee_priya' } })).status).toBe(403)
    const made = await issue(h.app, 'payee_priya')
    expect((await call(h.app, 'GET', `/v1/jobs/${JOB}/shares`, { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'POST', `/v1/shares/${made.json.share.id}/revoke`, { key: STUDIO_KEY })).status).toBe(403)
    const listed = await call(h.app, 'GET', `/v1/jobs/${JOB}/shares`)
    expect(listed.json.data).toEqual([expect.objectContaining({ role: 'contractor', partyName: 'Priya Shah', active: true, views: 0 })])
    // The list never carries the secret, and a view is counted.
    expect(JSON.stringify(listed.json)).not.toContain(tokenOf(made).split('~')[1]!)
    await anonymous(h.app, `/v1/share/${tokenOf(made)}`)
    expect((await call(h.app, 'GET', `/v1/jobs/${JOB}/shares`)).json.data[0].views).toBe(1)
    expect((await call(h.app, 'POST', `/v1/shares/${made.json.share.id}/revoke`)).json.active).toBe(false)
    expect((await anonymous(h.app, `/v1/share/${tokenOf(made)}`)).status).toBe(404)
  })

  it('is read-only: the link opens nothing else, and a key in its place is not the link', async () => {
    const h = await funded()
    const made = await issue(h.app, 'payee_priya')
    const token = tokenOf(made)
    // Using the link as a bearer key, or reaching any other route with no key, gets nothing.
    expect((await call(h.app, 'GET', '/v1/proposals', { key: token })).status).toBe(401)
    expect((await anonymous(h.app, '/v1/proposals')).status).toBe(401)
    expect((await anonymous(h.app, `/v1/share/${token}`, 'POST')).status).toBe(401)
    expect((await anonymous(h.app, `/v1/jobs/${JOB}`)).status).toBe(401)
    // The owner key does not turn a link route into anything else either.
    expect((await call(h.app, 'GET', `/v1/share/${token}`, { key: OWNER_KEY })).status).toBe(200)
  })

  it('will not issue a link for someone who is not on the job, or for a job that does not exist', async () => {
    const h = await funded()
    expect((await issue(h.app, 'payee_nobody')).status).toBe(422)
    expect((await call(h.app, 'POST', '/v1/jobs/job_missing/shares', { body: { partyId: 'payee_priya' } })).status).toBe(404)
    expect((await issue(h.app, 'payee_priya', { ttlDays: 400 })).status).toBe(400)
  })
})
