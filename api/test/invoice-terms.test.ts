import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalCart, cartHash, type CartFields } from '../src/domain/hash'
import { ProposalCreateSchema } from '../src/domain/schemas'
import { FakeInvoices } from '../src/paypal/fake'
import { createToolkitInvoices, invoiceDraftBody, type InvoiceRequest } from '../src/paypal/invoices'
import { allowRawWrites, call, closeAll, EVIDENCE, harness, idem, JOB, NOW } from './support'

afterEach(closeAll)

const DAY = 86_400_000
const ITEMS = [
  { description: 'Logo concepts', quantity: 2, unitCents: 5_000 },
  { description: 'Final files', quantity: 1, unitCents: 5_000 },
]
const bill = (extra: Record<string, unknown> = {}) => ({
  kind: 'charge', payee: 'Northwind', amountCents: 15_000, currency: 'USD', category: 'design',
  description: 'Northwind logo bill', evidenceUrl: EVIDENCE, prompt: 'Bill Northwind', jobId: JOB,
  lineItems: ITEMS, dueDate: '2026-10-17', customerNote: 'Thank you for the work together.', ...extra,
})
const plainBill = () => bill({ lineItems: undefined, dueDate: undefined, customerNote: undefined })
const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10)

async function approved(h: ReturnType<typeof harness>, body: Record<string, unknown> = bill()) {
  const made = await call(h.app, 'POST', '/v1/proposals', { idem: idem('t'), body })
  expect(made.status).toBe(201)
  expect((await call(h.app, 'POST', `/v1/proposals/${made.json.id}/approve`)).status).toBe(200)
  return made.json.id as string
}

describe('bill terms: the schema', () => {
  const parse = (extra: Record<string, unknown>) => ProposalCreateSchema.safeParse({ ...bill(), ...extra })

  it('accepts items, a due date and a note, and strips angle brackets', () => {
    const ok = parse({ lineItems: [{ description: '  <b>Logo</b> <script>alert(1)</script>', quantity: 1, unitCents: 15_000 }], customerNote: 'Hi <img src=x onerror=alert(1)>' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.lineItems![0]!.description).toBe('bLogo/b scriptalert(1)/script')
      expect(ok.data.customerNote).toBe('Hi img src=x onerror=alert(1)')
      expect(JSON.stringify(ok.data)).not.toMatch(/[<>]/)
    }
  })

  it('holds the bounds', () => {
    expect(parse({ lineItems: [] }).success).toBe(false)
    expect(parse({ lineItems: Array.from({ length: 21 }, () => ITEMS[0]) }).success).toBe(false)
    expect(parse({ lineItems: Array.from({ length: 20 }, () => ITEMS[0]) }).success).toBe(true)
    expect(parse({ lineItems: [{ description: '', quantity: 1, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: '<>', quantity: 1, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: 'x'.repeat(201), quantity: 1, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: 'x', quantity: 0, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: 'x', quantity: 1000, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: 'x', quantity: 1.5, unitCents: 1 }] }).success).toBe(false)
    expect(parse({ lineItems: [{ description: 'x', quantity: 1, unitCents: 0 }] }).success).toBe(false)
    expect(parse({ dueDate: '10/17/2026' }).success).toBe(false)
    expect(parse({ dueDate: '2026-02-31' }).success).toBe(false)
    expect(parse({ customerNote: 'x'.repeat(1001) }).success).toBe(false)
    expect(parse({ customerNote: 'x'.repeat(1000) }).success).toBe(true)
  })

  it('keeps items, a due date and a note to charges', () => {
    expect(parse({ kind: 'payment' }).success).toBe(false)
    expect(parse({ kind: 'refund', parentCaptureId: 'CAP1' }).success).toBe(false)
  })
})

describe('bill terms: the server checks them', () => {
  it('refuses items that do not add up, with its own code', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const res = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ amountCents: 14_999 }) })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('lineitems.sum_mismatch')
    expect(h.repo.allProposals()).toHaveLength(0)
  })

  it('refuses a due date in the past or more than a year ahead, and accepts today and the last day', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ dueDate: day(-1) }) })).json.code).toBe('duedate.past')
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ dueDate: day(366) }) })).json.code).toBe('duedate.too_far')
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ dueDate: day(0) }) })).status).toBe(201)
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ dueDate: day(365), lineItems: [{ description: 'One', quantity: 3, unitCents: 5_000 }] }) })).status).toBe(201)
  })

  it('stores the terms, returns them in the view, and sanitises over HTTP', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const made = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ customerNote: 'Pay <b>soon</b>' }) })
    expect(made.json).toMatchObject({ lineItems: ITEMS, dueDate: '2026-10-17', customerNote: 'Pay bsoon/b' })
    const plain = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: { ...plainBill(), jobId: 'job_other' } })
    expect(plain.json).toMatchObject({ lineItems: null, dueDate: null, customerNote: null })
  })

  it('treats two bills with different items, date or note as different asks, and identical ones as duplicates', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const first = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill() })
    expect(first.json.clause).not.toBe('duplicate.open')
    const same = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill() })
    expect(same.json.gate).toBe('DENY')
    expect(same.json.clause).toBe('duplicate.open')
    const swapped = [{ description: 'Logo concepts', quantity: 1, unitCents: 10_000 }, { description: 'Final files', quantity: 1, unitCents: 5_000 }]
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ lineItems: swapped }) })).json.clause).not.toBe('duplicate.open')
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ dueDate: '2026-10-18' }) })).json.clause).not.toBe('duplicate.open')
    expect((await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill({ customerNote: 'Another note' }) })).json.clause).not.toBe('duplicate.open')
  })
})

function fieldsOf(h: ReturnType<typeof harness>, id: string): CartFields {
  const row = h.repo.proposal(id)!
  return {
    proposalId: row.id, warrantId: row.warrant_id, warrantVersion: row.warrant_version, payeeId: row.payee_id!, amountCents: row.amount_cents,
    currency: row.currency, category: row.category!, evidenceUrl: row.evidence_url!, kind: row.kind, parentCaptureId: row.parent_capture_id,
    jobId: row.job_id, fundingCaptureId: row.funding_capture_id, dealId: row.deal_id, milestone: row.milestone,
    lineItems: JSON.parse(row.line_items_json ?? 'null'), dueDate: row.due_date, customerNote: row.customer_note,
  }
}

describe('bill terms: the lock', () => {
  const base: CartFields = {
    proposalId: 'p1', warrantId: 'w1', warrantVersion: 1, payeeId: 'client_a', amountCents: 100, currency: 'USD',
    category: 'design', evidenceUrl: 'https://e.example/x', kind: 'charge', parentCaptureId: null, jobId: 'job_a', fundingCaptureId: null,
  }

  it('hashes a cart without terms byte for byte as before (v1, v2 and v3 shapes)', () => {
    const v1 = { ...base, kind: 'payment' as const, jobId: null }
    expect(canonicalCart(v1)).toBe('{"v":1,"proposalId":"p1","warrantId":"w1","warrantVersion":1,"payeeId":"client_a","amountCents":100,"currency":"USD","category":"design","evidenceUrl":"https://e.example/x","kind":"payment","parentCaptureId":null}')
    expect(canonicalCart(base)).toBe('{"v":2,"proposalId":"p1","warrantId":"w1","warrantVersion":1,"payeeId":"client_a","amountCents":100,"currency":"USD","category":"design","evidenceUrl":"https://e.example/x","kind":"charge","parentCaptureId":null,"jobId":"job_a","fundingCaptureId":null}')
    expect(canonicalCart({ ...base, dealId: 'd1', milestone: 0 })).toBe('{"v":3,"proposalId":"p1","warrantId":"w1","warrantVersion":1,"payeeId":"client_a","amountCents":100,"currency":"USD","category":"design","evidenceUrl":"https://e.example/x","kind":"charge","parentCaptureId":null,"jobId":"job_a","fundingCaptureId":null,"dealId":"d1","milestone":0}')
    // Null, empty and absent all mean "no terms".
    expect(cartHash({ ...base, lineItems: null, dueDate: null, customerNote: null })).toBe(cartHash(base))
    expect(cartHash({ ...base, lineItems: [], dueDate: '', customerNote: '' })).toBe(cartHash(base))
    expect(createHash('sha256').update(canonicalCart(base)).digest('hex')).toBe(cartHash(base))
  })

  it('adds the terms in a fixed order, and any change to them changes the hash', () => {
    const items = [{ description: 'A', quantity: 2, unitCents: 50 }]
    const text = canonicalCart({ ...base, lineItems: items, dueDate: '2026-11-01', customerNote: 'n' })
    expect(text.endsWith(',"terms":{"lineItems":[{"description":"A","quantity":2,"unitCents":50}],"dueDate":"2026-11-01","customerNote":"n"}}')).toBe(true)
    // An item rebuilt with extra properties or a different key order hashes the same.
    const messy = [{ unitCents: 50, quantity: 2, description: 'A', extra: 1 }] as never
    expect(cartHash({ ...base, lineItems: messy, dueDate: '2026-11-01', customerNote: 'n' })).toBe(cartHash({ ...base, lineItems: items, dueDate: '2026-11-01', customerNote: 'n' }))
    const hashes = new Set([
      cartHash(base),
      cartHash({ ...base, lineItems: items }),
      cartHash({ ...base, lineItems: [{ ...items[0]!, quantity: 3 }] }),
      cartHash({ ...base, lineItems: [{ ...items[0]!, description: 'B' }] }),
      cartHash({ ...base, dueDate: '2026-11-01' }),
      cartHash({ ...base, dueDate: '2026-11-02' }),
      cartHash({ ...base, customerNote: 'n' }),
      cartHash({ ...base, customerNote: 'm' }),
    ])
    expect(hashes.size).toBe(8)
  })

  it('a bill without terms still verifies and passes the audit (an older lock is untouched)', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const id = await approved(h, plainBill())
    expect((await call(h.app, 'GET', `/v1/proposals/${id}/verify`)).json).toMatchObject({ verdict: 'valid', hashMatches: true })
    expect((await call(h.app, 'GET', '/v1/audit')).json.ok).toBe(true)
  })

  it('verifies a bill with terms, and any edit after approval breaks the lock and turns the audit red', async () => {
    const edits: Array<[string, string, unknown[]]> = [
      ['an item', 'UPDATE proposals SET line_items_json = ? WHERE id = ?', [JSON.stringify([{ description: 'Logo concepts', quantity: 2, unitCents: 5_000 }, { description: 'Free extras', quantity: 1, unitCents: 5_000 }])]],
      ['a quantity', 'UPDATE proposals SET line_items_json = ? WHERE id = ?', [JSON.stringify([{ description: 'Logo concepts', quantity: 3, unitCents: 5_000 }, { description: 'Final files', quantity: 1, unitCents: 5_000 }])]],
      ['the due date', 'UPDATE proposals SET due_date = ? WHERE id = ?', ['2027-01-01']],
      ['the note', 'UPDATE proposals SET customer_note = ? WHERE id = ?', ['Waived.']],
      ['removing the items', 'UPDATE proposals SET line_items_json = ? WHERE id = ?', [null]],
    ]
    for (const [label, sql, args] of edits) {
      const h = harness({ invoices: new FakeInvoices() })
      const id = await approved(h)
      expect((await call(h.app, 'GET', `/v1/proposals/${id}/verify`)).json.verdict, label).toBe('valid')
      expect((await call(h.app, 'GET', '/v1/audit')).json.ok).toBe(true)
      // The database itself refuses the edit, with no way round it but maintenance mode.
      expect(() => h.db.prepare(sql).run(...(args as never[]), id), label).toThrow(/cannot change/)
      allowRawWrites(h.db)
      h.db.prepare(sql).run(...(args as never[]), id)
      const verdict = (await call(h.app, 'GET', `/v1/proposals/${id}/verify`)).json
      expect(verdict, label).toMatchObject({ verdict: 'invalid', hashMatches: false })
      const audit = (await call(h.app, 'GET', '/v1/audit')).json
      expect(audit.ok, label).toBe(false)
      expect(audit.checks.find((check: { id: string }) => check.id === 'locks.valid').status).toBe('fail')
      // And PayPal is never called for a bill whose terms moved.
      const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
      expect(sent.json.phase, label).not.toBe('invoice_sent')
      expect((h.services as unknown as { mandate: unknown }).mandate).toBeTruthy()
    }
  })

  it('lets a request still waiting for approval carry its terms into the lock at the tap', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const made = await call(h.app, 'POST', '/v1/proposals', { idem: idem(), body: bill() })
    expect(made.json.phase).toBe('pending_approval')
    expect(made.json.cartHash).toBeNull()
    const locked = await call(h.app, 'POST', `/v1/proposals/${made.json.id}/approve`)
    expect(locked.json.cartHash).toBe(cartHash(fieldsOf(h, made.json.id)))
  })
})

describe('bill terms: what PayPal is sent', () => {
  it('sends the real items, the note and the due date, and still settles on the locked total', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const id = await approved(h)
    const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(sent.json.phase).toBe('invoice_sent')
    expect(invoices.lastCreate).toMatchObject({ lineItems: ITEMS, dueDate: '2026-10-17', customerNote: 'Thank you for the work together.' })
    const held = [...invoices.invoices.values()][0]!
    expect(held.items).toEqual([
      { name: 'Logo concepts', quantity: '2', unitCents: 5_000 },
      { name: 'Final files', quantity: '1', unitCents: 5_000 },
    ])
    expect(held).toMatchObject({ dueDate: '2026-10-17', note: 'Thank you for the work together.', totalCents: 15_000 })
    invoices.pay(sent.json.invoiceId)
    expect((await call(h.app, 'POST', `/v1/proposals/${id}/capture`)).json).toMatchObject({ phase: 'captured', capturedAmountCents: 15_000 })
  })

  it('refuses to settle when PayPal reports a total that is not the lock', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const id = await approved(h)
    const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    ;[...invoices.invoices.values()][0]!.totalCents = 14_000
    invoices.pay(sent.json.invoiceId)
    const again = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    expect(again.json.phase).not.toBe('captured')
  })

  it('keeps the old single-line invoice for a bill without items', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const id = await approved(h, plainBill())
    await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    const held = [...invoices.invoices.values()][0]!
    expect(held.items).toEqual([{ name: 'Northwind logo bill', quantity: '1', unitCents: 15_000 }])
    expect(held.dueDate).toBeNull()
    expect(held.note).toBe('Bill Northwind')
  })

  it('builds PayPal\'s own draft body with payment_term and posts it when a due date is set', async () => {
    const request: InvoiceRequest = {
      proposalId: 'abc', invoiceNumber: 'MND-1', amountCents: 15_000, currency: 'USD', title: 't', description: 'd', note: 'n',
      recipientEmail: 'ap@northwind.example', recipientName: 'Northwind', allowPartialPayment: false, earlyPaymentDiscount: null,
      lineItems: ITEMS, dueDate: '2026-10-17', customerNote: 'Thanks',
    }
    expect(invoiceDraftBody(request)).toMatchObject({
      detail: { invoice_number: 'MND-1', currency_code: 'USD', note: 'Thanks', payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-17' } },
      items: [
        { name: 'Logo concepts', quantity: '2', unit_amount: { currency_code: 'USD', value: '50.00' } },
        { name: 'Final files', quantity: '1', unit_amount: { currency_code: 'USD', value: '50.00' } },
      ],
    })
    const calls: Array<{ url: string; body: string | null }> = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : null })
      return url.endsWith('/oauth2/token')
        ? new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 })
        : new Response(JSON.stringify({ rel: 'self', href: 'https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-123', method: 'GET' }), { status: 201 })
    }) as unknown as typeof fetch
    const port = createToolkitInvoices({ clientId: 'id', clientSecret: 'secret', sandbox: true, fetch: fake })
    expect(await port.createDraft(request)).toEqual({ invoiceId: 'INV2-123' })
    expect(calls[1]!.url).toBe('https://api-m.sandbox.paypal.com/v2/invoicing/invoices')
    expect(JSON.parse(calls[1]!.body!).detail.payment_term).toEqual({ term_type: 'DUE_ON_DATE_SPECIFIED', due_date: '2026-10-17' })
  })
})

describe('bill terms: overdue means past the due date', () => {
  const today = async (h: ReturnType<typeof harness>) => (await call(h.app, 'GET', '/v1/today')).json
  const kinds = async (h: ReturnType<typeof harness>) => (await today(h)).waiting.map((item: { kind: string }) => item.kind)
  const open = async (extra: Record<string, unknown>, h = harness({ invoices: new FakeInvoices() })) => {
    const id = await approved(h, bill(extra))
    await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
    return { h, id }
  }

  it('is not overdue before or on the due date, however long ago it was sent, and overdue the day after', async () => {
    const { h } = await open({ dueDate: day(10) })
    h.setNow(new Date(NOW.getTime() + 5 * DAY))
    // Five days since sending would be overdue under the old three-day rule; the due date says it is not.
    expect(await kinds(h)).not.toContain('overdue')
    h.setNow(new Date(NOW.getTime() + 10 * DAY))
    expect(await kinds(h)).not.toContain('overdue')
    h.setNow(new Date(NOW.getTime() + 12 * DAY))
    const late = (await today(h)).waiting.find((item: { kind: string }) => item.kind === 'overdue')
    expect(late.detail).toContain('was due')
    expect(late.detail).toContain('2 days ago')
  })

  it('keeps the days-since-sent rule for a bill without a due date', async () => {
    const { h } = await open({ dueDate: undefined })
    h.setNow(new Date(NOW.getTime() + 4 * DAY))
    expect(await kinds(h)).toContain('overdue')
  })

  it('chases a dated bill only once it is past due', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const current = (await call(h.app, 'GET', '/v1/warrant')).json
    const { id: _a, version: _b, createdAt: _c, ...body } = current
    await call(h.app, 'PUT', '/v1/warrant', { body: { ...body, automation: { ...body.automation, remindUnpaidAfterDays: 3, maxReminders: 2 } } })
    await open({ dueDate: day(10) }, h)
    const sweep = async (days: number) => { h.setNow(new Date(NOW.getTime() + days * DAY)); return h.services.mandate.sweepPending() }
    expect((await sweep(5)).reminded).toBe(0)
    expect((await sweep(10)).reminded).toBe(0)
    expect((await sweep(11)).reminded).toBe(1)
    expect((await sweep(12)).reminded).toBe(0)
    expect((await sweep(14)).reminded).toBe(1)
  })
})

describe('bill terms: the client\'s status page', () => {
  it('shows the client the items, due date and note, and nothing extra on a plain bill', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    await approved(h)
    await approved(h, { ...plainBill(), jobId: JOB, amountCents: 7_000 })
    const link = await call(h.app, 'POST', `/v1/jobs/${JOB}/shares`, { body: { partyId: 'client_northwind', canPay: false, ttlDays: 30 } })
    const view = await call(h.app, 'GET', `/v1/share/${link.json.token}`)
    const invoices = view.json.client.invoices as Array<Record<string, unknown>>
    const itemised = invoices.find((item) => item.amountCents === 15_000)!
    expect(itemised).toMatchObject({ lineItems: ITEMS, dueDate: '2026-10-17', customerNote: 'Thank you for the work together.', currency: 'USD' })
    const plain = invoices.find((item) => item.amountCents === 7_000)!
    expect(plain).not.toHaveProperty('lineItems')
    expect(plain).not.toHaveProperty('dueDate')
  })
})
