import { afterEach, describe, expect, it } from 'vitest'
import { LINE_STUDIO_WARRANT, WarrantBodySchema } from '../src/domain/schemas'
import { FakeInvoices } from '../src/paypal/fake'
import { guardrailLines } from '../src/services/invoiceDesk'
import { agree, call, closeAll, collect, EVIDENCE, harness, idem, JOB, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

const DAY = 86_400_000
const day = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString().slice(0, 10)
type H = ReturnType<typeof harness>

const bill = (amountCents: number, extra: Record<string, unknown> = {}) => ({
  kind: 'charge', payee: 'Northwind', amountCents, currency: 'USD', category: 'design',
  description: `Northwind bill ${amountCents}`, evidenceUrl: EVIDENCE, prompt: 'Bill Northwind', jobId: JOB, ...extra,
})

/** Asks for a bill and (by how far it goes) approves it, sends it, or leaves it. Returns its id. */
async function make(h: H, amountCents: number, how: 'draft' | 'approved' | 'sent', extra: Record<string, unknown> = {}): Promise<{ id: string; invoiceId: string | null }> {
  const made = await call(h.app, 'POST', '/v1/proposals', { idem: idem('d'), body: bill(amountCents, extra) })
  expect(made.status).toBe(201)
  const id = made.json.id as string
  if (how === 'draft') return { id, invoiceId: null }
  expect((await call(h.app, 'POST', `/v1/proposals/${id}/approve`)).status).toBe(200)
  if (how === 'approved') return { id, invoiceId: null }
  const sent = await call(h.app, 'POST', `/v1/proposals/${id}/capture`)
  expect(sent.json.phase).toBe('invoice_sent')
  return { id, invoiceId: sent.json.invoiceId as string }
}

const desk = async (h: H, query = '') => (await call(h.app, 'GET', `/v1/invoices${query}`)).json
const statusOf = (json: { data: Array<{ id: string; status: string }> }, id: string) => json.data.find((row) => row.id === id)?.status

describe('the Invoices desk', () => {
  it('is empty on empty books, with KPIs of zero and no average', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const json = await desk(h)
    expect(json.data).toEqual([])
    expect(json.counts.all).toBe(0)
    expect(json.kpis).toMatchObject({ invoicedCents: 0, paidCents: 0, outstandingCents: 0, overdueCount: 0, overdueCents: 0, avgDaysToPay: null })
    expect(json.outlook.buckets.overdue).toEqual({ count: 0, cents: 0 })
    expect(json.guardrails.hasRules).toBe(true)
  })

  it('derives a status from the phase: draft, approved, sent, paid, part_paid, cancelled, declined', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const draft = await make(h, 11_000, 'draft')
    const approved = await make(h, 12_000, 'approved')
    const sent = await make(h, 13_000, 'sent')
    const paid = await make(h, 14_000, 'sent')
    invoices.pay(paid.invoiceId!)
    await call(h.app, 'POST', `/v1/proposals/${paid.id}/capture`)
    const part = await make(h, 15_000, 'sent')
    invoices.pay(part.invoiceId!, 5_000)
    await call(h.app, 'POST', `/v1/proposals/${part.id}/capture`)
    const cancelled = await make(h, 16_000, 'sent')
    expect((await call(h.app, 'POST', `/v1/proposals/${cancelled.id}/cancel-invoice`)).status).toBe(200)
    const rejected = await make(h, 17_000, 'draft')
    await call(h.app, 'POST', `/v1/proposals/${rejected.id}/reject`)
    const denied = await call(h.app, 'POST', '/v1/proposals', { idem: idem('x'), body: bill(18_000, { payee: 'Nobody Ltd' }) })
    expect(denied.json.gate).toBe('DENY')

    const json = await desk(h)
    expect(statusOf(json, draft.id)).toBe('draft')
    expect(statusOf(json, approved.id)).toBe('approved')
    expect(statusOf(json, sent.id)).toBe('sent')
    expect(statusOf(json, paid.id)).toBe('paid')
    expect(statusOf(json, part.id)).toBe('part_paid')
    expect(statusOf(json, cancelled.id)).toBe('cancelled')
    expect(statusOf(json, rejected.id)).toBe('declined')
    expect(statusOf(json, denied.json.id)).toBe('declined')
    expect(json.counts).toMatchObject({ all: 8, draft: 1, approved: 1, sent: 1, paid: 1, part_paid: 1, cancelled: 1, declined: 2 })
    // The part-paid row says what arrived and what is left.
    expect(json.data.find((row: { id: string }) => row.id === part.id)).toMatchObject({ amountCents: 15_000, paidCents: 5_000, remainingCents: 10_000 })
  })

  it('does the KPI arithmetic, the due-date overdue rule and the average days to pay', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const a = await make(h, 10_000, 'sent', { dueDate: day(10) }) // paid two days later
    const b = await make(h, 20_000, 'sent', { dueDate: day(20) }) // sent, not due yet
    const c = await make(h, 15_000, 'sent', { dueDate: day(5) }) // part paid, then past due
    const d = await make(h, 30_000, 'sent') // no due date: sent + 14 days, not yet
    const e = await make(h, 25_000, 'sent', { dueDate: day(6) }) // unpaid and past due
    const f = await make(h, 5_000, 'sent', { dueDate: day(40) })
    h.setNow(new Date(NOW.getTime() + 2 * DAY))
    invoices.pay(a.invoiceId!)
    await call(h.app, 'POST', `/v1/proposals/${a.id}/capture`)
    invoices.pay(c.invoiceId!, 5_000)
    await call(h.app, 'POST', `/v1/proposals/${c.id}/capture`)
    h.setNow(new Date(NOW.getTime() + 8 * DAY)) // 2026-10-11

    const json = await desk(h)
    expect(statusOf(json, a.id)).toBe('paid')
    expect(statusOf(json, b.id)).toBe('sent')
    expect(statusOf(json, c.id)).toBe('overdue')
    expect(statusOf(json, d.id)).toBe('sent')
    expect(statusOf(json, e.id)).toBe('overdue')
    const rowD = json.data.find((row: { id: string }) => row.id === d.id)
    expect(rowD).toMatchObject({ dueDate: '2026-10-17', dueSource: 'default' })
    expect(rowD.dueNote).toContain('No due date is on this bill')
    expect(json.data.find((row: { id: string }) => row.id === e.id)).toMatchObject({ dueSource: 'invoice', dueDate: day(6), daysOverdue: 2 })
    expect(json.data.find((row: { id: string }) => row.id === c.id)).toMatchObject({ daysOverdue: 3, remainingCents: 10_000 })

    expect(json.kpis).toMatchObject({
      invoicedCents: 105_000,
      paidCents: 15_000,
      outstandingCents: 90_000, // b 20,000 + c 10,000 + d 30,000 + e 25,000 + f 5,000
      overdueCount: 2,
      overdueCents: 35_000,
      avgDaysToPay: 2,
    })
    // A filter narrows the table but never the totals.
    const onlyOverdue = await desk(h, '?status=overdue')
    expect(onlyOverdue.data.map((row: { id: string }) => row.id).sort()).toEqual([c.id, e.id].sort())
    expect(onlyOverdue.kpis.invoicedCents).toBe(105_000)

    // The outlook: overdue, next 7 days (d, due the 17th is 6 days ahead), 8 to 14 days (b, due the 23rd, 12 ahead), later (f).
    expect(json.outlook.buckets).toEqual({ overdue: { count: 2, cents: 35_000 }, thisWeek: { count: 1, cents: 30_000 }, nextWeek: { count: 1, cents: 20_000 }, later: { count: 1, cents: 5_000 } })
    expect(json.outlook).toMatchObject({ outstandingCents: 90_000, committedPayoutsCents: 0, netOfBooksCents: 90_000 })
    expect(json.outlook.disclaimer).toContain('not a promise')
    if (json.outlook.balanceCents !== null) expect(json.outlook.projectedCents).toBe(json.outlook.balanceCents + 90_000)
    else expect(json.outlook.projectedCents).toBeNull()
  })

  it('counts reminders from the invoice.reminded events', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const a = await make(h, 10_000, 'sent')
    expect((await call(h.app, 'POST', `/v1/proposals/${a.id}/remind-invoice`)).status).toBe(200)
    expect((await desk(h)).data[0]).toMatchObject({ id: a.id, remindersSent: 1, canRemind: true, canCancel: true })
  })

  it('filters by status, job and search text', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    const logo = await make(h, 10_000, 'sent', { lineItems: [{ description: 'Favicon pack', quantity: 1, unitCents: 10_000 }] })
    await make(h, 20_000, 'draft', { jobId: 'job_other' })
    expect((await desk(h, '?status=sent')).data.map((row: { id: string }) => row.id)).toEqual([logo.id])
    expect((await desk(h, `?jobId=${JOB}`)).data).toHaveLength(1)
    expect((await desk(h, '?q=favicon')).data.map((row: { id: string }) => row.id)).toEqual([logo.id])
    expect((await desk(h, '?q=NORTHWIND')).data).toHaveLength(2)
    expect((await desk(h, '?q=zzz')).data).toHaveLength(0)
    expect((await desk(h, `?q=${logo.id.slice(0, 8)}`)).data).toHaveLength(1)
    expect((await call(h.app, 'GET', '/v1/invoices?status=bogus')).status).toBe(400)
  })

  it('subtracts approved, unpaid payouts from the outlook', async () => {
    const h = harness()
    const deal = await agree(h.app)
    const paid = await collect(h.app, deal.id, 0)
    const payout = await call(h.app, 'POST', '/v1/proposals', { idem: idem('p'), body: { payee: 'Priya', amountCents: 9_000, currency: 'USD', category: 'design', description: 'share', evidenceUrl: EVIDENCE, jobId: JOB, fundingCaptureId: paid.captureId, prompt: 'pay' } })
    expect(payout.status).toBe(201)
    expect((await call(h.app, 'POST', `/v1/proposals/${payout.json.id}/approve`)).status).toBe(200)
    const json = await desk(h)
    expect(json.outlook.committedPayoutsCents).toBe(9_000)
    expect(json.outlook.netOfBooksCents).toBe(json.outlook.outstandingCents - 9_000)
  })

  it('is owner only', async () => {
    const h = harness()
    expect((await call(h.app, 'GET', '/v1/invoices', { key: STUDIO_KEY })).status).toBe(403)
  })
})

describe('the guardrails, in plain English from the warrant', () => {
  const base = WarrantBodySchema.parse(LINE_STUDIO_WARRANT)
  const text = (w = base) => guardrailLines(w).map((line) => line.text).join('\n')

  it('says the amounts, the cap, no reminders, and no automatic billing for the demo rules', () => {
    const t = text()
    expect(t).toContain('under $20.00 can go out without your tap')
    expect(t).toContain('over $500.00')
    expect(t).toContain('capped at $180.00 a month')
    expect(t).toContain('sends no reminders on its own')
    expect(t).toContain('not billed automatically')
    expect(t).toContain('https link')
    expect(t).toContain('USD only')
  })

  it('says reminders, clearing days and acceptance when they are on', () => {
    const t = text({ ...base, clearingDays: 3, evidenceRequired: false, standing: [], automation: { ...base.automation, billSignedDeals: true, requireAcceptance: true, remindUnpaidAfterDays: 7, maxReminders: 3 } })
    expect(t).toContain('unpaid after 7 days gets a PayPal reminder, up to 3 times')
    expect(t).toContain('settled 3 days')
    expect(t).toContain('only after the client’s agent has accepted')
    expect(t).toContain('does not need a link')
  })

  it('handles one day, one reminder and zero reminders', () => {
    expect(text({ ...base, automation: { ...base.automation, remindUnpaidAfterDays: 1, maxReminders: 1 } })).toContain('unpaid after 1 day gets a PayPal reminder, up to 1 time.')
    expect(text({ ...base, automation: { ...base.automation, remindUnpaidAfterDays: 5, maxReminders: 0 } })).toContain('flagged, but no reminders are sent')
  })

  it('travels with the desk and links to Rules', async () => {
    const h = harness()
    const json = await desk(h)
    expect(json.guardrails.link).toBe('/rules')
    expect(json.guardrails.lines.length).toBeGreaterThan(5)
  })
})

describe('Ask: money questions from the desk', () => {
  const ask = async (h: H, message: string) => (await call(h.app, 'POST', '/v1/ask', { body: { message } })).json
  const chip = async (h: H, quick: string) => (await call(h.app, 'POST', '/v1/ask', { body: { quick } })).json

  it('answers every money question on empty books, honestly', async () => {
    const h = harness({ invoices: new FakeInvoices() })
    expect(await ask(h, 'Which invoices are overdue?')).toMatchObject({ kind: 'answer', id: 'overdue', title: 'No invoice is overdue', lines: ['There are no invoices yet.'] })
    expect(await ask(h, 'How much is outstanding right now?')).toMatchObject({ id: 'outstanding', title: 'Nobody owes you anything right now' })
    expect(await ask(h, 'Summarize payments received')).toMatchObject({ id: 'received', title: 'Nothing has been paid in October 2026' })
    const forecast = await ask(h, 'Cash forecast')
    expect(forecast).toMatchObject({ id: 'forecast', title: 'Nothing is expected to come in or go out' })
    expect(forecast.lines.join(' ')).toContain('not a promise')
  })

  it('answers from the numbers, listing each invoice with its id and a link', async () => {
    const invoices = new FakeInvoices()
    const h = harness({ invoices })
    const late = await make(h, 25_000, 'sent', { dueDate: day(6) })
    const paid = await make(h, 10_000, 'sent', { dueDate: day(30) })
    const soon = await make(h, 30_000, 'sent', { dueDate: day(12) })
    invoices.pay(paid.invoiceId!)
    await call(h.app, 'POST', `/v1/proposals/${paid.id}/capture`)
    h.setNow(new Date(NOW.getTime() + 8 * DAY))

    const overdue = await ask(h, 'which invoices are overdue')
    expect(overdue.title).toBe('1 invoice is overdue, $250.00 owed')
    expect(overdue.lines[0]).toContain(`invoice ${late.id.slice(0, 8)}`)
    expect(overdue.lines[0]).toContain('2 days past')
    expect(overdue.links[0]).toEqual({ label: `Northwind $250.00 (${late.id.slice(0, 8)})`, to: `/p/${late.id}` })

    const owed = await ask(h, 'who owes me money?')
    expect(owed).toMatchObject({ id: 'outstanding', title: '$550.00 is outstanding across 2 invoices' })
    expect(owed.links.map((l: { to: string }) => l.to)).toEqual(expect.arrayContaining([`/p/${late.id}`, `/p/${soon.id}`]))
    expect((await ask(h, 'how much is outstanding right now?')).id).toBe('outstanding')

    const received = await ask(h, 'What has been paid this month?')
    expect(received).toMatchObject({ id: 'received', title: '$100.00 received in October 2026 across 1 invoice' })
    expect(received.links[0].to).toBe(`/p/${paid.id}`)
    expect((await ask(h, 'summarize payments received')).id).toBe('received')

    const forecast = await ask(h, 'how much will I have in two weeks?')
    expect(forecast.id).toBe('forecast')
    expect(forecast.title).toBe('$550.00 expected in, $0.00 promised out')
    expect(forecast.lines.join('\n')).toContain('Overdue: $250.00 (1)')
    expect(forecast.lines.join('\n')).toContain('at most $550.00')
    expect(forecast.lines.join('\n')).toContain('not a promise')
    expect((await ask(h, 'cash forecast')).id).toBe('forecast')

    // The chips call the same answers by id.
    expect((await chip(h, 'overdue')).id).toBe('overdue')
    expect((await chip(h, 'forecast')).id).toBe('forecast')
  })

  it('keeps the older questions where they were', async () => {
    const h = harness()
    expect((await ask(h, 'what is waiting for me?')).id).toBe('waiting')
    expect((await ask(h, 'how much have we made this month')).id).toBe('month')
    expect((await ask(h, 'show me the unpaid invoices')).id).toBe('inflight')
  })
})
