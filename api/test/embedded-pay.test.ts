import { afterEach, describe, expect, it } from 'vitest'
import { FakeInvoices } from '../src/paypal/fake'
import { call, closeAll, EVIDENCE, harness, JOB, idem, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

/**
 * Paying on our own page. A client with a link that was given the right to pay opens a card form inside the console
 * and settles there. The browser is given an order id and a browser-safe token, and nothing else: the order is made
 * from the lock, and the server re-reads it before it captures, so the amount cannot differ from the amount the owner
 * approved.
 */

const chargeBody = (over: Record<string, unknown> = {}) => ({
  kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design',
  description: 'Northwind logo milestone 1', evidenceUrl: EVIDENCE, jobId: JOB, ...over,
})

/** A locked client charge the client may pay on our page. */
async function payableCharge(app: Parameters<typeof call>[0], overrides: Record<string, unknown> = {}) {
  const asked = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('charge'), body: chargeBody(overrides) })
  const approved = await call(app, 'POST', `/v1/proposals/${asked.json.id}/approve`, { body: { instrument: 'checkout' } })
  expect(approved.status).toBe(200)
  expect(approved.json.payInstrument).toBe('checkout')
  return asked.json.id as string
}

/** A link the client may pay with. */
async function payLink(app: Parameters<typeof call>[0], canPay = true) {
  const made = await call(app, 'POST', `/v1/jobs/${JOB}/shares`, { body: { partyId: 'client_northwind', canPay, ttlDays: 30 } })
  expect(made.status).toBe(201)
  return made.json.token as string
}

describe('paying on our own page', () => {
  it('opens a checkout from the lock, and settles it through the same capture the owner uses', async () => {
    const { app, paypal } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)

    // The buyer's page asks for a session. No key: the link is the proof.
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    expect(session.status).toBe(200)
    expect(session.json).toMatchObject({ proposalId, amountCents: 15_000, currency: 'USD' })
    expect(session.json.orderId).toBeTruthy()
    expect(session.json.clientToken).toBeTruthy()
    // A browser-safe token, not the app's access token.
    expect(paypal!.clientTokenCalls).toBe(1)

    // The order was made from the lock: the same cents, and the request id as the order's custom id.
    const order = paypal!.orders.get(session.json.orderId)!
    expect(order.amountCents).toBe(15_000)
    expect(order.customId).toBe(proposalId)

    // The buyer pays. The browser hands the card to PayPal and the server captures.
    const captured = await call(app, 'POST', `/v1/share/${token}/pay/capture`, { body: { proposalId } })
    expect(captured.status).toBe(200)
    expect(captured.json.phase).toBe('captured')
    expect(captured.json.captureId).toBeTruthy()
    expect(captured.json.capturedAmountCents).toBe(15_000)
  })

  it('will not capture a bill whose amount no longer matches the lock', async () => {
    const { app, paypal } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    // PayPal says the order is for a different sum. The lock holds, so nothing is captured.
    paypal!.mutateAmount(session.json.orderId, 1_500_000)
    const captured = await call(app, 'POST', `/v1/share/${token}/pay/capture`, { body: { proposalId } })
    expect(captured.status).toBe(409)
    expect(captured.json.code).toBe('cart.immutable')
    expect(paypal!.captureCalls).toBe(0)
  })

  it('will not capture a bill the buyer has not approved', async () => {
    const { app, paypal } = harness()
    paypal!.autoApprove = false
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    const captured = await call(app, 'POST', `/v1/share/${token}/pay/capture`, { body: { proposalId } })
    expect(captured.status).toBe(409)
    expect(captured.json.code).toBe('paypal.buyer_pending')
    expect(paypal!.captureCalls).toBe(0)
  })

  it('settles by itself when the buyer approved it and closed the browser', async () => {
    const { app, paypal } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    paypal!.approve(session.json.orderId)
    // The buyer never called capture. The server's own sweep finishes it.
    await app.request('http://mandate.test/v1/today', { headers: { authorization: `Bearer ${OWNER_KEY}` } })
    const swept = await call(app, 'POST', `/v1/proposals/${proposalId}/capture`)
    expect(swept.json.phase).toBe('captured')
  })
})

describe('who may pay on our own page', () => {
  it('refuses a link that was not given the right to pay', async () => {
    const { app } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app, false)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    expect(session.status).toBe(404)
    expect(session.json.code).toBe('share.unknown')
  })

  it('refuses a link that was withdrawn', async () => {
    const { app } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const shareId = token.split('~')[0]!
    await call(app, 'POST', `/v1/shares/${shareId}/revoke`)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    expect(session.status).toBe(404)
  })

  it('may pay any of that client\'s bills on that job, and nothing else', async () => {
    const { app } = harness()
    const proposalId = await payableCharge(app)
    const other = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('other'), body: chargeBody({ amountCents: 9_000, description: 'another bill' }) })
    await call(app, 'POST', `/v1/proposals/${other.json.id}/approve`, { body: { instrument: 'checkout' } })
    const token = await payLink(app)
    // The client's own second bill: the link may pay it.
    const mine = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId: other.json.id } })
    expect(mine.status).toBe(200)
    // A bill for somebody else on the same job: it may not.
    const stranger = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('stranger'), body: chargeBody({ payee: 'Priya', amountCents: 9_000, description: 'not the client\'s' }) })
    const notMine = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId: stranger.json.id } })
    expect(notMine.status).toBe(404)
    expect(proposalId).toBeTruthy()
  })

  it('refuses a payment that came from another site', async () => {
    const { app } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await app.request(`http://mandate.test/v1/share/${token}/pay/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' },
      body: JSON.stringify({ proposalId }),
    })
    expect(session.status).toBe(403)
    expect((await session.json()).code).toBe('auth.origin')
  })

  it('never lets a link pay money out', async () => {
    const { app } = harness()
    await payableCharge(app)
    const payout = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('payout'), body: { kind: 'payment', payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB } })
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId: payout.json.id } })
    expect(session.status).toBe(404)
  })
})

describe('one bill, one instrument', () => {
  it('refuses to pay on the page a bill PayPal already invoiced', async () => {
    const { app } = harness({ invoices: new FakeInvoices() })
    const asked = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('charge'), body: chargeBody() })
    await call(app, 'POST', `/v1/proposals/${asked.json.id}/approve`, { body: { instrument: 'invoice' } })
    await call(app, 'POST', `/v1/proposals/${asked.json.id}/capture`)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId: asked.json.id } })
    expect(session.status).toBe(409)
    expect(session.json.code).toBe('pay.invoice_open')
  })

  it('does not invoice a bill the owner said to be paid on our page', async () => {
    const { app } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    // The charge is settled through an order, never an invoice, so there is no invoice id on it.
    const row = await call(app, 'GET', `/v1/proposals/${proposalId}`)
    expect(row.json.invoiceId).toBeNull()
    expect(row.json.orderId).toBeTruthy()
  })

  it('opens an order for a card on our page with no way back to PayPal', async () => {
    const { app, paypal } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    // A card is taken on our page, so PayPal must not be given a way to send the buyer back to PayPal.
    expect(paypal!.lastReturnUrl).toBeNull()
  })

  it('knows a card order from a checkout order by the way back, not by the link', async () => {
    const { app, paypal } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    // PayPal gives a card order a payer-action link too, so the link is not the signal. What we opened is.
    const live = await paypal!.getOrder(session.json.orderId)
    expect(live.approveUrl).toBeTruthy()
    const row = await call(app, 'GET', `/v1/proposals/${proposalId}`)
    expect(row.json.orderKind).toBe('card')
  })

  it('replaces an order that was opened as a PayPal checkout, so a card can be taken', async () => {
    const { app, paypal } = harness()
    paypal!.autoApprove = false
    const asked = await call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('charge'), body: chargeBody() })
    await call(app, 'POST', `/v1/proposals/${asked.json.id}/approve`, { body: { instrument: 'checkout' } })
    // The bill was opened as the ordinary PayPal checkout, with a way back to PayPal, so a card cannot be taken on it.
    const wrong = await paypal!.createOrder({
      proposalId: asked.json.id, amountCents: 15_000, currency: 'USD', description: 'x', payeeEmail: null,
      returnUrl: 'https://127.0.0.1:8787/app/p/x?paypal=return',
    })
    await call(app, 'POST', `/v1/proposals/${asked.json.id}/capture`)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId: asked.json.id } })
    expect(session.status).toBe(200)
    // A different order, opened for a card, with no way back to PayPal.
    expect(session.json.orderId).not.toBe(wrong.orderId)
    expect(paypal!.orders.get(session.json.orderId)!.cardFlow).toBe(true)
    // The old one was never captured, so no money moved.
    expect(paypal!.orders.get(wrong.orderId)!.status).toBe('CREATED')
  })
  it('settles a bill the buyer paid in PayPal instead, with one settle line that says nobody pressed anything', async () => {
    const { app, paypal, services } = harness()
    paypal!.autoApprove = false
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    // The buyer used the PayPal button on the same order, and nobody called capture.
    paypal!.approve(session.json.orderId)
    await services.mandate.sweepPending()
    const row = await call(app, 'GET', `/v1/proposals/${proposalId}`)
    expect(row.json.phase).toBe('captured')
    const settles = services.repo.eventsFor(proposalId).filter((event) => event.type === 'capture.completed')
    expect(settles).toHaveLength(1)
    expect(JSON.parse(settles[0]!.payload_json)).toMatchObject({ amountCents: 15_000, by: 'server' })
  })

  it('writes no settle line when the server refuses an order that no longer matches the lock', async () => {
    const { app, paypal, services } = harness()
    paypal!.autoApprove = false
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    const session = await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    paypal!.mutateAmount(session.json.orderId, 1_500)
    paypal!.approve(session.json.orderId)
    const refreshed = await services.mandate.refreshOrder(session.json.orderId, 'server')
    expect(refreshed.refreshed).toBe(false)
    expect(services.repo.eventsFor(proposalId).some((event) => event.type === 'capture.completed')).toBe(false)
  })

  it('does not log a replaced order when the bill is already paid', async () => {
    const { app, db, services } = harness()
    const proposalId = await payableCharge(app)
    const token = await payLink(app)
    await call(app, 'POST', `/v1/share/${token}/pay/session`, { body: { proposalId } })
    await call(app, 'POST', `/v1/share/${token}/pay/capture`, { body: { proposalId } })
    // As if it had been paid through a checkout order an older build opened.
    db.prepare("UPDATE proposals SET order_kind = 'checkout' WHERE id = ?").run(proposalId)
    const again = await services.mandate.paySession(proposalId).catch((error: { status?: number }) => error)
    expect((again as { status?: number }).status).toBe(409)
    expect(services.repo.eventsFor(proposalId).some((event) => event.type === 'order.replaced')).toBe(false)
  })
})
