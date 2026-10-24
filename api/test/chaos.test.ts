import { afterEach, describe, expect, it } from 'vitest'
import { call, closeAll, harness, OWNER_KEY, STUDIO_KEY, JOB } from './support'
import { scriptedModel } from './mockModel'

afterEach(closeAll)

describe('Chaos testing: resilience against failures and corrupt state', () => {
  it('1. PayPal timeout: upstream timeout gives a clear message and leaves money state untouched', async () => {
    const h = harness()

    // Create a proposal
    const created = await call(h.app, 'POST', '/v1/proposals', {
      key: STUDIO_KEY,
      idem: 'idemp-chaos-1',
      body: {
        kind: 'charge',
        payee: 'Northwind',
        amountCents: 15000,
        currency: 'USD',
        category: 'design',
        description: 'Chaos test milestone payment',
        evidenceUrl: 'https://www.figma.com/file/northwind-logo',
        jobId: JOB,
      },
    })
    expect(created.status).toBe(201)
    expect(created.json.gate).toBe('NEEDS_APPROVAL')
    const proposalId = created.json.id

    // Approve the proposal with owner key
    const approved = await call(h.app, 'POST', `/v1/proposals/${proposalId}/approve`, {
      key: OWNER_KEY,
    })
    expect(approved.status).toBe(200)

    // Capture initial ledger / balance state
    const preAudit = await call(h.app, 'GET', '/v1/audit', { key: OWNER_KEY })
    const preSettled = preAudit.json.checks.find((c: { id: string }) => c.id === 'ledger.pure')?.checked

    // Inject a PayPal timeout when capturing the order
    const originalCapture = h.paypal!.captureOrder.bind(h.paypal!)
    h.paypal!.captureOrder = async () => {
      const err = new Error('The operation was aborted due to timeout')
      err.name = 'AbortError'
      throw err
    }

    // Attempt capture/settle with timeout
    const settleRes = await call(h.app, 'POST', `/v1/proposals/${proposalId}/capture`, {
      key: OWNER_KEY,
    })

    // Settle must return 503 paypal.unavailable with a clear message
    expect(settleRes.status).toBe(503)
    expect(settleRes.json.code).toBe('paypal.unavailable')
    expect(settleRes.json.title).toBe('PayPal is not answering')
    expect(settleRes.json.detail).toContain('Nothing was lost')

    // Verify proposal remains in order_created/approved, NOT settled or captured
    const proposalRes = await call(h.app, 'GET', `/v1/proposals/${proposalId}`, { key: OWNER_KEY })
    expect(proposalRes.json.phase).toBe('order_created')
    expect(proposalRes.json.phase).not.toBe('captured')
    expect(proposalRes.json.phase).not.toBe('settled')

    // Verify audit / ledger state has zero newly settled money
    const postAudit = await call(h.app, 'GET', '/v1/audit', { key: OWNER_KEY })
    const postSettled = postAudit.json.checks.find((c: { id: string }) => c.id === 'ledger.pure')?.checked
    expect(postSettled).toBe(preSettled)

    // Restore
    h.paypal!.captureOrder = originalCapture
  })

  it('2. Model timeout: agent model timeout gives a clear message and moves zero money', async () => {
    const timeoutModel = scriptedModel(() => {
      const err = new Error('The model operation timed out')
      err.name = 'TimeoutError'
      throw err
    })

    const h = harness({ model: timeoutModel })

    const clerkRes = await call(h.app, 'POST', '/v1/clerk/messages', {
      key: OWNER_KEY,
      body: { message: 'Please pay $500 to Northwind' },
    })

    // Clerk returns 504 agent.timeout with clear message
    expect(clerkRes.status).toBe(504)
    expect(clerkRes.json.code).toBe('agent.timeout')
    expect(clerkRes.json.title).toBe('The agent took too long')
    expect(clerkRes.json.detail).toBe('The model did not finish in time. Nothing was sent to PayPal.')

    // Verify zero proposals or money moves occurred
    const proposals = await call(h.app, 'GET', '/v1/proposals', { key: OWNER_KEY })
    const matching = proposals.json.data.filter((p: { description: string }) => p.description.includes('500'))
    expect(matching).toHaveLength(0)
  })

  it('3. Database locked: SQLITE_BUSY gives clear RFC 9457 error and rolls back cleanly', async () => {
    const h = harness()

    // Monkey-patch db.prepare for an INSERT to simulate SQLITE_BUSY
    const originalPrepare = h.services.repo['db'].prepare.bind(h.services.repo['db'])
    let lockActive = false
    h.services.repo['db'].prepare = (sql: string) => {
      if (lockActive && sql.includes('INSERT INTO proposals')) {
        const err = new Error('SQLITE_BUSY: database is locked') as any
        err.code = 'SQLITE_BUSY'
        throw err
      }
      return originalPrepare(sql)
    }

    lockActive = true
    const res = await call(h.app, 'POST', '/v1/proposals', {
      key: STUDIO_KEY,
      idem: 'idemp-chaos-3',
      body: {
        kind: 'charge',
        payee: 'Northwind',
        amountCents: 12000,
        currency: 'USD',
        description: 'Locked db proposal',
        jobId: JOB,
      },
    })

    expect(res.status).toBe(503)
    expect(res.json.code).toBe('db.locked')
    expect(res.json.title).toBe('Database is busy')
    expect(res.json.detail).toBe('The database is locked by another operation. Please retry.')

    // Remove lock and verify database is fully functional and no partial proposal was created
    lockActive = false
    const listRes = await call(h.app, 'GET', '/v1/proposals', { key: OWNER_KEY })
    expect(listRes.json.data.some((p: { description: string }) => p.description === 'Locked db proposal')).toBe(false)
  })

  it('4. Disk full: SQLITE_FULL / ENOSPC rolls back and returns clear storage error', async () => {
    const h = harness()

    // Monkey-patch db.prepare for proposals to simulate disk full
    const originalPrepare = h.services.repo['db'].prepare.bind(h.services.repo['db'])
    let diskFullActive = false
    h.services.repo['db'].prepare = (sql: string) => {
      if (diskFullActive && sql.includes('INSERT INTO proposals')) {
        const err = new Error('SQLITE_FULL: database or disk is full') as any
        err.code = 'SQLITE_FULL'
        throw err
      }
      return originalPrepare(sql)
    }

    diskFullActive = true
    const res = await call(h.app, 'POST', '/v1/proposals', {
      key: STUDIO_KEY,
      idem: 'idemp-chaos-4',
      body: {
        kind: 'charge',
        payee: 'Northwind',
        amountCents: 15000,
        currency: 'USD',
        description: 'Disk full test proposal',
        jobId: JOB,
      },
    })

    expect(res.status).toBe(507)
    expect(res.json.code).toBe('db.disk_full')
    expect(res.json.title).toBe('Database storage full')
    expect(res.json.detail).toBe('The database or disk has run out of space. No changes were made.')

    // Restore and verify database integrity
    diskFullActive = false
    const verifyRes = await call(h.app, 'GET', '/v1/proposals', { key: OWNER_KEY })
    expect(verifyRes.json.data.some((p: { description: string }) => p.description === 'Disk full test proposal')).toBe(false)
  })

  it('5. Model provider usage refusal: clerk goes quiet with clear message, and quick asks continue to work', async () => {
    const refusalModel = scriptedModel(() => {
      const err = new Error('Model usage refused: quota exceeded') as any
      err.statusCode = 429
      throw err
    })

    const h = harness({ model: refusalModel })

    // Clerk attempt: must fail with clear rate_limited message, nothing sent to PayPal
    const clerkRes = await call(h.app, 'POST', '/v1/clerk/messages', {
      key: OWNER_KEY,
      body: { message: 'Can we pay contractor 1?' },
    })

    expect(clerkRes.status).toBe(429)
    expect(clerkRes.json.code).toBe('agent.rate_limited')
    expect(clerkRes.json.title).toBe('The model is busy')
    expect(clerkRes.json.detail).toContain('refused usage')
    expect(clerkRes.json.detail).toContain('Nothing was sent to PayPal')

    // Quick asks continue to answer directly from ledger without model
    const quickWaiting = await call(h.app, 'POST', '/v1/ask', {
      key: OWNER_KEY,
      body: { quick: 'waiting' },
    })
    expect(quickWaiting.status).toBe(200)
    expect(quickWaiting.json.kind).toBe('answer')
    expect(quickWaiting.json.id).toBe('waiting')
    expect(Array.isArray(quickWaiting.json.lines)).toBe(true)

    const quickMonth = await call(h.app, 'POST', '/v1/ask', {
      key: OWNER_KEY,
      body: { message: 'how much money in and out this month?' },
    })
    expect(quickMonth.status).toBe(200)
    expect(quickMonth.json.kind).toBe('answer')
    expect(quickMonth.json.id).toBe('month')
  })
})
