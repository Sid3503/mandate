import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlStore } from '../src/control/store'
import { loadFlags } from '../src/flags'
import { FakePayPal } from '../src/paypal/fake'
import { call, closeAll, harness, OWNER_KEY } from './support'

afterEach(closeAll)

describe('npm run seed:template and frozen numbers check (P2.T6)', () => {
  const rootDir = resolve(__dirname, '../..')
  const seedScript = join(rootDir, 'api/scripts/seed-template.ts')
  const tsxCli = join(rootDir, 'api/node_modules/tsx/dist/cli.mjs')

  it('runs seed:template and creates a database with verified frozen numbers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mandate-seed-template-'))
    const targetDb = join(dir, 'seeded-template.sqlite')

    const output = execFileSync('node', [tsxCli, seedScript, targetDb], {
      cwd: dir,
      encoding: 'utf8',
    }).trim()

    expect(output).toBe(targetDb)
    expect(existsSync(targetDb)).toBe(true)

    const db = new DatabaseSync(targetDb)

    // 1. Verify warrant row and frozen numbers
    const warrantRow = db.prepare('SELECT body_json FROM warrants WHERE id = ?').get('wnt_line_studio') as { body_json: string } | undefined
    expect(warrantRow).toBeDefined()
    const warrant = JSON.parse(warrantRow!.body_json)
    expect(warrant.currency).toBe('USD')
    expect(warrant.autoSettleUnderCents).toBe(2000) // $20.00
    expect(warrant.monthlyCapCents).toBe(18000) // $180.00
    expect(warrant.perPaymentCeilingCents).toBe(50000) // $500.00
    expect(warrant.contractorShareBps).toBe(6000) // 60%
    expect(warrant.clearingDays).toBe(0)
    expect(warrant.timezone).toBe('Asia/Kolkata')
    expect(warrant.fundingRequired).toBe(true)
    expect(warrant.evidenceRequired).toBe(true)
    expect(warrant.payees).toEqual([
      {
        id: 'payee_priya',
        displayName: 'Priya Shah',
        email: 'priya.shah@example.com',
        aliases: ['Priya', 'priya'],
      },
    ])
    expect(warrant.clients).toEqual([
      {
        id: 'client_northwind',
        displayName: 'Northwind',
        email: 'ap@northwind.example',
        aliases: ['Northwind', 'northwind'],
      },
    ])

    // 2. Verify party rules frozen numbers
    const buyerRuleRow = db.prepare('SELECT body_json FROM party_rules WHERE party_id = ?').get('client_northwind') as { body_json: string } | undefined
    expect(buyerRuleRow).toBeDefined()
    const buyerRules = JSON.parse(buyerRuleRow!.body_json)
    expect(buyerRules.role).toBe('buyer')
    expect(buyerRules.maxTotalCents).toBe(40000) // $400.00
    expect(buyerRules.maxMilestones).toBe(4)
    expect(buyerRules.currency).toBe('USD')

    const sellerRuleRow = db.prepare('SELECT body_json FROM party_rules WHERE party_id = ?').get('wnt_line_studio') as { body_json: string } | undefined
    expect(sellerRuleRow).toBeDefined()
    const sellerRules = JSON.parse(sellerRuleRow!.body_json)
    expect(sellerRules.role).toBe('seller')
    expect(sellerRules.minTotalCents).toBe(25000) // $250.00
    expect(sellerRules.maxMilestones).toBe(4)
    expect(sellerRules.currency).toBe('USD')

    // 3. Verify payees table row
    const payeeRow = db.prepare('SELECT id, email, status, total_paid_cents FROM payees WHERE id = ?').get('payee_priya') as { id: string; email: string; status: string; total_paid_cents: number } | undefined
    expect(payeeRow).toBeDefined()
    expect(payeeRow!.email).toBe('priya.shah@example.com')
    expect(payeeRow!.status).toBe('active')
    expect(payeeRow!.total_paid_cents).toBe(0)

    db.close()
  }, 20_000)
})

describe('Demo reset endpoint /v1/demo/reset (P2.T7)', () => {
  it('returns 404 when demoReset is not enabled', async () => {
    const { app } = harness({ demoReset: false })
    const res = await call(app, 'POST', '/v1/demo/reset', {
      key: OWNER_KEY,
      body: { confirm: 'reset the demo' },
    })
    expect(res.status).toBe(404)
    expect(res.json.code).toBe('demo.off')
  })

  it('requires exact confirmation string when demoReset is enabled', async () => {
    const { app } = harness({ demoReset: true })
    const res = await call(app, 'POST', '/v1/demo/reset', {
      key: OWNER_KEY,
      body: { confirm: 'wrong string' },
    })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('demo.confirm')
  })

  it('wipes the ledger back to fresh Line Studio state on confirmed reset', async () => {
    const { app, db } = harness({ demoReset: true })

    // Insert dummy proposal
    db.prepare(`
      INSERT INTO proposals (id, warrant_id, warrant_version, kind, amount_cents, currency, description, gate, clause, detail, phase, created_at, updated_at)
      VALUES ('p_reset_test', 'wnt_line_studio', 1, 'payment', 1500, 'USD', 'Reset target', 'allow', 'c', 'd', 'approved', 'now', 'now')
    `).run()

    expect(db.prepare('SELECT COUNT(*) AS c FROM proposals').get()).toEqual({ c: 1 })

    const res = await call(app, 'POST', '/v1/demo/reset', {
      key: OWNER_KEY,
      body: { confirm: 'reset the demo' },
    })
    expect(res.status).toBe(200)
    expect(res.json.reset).toBe(true)

    // Proposals wiped
    expect(db.prepare('SELECT COUNT(*) AS c FROM proposals').get()).toEqual({ c: 0 })
    // Seeded tables restored
    const warrantCount = db.prepare('SELECT COUNT(*) AS c FROM warrants').get() as { c: number }
    expect(warrantCount.c).toBeGreaterThanOrEqual(1)
  })
})

describe('Demo switch and simulate endpoints (P2.T7)', () => {
  it('refuses switch and simulate when workspace mode is not demo', async () => {
    const controlDb = new DatabaseSync(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test-mode')
    const now = new Date()
    const workspaceId = 'ws_studio'

    control.insertWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'Studio Workspace',
      mode: 'studio',
      paypal_mode: 'fake',
      db_path: ':memory:',
      status: 'active',
      created_at: now.toISOString(),
      expires_at: null,
      last_active_at: now.toISOString(),
      signing_key_sealed: null,
    })

    const memberId = 'mem_studio'
    control.addMember({ id: memberId, workspaceId, name: 'Studio Member', role: 'owner', now: now.toISOString() })
    const sessionToken = 'studio_token_1234567890'
    control.putSession({ token: sessionToken, memberId, workspaceId, method: 'demo', now: now.toISOString(), idleHours: 12, absoluteDays: 7 })

    const { app } = harness({
      control,
      workspace: { id: workspaceId, mode: 'studio' },
      webauthn: { rpID: 'mandate.test', rpName: 'Mandate', origins: ['http://mandate.test'] },
    })

    const headers = {
      cookie: `mnd_session=${sessionToken}`,
      'content-type': 'application/json',
      'x-mandate-client': 'web',
      origin: 'http://mandate.test',
    }

    const swRes = await app.request('http://mandate.test/v1/demo/switch', {
      method: 'POST',
      headers,
      body: JSON.stringify({ role: 'approver' }),
    })
    expect(swRes.status).toBe(404)
    const swBody = await swRes.json() as { code: string }
    expect(swBody.code).toBe('tenant/not-found')

    const simRes = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'payout_success' }),
    })
    expect(simRes.status).toBe(404)
    const simBody = await simRes.json() as { code: string }
    expect(simBody.code).toBe('tenant/not-found')
  })

  it('refuses switch and simulate without demo session cookie', async () => {
    const { app } = harness({ workspace: { id: 'ws_demo_1', mode: 'demo' } })

    const swRes = await call(app, 'POST', '/v1/demo/switch', {
      body: { role: 'approver' },
    })
    expect(swRes.status).toBe(401)
    expect(swRes.json.code).toBe('auth.unauthorized')

    const simRes = await call(app, 'POST', '/v1/demo/simulate', {
      body: { action: 'payout_success' },
    })
    expect(simRes.status).toBe(401)
    expect(simRes.json.code).toBe('auth.unauthorized')
  })

  it('switches between demo roles with updated session cookie', async () => {
    const controlDb = new DatabaseSync(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test-switch')
    const now = new Date()
    const workspaceId = 'ws_demo_switch'

    control.insertWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'Demo Workspace',
      mode: 'demo',
      paypal_mode: 'fake',
      db_path: ':memory:',
      status: 'active',
      created_at: now.toISOString(),
      expires_at: null,
      last_active_at: now.toISOString(),
      signing_key_sealed: null,
    })

    const memberId = 'mem_initial'
    control.addMember({ id: memberId, workspaceId, name: 'Initial Owner', role: 'owner', now: now.toISOString() })
    const sessionToken = 'demo_initial_token_1234567890'
    control.putSession({ token: sessionToken, memberId, workspaceId, method: 'demo', now: now.toISOString(), idleHours: 12, absoluteDays: 7 })

    const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1' })
    const { app } = harness({
      flags,
      control,
      workspace: { id: workspaceId, mode: 'demo' },
      webauthn: { rpID: 'mandate.test', rpName: 'Mandate', origins: ['http://mandate.test'] },
    })

    const headers = {
      cookie: `mnd_session=${sessionToken}`,
      'content-type': 'application/json',
      'x-mandate-client': 'web',
      origin: 'http://mandate.test',
    }

    // Invalid role rejected
    const badRole = await app.request('http://mandate.test/v1/demo/switch', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(badRole.status).toBe(400)

    // Switch to each role
    for (const targetRole of ['approver', 'proposer', 'viewer', 'payee', 'owner'] as const) {
      const res = await app.request('http://mandate.test/v1/demo/switch', {
        method: 'POST',
        headers,
        body: JSON.stringify({ role: targetRole }),
      })
      expect(res.status).toBe(200)
      const data = await res.json() as { role: string }
      expect(data.role).toBe(targetRole)
      expect(res.headers.get('set-cookie')).toContain('mnd_session=')
    }
  })

  it('simulates paypal actions inside demo mode', async () => {
    const controlDb = new DatabaseSync(':memory:')
    const control = new ControlStore(controlDb, 'pepper-test-sim')
    const now = new Date()
    const workspaceId = 'ws_demo_sim'

    control.insertWorkspace({
      id: workspaceId,
      slug: workspaceId,
      name: 'Demo Sim',
      mode: 'demo',
      paypal_mode: 'fake',
      db_path: ':memory:',
      status: 'active',
      created_at: now.toISOString(),
      expires_at: null,
      last_active_at: now.toISOString(),
      signing_key_sealed: null,
    })

    const memberId = 'mem_sim'
    control.addMember({ id: memberId, workspaceId, name: 'Sim Owner', role: 'owner', now: now.toISOString() })
    const sessionToken = 'demo_sim_token_1234567890'
    control.putSession({ token: sessionToken, memberId, workspaceId, method: 'demo', now: now.toISOString(), idleHours: 12, absoluteDays: 7 })

    let paidInvoiceId: string | null = null
    let payoutsStatus: string | null = null
    const paypal = {
      pay: (id: string) => { paidInvoiceId = id },
      settlePayouts: (status?: 'SUCCESS' | 'FAILED') => { payoutsStatus = status ?? 'SUCCESS' },
    }

    const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1' })
    const { app } = harness({
      flags,
      control,
      paypal: paypal as any,
      workspace: { id: workspaceId, mode: 'demo' },
      webauthn: { rpID: 'mandate.test', rpName: 'Mandate', origins: ['http://mandate.test'] },
    })

    const headers = {
      cookie: `mnd_session=${sessionToken}`,
      'content-type': 'application/json',
      'x-mandate-client': 'web',
      origin: 'http://mandate.test',
    }

    // Invalid action rejected
    const badAction = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'unknown' }),
    })
    expect(badAction.status).toBe(400)

    // Pay action missing invoice id rejected
    const payNoId = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'pay' }),
    })
    expect(payNoId.status).toBe(400)

    // Pay action with invoice id
    const payOk = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'pay', id: 'inv_sim_101' }),
    })
    expect(payOk.status).toBe(200)
    expect(paidInvoiceId).toBe('inv_sim_101')

    // Payout success
    const payoutSuccess = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'payout_success' }),
    })
    expect(payoutSuccess.status).toBe(200)
    expect(payoutsStatus).toBe('SUCCESS')

    // Payout fail
    const payoutFail = await app.request('http://mandate.test/v1/demo/simulate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'payout_fail' }),
    })
    expect(payoutFail.status).toBe(200)
    expect(payoutsStatus).toBe('FAILED')
  })
})
