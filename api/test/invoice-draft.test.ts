import { afterEach, describe, expect, it } from 'vitest'
import { draftInvoice, parseNotes } from '../src/agents/invoiceDraft'
import { LINE_STUDIO_WARRANT, WarrantBodySchema } from '../src/domain/schemas'
import { scriptedModel } from './mockModel'
import { call, closeAll, harness, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

const warrant = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)
const read = (notes: string) => parseNotes(notes, warrant, NOW)
const PROOF = 'https://www.figma.com/file/northwind-logo'

describe('notes to invoice: a corpus of messy notes, read by rules alone', () => {
  it('1. the PayPilot example: an unknown client is named, never matched or invented', () => {
    const d = read('Hey PayPilot, bill PayPal Hackathon Sponsor $120 for PayPilot AI Copilot MVP development and PayPal sandbox integration. Send it to buyer@personal.example.com in USD.')
    expect(d.client).toBeNull()
    expect(d.lineItems).toEqual([{ description: 'PayPilot AI Copilot MVP development and PayPal sandbox integration', quantity: 1, unitCents: 12_000 }])
    expect(d.totalCents).toBe(12_000)
    expect(d.currency).toBe('USD')
    expect(d.missing).toEqual(expect.arrayContaining(['client', 'dueDate', 'jobId', 'category', 'evidenceUrl']))
    expect(d.warnings.join(' ')).toContain('PayPal Hackathon Sponsor')
    expect(d.warnings.join(' ')).toContain('buyer@personal.example.com')
  })

  it('2. the client is matched by name, with net terms and an email', () => {
    const d = read('Bill Northwind $120 for logo tweaks, net 14, send to accounts@northwind.example')
    expect(d.client).toEqual({ id: 'client_northwind', name: 'Northwind', matchedBy: 'name' })
    expect(d.lineItems).toEqual([{ description: 'logo tweaks', quantity: 1, unitCents: 12_000 }])
    expect(d.dueDate).toBe('2026-10-17')
    expect(d.missing).not.toContain('client')
    expect(d.missing).not.toContain('dueDate')
  })

  it('3. an email on the rules beats a name, and says it matched by email', () => {
    const d = read('invoice ap@northwind.example $45 for a favicon pack')
    expect(d.client).toMatchObject({ id: 'client_northwind', matchedBy: 'email' })
    expect(d.lineItems[0]).toMatchObject({ description: 'a favicon pack', unitCents: 4_500 })
  })

  it('4. several lines, a quantity and "each"', () => {
    const d = read('Invoice Northwind: logo design $200, banner x2 $40 each, due in 2 weeks')
    expect(d.lineItems).toEqual([
      { description: 'logo design', quantity: 1, unitCents: 20_000 },
      { description: 'banner', quantity: 2, unitCents: 4_000 },
    ])
    expect(d.totalCents).toBe(28_000)
    expect(d.dueDate).toBe('2026-10-17')
  })

  it('5. "3 x" in front of a price is a unit price', () => {
    const d = read('Bill Northwind 3 x logo variations at $40')
    expect(d.lineItems[0]).toMatchObject({ quantity: 3, unitCents: 4_000 })
    expect(d.totalCents).toBe(12_000)
  })

  it('6. "3 units" with "per unit" and a "due Nov 20" date', () => {
    const d = read('charge Northwind 3 units of icon sets $25 per unit due Nov 20')
    expect(d.lineItems[0]).toMatchObject({ quantity: 3, unitCents: 2_500 })
    expect(d.dueDate).toBe('2026-11-20')
  })

  it('7. hours at a rate, and thousands with a comma and cents', () => {
    const d = read('Northwind: 5 hours of design @ $1,200.50/hr')
    expect(d.lineItems[0]).toMatchObject({ description: 'design', quantity: 5, unitCents: 120_050 })
    expect(d.totalCents).toBe(600_250)
  })

  it('8. a proof link, a job and a category are read only when they are written', () => {
    const d = read(`Bill Northwind $90 for the brochure. proof ${PROOF}, job job_northwind_logo, category: design`)
    expect(d.evidenceUrl).toBe(PROOF)
    expect(d.jobId).toBe('job_northwind_logo')
    expect(d.category).toBe('design')
    expect(d.missing).toEqual(['dueDate'])
  })

  it('9. a customer note and a due date of tomorrow', () => {
    const d = read('Bill Northwind $60 for edits due tomorrow\nnote: Thank you for the quick turnaround')
    expect(d.customerNote).toBe('Thank you for the quick turnaround')
    expect(d.dueDate).toBe('2026-10-04')
  })

  it('10. an ISO date, and a weekday', () => {
    expect(read('Bill Northwind $60 for edits due 2026-12-01').dueDate).toBe('2026-12-01')
    // 2026-10-03 is a Saturday, so the next Friday is the 9th.
    expect(read('Bill Northwind $60 for edits due friday').dueDate).toBe('2026-10-09')
    expect(read('Bill Northwind $60 for edits due end of month').dueDate).toBe('2026-10-31')
  })

  it('11. a date that already passed this year means next year; a real past date is refused', () => {
    expect(read('Bill Northwind $60 for edits due 9/1').dueDate).toBe('2027-09-01')
    const past = read('Bill Northwind $60 for edits due 2026-01-05')
    expect(past.dueDate).toBeNull()
    expect(past.warnings.join(' ')).toContain('in the past')
    expect(read('Bill Northwind $60 for edits due Feb 30').dueDate).toBeNull()
  })

  it('12. two amounts joined by "and" become two lines', () => {
    const d = read('Bill Northwind logo $200 and business cards $80')
    expect(d.lineItems.map((item) => [item.description, item.unitCents])).toEqual([['logo', 20_000], ['business cards', 8_000]])
  })
})

describe('notes to invoice: honesty', () => {
  it('never invents a price: no amount means no price, and the total says it cannot be worked out', () => {
    const d = read('Bill Northwind for the logo tweaks')
    expect(d.lineItems).toEqual([{ description: 'the logo tweaks', quantity: 1, unitCents: null }])
    expect(d.totalCents).toBeNull()
    expect(d.missing).toContain('price')
    expect(d.warnings.join(' ')).toContain('total cannot be worked out')
  })

  it('does not treat a bare number as a price', () => {
    const d = read('Bill Northwind 120 for logo tweaks')
    expect(d.lineItems.every((item) => item.unitCents === null)).toBe(true)
    expect(d.totalCents).toBeNull()
    expect(d.missing).toContain('price')
    expect(d.warnings.join(' ')).toContain('no currency mark')
  })

  it('does not guess a quantity: "x3" with one price is read as the total, split evenly, and says so', () => {
    const d = read('Bill Northwind logo x3 $120')
    expect(d.lineItems[0]).toMatchObject({ quantity: 3, unitCents: 4_000 })
    expect(d.totalCents).toBe(12_000)
    expect(d.warnings.join(' ')).toContain('as the total for 3')
    const odd = read('Bill Northwind logo x3 $100')
    expect(odd.lineItems[0]).toMatchObject({ quantity: 1, unitCents: 10_000 })
  })

  it('keeps another currency as written and warns, never converts', () => {
    const d = read('Bill Northwind €100 for the logo')
    expect(d.currency).toBe('EUR')
    expect(d.lineItems[0]!.unitCents).toBe(10_000)
    expect(d.warnings.join(' ')).toContain('Mandate bills in USD only')
    const named = read('Bill Northwind 100 EUR for the logo')
    expect(named.currency).toBe('EUR')
  })

  it('strips markup, including an address in angle brackets', () => {
    const d = read('Bill Northwind $50 for <b>logo</b> <script>alert(1)</script> tweaks from Ann <ap@northwind.example>')
    expect(JSON.stringify(d)).not.toMatch(/[<>]/)
    expect(d.client).toMatchObject({ matchedBy: 'email' })
    expect(d.warnings.join(' ')).toContain('Markup was removed')
  })

  it('finds no client when none is named, and does not pick one for you', () => {
    const d = read('$50 for logo tweaks')
    expect(d.client).toBeNull()
    expect(d.missing).toContain('client')
  })

  it('does not accept an http link as proof, and does not guess a category from a word', () => {
    const d = read('Bill Northwind $50 for logo design http://example.com/work')
    expect(d.evidenceUrl).toBeNull()
    expect(d.missing).toContain('evidenceUrl')
    expect(d.category).toBeNull()
    expect(d.warnings.join(' ')).toContain('not https')
  })

  it('refuses a category the rules do not allow, and says so', () => {
    const d = read('Bill Northwind $50 for logo category: gambling')
    expect(d.category).toBeNull()
    expect(d.warnings.join(' ')).toContain('not one of the allowed')
  })

  it('does not read the digits of a link or an address as money', () => {
    const d = read('Bill Northwind $50 for logo https://example.com/file/1200 ap@northwind2024.example')
    expect(d.totalCents).toBe(5_000)
  })
})

describe('notes to invoice: draftInvoice, the verdict and the model', () => {
  const preview = (h: ReturnType<typeof harness>) => (request: Parameters<typeof h.services.mandate.tryRequest>[0]) => h.services.mandate.tryRequest(request).live!

  it('previews what the gate would decide and writes nothing', async () => {
    const h = harness()
    const before = h.repo.allProposals().length
    const d = await draftInvoice({ notes: `Bill Northwind $120 for logo tweaks, net 14. job job_northwind_logo category: design ${PROOF}`, warrant, now: NOW, preview: preview(h) })
    expect(d.verdict).toMatchObject({ gate: 'NEEDS_APPROVAL', clause: 'amount.needs_approval', complete: true })
    expect(d.source).toBe('rules')
    expect(h.repo.allProposals().length).toBe(before)
  })

  it('previews an amount over the limits instead of blocking it', async () => {
    const h = harness()
    const d = await draftInvoice({ notes: `Bill Northwind $9,000 for the whole brand. job job_northwind_logo category: design ${PROOF}`, warrant, now: NOW, preview: preview(h) })
    expect(d.totalCents).toBe(900_000)
    expect(d.verdict).toMatchObject({ gate: 'DENY', clause: 'amount.ceiling' })
  })

  it('an amount under the automatic line is previewed as AUTO, and incomplete drafts say so', async () => {
    const h = harness()
    const auto = await draftInvoice({ notes: `Bill Northwind $12 for a tweak. job job_northwind_logo category: design ${PROOF}`, warrant, now: NOW, preview: preview(h) })
    expect(auto.verdict).toMatchObject({ gate: 'AUTO', complete: true })
    const partial = await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, preview: preview(h) })
    expect(partial.verdict!.complete).toBe(false)
  })

  it('a foreign currency is refused by the gate in the preview', async () => {
    const h = harness()
    const d = await draftInvoice({ notes: `Bill Northwind €100 for the logo. job job_northwind_logo category: design ${PROOF}`, warrant, now: NOW, preview: preview(h) })
    expect(d.verdict).toMatchObject({ gate: 'DENY', clause: 'currency.mismatch' })
  })

  it('uses the model\'s lines when every number and word is in the notes', async () => {
    const model = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'logo tweaks', quantity: 1, unitPrice: 120 }] } }))
    const d = await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, model })
    expect(d.source).toBe('model')
    expect(d.lineItems).toEqual([{ description: 'logo tweaks', quantity: 1, unitCents: 12_000 }])
    expect(model.calls()).toBe(1)
  })

  it('throws away a model answer with a price that is not in the notes, and falls back to the rules', async () => {
    const model = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'logo tweaks', quantity: 1, unitPrice: 999 }] } }))
    const d = await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, model })
    expect(d.source).toBe('rules')
    expect(d.lineItems).toEqual([{ description: 'logo tweaks', quantity: 1, unitCents: 12_000 }])
    expect(d.warnings.join(' ')).toContain('not in the notes')
  })

  it('throws away invented words and invented quantities', async () => {
    const words = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'premium blockchain consulting retainer', quantity: 1, unitPrice: 120 }] } }))
    expect((await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, model: words })).source).toBe('rules')
    const qty = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'logo tweaks', quantity: 7, unitPrice: 120 }] } }))
    expect((await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, model: qty })).source).toBe('rules')
  })

  it('falls back to the rules, and says so, when the model fails', async () => {
    const model = scriptedModel(() => ({ fail: true }))
    const d = await draftInvoice({ notes: 'Bill Northwind $120 for logo tweaks', warrant, now: NOW, model })
    expect(d.source).toBe('rules')
    expect(d.lineItems[0]!.unitCents).toBe(12_000)
    expect(d.warnings.join(' ')).toContain('not available')
  })

  it('never asks the model about a foreign currency draft', async () => {
    const model = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'the logo', quantity: 1, unitPrice: 100 }] } }))
    const d = await draftInvoice({ notes: 'Bill Northwind €100 for the logo', warrant, now: NOW, model })
    expect(model.calls()).toBe(0)
    expect(d.currency).toBe('EUR')
  })
})

describe('POST /v1/invoices/draft', () => {
  const body = { notes: `Bill Northwind $120 for logo tweaks, net 14. job job_northwind_logo category: design ${PROOF}` }

  it('is owner only: an agent key cannot call it, nor read the desk', async () => {
    const h = harness()
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { key: STUDIO_KEY, body })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/invoices', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { body })).status).toBe(200)
  })

  it('returns the draft with the gate\'s verdict, writes nothing and says nothing was sent', async () => {
    const h = harness()
    const res = await call(h.app, 'POST', '/v1/invoices/draft', { body })
    expect(res.json).toMatchObject({ client: { id: 'client_northwind' }, totalCents: 12_000, dueDate: '2026-10-17', nothingSent: true, verdict: { gate: 'NEEDS_APPROVAL', complete: true } })
    expect((await call(h.app, 'GET', '/v1/proposals')).json.data).toHaveLength(0)
    expect(h.paypal!.refunds.size).toBe(0)
  })

  it('rejects empty and oversized notes and unknown fields', async () => {
    const h = harness()
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { body: { notes: '   ' } })).status).toBe(400)
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { body: { notes: 'x'.repeat(4001) } })).status).toBe(400)
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { body: { notes: 'a', extra: 1 } })).status).toBe(400)
  })

  it('is rate limited', async () => {
    const h = harness()
    for (let i = 0; i < 8; i += 1) expect((await call(h.app, 'POST', '/v1/invoices/draft', { body })).status).toBe(200)
    expect((await call(h.app, 'POST', '/v1/invoices/draft', { body })).status).toBe(429)
  })

  it('uses the model under budget and reads with rules when the budget is spent', async () => {
    const { ModelBudget } = await import('../src/ops/budget')
    const model = scriptedModel(() => ({ tool: 'list_lines', input: { items: [{ description: 'logo tweaks', quantity: 1, unitPrice: 120 }] } }))
    const open = harness({ model, budget: new ModelBudget({ globalDailyTokens: 100_000, workspaceDailyTokens: 100_000, maxOutputTokens: 500, maxSteps: 4 }) })
    expect((await call(open.app, 'POST', '/v1/invoices/draft', { body })).json.source).toBe('model')
    const shut = scriptedModel(() => ({ tool: 'list_lines', input: { items: [] } }))
    const spent = harness({ model: shut, budget: new ModelBudget({ globalDailyTokens: 0, workspaceDailyTokens: 0, maxOutputTokens: 500, maxSteps: 4 }) })
    const res = await call(spent.app, 'POST', '/v1/invoices/draft', { body })
    expect(res.json.source).toBe('rules')
    expect(shut.calls()).toBe(0)
  })
})
