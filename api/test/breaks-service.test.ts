import { afterEach, describe, expect, it } from 'vitest'
import { Notifier } from '../src/services/notify'
import { allowRawWrites, call, closeAll, harness, idem, JOB, EVIDENCE, NOW, STUDIO_KEY } from './support'

afterEach(closeAll)

const charge = { kind: 'charge', payee: 'Northwind', amountCents: 15000, currency: 'USD', category: 'design', description: 'Northwind logo milestone', evidenceUrl: EVIDENCE, prompt: 'Bill Northwind', jobId: JOB }
type H = ReturnType<typeof harness>

async function paid(h: H): Promise<{ id: string; captureId: string }> {
  const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('c'), body: charge })
  await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
  const captured = await call(h.app, 'POST', `/v1/proposals/${created.json.id}/capture`)
  if (!captured.json.captureId) throw new Error(JSON.stringify(captured.json))
  return { id: created.json.id, captureId: captured.json.captureId }
}

describe('the Breaks desk', () => {
  it('finds nothing on clean books, and is owner only', async () => {
    const h = harness()
    await paid(h)
    const scan = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(scan.status).toBe(200)
    expect(scan.json.detected).toBe(0)
    const list = await call(h.app, 'GET', '/v1/breaks')
    expect(list.json.kpis).toMatchObject({ open: 0, moneyAtStakeCents: 0, waitingOnYou: 0, resolved: 0, attention: 0 })
    expect((await call(h.app, 'GET', '/v1/breaks', { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'POST', '/v1/breaks/scan', { key: STUDIO_KEY })).status).toBe(403)
  })

  it('opens a duplicate once, notifies once, files a refund through the gate, and resolves when it is refunded', async () => {
    const h = harness()
    const told: string[] = []
    h.services.breaks.onCritical = (found) => told.push(found.key)
    await paid(h)
    // The second payment lands an hour later, so which one is the later one is not a tie.
    h.setNow(new Date(NOW.getTime() + 3_600_000))
    const second = await paid(h)
    const first = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(first.json.opened).toEqual([`capture.duplicate:${second.id}`])
    await call(h.app, 'POST', '/v1/breaks/scan')
    expect(told).toEqual([`capture.duplicate:${second.id}`])

    const listed = await call(h.app, 'GET', '/v1/breaks?state=open&severity=critical')
    expect(listed.json.kpis).toMatchObject({ open: 1, moneyAtStakeCents: 15000, attention: 1 })
    expect((await call(h.app, 'GET', '/v1/breaks?severity=warning')).json.data).toHaveLength(0)

    const detail = await call(h.app, 'GET', `/v1/breaks/${encodeURIComponent(`capture.duplicate:${second.id}`)}`)
    expect(detail.json.evidence.paypalIds.some((item: { id: string }) => item.id === second.captureId)).toBe(true)
    expect(detail.json.evidence.books.length).toBeGreaterThan(0)
    expect(detail.json.fix.action).toBe('file_refund')

    const fixed = await call(h.app, 'POST', `/v1/breaks/${encodeURIComponent(`capture.duplicate:${second.id}`)}/fix`, { body: {} })
    expect(fixed.status).toBe(200)
    // The gate decided: the refund was filed as the autopilot and nothing was refunded by the button.
    expect(['AUTO', 'NEEDS_APPROVAL', 'DENY']).toContain(fixed.json.gate)
    expect(fixed.json.statement).toContain('Nothing was refunded by this button')
    expect(h.repo.proposal(fixed.json.filedProposalId)!.kind).toBe('refund')
    expect(h.paypal!.refunds.size).toBe(0)
    expect(fixed.json.break.state).toBe('open')
    expect(fixed.json.break.waitingOnYou).toBe(fixed.json.gate === 'NEEDS_APPROVAL')

    // The owner approves and settles the refund; the next scan resolves the break.
    if (fixed.json.gate === 'NEEDS_APPROVAL') await call(h.app, 'POST', `/v1/proposals/${fixed.json.filedProposalId}/approve`)
    await call(h.app, 'POST', `/v1/proposals/${fixed.json.filedProposalId}/capture`)
    const again = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(again.json.resolved).toEqual([`capture.duplicate:${second.id}`])
    expect((await call(h.app, 'GET', '/v1/breaks')).json.kpis).toMatchObject({ open: 0, resolved: 1 })
  })

  it('dismisses with a required note and keeps it quiet until the evidence changes', async () => {
    const h = harness()
    const told: string[] = []
    h.services.breaks.onCritical = (found) => told.push(found.key)
    await paid(h)
    // The second payment lands an hour later, so which one is the later one is not a tie.
    h.setNow(new Date(NOW.getTime() + 3_600_000))
    const second = await paid(h)
    await call(h.app, 'POST', '/v1/breaks/scan')
    const path = `/v1/breaks/${encodeURIComponent(`capture.duplicate:${second.id}`)}/dismiss`
    expect((await call(h.app, 'POST', path, { body: {} })).status).toBe(400)
    expect((await call(h.app, 'POST', path, { body: { note: '   ' } })).status).toBe(400)
    const done = await call(h.app, 'POST', path, { body: { note: 'The client really did buy two.' } })
    expect(done.json).toMatchObject({ state: 'dismissed', dismissedBy: 'owner', dismissNote: 'The client really did buy two.' })
    const scan = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(scan.json.opened).toEqual([])
    expect(scan.json.reopened).toEqual([])
    expect(told).toHaveLength(1)
    expect((await call(h.app, 'POST', path, { body: { note: 'again' } })).status).toBe(409)
    // Evidence changes: the stored print no longer matches what is seen, so it reopens (and tells once more).
    h.db.prepare(`UPDATE breaks SET fingerprint = 'old' WHERE key = ?`).run(`capture.duplicate:${second.id}`)
    const changed = await call(h.app, 'POST', '/v1/breaks/scan')
    expect(changed.json.reopened).toEqual([`capture.duplicate:${second.id}`])
    expect(told).toHaveLength(2)
    const history = (await call(h.app, 'GET', `/v1/breaks/${encodeURIComponent(`capture.duplicate:${second.id}`)}`)).json.history.map((e: { type: string }) => e.type)
    expect(history).toEqual(['opened', 'dismissed', 'reopened'])
  })

  it('a stale pending capture is found, re-read by the fix, and resolves when PayPal completes it', async () => {
    const h = harness()
    h.paypal!.captureOutcome = 'PENDING'
    const created = await call(h.app, 'POST', '/v1/proposals', { idem: idem('c'), body: charge })
    await call(h.app, 'POST', `/v1/proposals/${created.json.id}/approve`)
    const res = await call(h.app, 'POST', `/v1/proposals/${created.json.id}/capture`)
    expect(res.status).toBe(202)
    h.setNow(new Date(NOW.getTime() + 7 * 3_600_000))
    const scan = await call(h.app, 'POST', '/v1/breaks/scan')
    const key = `capture.pending_stale:${created.json.id}`
    expect(scan.json.opened).toEqual([key])
    h.paypal!.setCaptureStatus(res.json.captureId, 'COMPLETED')
    const fixed = await call(h.app, 'POST', `/v1/breaks/${encodeURIComponent(key)}/fix`, { body: {} })
    expect(fixed.json.action).toBe('refresh_capture')
    expect(fixed.json.break.state).toBe('resolved')
  })

  it('refuses a fix where a person must decide, and a fix on a resolved break', async () => {
    const h = harness()
    const { id } = await paid(h)
    allowRawWrites(h.db)
    h.db.prepare(`UPDATE proposals SET phase = 'capture_reversed' WHERE id = ?`).run(id)
    await call(h.app, 'POST', '/v1/breaks/scan')
    const key = `capture.reversed:${id}`
    const refused = await call(h.app, 'POST', `/v1/breaks/${encodeURIComponent(key)}/fix`, { body: {} })
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('break.no_fix')
    expect((await call(h.app, 'GET', '/v1/breaks')).json.kpis.waitingOnYou).toBeGreaterThan(0)
    expect((await call(h.app, 'GET', '/v1/breaks/nope:nope')).status).toBe(404)
  })

  it('does not resolve a PayPal break on a scan that did not look at PayPal, and keeps history append-only', async () => {
    const h = harness()
    await paid(h)
    const now = NOW.toISOString()
    h.db.prepare(`INSERT INTO breaks (key, rule, severity, proposal_id, title, detail, expected, observed, delta_cents, first_seen_at, last_seen_at) VALUES ('paypal.unknown_or_differs:T9', 'paypal.unknown_or_differs', 'warning', NULL, 't', 'd', 'e', 'o', 100, ?, ?)`).run(now, now)
    const scan = await call(h.app, 'POST', '/v1/breaks/scan')
    // The fake PayPal has no transaction search, so Reconcile now reports it unavailable rather than inventing an answer.
    expect(['unavailable', 'checked']).toContain(scan.json.paypal)
    await h.services.breaks.scan(NOW, { withPayPal: false })
    expect(h.db.prepare(`SELECT resolved_at FROM breaks WHERE key = 'paypal.unknown_or_differs:T9'`).get()).toEqual({ resolved_at: null })
    h.db.prepare(`INSERT INTO break_events (break_key, at, type, detail) VALUES ('k', ?, 'opened', '')`).run(now)
    expect(() => h.db.exec(`UPDATE break_events SET detail = 'x'`)).toThrow(/append-only/)
    expect(() => h.db.exec('DELETE FROM break_events')).toThrow(/append-only/)
    allowRawWrites(h.db)
    expect(() => h.db.exec('DELETE FROM break_events')).not.toThrow()
  })

  it('lists a request\'s PayPal attempts, recorded before each call, owner only', async () => {
    const h = harness()
    const { id, captureId } = await paid(h)
    const res = await call(h.app, 'GET', `/v1/proposals/${id}/attempts`)
    expect(res.status).toBe(200)
    expect(res.json.data.length).toBeGreaterThan(0)
    const attempt = res.json.data.find((a: { externalId: string | null }) => a.externalId === captureId) ?? res.json.data[0]
    expect(attempt).toMatchObject({ status: 'succeeded' })
    expect(attempt.requestIdPrefix).toHaveLength(8)
    expect(Object.keys(attempt)).not.toContain('error')
    expect((await call(h.app, 'GET', `/v1/proposals/${id}/attempts`, { key: STUDIO_KEY })).status).toBe(403)
    expect((await call(h.app, 'GET', '/v1/proposals/00000000-0000-4000-8000-000000000000/attempts')).status).toBe(404)
  })

  it('tells the owner\'s channel once per critical opening, with a link and no secrets', async () => {
    const h = harness()
    const bodies: string[] = []
    const notifier = new Notifier({ url: 'https://hooks.example/secret-token', repo: h.repo, consoleUrl: 'http://console/app', now: () => NOW, fetch: async (_url, init) => { bodies.push(init.body); return { ok: true, status: 200 } } })
    h.services.breaks.onCritical = (found) => void notifier.breakOpened(found)
    await paid(h)
    h.setNow(new Date(NOW.getTime() + 3_600_000))
    await paid(h)
    await call(h.app, 'POST', '/v1/breaks/scan')
    await call(h.app, 'POST', '/v1/breaks/scan')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('/breaks')
    expect(bodies[0]).not.toContain('secret-token')
  })
})
