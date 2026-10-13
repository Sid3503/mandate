import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { ephemeralSigner, loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { FakeInvoices, FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { openSeal, seal } from '../src/tenancy/envelope'
import { newWorkspaceId } from '../src/tenancy/ids'
import { TenantRegistry } from '../src/tenancy/registry'
import { closeAll, harness } from './support'

afterEach(closeAll)

const NOW = new Date('2026-04-01T12:00:00.000Z')
const MASTER = 'master-secret-key-at-least-32-chars!'
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }

function setupTenancyHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-routing-test-'))
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-test-routing')
  control.ensureDefault(':memory:', NOW.toISOString())

  const flags = loadFlags({
    FLAG_TENANCY: '1',
    DEMO_ENABLED: '1',
    FLAG_PASSKEYS: '1',
    FLAG_INVITES: '1',
  })

  const tenantSigners = new Map<string, ReturnType<typeof ephemeralSigner>>()
  const tenantServices = new Map<string, ReturnType<typeof buildServices>>()
  const tenantPaypals = new Map<string, FakePayPal>()
  const tenantInvoices = new Map<string, FakeInvoices>()

  const registry = new TenantRegistry((id) => {
    const row = control.workspace(id)
    if (!row?.signing_key_sealed) return null
    const db = openDatabase(row.db_path)
    migrate(db)
    seed(db, NOW)
    const paypal = new FakePayPal()
    const invoices = new FakeInvoices()
    tenantPaypals.set(id, paypal)
    tenantInvoices.set(id, invoices)
    const signer = loadSigner({ pem: openSeal(MASTER, row.signing_key_sealed), production: false })
    tenantSigners.set(id, signer as any)
    const services = buildServices({
      db,
      paypal,
      invoices,
      now: () => NOW,
      signer,
      onExternalRef: (kind, externalId) => control.rememberRef(kind, externalId, id),
    })
    tenantServices.set(id, services)
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
        apiKey: `owner-key-for-${id}`,
        proposerKey: `studio-key-for-${id}`,
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
    }
  })

  const rootHarness = harness({
    flags,
    control,
    registry,
    masterKey: MASTER,
    webauthn: WA,
  })

  const createTenantWorkspace = (id: string, name: string = 'Tenant Studio') => {
    const dbPath = join(dir, `${id}.sqlite`)
    const tDb = openDatabase(dbPath)
    migrate(tDb)
    seed(tDb, NOW)
    const row = tDb.prepare('SELECT body_json FROM warrants WHERE id = ?').get('wnt_line_studio') as { body_json: string }
    const body = JSON.parse(row.body_json)
    body.fundingRequired = false
    tDb.prepare('UPDATE warrants SET body_json = ? WHERE id = ?').run(JSON.stringify(body), 'wnt_line_studio')
    tDb.close()

    const { privateKey } = generateKeyPairSync('ed25519')
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const sealedKey = seal(MASTER, pem)
    control.insertWorkspace({
      id,
      slug: id,
      name,
      mode: 'studio',
      paypal_mode: 'fake',
      db_path: dbPath,
      status: 'active',
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + 86400000).toISOString(),
      last_active_at: NOW.toISOString(),
      signing_key_sealed: sealedKey,
    })
    return { id, dbPath, pem }
  }

  return {
    ...rootHarness,
    control,
    registry,
    dir,
    createTenantWorkspace,
    tenantSigners,
    tenantServices,
    tenantPaypals,
    tenantInvoices,
  }
}

describe('Q3.5 tenant routing: public keys, MCP under /w, and webhook external_refs', () => {
  it('serves per-workspace public keys under GET /w/:workspaceId/.well-known/mandate-keys.json', async () => {
    const ctx = setupTenancyHarness()
    const tenant1Id = newWorkspaceId()
    const tenant2Id = newWorkspaceId()
    ctx.createTenantWorkspace(tenant1Id, 'Tenant Alpha')
    ctx.createTenantWorkspace(tenant2Id, 'Tenant Beta')

    // Root workspace public keys
    const rootRes = await ctx.app.request('http://mandate.test/.well-known/mandate-keys.json')
    expect(rootRes.status).toBe(200)
    const rootKeys = (await rootRes.json()) as { data: Array<{ keyId: string; publicKeyPem: string }> }
    expect(rootKeys.data.length).toBeGreaterThan(0)

    // Forwarded default workspace public keys
    const defaultRes = await ctx.app.request('http://mandate.test/w/ws_default/.well-known/mandate-keys.json')
    expect(defaultRes.status).toBe(200)
    const defaultKeys = (await defaultRes.json()) as { data: Array<{ keyId: string; publicKeyPem: string }> }
    expect(defaultKeys.data[0]!.publicKeyPem).toBe(rootKeys.data[0]!.publicKeyPem)

    // Tenant 1 public keys
    const t1Res = await ctx.app.request(`http://mandate.test/w/${tenant1Id}/.well-known/mandate-keys.json`)
    expect(t1Res.status).toBe(200)
    const t1Keys = (await t1Res.json()) as { data: Array<{ keyId: string; publicKeyPem: string }> }
    expect(t1Keys.data.length).toBeGreaterThan(0)
    expect(t1Keys.data[0]!.publicKeyPem).not.toBe(rootKeys.data[0]!.publicKeyPem)

    // Tenant 2 public keys
    const t2Res = await ctx.app.request(`http://mandate.test/w/${tenant2Id}/.well-known/mandate-keys.json`)
    expect(t2Res.status).toBe(200)
    const t2Keys = (await t2Res.json()) as { data: Array<{ keyId: string; publicKeyPem: string }> }
    expect(t2Keys.data.length).toBeGreaterThan(0)
    expect(t2Keys.data[0]!.publicKeyPem).not.toBe(t1Keys.data[0]!.publicKeyPem)

    // Rejects bad workspace id (traversal or invalid format) with 400
    const badRes = await ctx.app.request('http://mandate.test/w/ws_invalid..id/.well-known/mandate-keys.json')
    expect(badRes.status).toBe(400)

    // Unknown workspace id with 404
    const unknownId = newWorkspaceId()
    const unknownRes = await ctx.app.request(`http://mandate.test/w/${unknownId}/.well-known/mandate-keys.json`)
    expect(unknownRes.status).toBe(404)
  })

  it('serves MCP under /w/:workspaceId/mcp isolated to that tenant', async () => {
    const ctx = setupTenancyHarness()
    const tenantId = newWorkspaceId()
    ctx.createTenantWorkspace(tenantId, 'MCP Studio')

    // Invalid key to /w/:workspaceId/mcp is 401
    const badKeyRes = await ctx.app.request(`http://mandate.test/w/${tenantId}/mcp`, {
      method: 'POST',
      headers: { authorization: 'Bearer invalid-agent-key-12345678', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(badKeyRes.status).toBe(401)

    // Connect MCP client to /w/:workspaceId/mcp with tenant studio key
    const tenantStudioKey = `studio-key-for-${tenantId}`
    const transport = new StreamableHTTPClientTransport(new URL(`http://mandate.test/w/${tenantId}/mcp`), {
      fetch: (input, init) => Promise.resolve(ctx.app.fetch(new Request(input as string, init))),
      requestInit: { headers: { authorization: `Bearer ${tenantStudioKey}`, 'x-mandate-run': 'test-run-1' } },
    })
    const client = new Client({ name: 'test-tenant-agent', version: '1.0.0' })
    await client.connect(transport)

    const tools = (await client.listTools()).tools
    expect(tools.map((t) => t.name).sort()).toEqual(['explain', 'get_jobs', 'get_rules', 'list_ledger', 'offer_deal', 'propose'])

    // Call a tool on tenant MCP
    const callResult = await client.callTool({ name: 'get_rules', arguments: {} })
    expect(callResult.isError).toBeFalsy()
    expect(callResult.structuredContent).toBeDefined()

    await client.close()

    // MCP call on unknown workspace is 404
    const unknownId = newWorkspaceId()
    const unknownRes = await ctx.app.request(`http://mandate.test/w/${unknownId}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tenantStudioKey}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(unknownRes.status).toBe(404)
  })

  it('routes webhooks arriving at top-level to tenant workspace via external_refs', async () => {
    const ctx = setupTenancyHarness()
    const tenantId = newWorkspaceId()
    ctx.createTenantWorkspace(tenantId, 'Webhook Studio')

    // Access the tenant via registry to warm it and create a proposal with a payout batch
    const tenantEntry = ctx.registry.get(tenantId)
    expect(tenantEntry).not.toBeNull()
    const services = ctx.tenantServices.get(tenantId)!
    expect(services).toBeDefined()
    const tenantPaypal = ctx.tenantPaypals.get(tenantId)!

    // Create a payment proposal in tenant workspace
    const propRes = services.mandate.propose({
      kind: 'payment',
      payee: 'Priya',
      amountCents: 5000,
      currency: 'USD',
      category: 'design',
      description: 'Milestone delivery',
      evidenceUrl: 'https://example.com/evidence.pdf',
    }, 'idemp-payout-1')
    const proposal = propRes.body as { id: string; gate: string }
    expect(proposal.gate).toBe('NEEDS_APPROVAL')
    expect(proposal.id).toBeDefined()

    // Approve the proposal in tenant workspace
    services.mandate.approve(proposal.id)
    // Set PENDING so capture sends the batch but the payout is not yet settled (proposal lands in payout_sent)
    tenantPaypal.payoutOutcome = 'PENDING'
    // Execute payout in tenant workspace: creates payout batch and records external_ref
    await services.mandate.capture(proposal.id)
    const paid = services.repo.proposal(proposal.id)!
    expect(paid.phase).toBe('payout_sent')
    expect(paid.payout_batch_id).toBeDefined()
    const batchId = paid.payout_batch_id!

    // Verify external_refs registered in control store for tenant
    expect(ctx.control.workspaceForRef('payout', batchId)).toBe(tenantId)

    // Settle the batch in the fake so refreshPayoutBatch will see SUCCESS
    tenantPaypal.settlePayouts('SUCCESS')

    // Now send a PayPal payout webhook to the TOP-LEVEL route (not /w/:workspace)
    const webhookPayload = {
      id: 'WH-EVENT-TEST-TENANT-001',
      event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS',
      resource: {
        batch_header: {
          payout_batch_id: batchId,
          batch_status: 'SUCCESS',
        },
      },
    }

    const webhookRes = await ctx.app.request('http://mandate.test/v1/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    })
    expect(webhookRes.status).toBe(200)
    const webhookBody = (await webhookRes.json()) as { received: boolean; refreshed?: boolean }
    expect(webhookBody.received).toBe(true)

    // Verify tenant proposal was updated by the webhook (payout.completed → 'captured')
    const tenantUpdated = services.repo.proposal(proposal.id)!
    expect(tenantUpdated.phase).toBe('captured')

    // Verify duplicate webhook event is recognized as duplicate by the tenant
    const dupRes = await ctx.app.request('http://mandate.test/v1/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    })
    expect(dupRes.status).toBe(200)
    const dupBody = (await dupRes.json()) as { received: boolean; duplicate?: boolean }
    expect(dupBody.received).toBe(true)
    expect(dupBody.duplicate).toBe(true)
  })

  it('routes invoice webhooks arriving at top-level to tenant workspace via external_refs', async () => {
    const ctx = setupTenancyHarness()
    const tenantId = newWorkspaceId()
    ctx.createTenantWorkspace(tenantId, 'Invoice Studio')

    const tenantEntry = ctx.registry.get(tenantId)
    expect(tenantEntry).not.toBeNull()
    const services = ctx.tenantServices.get(tenantId)!
    expect(services).toBeDefined()
    const tenantInvoices = ctx.tenantInvoices.get(tenantId)!

    // Create a charge proposal in tenant workspace
    const invRes = services.mandate.propose({
      kind: 'charge',
      payee: 'Northwind',
      amountCents: 12000,
      currency: 'USD',
      category: 'design',
      description: 'Consulting services',
      jobId: 'job_northwind_logo',
      evidenceUrl: 'https://example.com/invoice-evidence.pdf',
    }, 'idemp-inv-1')
    const proposal = invRes.body as { id: string; gate: string }
    expect(proposal.gate).toBe('NEEDS_APPROVAL')
    expect(proposal.id).toBeDefined()
    services.mandate.approve(proposal.id)

    // Capture triggers invoice creation and sending via FakeInvoices; invoice starts in SENT
    await services.mandate.capture(proposal.id)
    const invoiced = services.repo.proposal(proposal.id)!
    expect(invoiced.phase).toBe('invoice_sent')
    expect(invoiced.invoice_id).toBeDefined()
    const invoiceId = invoiced.invoice_id!

    // Verify external_refs in control store
    expect(ctx.control.workspaceForRef('invoice', invoiceId)).toBe(tenantId)

    // Simulate the client paying the invoice at PayPal so refreshInvoice will see PAID
    tenantInvoices.pay(invoiceId)

    // Send PayPal invoice paid webhook to top-level route
    const webhookPayload = {
      id: 'WH-EVENT-INV-PAID-001',
      event_type: 'INVOICING.INVOICE.PAID',
      resource: {
        invoice: {
          id: invoiceId,
          status: 'PAID',
        },
      },
    }

    const webhookRes = await ctx.app.request('http://mandate.test/v1/webhooks/paypal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload),
    })
    expect(webhookRes.status).toBe(200)
    const webhookBody = (await webhookRes.json()) as { received: boolean }
    expect(webhookBody.received).toBe(true)

    // After the webhook routes to the tenant and refreshInvoice sees PAID, proposal settles to 'captured'
    const updated = services.repo.proposal(proposal.id)!
    expect(updated.phase).toBe('captured')
  })
})
