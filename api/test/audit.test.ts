import { afterEach, describe, expect, it } from 'vitest'
import { FakeWatch } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

type App = Parameters<typeof call>[0]
const RULE = { id: 'priya_from_northwind', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }
const audit = async (app: App, query = '') => (await call(app, 'GET', `/v1/audit${query}`)).json
const failing = (report: { checks: Array<{ id: string; status: string }> }) => report.checks.filter((check) => check.status === 'fail').map((check) => check.id).sort()

/** The frozen job, start to finish: a tapped charge, a tapped payout, and a second payout the owner's rule sent. */
async function worked() {
  const h = harness()
  const deal = await agree(h.app)
  const one = await collect(h.app, deal.id, 0)
  const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'M1 share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: one.captureId } })
  await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
  await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/capture`)
  const current = (await call(h.app, 'GET', '/v1/warrant')).json
  const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
  await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, standing: [RULE] } })
  const two = await collect(h.app, deal.id, 1)
  const auto = await call(h.app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem(), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'M2 share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: two.captureId } })
  expect(auto.json).toMatchObject({ clause: 'standing.matched', phase: 'captured' })
  return { ...h, deal, one, two, tapped: payout.json.id as string, auto: auto.json.id as string }
}

describe('the audit', () => {
  it('is for the owner only, and passes on an empty ledger', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/audit', { key: STUDIO_KEY })).status).toBe(403)
    const report = await audit(h.app)
    expect(report.ok).toBe(true)
    expect(report.totals).toMatchObject({ requests: 0, moved: 0 })
    expect(report.agentReach).toMatchObject({ toolkitTools: 47, agentCanCallDirectly: 0, mcpTools: 6 })
  })

  it('passes on the whole frozen job: a tapped payout and a payout a rule sent', async () => {
    const h = await worked()
    const report = await audit(h.app)
    expect(failing(report)).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.totals).toMatchObject({ requests: 4, moved: 4, deals: 1, jobs: 1 })
    expect(Object.fromEntries(report.checks.map((check: { id: string; checked: number }) => [check.id, check.checked]))).toMatchObject({ 'locks.valid': 4, 'moved.authorised': 4, 'amounts.match': 4, 'deals.signed': 3 })
  })

  it('catches an amount changed after approval', async () => {
    const h = await worked()
    h.db.prepare('UPDATE proposals SET amount_cents = 90000 WHERE id = ?').run(h.tapped)
    const report = await audit(h.app)
    expect(report.ok).toBe(false)
    expect(failing(report)).toEqual(expect.arrayContaining(['locks.valid', 'amounts.match']))
    expect(report.checks.find((check: { id: string }) => check.id === 'locks.valid').failures[0]).toMatchObject({ proposalId: h.tapped })
  })

  it('catches a settled amount that differs from the lock', async () => {
    const h = await worked()
    h.db.prepare('UPDATE proposals SET captured_amount_cents = 9100 WHERE id = ?').run(h.auto)
    expect(failing(await audit(h.app))).toEqual(['amounts.match', 'jobs.in_covers_out'].filter((id) => id === 'amounts.match'))
  })

  it('catches money that moved with no yes: a deleted approval, or a signature removed', async () => {
    const h = await worked()
    h.db.prepare(`DELETE FROM events WHERE proposal_id = ? AND type = 'proposal.approved'`).run(h.tapped)
    expect(failing(await audit(h.app))).toEqual(['moved.authorised'])
    const h2 = await worked()
    h2.db.prepare('UPDATE proposals SET lock_sig = NULL WHERE id = ?').run(h2.auto)
    expect(failing(await audit(h2.app))).toEqual(expect.arrayContaining(['locks.valid', 'moved.authorised']))
  })

  it('catches a payout bigger than its share of the client payment, and a job that paid out more than came in', async () => {
    const h = await worked()
    h.db.prepare('UPDATE proposals SET amount_cents = 40000, captured_amount_cents = 40000 WHERE id = ?').run(h.auto)
    const report = await audit(h.app)
    expect(failing(report)).toEqual(expect.arrayContaining(['payouts.funded', 'jobs.in_covers_out', 'locks.valid']))
  })

  it('catches a month that passed the cap, judged by the cap that was in force', async () => {
    const h = await worked()
    const row = h.db.prepare(`SELECT body_json FROM warrants WHERE version = 1`).get() as { body_json: string }
    h.db.prepare(`UPDATE warrants SET body_json = ? WHERE version = 1`).run(JSON.stringify({ ...JSON.parse(row.body_json), monthlyCapCents: 5_000 }))
    h.db.prepare(`UPDATE warrants SET body_json = ? WHERE version = 2`).run(JSON.stringify({ ...JSON.parse((h.db.prepare(`SELECT body_json FROM warrants WHERE version = 2`).get() as { body_json: string }).body_json), monthlyCapCents: 5_000 }))
    expect(failing(await audit(h.app))).toEqual(['cap.respected'])
  })

  it('catches a settlement the ledger never recorded, and a deal that was edited', async () => {
    const h = await worked()
    h.db.prepare(`DELETE FROM events WHERE proposal_id = ? AND type = 'payout.completed'`).run(h.tapped)
    expect(failing(await audit(h.app))).toEqual(['history.complete'])
    const h2 = await worked()
    const deal = h2.db.prepare('SELECT terms_json FROM deals WHERE id = ?').get(h2.deal.id) as { terms_json: string }
    h2.db.prepare('UPDATE deals SET terms_json = ? WHERE id = ?').run(deal.terms_json.replace('15000', '99000'), h2.deal.id)
    const report = await audit(h2.app)
    expect(failing(report)).toEqual(expect.arrayContaining(['deals.signed']))
  })

  it('compares with PayPal\'s own history when asked, and does not hold the newest payments against it', async () => {
    const watch = new FakeWatch()
    const h = harness({ watch })
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    // Just settled: PayPal's report has not caught up, and that is said, not failed.
    const fresh = await audit(h.app, '?paypal=1')
    expect(fresh.checks.find((check: { id: string }) => check.id === 'paypal.agrees')).toMatchObject({ status: 'pass', checked: 1, note: expect.stringContaining('too new') })

    h.setNow(new Date(NOW.getTime() + 3 * 86_400_000))
    const stale = await audit(h.app, '?paypal=1')
    expect(stale.checks.find((check: { id: string }) => check.id === 'paypal.agrees')).toMatchObject({ status: 'fail' })
    watch.transactions = [{ id: paid.captureId, date: NOW.toISOString(), cents: 15_000, currency: 'USD', status: 'S', eventCode: 'T0006', subject: null, counterparty: null, referenceId: null, invoiceId: null, customId: paid.proposalId }]
    expect((await audit(h.app, '?paypal=1')).checks.find((check: { id: string }) => check.id === 'paypal.agrees')).toMatchObject({ status: 'pass', checked: 1 })
  })
})
