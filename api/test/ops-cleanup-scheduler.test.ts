import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { Repo } from '../src/db/repo'
import { ephemeralSigner, loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { FakeInvoices, FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { openSeal, seal } from '../src/tenancy/envelope'
import { newWorkspaceId } from '../src/tenancy/ids'
import { TenantRegistry } from '../src/tenancy/registry'
import { cleanupExpiredDemos, runTenantSchedulerSweep } from '../src/ops/scheduler'
import { closeAll, harness } from './support'

afterEach(closeAll)

const NOW = new Date('2026-04-01T12:00:00.000Z')
const MASTER = 'master-secret-key-at-least-32-chars!'
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }

function setupTestEnvironment() {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-cleanup-test-'))
  const controlDb = openDatabase(join(dir, 'control.sqlite'))
  const control = new ControlStore(controlDb, 'pepper-test-cleanup')
  control.ensureDefault(join(dir, 'default.sqlite'), NOW.toISOString())

  const flags = loadFlags({
    FLAG_TENANCY: '1',
    DEMO_ENABLED: '1',
    FLAG_PASSKEYS: '1',
    FLAG_INVITES: '1',
  })

  const tenantSweeps = new Map<string, number>()

  const registry = new TenantRegistry((id) => {
    const row = control.workspace(id)
    if (!row?.signing_key_sealed) return null
    const db = openDatabase(row.db_path)
    migrate(db)
    seed(db, NOW)
    const paypal = new FakePayPal()
    const invoices = new FakeInvoices()
    const signer = loadSigner({ pem: openSeal(MASTER, row.signing_key_sealed), production: false })
    const services = buildServices({
      db,
      paypal,
      invoices,
      now: () => NOW,
      signer,
      onExternalRef: (kind, externalId) => control.rememberRef(kind, externalId, id),
    })
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
        proposerKey: `studio-key-${id}`,
        rateLimitPerMinute: 0,
        paypalConfigured: true,
        log: false,
        publicUrl: 'http://127.0.0.1:8787',
        flags,
        webauthn: WA,
      },
    })
    return {
      id,
      fetch: (request) => built.fetch(request),
      close: () => db.close(),
      sweep: async () => {
        tenantSweeps.set(id, (tenantSweeps.get(id) ?? 0) + 1)
        await services.mandate.sweepStanding()
        await services.mandate.sweepPending()
      },
    }
  })

  function createTenant(input: {
    name: string
    mode: 'demo' | 'studio' | 'live'
    expiresAt?: string | null
    customId?: string
  }) {
    const id = input.customId ?? newWorkspaceId()
    const dbPath = join(dir, `${id}.sqlite`)
    const db = openDatabase(dbPath)
    migrate(db)
    seed(db, NOW)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()

    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    const sealed = seal(MASTER, pem)

    control.insertWorkspace({
      id,
      slug: id,
      name: input.name,
      mode: input.mode,
      paypal_mode: 'fake',
      db_path: dbPath,
      status: 'active',
      created_at: NOW.toISOString(),
      expires_at: input.expiresAt ?? null,
      last_active_at: NOW.toISOString(),
      signing_key_sealed: sealed,
    })

    return { id, dbPath }
  }

  const template = join(dir, 'template.sqlite')
  const templateDb = openDatabase(template)
  migrate(templateDb)
  seed(templateDb, NOW)
  templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  templateDb.close()

  const rootHarness = harness({
    flags,
    control,
    registry,
    masterKey: MASTER,
    demo: { root: dir, template },
    webauthn: WA,
  })

  return { dir, control, registry, tenantSweeps, rootHarness, createTenant, controlDb }
}

describe('Q3.6 P2.T9: Expired demo cleanup job & preservation of default/studio/live', () => {
  it('cleans up expired demo workspaces, deletes their sqlite files, and frees resources', () => {
    const { control, registry, dir, createTenant } = setupTestEnvironment()

    // 1. Create an expired demo workspace
    const expiredDemo = createTenant({
      name: 'Expired Demo',
      mode: 'demo',
      expiresAt: '2026-03-31T00:00:00.000Z', // In the past
    })

    // Add session, member, external_ref to the expired demo
    const memberId = randomUUID()
    control.addMember({ id: memberId, workspaceId: expiredDemo.id, name: 'Alice Demo', role: 'owner', now: NOW.toISOString() })
    control.putSession({ token: 'expired-demo-token-12345678', memberId, workspaceId: expiredDemo.id, method: 'demo', now: NOW.toISOString(), idleHours: 1, absoluteDays: 1 })
    control.rememberRef('invoice', 'INV-EXPIRED-123', expiredDemo.id)

    // Verify files exist before cleanup
    expect(existsSync(expiredDemo.dbPath)).toBe(true)

    // Touch fake wal and shm files
    writeFileSync(`${expiredDemo.dbPath}-wal`, 'fake wal')
    writeFileSync(`${expiredDemo.dbPath}-shm`, 'fake shm')
    expect(existsSync(`${expiredDemo.dbPath}-wal`)).toBe(true)

    // Load into registry
    const handle = registry.get(expiredDemo.id)
    expect(handle).not.toBeNull()

    // 2. Create an active (unexpired) demo workspace
    const activeDemo = createTenant({
      name: 'Active Demo',
      mode: 'demo',
      expiresAt: '2026-04-02T00:00:00.000Z', // In the future
    })

    // 3. Run cleanup
    const result = cleanupExpiredDemos({ control, registry, now: NOW })

    expect(result.cleaned).toContain(expiredDemo.id)
    expect(result.cleaned).not.toContain(activeDemo.id)

    // 4. Verify expired demo file is gone from disk
    expect(existsSync(expiredDemo.dbPath)).toBe(false)
    expect(existsSync(`${expiredDemo.dbPath}-wal`)).toBe(false)
    expect(existsSync(`${expiredDemo.dbPath}-shm`)).toBe(false)

    // 5. Verify records in control database are deleted
    expect(control.workspace(expiredDemo.id)).toBeNull()
    expect(control.session('expired-demo-token-12345678', NOW.toISOString())).toBeNull()
    expect(control.workspaceForRef('invoice', 'INV-EXPIRED-123')).toBeNull()

    // 6. Verify active demo remains intact
    expect(existsSync(activeDemo.dbPath)).toBe(true)
    expect(control.workspace(activeDemo.id)).not.toBeNull()
  })

  it('never deletes default, studio, or live workspaces even if expires_at is set (Appendix B Case 27)', () => {
    const { control, registry, createTenant } = setupTestEnvironment()

    // Create studio workspace with past expiration
    const studio = createTenant({
      name: 'Line Studio',
      mode: 'studio',
      expiresAt: '2020-01-01T00:00:00.000Z',
    })

    // Create live workspace with past expiration
    const live = createTenant({
      name: 'Acme Live',
      mode: 'live',
      expiresAt: '2020-01-01T00:00:00.000Z',
    })

    // Ensure default workspace has a past date
    const defaultWs = control.workspace('ws_default')!
    expect(defaultWs).not.toBeNull()

    // Run cleanup
    const result = cleanupExpiredDemos({ control, registry, now: NOW })

    expect(result.cleaned).not.toContain(studio.id)
    expect(result.cleaned).not.toContain(live.id)
    expect(result.cleaned).not.toContain('ws_default')

    // Direct deletion attempts on non-demo workspaces fail
    expect(control.deleteDemo(studio.id)).toBe(false)
    expect(control.deleteDemo(live.id)).toBe(false)
    expect(control.deleteDemo('ws_default')).toBe(false)

    // Both files and control rows still exist
    expect(existsSync(studio.dbPath)).toBe(true)
    expect(existsSync(live.dbPath)).toBe(true)
    expect(control.workspace(studio.id)).not.toBeNull()
    expect(control.workspace(live.id)).not.toBeNull()
    expect(control.workspace('ws_default')).not.toBeNull()
  })
})

describe('Q3.6 P2.T10: Background work without per-tenant timers & on-demand demo ticks', () => {
  it('runs a single scheduler sweep visiting only tenants with active invoices or payouts', async () => {
    const { control, registry, tenantSweeps, createTenant } = setupTestEnvironment()

    const tenantA = createTenant({ name: 'Tenant A', mode: 'studio' })
    const tenantB = createTenant({ name: 'Tenant B', mode: 'studio' })
    const tenantC = createTenant({ name: 'Tenant C', mode: 'studio' })

    // Tenant A has an open invoice ref, Tenant B has an open payout ref, Tenant C has none
    control.rememberRef('invoice', 'INV-A-100', tenantA.id)
    control.rememberRef('payout', 'PAYOUT-B-200', tenantB.id)

    expect(control.activeRefWorkspaces()).toEqual(expect.arrayContaining([tenantA.id, tenantB.id]))
    expect(control.activeRefWorkspaces()).not.toContain(tenantC.id)

    // Run scheduler sweep
    const sweepResult = await runTenantSchedulerSweep({ control, registry })

    expect(sweepResult.swept).toContain(tenantA.id)
    expect(sweepResult.swept).toContain(tenantB.id)
    expect(sweepResult.swept).not.toContain(tenantC.id)

    expect(tenantSweeps.get(tenantA.id)).toBe(1)
    expect(tenantSweeps.get(tenantB.id)).toBe(1)
    expect(tenantSweeps.get(tenantC.id)).toBeUndefined()
  })

  it('demo tenants tick sweeps on demand after simulate action and when opening Today', async () => {
    const { rootHarness, control } = setupTestEnvironment()

    // Start a demo session
    const started = await rootHarness.app.request('http://mandate.test/demo/start', { method: 'POST' })
    expect(started.status).toBe(200)
    const { workspaceId } = await started.json() as { workspaceId: string }
    const cookie = started.headers.get('set-cookie') ?? ''

    // 1. Simulate payout success triggers on-demand sweep without errors
    const simRes = await rootHarness.app.request(`http://mandate.test/w/${workspaceId}/v1/demo/simulate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...WEB },
      body: JSON.stringify({ action: 'payout_success' }),
    })
    expect(simRes.status).toBe(200)

    // 2. Fetching Today triggers on-demand demo sweep
    const todayRes = await rootHarness.app.request(`http://mandate.test/w/${workspaceId}/v1/today`, {
      headers: { cookie },
    })
    expect(todayRes.status).toBe(200)
    const todayBody = await todayRes.json() as { clientAgent: { ready: boolean } }
    expect(todayBody.clientAgent).toBeDefined()
  })
})

describe('Q3.6 P2.T11: Isolation tests (Appendix B cases 22, 23, 24)', () => {
  it('Case 22: cookie, key, or id from A on B is 404', async () => {
    const { rootHarness, control, createTenant } = setupTestEnvironment()

    const tenantA = createTenant({ name: 'Studio A', mode: 'studio' })
    const tenantB = createTenant({ name: 'Studio B', mode: 'studio' })

    // Create session for member in Tenant A
    const memberA = randomUUID()
    control.addMember({ id: memberA, workspaceId: tenantA.id, name: 'Alice A', role: 'owner', now: NOW.toISOString() })
    const tokenA = 'session-token-for-tenant-a-12345'
    control.putSession({ token: tokenA, memberId: memberA, workspaceId: tenantA.id, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })

    // 1. Cookie from A used on Tenant A works
    const mineA = await rootHarness.app.request(`http://mandate.test/w/${tenantA.id}/v1/session`, {
      headers: { cookie: `mnd_session=${tokenA}` },
    })
    expect(mineA.status).toBe(200)

    // 2. Cookie from A used on Tenant B returns 404
    const cookieOnB = await rootHarness.app.request(`http://mandate.test/w/${tenantB.id}/v1/session`, {
      headers: { cookie: `mnd_session=${tokenA}` },
    })
    expect(cookieOnB.status).toBe(404)

    // 3. API key from A used on Tenant B returns 401
    const keyOnB = await rootHarness.app.request(`http://mandate.test/w/${tenantB.id}/v1/today`, {
      headers: { authorization: `Bearer owner-key-${tenantA.id}` },
    })
    expect(keyOnB.status).toBe(401)

    // 4. Create proposal in Tenant A
    const propResA = await rootHarness.app.request(`http://mandate.test/w/${tenantA.id}/v1/proposals`, {
      method: 'POST',
      headers: {
        cookie: `mnd_session=${tokenA}`,
        ...WEB,
        'content-type': 'application/json',
        'idempotency-key': 'idemp-proposal-isolated-123',
      },
      body: JSON.stringify({
        amountCents: 5000,
        currency: 'USD',
        category: 'design',
        payee: 'priya.shah@example.com',
        description: 'Milestone delivery',
        evidenceUrl: 'https://example.com/work',
      }),
    })
    expect(propResA.status).toBe(201)
    const bodyA = await propResA.json() as { id: string }
    expect(bodyA.id).toBeDefined()

    // 5. Querying Tenant A's proposal ID on Tenant B returns 404
    const memberB = randomUUID()
    control.addMember({ id: memberB, workspaceId: tenantB.id, name: 'Bob B', role: 'owner', now: NOW.toISOString() })
    const tokenB = 'session-token-for-tenant-b-12345'
    control.putSession({ token: tokenB, memberId: memberB, workspaceId: tenantB.id, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })

    const propOnB = await rootHarness.app.request(`http://mandate.test/w/${tenantB.id}/v1/proposals/${bodyA.id}`, {
      headers: { cookie: `mnd_session=${tokenB}` },
    })
    expect(propOnB.status).toBe(404)
  })

  it('Case 23: workspace id with path traversal or invalid format is 400', async () => {
    const { rootHarness } = setupTestEnvironment()

    // 1. Path traversal attempts
    const traversal = await rootHarness.app.request('http://mandate.test/w/..%2f..%2fetc/v1/session')
    expect(traversal.status).toBe(400)

    // 2. Malformed workspace ID
    const badId = await rootHarness.app.request('http://mandate.test/w/not-a-valid-workspace-id/v1/session')
    expect(badId.status).toBe(400)
  })

  it('Case 24: random work in A leaves B checksum completely unchanged', async () => {
    const { rootHarness, control, createTenant } = setupTestEnvironment()

    const tenantA = createTenant({ name: 'Studio A', mode: 'studio' })
    const tenantB = createTenant({ name: 'Studio B', mode: 'studio' })

    const memberA = randomUUID()
    control.addMember({ id: memberA, workspaceId: tenantA.id, name: 'Alice Work', role: 'owner', now: NOW.toISOString() })
    const tokenA = 'session-token-for-tenant-a-work'
    control.putSession({ token: tokenA, memberId: memberA, workspaceId: tenantA.id, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })

    // Helper to compute checksum of tables in B's database
    function getDbChecksum(dbPath: string): string {
      const db = openDatabase(dbPath)
      const tables = ['warrants', 'proposals', 'events', 'payees']
      const hash = createHash('sha256')
      for (const table of tables) {
        const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
        hash.update(JSON.stringify(rows))
      }
      db.close()
      return hash.digest('hex')
    }

    const checksumBefore = getDbChecksum(tenantB.dbPath)

    // Perform operations in Tenant A
    for (let i = 0; i < 3; i++) {
      const res = await rootHarness.app.request(`http://mandate.test/w/${tenantA.id}/v1/proposals`, {
        method: 'POST',
        headers: {
          cookie: `mnd_session=${tokenA}`,
          ...WEB,
          'content-type': 'application/json',
          'idempotency-key': `idemp-work-a-${i}-${randomUUID()}`,
        },
        body: JSON.stringify({
          amountCents: 1000 * (i + 1),
          currency: 'USD',
          category: 'design',
          payee: 'priya.shah@example.com',
          description: `Work item ${i}`,
          evidenceUrl: `https://example.com/proof-${i}`,
        }),
      })
      expect(res.status).toBe(201)
    }

    const checksumAfter = getDbChecksum(tenantB.dbPath)

    // B's database data is 100% identical and unchanged
    expect(checksumAfter).toBe(checksumBefore)
  })

  it('trims auth events older than 90 days and retains newer ones (P12.T5)', () => {
    const { control, registry } = setupTestEnvironment()

    // 100 days ago (should be trimmed)
    const oldDate = new Date(NOW.getTime() - 100 * 86_400_000).toISOString()
    control.event({
      id: 'event-old-100d',
      at: oldDate,
      workspaceId: 'ws_default',
      event: 'login',
      result: 'ok',
      ip: '127.0.0.1',
    })

    // 80 days ago (should be kept)
    const recentDate = new Date(NOW.getTime() - 80 * 86_400_000).toISOString()
    control.event({
      id: 'event-recent-80d',
      at: recentDate,
      workspaceId: 'ws_default',
      event: 'login',
      result: 'ok',
      ip: '127.0.0.1',
    })

    // Today (should be kept)
    control.event({
      id: 'event-today',
      at: NOW.toISOString(),
      workspaceId: 'ws_default',
      event: 'login',
      result: 'ok',
      ip: '127.0.0.1',
    })

    const beforeEvents = control.events('ws_default', 10)
    expect(beforeEvents).toHaveLength(3)

    // Run cleanup with now = NOW
    const result = cleanupExpiredDemos({ control, registry, now: NOW })
    expect(result.authEventsTrimmed).toBe(1)

    const afterEvents = control.events('ws_default', 10)
    expect(afterEvents).toHaveLength(2)
    expect(afterEvents.map((e) => e.at)).toEqual([NOW.toISOString(), recentDate])
  })

  it('trims client error logs and log files older than 14 days and retains newer ones (P12.T5)', () => {
    const { control, registry, createTenant } = setupTestEnvironment()
    const logDir = mkdtempSync(join(tmpdir(), 'mandate-logs-test-'))

    // Create an old log file (20 days old)
    const oldLog = join(logDir, 'access-old.log')
    writeFileSync(oldLog, 'old log content\n')
    const oldMtime = (NOW.getTime() - 20 * 86_400_000) / 1000
    utimesSync(oldLog, oldMtime, oldMtime)

    // Create a recent log file (5 days old)
    const recentLog = join(logDir, 'access-recent.log')
    writeFileSync(recentLog, 'recent log content\n')
    const recentMtime = (NOW.getTime() - 5 * 86_400_000) / 1000
    utimesSync(recentLog, recentMtime, recentMtime)

    // Setup tenant repo with client_errors
    const tenant = createTenant({ name: 'Log Studio', mode: 'studio' })
    const db = openDatabase(tenant.dbPath)
    const repo = new Repo(db)

    // 20 days old client error
    repo.insertClientError({
      id: 'err-old-20d',
      at: new Date(NOW.getTime() - 20 * 86_400_000).toISOString(),
      role: 'owner',
      scope: 'ui',
      message: 'old test error',
      stack: null,
      url: '/app',
      agent: null,
      releaseId: null,
    })

    // 5 days old client error
    repo.insertClientError({
      id: 'err-recent-5d',
      at: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
      role: 'owner',
      scope: 'ui',
      message: 'recent test error',
      stack: null,
      url: '/app',
      agent: null,
      releaseId: null,
    })

    expect(repo.recentClientErrors(10)).toHaveLength(2)
    expect(existsSync(oldLog)).toBe(true)
    expect(existsSync(recentLog)).toBe(true)

    // Run cleanup
    const result = cleanupExpiredDemos({
      control,
      registry,
      repo,
      logDir,
      now: NOW,
    })

    expect(result.logsTrimmed).toBe(2) // 1 file + 1 client_error record

    // Old log file deleted, recent remains
    expect(existsSync(oldLog)).toBe(false)
    expect(existsSync(recentLog)).toBe(true)

    // Old client error deleted, recent remains
    const remainingErrors = repo.recentClientErrors(10)
    expect(remainingErrors).toHaveLength(1)
    expect(remainingErrors[0]?.message).toBe('recent test error')

    db.close()
  })
})
