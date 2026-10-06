import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices, FakePayPal, FakeWatch } from '../src/paypal/fake'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, STUDIO_KEY } from './support'

afterEach(closeAll)

const payoutBody = (fundingCaptureId: string) => ({ payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'Milestone 1 share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId })

async function funded(options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options)
  const deal = await agree(h.app)
  const charge = await collect(h.app, deal.id, 0)
  return { ...h, deal, ...charge }
}

async function approvedPayout(h: Awaited<ReturnType<typeof funded>>) {
  const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: payoutBody(h.captureId) })
  if (payout.json.gate === 'DENY') return payout.json as { id: string; gate: string; clause: string }
  await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)
  return payout.json as { id: string; gate: string; clause: string }
}

const dispute = (captureId: string, status = 'UNDER_REVIEW') => ({ id: 'PP-D-1', status, reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', cents: 15_000, currency: 'USD', openedAt: null, updatedAt: null, transactionIds: [captureId] })

describe('which PayPal features the app may use', () => {
  it('reads the token scopes and says what each missing feature costs, with the steps to turn it on', async () => {
    const h = harness()
    h.paypal!.scopeList = h.paypal!.scopeList.filter((scope) => !scope.includes('invoicing') && !scope.includes('reporting'))
    const result = await call(h.app, 'GET', '/v1/paypal/features')
    expect(result.status).toBe(200)
    const byId = Object.fromEntries(result.json.features.map((item: { id: string }) => [item.id, item]))
    expect(byId.invoicing).toMatchObject({ enabled: false, core: false })
    expect(byId.invoicing.steps.join(' ')).toContain('tick Invoicing')
    expect(byId.transactions.enabled).toBe(false)
    expect(byId.payouts.enabled).toBe(true)
    expect(byId.disputes.enabled).toBe(true)
  })

  it('asks PayPal for a fresh token when the owner presses Check again', async () => {
    const h = harness()
    await call(h.app, 'POST', '/v1/paypal/features/check')
    expect(h.paypal!.scopeChecks).toBe(1)
  })

  it('is for the owner only', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/paypal/features', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/paypal/activity', { key: STUDIO_KEY })).status).toBe(403)
  })
})

describe('cancelling a payout PayPal is holding', () => {
  it('returns the money and frees the reservation', async () => {
    const paypal = new FakePayPal()
    paypal.unregistered.add('priya.shah@example.com')
    const h = await funded({ paypal })
    const payout = await approvedPayout(h)
    const sent = await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)
    expect(sent.json.phase).toBe('payout_unclaimed')

    const cancelled = await call(h.app, 'POST', `/v1/proposals/${payout.id}/cancel-payout`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.json).toMatchObject({ phase: 'payout_failed', payoutStatus: 'RETURNED' })
    expect(paypal.cancelCalls).toBe(1)
    const packet = (await call(h.app, 'GET', `/v1/proposals/${payout.id}/packet`)).json
    expect(packet.events.map((event: { type: string }) => event.type)).toContain('payout.cancelled')
    const job = (await call(h.app, 'GET', `/v1/jobs/${JOB}`)).json
    expect(job.totals).toEqual({ inCents: 15_000, outCents: 0, heldCents: 0, keptCents: 15_000 })
  })

  it('refuses to cancel a payout PayPal already delivered', async () => {
    const h = await funded()
    const payout = await approvedPayout(h)
    expect((await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)).json.phase).toBe('captured')
    const refused = await call(h.app, 'POST', `/v1/proposals/${payout.id}/cancel-payout`)
    expect(refused.status).toBe(409)
    expect(h.paypal!.cancelCalls).toBe(0)
  })
})

describe('sending the buyer back', () => {
  it('asks PayPal to return the buyer to this receipt after they approve', async () => {
    const paypal = new FakePayPal()
    paypal.autoApprove = false
    const h = harness({ paypal })
    const deal = await agree(h.app)
    const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${bill.json.id}/capture`)
    expect(paypal.lastReturnUrl).toBe(`http://127.0.0.1:8787/app/p/${bill.json.id}?paypal=return`)
  })
})

describe('reminding and cancelling an invoice', () => {
  async function invoiced() {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const deal = await agree(h.app)
    const bill = await call(h.app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    const id = bill.json.id as string
    await call(h.app, 'POST', `/v1/proposals/${id}/approve`)
    expect((await call(h.app, 'POST', `/v1/proposals/${id}/capture`)).json.phase).toBe('invoice_sent')
    return { ...h, deal, id, invoices }
  }

  it('reminds the client through PayPal and records it', async () => {
    const { app, id, invoices } = await invoiced()
    expect((await call(app, 'POST', `/v1/proposals/${id}/remind-invoice`)).status).toBe(200)
    expect(invoices.remindCalls).toHaveLength(1)
    const events = (await call(app, 'GET', `/v1/proposals/${id}/packet`)).json.events.map((event: { type: string }) => event.type)
    expect(events).toContain('invoice.reminded')
  })

  it('voids a wrong invoice, and the milestone can be billed again', async () => {
    const { app, id, deal, invoices } = await invoiced()
    const cancelled = await call(app, 'POST', `/v1/proposals/${id}/cancel-invoice`)
    expect(cancelled.json).toMatchObject({ phase: 'invoice_cancelled', invoiceStatus: 'CANCELLED' })
    expect([...invoices.invoices.values()][0]!.status).toBe('CANCELLED')
    const again = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/0/bill`, { body: { evidenceUrl: EVIDENCE } })
    expect(again.status).toBe(201)
    expect(again.json.gate).not.toBe('DENY')
  })

  it('refuses when there is no open invoice', async () => {
    const h = await funded()
    expect((await call(h.app, 'POST', `/v1/proposals/${h.proposalId}/remind-invoice`)).status).toBe(503)
    const { app, id, invoices } = await invoiced()
    invoices.pay([...invoices.invoices.keys()][0]!)
    await call(app, 'POST', `/v1/proposals/${id}/capture`)
    const refused = await call(app, 'POST', `/v1/proposals/${id}/cancel-invoice`)
    expect(refused.status).toBe(409)
  })
})

describe('a client dispute blocks the payout it funds', () => {
  it('denies a new payout that cites a disputed client payment', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    watch.disputes = [dispute(h.captureId)]
    const synced = await call(h.app, 'POST', '/v1/paypal/disputes/sync')
    expect(synced.json).toMatchObject({ checked: true, open: 1 })
    const payout = await approvedPayout(h)
    expect(payout).toMatchObject({ gate: 'DENY', clause: 'funding.disputed' })
    const events = (await call(h.app, 'GET', `/v1/proposals/${h.proposalId}/packet`)).json.events.map((event: { type: string }) => event.type)
    expect(events).toContain('dispute.opened')
  })

  it('stops an approved payout at capture, before PayPal is called, and lets it go once resolved', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    const payout = await approvedPayout(h)
    expect(payout.gate).not.toBe('DENY')
    watch.disputes = [dispute(h.captureId)]
    const blocked = await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)
    expect(blocked.status).toBe(409)
    expect(blocked.json.code).toBe('funding.disputed')
    expect(h.paypal!.payoutCalls).toBe(0)

    watch.disputes = [dispute(h.captureId, 'RESOLVED')]
    const released = await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)
    expect(released.json.phase).toBe('captured')
    const events = (await call(h.app, 'GET', `/v1/proposals/${h.proposalId}/packet`)).json.events.map((event: { type: string }) => event.type)
    expect(events).toEqual(expect.arrayContaining(['dispute.opened', 'dispute.resolved']))
  })

  it('waits, rather than guessing, when PayPal cannot say whether the payment is disputed', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    const payout = await approvedPayout(h)
    watch.failStatus = 502
    const waiting = await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)
    expect(waiting.status).toBe(503)
    expect(waiting.json.code).toBe('funding.unverifiable')
    expect(h.paypal!.payoutCalls).toBe(0)
  })

  it('carries on when the app has no permission to look at disputes', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    const payout = await approvedPayout(h)
    watch.failStatus = 403
    expect((await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)).json.phase).toBe('captured')
    const synced = await call(h.app, 'POST', '/v1/paypal/disputes/sync')
    expect(synced.json).toMatchObject({ checked: false, open: 0 })
  })
})

describe('comparing the PayPal account with the ledger', () => {
  const txn = (id: string, cents: number, extra: Record<string, unknown> = {}) => ({ id, date: '2026-10-03T10:00:00+0000', cents, currency: 'USD', status: 'S', eventCode: 'T0006', subject: null, counterparty: null, referenceId: null, invoiceId: null, customId: null, ...extra })

  it('matches what Mandate moved and flags what it did not', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    watch.transactions = [txn(h.captureId, 15_000), txn('EXTERNAL-1', -4_800, { subject: 'Font licence' }), txn('X-2', 2_000, { customId: h.proposalId })]
    const result = await call(h.app, 'GET', '/v1/paypal/activity')
    expect(result.json).toMatchObject({ available: true, matched: 2, unmatched: 1, unmatchedNetCents: -4_800 })
    expect(result.json.rows.find((row: { id: string }) => row.id === 'EXTERNAL-1').proposalId).toBeNull()
    expect(result.json.rows.find((row: { id: string }) => row.id === h.captureId).proposalId).toBe(h.proposalId)
  })

  it('says so, instead of failing, when Transaction Search is off', async () => {
    const watch = new FakeWatch()
    watch.failStatus = 403
    const h = harness({ watch })
    const result = await call(h.app, 'GET', '/v1/paypal/activity')
    expect(result.status).toBe(200)
    expect(result.json).toMatchObject({ available: false })
  })
})

describe('webhooks', () => {
  const event = (id: string, type: string, resource: Record<string, unknown> = {}) => ({ id, event_type: type, resource })
  const post = (app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }, body: unknown) =>
    app.request('http://mandate.test/v1/webhooks/paypal', { method: 'POST', body: JSON.stringify(body) })

  it('rejects a delivery PayPal does not vouch for, when a webhook id is set', async () => {
    const h = harness({ webhookId: 'WH-1' })
    h.paypal!.webhookValid = false
    expect((await post(h.app, event('E1', 'PAYMENT.PAYOUTSBATCH.SUCCESS'))).status).toBe(401)
    h.paypal!.webhookValid = true
    expect((await post(h.app, event('E1', 'PAYMENT.PAYOUTSBATCH.SUCCESS'))).status).toBe(200)
  })

  it('handles a repeated delivery once', async () => {
    const h = harness()
    const first = await (await post(h.app, event('E2', 'PAYMENT.PAYOUTSBATCH.SUCCESS'))).json()
    const second = await (await post(h.app, event('E2', 'PAYMENT.PAYOUTSBATCH.SUCCESS'))).json()
    expect(first.duplicate).toBeUndefined()
    expect(second.duplicate).toBe(true)
  })

  it('reads disputes again when PayPal says one changed', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    watch.disputes = [dispute(h.captureId)]
    const result = await (await post(h.app, event('E3', 'CUSTOMER.DISPUTE.CREATED'))).json()
    expect(result.refreshed).toBe(true)
    expect(watch.calls.disputes).toBe(1)
    expect((await call(h.app, 'GET', '/v1/paypal/disputes')).json.data).toHaveLength(1)
  })
})

describe('the account balance', () => {
  it('reports what PayPal says and when, and says so plainly when the app may not look', async () => {
    const h = harness()
    h.paypal!.balanceCents = 534_124
    expect((await call(h.app, 'GET', '/v1/paypal/balance')).json).toMatchObject({ available: true, availableCents: 534_124, currency: 'USD', asOf: '2026-10-03T06:00:00Z' })
    h.paypal!.balanceFails = 403
    expect((await call(h.app, 'GET', '/v1/paypal/balance')).json).toMatchObject({ available: false })
    expect((await call(h.app, 'GET', '/v1/paypal/balance', { key: STUDIO_KEY })).status).toBe(403)
  })
})

describe('reading PayPal\'s own shapes', () => {
  it('parses a transaction the way PayPal\'s reporting API returns it, with signs and cents exact', async () => {
    const { parseTransaction } = await import('../src/paypal/watch')
    const income = parseTransaction({ transaction_info: { transaction_id: '116217535A663733R', transaction_event_code: 'T0006', transaction_initiation_date: '2026-10-05T07:00:03+0000', transaction_amount: { currency_code: 'USD', value: '150.00' }, transaction_status: 'S', invoice_id: 'MND-801E5B4ED2CF4E35' }, payer_info: { email_address: 'sb-jxwz553178202@personal.example.com', payer_name: { alternate_full_name: 'John Doe' } } })
    expect(income).toMatchObject({ id: '116217535A663733R', cents: 15_000, currency: 'USD', status: 'S', eventCode: 'T0006', invoiceId: 'MND-801E5B4ED2CF4E35', counterparty: 'sb-jxwz553178202@personal.example.com' })
    const payout = parseTransaction({ transaction_info: { transaction_id: '6LD8478255700282K', transaction_amount: { currency_code: 'USD', value: '-90.25' }, transaction_status: 'S' } })
    expect(payout).toMatchObject({ cents: -9_025, counterparty: null })
    expect(parseTransaction({ transaction_info: {} })).toBeNull()
  })

  it('parses a dispute and the payment it is on', async () => {
    const { parseDispute } = await import('../src/paypal/watch')
    const dispute = parseDispute({ dispute_id: 'PP-D-27803', create_time: '2026-10-06T09:00:00.000Z', update_time: '2026-10-06T09:05:00.000Z', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', dispute_state: 'REQUIRED_ACTION', dispute_amount: { currency_code: 'USD', value: '150.00' } }, ['63168379KF7336631'])
    expect(dispute).toMatchObject({ id: 'PP-D-27803', status: 'WAITING_FOR_SELLER_RESPONSE', cents: 15_000, transactionIds: ['63168379KF7336631'] })
  })

  it('treats any status but RESOLVED as a dispute that still holds the payout', async () => {
    const watch = new FakeWatch()
    const h = await funded({ watch })
    for (const status of ['OPEN', 'WAITING_FOR_BUYER_RESPONSE', 'WAITING_FOR_SELLER_RESPONSE', 'UNDER_REVIEW', 'OTHER']) {
      watch.disputes = [dispute(h.captureId, status)]
      await call(h.app, 'POST', '/v1/paypal/disputes/sync')
      expect((h.repo.openDisputeFor(h.captureId))?.status, status).toBe(status)
    }
    watch.disputes = [dispute(h.captureId, 'RESOLVED')]
    await call(h.app, 'POST', '/v1/paypal/disputes/sync')
    expect(h.repo.openDisputeFor(h.captureId)).toBeNull()
  })
})

describe('cancelling before PayPal has finished the batch', () => {
  it('explains the wait instead of failing, and changes nothing', async () => {
    const paypal = new FakePayPal()
    paypal.unregistered.add('priya.shah@example.com')
    const h = await funded({ paypal })
    const payout = await approvedPayout(h)
    await call(h.app, 'POST', `/v1/proposals/${payout.id}/capture`)
    paypal.cancelPayoutItem = async () => { throw new (await import('../src/paypal/port')).PayPalError(400, 'BATCH_NOT_COMPLETED', null, 'Only item belonging to a batch in Processed status can be cancelled.') }
    const early = await call(h.app, 'POST', `/v1/proposals/${payout.id}/cancel-payout`)
    expect(early.status).toBe(409)
    expect(early.json.code).toBe('payout.batch_processing')
    expect((await call(h.app, 'GET', `/v1/proposals/${payout.id}`)).json.phase).toBe('payout_unclaimed')
  })
})
