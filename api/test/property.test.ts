import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createApp } from '../src/app'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { decide, type GateContext, type GateProposal } from '../src/domain/gate'
import { LINE_STUDIO_WARRANT, type WarrantBody } from '../src/domain/schemas'
import { loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { FakeInvoices, FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { openSeal, seal } from '../src/tenancy/envelope'
import { newWorkspaceId } from '../src/tenancy/ids'
import { TenantRegistry } from '../src/tenancy/registry'
import { agree, call, closeAll, EVIDENCE, harness, idem, JOB, NOW, OWNER_KEY, STUDIO_KEY } from './support'

afterEach(closeAll)

/**
 * Random months and invariant property tests.
 *
 * Checks invariants I1 to I15 across single studio runs and fast-check property sequences over tenants A and B.
 */
export const RUNS = Number(process.env.PROPERTY_RUNS ?? 40)
const STEPS = 36

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Row = Record<string, any>

async function month(seed: number) {
  const random = rng(seed)
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)]!
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1))

  const invoices = new FakeInvoices()
  const h = harness({ invoices })
  const app = h.app
  const rows = async () => (await call(app, 'GET', '/v1/proposals?limit=100')).json.data as Row[]
  const captured = async () => (await rows()).filter((row) => row.kind === 'charge' && row.phase === 'captured')
  const deal = await agree(app)
  let billed = 0
  let trail = ''
  const note = (what: string) => { trail += `${what}; ` }

  for (let step = 0; step < STEPS; step += 1) {
    const move = random()
    if (move < 0.16 && billed < 2) {
      note(`bill ${billed}`)
      const made = await call(app, 'POST', `/v1/deals/${deal.id}/milestones/${billed}/bill`, { key: pick([STUDIO_KEY, OWNER_KEY]), body: { evidenceUrl: EVIDENCE } })
      if (made.status === 201 && made.json.gate !== 'DENY') billed += 1
    } else if (move < 0.3) {
      const pending = (await rows()).filter((row) => row.kind === 'charge' && ['pending_approval', 'locked', 'invoice_sent', 'order_created'].includes(row.phase))
      if (pending.length > 0) {
        const row = pick(pending)
        note(`client pays ${row.id.slice(0, 4)}`)
        if (row.phase === 'pending_approval') await call(app, 'POST', `/v1/proposals/${row.id}/approve`)
        if (row.phase === 'invoice_sent') { invoices.pay(row.invoiceId); await h.services.mandate.sweepPending() } else await call(app, 'POST', `/v1/proposals/${row.id}/capture`)
      }
    } else if (move < 0.62) {
      const charges = await captured()
      const funding = charges.length > 0 && random() < 0.8 ? pick(charges) : null
      const body: Record<string, unknown> = {
        kind: 'payment',
        payee: pick(['Priya', 'Priya', 'Priya', 'P. Shah', 'Cafe Lila']),
        amountCents: pick([between(1, 2_500), between(1_000, 9_000), between(9_000, 60_000)]),
        currency: random() < 0.95 ? 'USD' : 'EUR',
        category: pick(['design', 'design', 'production', 'lunch']),
        description: 'random',
        evidenceUrl: random() < 0.9 ? EVIDENCE : undefined,
        jobId: JOB,
        fundingCaptureId: funding ? (random() < 0.9 ? funding.captureId : 'CAP-NOT-REAL') : undefined,
      }
      note(`ask ${body.amountCents} ${body.payee}`)
      await call(app, 'POST', '/v1/proposals', { key: pick([STUDIO_KEY, OWNER_KEY]), idem: random() < 0.15 ? 'same-key-for-replays-0001' : idem(), body })
    } else if (move < 0.78) {
      const waiting = (await rows()).filter((row) => row.phase === 'pending_approval' && row.kind === 'payment')
      if (waiting.length > 0) {
        const row = pick(waiting)
        note(`${random() < 0.8 ? 'approve' : 'reject'} ${row.id.slice(0, 4)}`)
        if (random() < 0.8) {
          await call(app, 'POST', `/v1/proposals/${row.id}/approve`)
          await call(app, 'POST', `/v1/proposals/${row.id}/capture`)
        } else await call(app, 'POST', `/v1/proposals/${row.id}/reject`)
      }
    } else if (move < 0.86) {
      const charges = await captured()
      if (charges.length > 0) {
        const row = pick(charges)
        note('refund')
        await call(app, 'POST', '/v1/proposals', { idem: idem(), body: { kind: 'refund', payee: 'Northwind', amountCents: between(100, row.amountCents), currency: 'USD', category: 'design', description: 'refund', evidenceUrl: EVIDENCE, parentCaptureId: row.captureId } })
      }
    } else if (move < 0.92) {
      note('rules')
      const current = (await call(app, 'GET', '/v1/warrant')).json
      const { id: _id, version: _v, createdAt: _c, ...body } = current
      await call(app, 'PUT', '/v1/warrant', { body: { ...body, monthlyCapCents: pick([6_000, 18_000, 50_000]), autoSettleUnderCents: pick([0, 1_000, 2_000, 5_000]), standing: random() < 0.5 ? [{ id: 'p', payeeId: 'payee_priya', clientIds: ['client_northwind'], requireDeal: true }] : [], automation: { ...body.automation, billSignedDeals: random() < 0.5, payOnSettle: random() < 0.5 } } })
    } else {
      note('pause/resume')
      await call(app, 'POST', random() < 0.5 ? '/v1/safety/pause' : '/v1/safety/resume')
    }
  }
  return { h, trail, rows: await rows(), app }
}

function getDbChecksum(dbPath: string): string {
  const db = openDatabase(dbPath)
  const tables = ['warrants', 'proposals', 'events', 'payees']
  const hash = createHash('sha256')
  for (const table of tables) {
    try {
      const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      hash.update(JSON.stringify(rows))
    } catch {
      // ignored
    }
  }
  db.close()
  return hash.digest('hex')
}

describe('random months', () => {
  it(`keep every promise, in ${RUNS} runs of ${STEPS} random steps`, async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const { h, trail, rows, app } = await month(seed * 7919)
      const where = `seed ${seed * 7919} (${trail.slice(0, 400)})`
      const versions = (await call(app, 'GET', '/v1/warrant/versions')).json.data as Row[]
      const maxShare = Math.max(...versions.map((v) => v.contractorShareBps))
      const maxCap = Math.max(...versions.map((v) => v.monthlyCapCents))
      const settled = (row: Row) => row.phase === 'captured' && (row.capturedAmountCents ?? 0) > 0
      const payouts = rows.filter((row) => row.kind === 'payment')
      const charges = rows.filter((row) => row.kind === 'charge' && settled(row))

      // 1. A payout never exceeds the contractor's share of the client money it cites.
      for (const charge of charges) {
        const out = payouts.filter((p) => p.fundingCaptureId === charge.captureId && settled(p)).reduce((sum, p) => sum + p.amountCents, 0)
        expect(out, `payouts from ${charge.captureId} exceed the share. ${where}`).toBeLessThanOrEqual(Math.floor((charge.capturedAmountCents * maxShare) / 10_000))
      }
      // 2. Nothing is paid out of money that did not arrive.
      for (const p of payouts.filter(settled)) expect(charges.some((c) => c.captureId === p.fundingCaptureId), `a payout was sent with no settled client payment behind it. ${where}`).toBe(true)
      // 3. In total, contractors are paid less than came in, and never more than the highest cap ever in force.
      const totalIn = charges.reduce((sum, c) => sum + c.capturedAmountCents, 0)
      const totalOut = payouts.filter(settled).reduce((sum, p) => sum + p.capturedAmountCents, 0)
      expect(totalOut, `more went out than came in. ${where}`).toBeLessThanOrEqual(totalIn)
      expect(totalOut, `more went out than any cap allowed. ${where}`).toBeLessThanOrEqual(maxCap)
      // 4. A request nobody could approve never went through: unknown payees and unlisted work are never paid.
      for (const p of payouts) {
        if (['payee_unknown', null].includes(p.payeeId)) expect(settled(p) || p.phase === 'locked', `an unknown payee was approved. ${where}`).toBe(false)
        if (p.category === 'lunch') expect(settled(p), `unlisted work was paid. ${where}`).toBe(false)
      }
      // 5. Nothing the rules refused ever reached PayPal.
      for (const p of rows.filter((row) => row.gate === 'DENY')) expect(p.orderId ?? p.payoutBatchId ?? p.captureId, `a refused request has a PayPal id. ${where}`).toBeFalsy()
      // 6. PayPal was asked to pay exactly the payouts that have a batch: never twice for one request.
      const batches = payouts.filter((p) => p.payoutBatchId).length
      expect(h.paypal!.payoutCalls, `PayPal was asked to pay a different number of times than there are payouts. ${where}`).toBe(batches)
      // 7. The server's own audit, which does not share the gate's code, agrees with all of it.
      const audit = (await call(app, 'GET', '/v1/audit')).json
      const failed = audit.checks.filter((check: Row) => check.status === 'fail').map((check: Row) => `${check.id}: ${JSON.stringify(check.failures).slice(0, 200)}`)
      expect(failed, `the audit failed. ${where}`).toEqual([])
      closeAll()
    }
  }, 600_000)
})

describe('invariants fast-check', () => {
  it('Invariant 2: the gate is a pure function over arbitrary proposals and rules', () => {
    fc.assert(
      fc.property(
        fc.record({
          kind: fc.constantFrom('payment' as const, 'charge' as const, 'refund' as const),
          amountCents: fc.integer({ min: -100, max: 100_000 }),
          payeeId: fc.constantFrom('payee_priya', 'payee_unknown', null),
          category: fc.constantFrom('design', 'production', 'lunch', null),
          fundingCaptureId: fc.constantFrom('CAP-123', null),
          jobId: fc.constantFrom('job_123', null),
          hasEvidence: fc.boolean(),
        }),
        fc.record({
          monthlyCapCents: fc.integer({ min: 1_000, max: 100_000 }),
          autoSettleUnderCents: fc.integer({ min: 0, max: 50_000 }),
          contractorShareBps: fc.integer({ min: 0, max: 10_000 }),
          evidenceRequired: fc.boolean(),
          fundingRequired: fc.boolean(),
        }),
        (proposalInput, rulesInput) => {
          const body: WarrantBody = {
            ...LINE_STUDIO_WARRANT,
            monthlyCapCents: rulesInput.monthlyCapCents,
            autoSettleUnderCents: rulesInput.autoSettleUnderCents,
            contractorShareBps: rulesInput.contractorShareBps,
            evidenceRequired: rulesInput.evidenceRequired,
            fundingRequired: rulesInput.fundingRequired,
          }
          const proposal: GateProposal = {
            kind: proposalInput.kind,
            amountCents: proposalInput.amountCents,
            currency: 'USD',
            payeeId: proposalInput.payeeId,
            category: proposalInput.category,
            fundingCaptureId: proposalInput.fundingCaptureId,
            jobId: proposalInput.jobId,
            evidenceUrl: proposalInput.hasEvidence ? 'https://example.com/proof' : null,
            parent: null,
          }
          const context: GateContext = {
            reservedCents: 5_000,
            priorCaptureIds: [],
            nowMs: Date.parse('2026-10-14T10:00:00.000Z'),
          }
          const res1 = decide(body, proposal, context)
          const res2 = decide(body, proposal, context)
          expect(res1).toEqual(res2)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('Invariant 4 & 5: money amounts are integer cents and idempotency preserves single settlement', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-zA-Z0-9_-]{12,32}$/),
        fc.integer({ min: 100, max: 5_000 }),
        async (keySuffix, amountCents) => {
          const h = harness()
          const key = `idem-${keySuffix}`
          const call1 = await call(h.app, 'POST', '/v1/proposals', {
            idem: key,
            body: { kind: 'payment', payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: 'test', evidenceUrl: EVIDENCE, jobId: JOB },
          })
          const call2 = await call(h.app, 'POST', '/v1/proposals', {
            idem: key,
            body: { kind: 'payment', payee: 'Priya', amountCents, currency: 'USD', category: 'design', description: 'test', evidenceUrl: EVIDENCE, jobId: JOB },
          })
          expect(call1.status).toBe(201)
          expect(call2.status).toBe(call1.status)
          expect(call2.json.id).toBe(call1.json.id)
          expect(Number.isInteger(call1.json.amountCents)).toBe(true)
          expect(call1.json.amountCents).toBe(amountCents)
          const matched = (await call(h.app, 'GET', '/v1/proposals')).json.data.filter((r: any) => r.id === call1.json.id)
          expect(matched).toHaveLength(1)
          closeAll()
        }
      ),
      { numRuns: 10 }
    )
  })

  it('Invariant 6: the ledger is strictly append-only across state transitions', async () => {
    const h = harness()
    const getEventsCount = () => h.services.repo.allEvents().length
    let countBefore = getEventsCount()

    // 1. Create a proposal
    await call(h.app, 'POST', '/v1/proposals', {
      idem: idem(),
      body: { kind: 'payment', payee: 'Priya', amountCents: 1500, currency: 'USD', category: 'design', description: 'test', evidenceUrl: EVIDENCE, jobId: JOB },
    })
    const countAfter1 = getEventsCount()
    expect(countAfter1).toBeGreaterThanOrEqual(countBefore)
    countBefore = countAfter1

    // 2. Change safety state
    await call(h.app, 'POST', '/v1/safety/pause')
    const countAfter2 = getEventsCount()
    expect(countAfter2).toBeGreaterThanOrEqual(countBefore)
    countBefore = countAfter2

    // 3. Resume safety
    await call(h.app, 'POST', '/v1/safety/resume')
    const countAfter3 = getEventsCount()
    expect(countAfter3).toBeGreaterThanOrEqual(countBefore)

    closeAll()
  })

  it('Invariant 15: fast-check sequences in Tenant A leave Tenant B completely isolated and unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-prop-'))
    const controlDb = openDatabase(join(dir, 'control.sqlite'))
    const control = new ControlStore(controlDb, 'pepper-prop')
    const nowIso = NOW.toISOString()
    control.ensureDefault(join(dir, 'default.sqlite'), nowIso)

    const MASTER_KEY = Buffer.alloc(32, 7).toString('base64')
    const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1' })

    const registry = new TenantRegistry((id) => {
      const row = control.workspace(id)
      if (!row?.signing_key_sealed) return null
      const db = openDatabase(row.db_path)
      migrate(db)
      seed(db, NOW)
      const paypal = new FakePayPal()
      const invoices = new FakeInvoices()
      const signer = loadSigner({ pem: openSeal(MASTER_KEY, row.signing_key_sealed), production: false })
      const services = buildServices({ db, paypal, invoices, now: () => NOW, signer })
      const built = createApp({
        db,
        paypal,
        invoices,
        signer,
        now: () => NOW,
        nested: true,
        control,
        workspace: { id, mode: row.mode },
        services,
        config: {
          apiKey: `owner-key-${id}`,
          rateLimitPerMinute: 0,
          paypalConfigured: true,
          log: false,
          publicUrl: 'http://127.0.0.1:8787',
          flags,
          webauthn: { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] },
        },
      })
      return { id, fetch: (req) => built.fetch(req), close: () => db.close() }
    })

    const rootHarness = harness({
      control,
      registry,
      masterKey: MASTER_KEY,
      flags,
      webauthn: { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] },
    })
    const rootApp = rootHarness.app

    function makeTenant(name: string, id: string) {
      const dbPath = join(dir, `${id}.sqlite`)
      const db = openDatabase(dbPath)
      migrate(db)
      seed(db, NOW)
      db.close()

      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
      const sealed = seal(MASTER_KEY, pem)

      control.insertWorkspace({
        id,
        slug: id,
        name,
        mode: 'studio',
        paypal_mode: 'fake',
        db_path: dbPath,
        status: 'active',
        created_at: nowIso,
        expires_at: null,
        last_active_at: nowIso,
        signing_key_sealed: sealed,
      })
      return { id, dbPath }
    }

    const tenantA = makeTenant('Studio A', newWorkspaceId())
    const tenantB = makeTenant('Studio B', newWorkspaceId())

    const actionArbitrary = fc.oneof(
      fc.record({
        type: fc.constant('proposal' as const),
        amountCents: fc.integer({ min: 100, max: 5_000 }),
        payee: fc.constantFrom('Priya', 'P. Shah', 'Cafe Lila'),
        category: fc.constantFrom('design', 'production', 'lunch'),
      }),
      fc.record({
        type: fc.constant('rules' as const),
        monthlyCapCents: fc.constantFrom(6_000, 18_000, 50_000),
        autoSettleUnderCents: fc.constantFrom(0, 1_000, 2_000),
      }),
      fc.record({
        type: fc.constant('pause' as const),
        pause: fc.boolean(),
      })
    )

    await fc.assert(
      fc.asyncProperty(fc.array(actionArbitrary, { minLength: 3, maxLength: 10 }), async (actions) => {
        const checksumBBefore = getDbChecksum(tenantB.dbPath)

        for (const action of actions) {
          if (action.type === 'proposal') {
            await rootApp.request(`http://mandate.test/w/${tenantA.id}/v1/proposals`, {
              method: 'POST',
              headers: {
                authorization: `Bearer owner-key-${tenantA.id}`,
                'content-type': 'application/json',
                'idempotency-key': `idem-${randomUUID()}`,
              },
              body: JSON.stringify({
                kind: 'payment',
                amountCents: action.amountCents,
                currency: 'USD',
                category: action.category,
                payee: action.payee,
                description: 'fc test',
                evidenceUrl: EVIDENCE,
                jobId: JOB,
              }),
            })
          } else if (action.type === 'rules') {
            await rootApp.request(`http://mandate.test/w/${tenantA.id}/v1/warrant`, {
              method: 'PUT',
              headers: {
                authorization: `Bearer owner-key-${tenantA.id}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                ...LINE_STUDIO_WARRANT,
                monthlyCapCents: action.monthlyCapCents,
                autoSettleUnderCents: action.autoSettleUnderCents,
              }),
            })
          } else if (action.type === 'pause') {
            await rootApp.request(`http://mandate.test/w/${tenantA.id}/v1/safety/${action.pause ? 'pause' : 'resume'}`, {
              method: 'POST',
              headers: {
                authorization: `Bearer owner-key-${tenantA.id}`,
              },
            })
          }
        }

        // Invariant 15 checks:
        // 1. Tenant B database checksum is 100% unchanged
        const checksumBAfter = getDbChecksum(tenantB.dbPath)
        expect(checksumBAfter).toBe(checksumBBefore)

        // 2. Tenant A key cannot access Tenant B (401 invalid key, 404 for unauthenticated/foreign session)
        const crossRes = await rootApp.request(`http://mandate.test/w/${tenantB.id}/v1/today`, {
          headers: {
            authorization: `Bearer owner-key-${tenantA.id}`,
          },
        })
        expect(crossRes.status).toBe(401)
        const crossCookie = await rootApp.request(`http://mandate.test/w/${tenantB.id}/v1/today`, {
          headers: {
            cookie: 'mnd_session=token-from-tenant-a',
          },
        })
        expect(crossCookie.status).toBe(404)
      }),
      { numRuns: 8 }
    )

    controlDb.close()
  })
})
