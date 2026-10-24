import { afterEach, describe, expect, it } from 'vitest'
import { centsToPayPal, payableIn, payPalToCents } from '../src/domain/money'
import { call, closeAll, harness, idem, STUDIO_KEY } from './support'

afterEach(closeAll)

describe('amounts in the currency PayPal expects', () => {
  it('writes two decimals for currencies that have them', () => {
    expect(centsToPayPal(9000, 'USD')).toBe('90.00')
    expect(centsToPayPal(125_050, 'EUR')).toBe('1250.50')
    expect(centsToPayPal(500_000, 'INR')).toBe('5000.00')
    expect(payPalToCents('90.00')).toBe(9000)
  })

  it('writes whole units, with no decimals, for currencies PayPal takes only whole', () => {
    expect(centsToPayPal(900_000, 'JPY')).toBe('9000')
    expect(centsToPayPal(150_000, 'HUF')).toBe('1500')
    expect(() => centsToPayPal(900_050, 'JPY')).toThrow(/no decimals/)
    expect(payableIn(900_050, 'JPY')).toBe(false)
    expect(payableIn(900_050, 'EUR')).toBe(true)
  })

  it('refuses at the rules, before PayPal is asked, an amount the currency cannot carry', async () => {
    const { app, paypal } = harness()
    const current = (await call(app, 'GET', '/v1/warrant')).json
    const { id: _id, version: _version, createdAt: _createdAt, ...body } = current
    expect((await call(app, 'PUT', '/v1/warrant', { body: { ...body, currency: 'JPY', fundingRequired: false, standing: [] } })).status).toBe(201)
    const ask = (amountCents: number) => call(app, 'POST', '/v1/proposals', { key: STUDIO_KEY, idem: idem('yen'), body: { payee: 'Priya', amountCents, currency: 'JPY', category: 'design', description: 'Logo work', evidenceUrl: 'https://www.figma.com/file/logo' } })
    const fractional = await ask(15_050)
    expect(fractional.json).toMatchObject({ gate: 'DENY', clause: 'currency.mismatch' })
    expect(fractional.json.detail).toContain('whole units')
    // Whole yen under the ceiling passes this check (and is decided by the rest of the rules).
    expect((await ask(15_000)).json.clause).not.toBe('currency.mismatch')
    expect(paypal!.payoutCalls).toBe(0)
  })
})
