import { afterEach, describe, expect, it } from 'vitest'
import { createPayPalClient } from '../src/paypal/client'
import { agree, call, closeAll, collect, harness } from './support'

afterEach(closeAll)

/** A capture response shaped the way PayPal shapes one, so the reader is tested against the real field names. */
const captureResponse = (breakdown: Record<string, unknown> | null) => ({
  id: 'ORDER-1',
  status: 'COMPLETED',
  purchase_units: [{
    payments: {
      captures: [{
        id: 'CAP-1',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '150.00' },
        ...(breakdown ? { seller_receivable_breakdown: breakdown } : {}),
      }],
    },
  }],
})

const client = (body: unknown) => createPayPalClient({
  clientId: 'id',
  clientSecret: 'secret',
  baseUrl: 'https://api-m.sandbox.paypal.com',
  fetch: (async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/v1/oauth2/token')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 300 }), { status: 200 })
    return new Response(JSON.stringify(body), { status: 201 })
  }) as typeof fetch,
})

describe('what PayPal says it took on a capture', () => {
  it('reads the fee and the net out of seller_receivable_breakdown', async () => {
    const paypal = client(captureResponse({
      gross_amount: { currency_code: 'USD', value: '150.00' },
      paypal_fee: { currency_code: 'USD', value: '4.65' },
      net_amount: { currency_code: 'USD', value: '145.35' },
    }))
    const captured = await paypal.captureOrder('ORDER-1', '11111111-1111-4111-8111-111111111111')
    expect(captured).toMatchObject({ captureId: 'CAP-1', amountCents: 15_000, feeCents: 465, netCents: 14_535 })
  })

  it('leaves both null when PayPal states no breakdown, never zero', async () => {
    const captured = await client(captureResponse(null)).captureOrder('ORDER-1', '11111111-1111-4111-8111-111111111111')
    expect(captured.feeCents).toBeNull()
    expect(captured.netCents).toBeNull()
  })

  it('reads a fee PayPal states without a net, and a net without a fee', async () => {
    const feeOnly = await client(captureResponse({ paypal_fee: { currency_code: 'USD', value: '4.65' } })).captureOrder('ORDER-1', '11111111-1111-4111-8111-111111111111')
    expect(feeOnly).toMatchObject({ feeCents: 465, netCents: null })
    const netOnly = await client(captureResponse({ net_amount: { currency_code: 'USD', value: '145.35' } })).captureOrder('ORDER-1', '11111111-1111-4111-8111-111111111111')
    expect(netOnly).toMatchObject({ feeCents: null, netCents: 14_535 })
  })
})

describe('the capture fee reaches the row', () => {
  it('stores what PayPal stated and shows it on the proposal', async () => {
    // No invoice port, so the charge settles through Orders and this caller of markCaptured runs.
    const h = harness()
    const deal = await agree(h.app)
    const { proposalId } = await collect(h.app, deal.id, 0)
    const row = (await call(h.app, 'GET', `/v1/proposals/${proposalId}`)).json
    // The fake stands in with PayPal's published US rate (2.9% + $0.30) for a 150.00 capture.
    expect(row).toMatchObject({ phase: 'captured', captureFeeCents: 465, captureNetCents: 14_535 })
    const stored = h.repo.proposal(proposalId)!
    expect(stored).toMatchObject({ capture_fee_cents: 465, capture_net_cents: 14_535 })
  })

  it('keeps a fee PayPal already stated when a later read does not repeat it', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const { proposalId } = await collect(h.app, deal.id, 0)
    const captureId = h.repo.proposal(proposalId)!.capture_id!
    // A re-read that states no fee (the invoice path, or a sweep) must not erase the fee PayPal already gave us.
    h.repo.markCaptured(proposalId, captureId, 15_000, 15_000, new Date().toISOString())
    const stored = h.repo.proposal(proposalId)!
    expect(stored).toMatchObject({ capture_fee_cents: 465, capture_net_cents: 14_535 })
  })
})
