import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { ControlStore } from '../src/control/store'
import { migrate, openDatabase, seed } from '../src/db/database'
import { Repo } from '../src/db/repo'
import { machineKeyHash } from '../src/services/machine-key'
import { loadSigner } from '../src/domain/signing'
import { loadFlags } from '../src/flags'
import { FakePayPal } from '../src/paypal/fake'
import { buildServices } from '../src/services/container'
import { stepBinding } from '../src/auth/passkeys'
import { openSeal } from '../src/tenancy/envelope'
import { TenantRegistry } from '../src/tenancy/registry'
import { closeAll, harness, NOW } from './support'
import { SoftAuthenticator } from './soft-authenticator'

afterEach(closeAll)

const MASTER = Buffer.alloc(32, 9).toString('base64')
const WA = { rpID: 'localhost', rpName: 'Mandate', origins: ['http://127.0.0.1:8787'] }
const WEB = { origin: 'http://127.0.0.1:8787', 'x-mandate-client': 'web' }

/**
 * A server with the doors open: studios, passkeys and the demo. The PayPal mode says what a new studio moves money
 * on, which is what the server itself uses.
 */
function desk(paypalMode: 'none' | 'fake' | 'sandbox' = 'none') {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-studio-'))
  const template = join(dir, 'template.sqlite')
  const templateDb = openDatabase(template)
  migrate(templateDb)
  seed(templateDb, NOW)
  templateDb.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  templateDb.close()
  const controlDb = openDatabase(':memory:')
  const control = new ControlStore(controlDb, 'pepper-studio')
  control.ensureDefault(':memory:', NOW.toISOString())
  const flags = loadFlags({ FLAG_TENANCY: '1', DEMO_ENABLED: '1', FLAG_PASSKEYS: '1' })
  let registry!: TenantRegistry
  registry = new TenantRegistry((id) => {
    const row = control.workspace(id)
    if (!row?.signing_key_sealed) return null
    const db = openDatabase(row.db_path)
    migrate(db)
    const paypal = new FakePayPal()
    const signer = loadSigner({ pem: openSeal(MASTER, row.signing_key_sealed), production: false })
    const built = createApp({
      db,
      paypal,
      signer,
      now: () => NOW,
      nested: true,
      control,
      registry,
      workspace: { id, mode: row.mode, name: row.name, paypalMode: row.paypal_mode },
      services: buildServices({ db, paypal, now: () => NOW, signer }),
      config: {
        apiKey: 'tenant-owner-key-32chars',
        rateLimitPerMinute: 0,
        paypalConfigured: paypalMode === 'sandbox',
        paypalMode,
        log: false,
        publicUrl: 'http://127.0.0.1:8787',
        flags,
        webauthn: WA,
      },
    })
    return { id, fetch: (request) => built.fetch(request), close: () => db.close() }
  })
  const app = harness({ flags, control, registry, masterKey: MASTER, demo: { root: dir, template }, webauthn: WA, paypalMode })
  return { ...app, control, controlDb }
}

/** Opens a studio and signs its owner in, the way the console does. */
async function openStudio(h: ReturnType<typeof desk>, name: string) {
  const opened = await h.app.request('http://mandate.test/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  expect(opened.status).toBe(200)
  const body = await opened.json() as { workspaceId: string; memberId: string; challengeId: string; options: { challenge: string }; paypal: string }
  const auth = new SoftAuthenticator('http://127.0.0.1:8787', 'localhost')
  const registered = await h.app.request('http://mandate.test/auth/register/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: body.challengeId, response: auth.register(body.options.challenge) }),
  })
  expect(registered.status).toBe(200)
  const login = await h.app.request('http://mandate.test/auth/login/options', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const options = await login.json() as { challengeId: string; options: { challenge: string } }
  const signedIn = await h.app.request('http://mandate.test/auth/login/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challengeId: options.challengeId, response: auth.authenticate(options.options.challenge) }),
  })
  expect(signedIn.status).toBe(200)
  const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  return { ...body, cookie, headers: { ...WEB, cookie } }
}

describe('a studio of its own', () => {
  it('opens a page on 127.0.0.1 at localhost, where a passkey can be made', async () => {
    const h = harness()
    const page = await h.app.request('http://127.0.0.1:8787/app/studio', { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } })
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe('http://localhost:8787/app/studio')
    const call = await h.app.request('http://127.0.0.1:8787/health', { headers: { 'sec-fetch-dest': 'document', accept: 'text/html' } })
    expect(call.status).not.toBe(302)
    const fetch = await h.app.request('http://127.0.0.1:8787/app/studio', { headers: { accept: 'text/html' } })
    expect(fetch.status).not.toBe(302)
  })

  it('starts with nothing in it: no rules, no people, no example numbers', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Quiet Studio')
    const rules = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/warrant`, { headers: studio.headers })
    expect(rules.status).toBe(404)
    expect((await rules.json() as { code: string }).code).toBe('warrant.missing')
    // Nothing may be asked for money before the owner has written any rules.
    const asked = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/proposals`, {
      method: 'POST',
      headers: { ...studio.headers, 'content-type': 'application/json', 'idempotency-key': `studio-${randomUUID()}` },
      body: JSON.stringify({ kind: 'charge', payee: 'Northwind', amountCents: 9000, currency: 'USD', category: 'design', description: 'Logo', evidenceUrl: 'https://example.com/logo', jobId: 'job_one' }),
    })
    expect(asked.status).toBe(404)
    expect((await asked.json() as { code: string }).code).toBe('warrant.missing')
    h.controlDb.close()
  })

  it('a client key pasted at the front door opens that studio', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Harbor Studio')
    const token = `mnd_cl_${studio.workspaceId}_harborfoodsbuyerkey1`
    const row = h.control.workspace(studio.workspaceId)
    const db = openDatabase(row!.db_path)
    new Repo(db).createClientKey({
      id: randomUUID(),
      name: 'Harbor Foods buyer',
      party_id: 'client_harbor',
      status: 'active',
      key_hash: machineKeyHash(token),
      created_at: NOW.toISOString(),
      last_seen_at: null,
    })
    db.close()
    const session = await h.app.request('http://mandate.test/v1/session', { headers: { authorization: `Bearer ${token}` } })
    expect(session.status).toBe(200)
    const body = await session.json() as { workspaceId: string; side: string; role: string; studioName: string }
    expect(body.workspaceId).toBe(studio.workspaceId)
    expect(body.studioName).toBe('Harbor Studio')
    expect(body.side).toBe('buyer')
    expect(body.role).toBe('proposer')
    const status = await h.app.request('http://mandate.test/v1/status', { headers: { authorization: `Bearer ${token}` } })
    expect(status.status).toBe(200)
    const missing = await h.app.request('http://mandate.test/v1/session', { headers: { authorization: 'Bearer mnd_cl_ws_abcdefghijklmnopqrst_notakey' } })
    expect(missing.status).toBe(404)
    h.controlDb.close()
  })

  it('opens a studio whose client key was stamped ws_default', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Harbor Studio')
    const token = 'mnd_cl_ws_default_harborfoodsbuyerkey'
    const row = h.control.workspace(studio.workspaceId)
    const db = openDatabase(row!.db_path)
    new Repo(db).createClientKey({
      id: randomUUID(),
      name: 'Harbor Foods buyer',
      party_id: 'client_harbor',
      status: 'active',
      key_hash: machineKeyHash(token),
      created_at: NOW.toISOString(),
      last_seen_at: null,
    })
    db.close()
    const session = await h.app.request('http://mandate.test/v1/session', { headers: { authorization: `Bearer ${token}` } })
    expect(session.status).toBe(200)
    const body = await session.json() as { workspaceId: string; side: string; studioName: string }
    expect(body.workspaceId).toBe(studio.workspaceId)
    expect(body.studioName).toBe('Harbor Studio')
    expect(body.side).toBe('buyer')
    const nowhere = await h.app.request('http://mandate.test/v1/session', { headers: { authorization: 'Bearer mnd_cl_ws_default_not_a_real_key' } })
    expect(nowhere.status).toBe(401)
    h.controlDb.close()
  })

  it('is named by the owner, and says so', async () => {
    const h = desk()
    const studio = await openStudio(h, "Sid's Studio")
    expect(h.control.workspace(studio.workspaceId)?.name).toBe("Sid's Studio")
    const session = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/session`, { headers: studio.headers })
    expect(session.status).toBe(200)
    expect((await session.json() as { studioName: string }).studioName).toBe("Sid's Studio")
    h.controlDb.close()
  })

  it('moves money the way the server moves money', async () => {
    const without = desk('none')
    const plain = await openStudio(without, 'No PayPal Studio')
    expect(plain.paypal).toBe('fake')
    expect(without.control.workspace(plain.workspaceId)?.paypal_mode).toBe('fake')
    without.controlDb.close()

    const withPayPal = desk('sandbox')
    const real = await openStudio(withPayPal, 'Real Studio')
    expect(real.paypal).toBe('sandbox')
    expect(withPayPal.control.workspace(real.workspaceId)?.paypal_mode).toBe('sandbox')
    const session = await withPayPal.app.request(`http://mandate.test/w/${real.workspaceId}/v1/session`, { headers: real.headers })
    expect((await session.json() as { paypalMode: string }).paypalMode).toBe('sandbox')
    withPayPal.controlDb.close()
  })

  it('keeps the rules in the owner\'s own words, and drops them once they are rules', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Words Studio')
    const written = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/rules/words`, {
      method: 'POST',
      headers: { ...studio.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Pay a contractor only when the client has paid and the work is delivered.' }),
    })
    expect(written.status).toBe(200)
    const read = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/rules/words`, { headers: studio.headers })
    expect(read.status).toBe(200)
    expect((await read.json() as { words: { body: string } }).words.body).toBe('Pay a contractor only when the client has paid and the work is delivered.')
    // The words live in the studio's own ledger, so another browser finds them.
    const row = h.control.workspace(studio.workspaceId)
    expect(row).toBeTruthy()
    const db = openDatabase(row!.db_path)
    const stored = db.prepare('SELECT body FROM rule_words').all() as Array<{ body: string }>
    expect(stored.map((item) => item.body)).toEqual(['Pay a contractor only when the client has paid and the work is delivered.'])
    db.close()
    h.controlDb.close()
  })

  it('tells a new studio its own next step, not the sample job', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Harbor Studio')
    const empty = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/today`, { headers: studio.headers })
    expect(empty.status).toBe(200)
    expect((await empty.json() as { next: { step: string } }).next.step).toContain('no rules yet')
    const rules = {
      currency: 'USD',
      autoSettleUnderCents: 2000,
      monthlyCapCents: 18000,
      perPaymentCeilingCents: 50000,
      evidenceRequired: true,
      timezone: 'UTC',
      payees: [{ id: 'payee_ava', displayName: 'Ava Chen', email: 'ava@example.com', aliases: [] }],
      categories: ['design'],
      clients: [{ id: 'client_harbor', displayName: 'Harbor Foods', email: 'ap@harbor.example', aliases: [] }],
      fundingRequired: true,
      contractorShareBps: 6000,
      clearingDays: 0,
      allowPartialPayment: false,
      standing: [],
      automation: { billSignedDeals: false, requireAcceptance: false, payOnSettle: false, remindUnpaidAfterDays: null, maxReminders: 2 },
    }
    const binding = createHash('sha256').update(JSON.stringify(rules)).digest('hex')
    h.control.putGrant({ id: 'grant-harbor-rules', memberId: studio.memberId, workspaceId: studio.workspaceId, kind: 'rules', binding, now: NOW.toISOString() })
    const published = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/warrant`, {
      method: 'PUT',
      headers: { ...studio.headers, 'content-type': 'application/json', 'x-mandate-stepup': 'grant-harbor-rules' },
      body: JSON.stringify(rules),
    })
    expect(published.status).toBe(201)
    const page = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/today`, { headers: studio.headers })
    const step = (await page.json() as { next: { step: string }; setup: { steps: Array<{ id: string; done: boolean }> } })
    expect(step.next.step).toBe('Set the least your studio will take for a job, on Deals. That number is yours. Each client sets the most they will pay with their own key.')
    expect(step.next.step).not.toContain('Northwind')
    expect(step.next.step).not.toContain('$300.00')
    expect(step.setup.steps.find((item) => item.id === 'people')?.done).toBe(true)
    expect(step.setup.steps.find((item) => item.id === 'price')?.done).toBe(false)
    h.controlDb.close()
  })

  it('lets only the owner write the words', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Owner Words')
    // Someone else in the studio: they may read the owner's words, but not write them.
    const proposerId = randomUUID()
    h.control.addMember({ id: proposerId, workspaceId: studio.workspaceId, name: 'Arun', role: 'proposer', now: NOW.toISOString() })
    const token = 'studio-proposer-session-token-32'
    h.control.putSession({ token, memberId: proposerId, workspaceId: studio.workspaceId, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const asProposer = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/rules/words`, {
      method: 'POST',
      headers: { ...WEB, cookie: `mnd_session=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'not the owner' }),
    })
    expect(asProposer.status).toBe(403)
    const read = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/rules/words`, { headers: { ...WEB, cookie: `mnd_session=${token}` } })
    expect(read.status).toBe(200)
    h.controlDb.close()
  })

  it('lets an approver read Today, and still refuses a proposer', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Queue Studio')
    const approverId = randomUUID()
    h.control.addMember({ id: approverId, workspaceId: studio.workspaceId, name: 'Ada', role: 'approver', now: NOW.toISOString() })
    h.control.putSession({ token: 'studio-approver-session-token-32', memberId: approverId, workspaceId: studio.workspaceId, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const approver = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/today`, { headers: { ...WEB, cookie: 'mnd_session=studio-approver-session-token-32' } })
    expect(approver.status).toBe(200)
    const proposerId = randomUUID()
    h.control.addMember({ id: proposerId, workspaceId: studio.workspaceId, name: 'Arun', role: 'proposer', now: NOW.toISOString() })
    h.control.putSession({ token: 'studio-proposer-today-token-32', memberId: proposerId, workspaceId: studio.workspaceId, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    const proposer = await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/today`, { headers: { ...WEB, cookie: 'mnd_session=studio-proposer-today-token-32' } })
    expect(proposer.status).toBe(403)
    h.controlDb.close()
  })

  it('lets the owner close the studio after naming it, and will not close the demo', async () => {
    const h = desk()
    const studio = await openStudio(h, 'Harbor Studio')
    const dbPath = h.control.workspace(studio.workspaceId)!.db_path
    const binding = stepBinding('studio.close', studio.workspaceId)
    h.control.putGrant({ id: 'grant-close-harbor', memberId: studio.memberId, workspaceId: studio.workspaceId, kind: 'studio.close', binding, now: NOW.toISOString() })
    const close = (name: string, grant = 'grant-close-harbor', headers = studio.headers) => h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/studio/close`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json', 'x-mandate-stepup': grant },
      body: JSON.stringify({ name }),
    })
    expect((await close('Not Harbor')).status).toBe(400)
    expect(h.control.workspace(studio.workspaceId)?.name).toBe('Harbor Studio')
    expect((await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/studio/close`, {
      method: 'POST',
      headers: { ...studio.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Harbor Studio' }),
    })).status).toBe(401)
    const approverId = randomUUID()
    h.control.addMember({ id: approverId, workspaceId: studio.workspaceId, name: 'Ada', role: 'approver', now: NOW.toISOString() })
    h.control.putSession({ token: 'studio-approver-close-token-32', memberId: approverId, workspaceId: studio.workspaceId, method: 'passkey', now: NOW.toISOString(), idleHours: 12, absoluteDays: 7 })
    expect((await close('Harbor Studio', 'grant-close-harbor', { ...WEB, cookie: 'mnd_session=studio-approver-close-token-32' })).status).toBe(403)
    const closed = await close('Harbor Studio')
    expect(closed.status).toBe(200)
    expect(h.control.workspace(studio.workspaceId)).toBeNull()
    expect(existsSync(dbPath)).toBe(false)
    expect((await h.app.request(`http://mandate.test/w/${studio.workspaceId}/v1/today`, { headers: studio.headers })).status).toBe(404)

    const started = await h.app.request('http://mandate.test/demo/start', { method: 'POST' })
    expect(started.status).toBe(200)
    const demoId = (await started.json() as { workspaceId: string }).workspaceId
    const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
    const refused = await h.app.request(`http://mandate.test/w/${demoId}/v1/studio/close`, {
      method: 'POST',
      headers: { ...WEB, cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Line Studio' }),
    })
    expect(refused.status).toBe(404)
    expect(h.control.workspace(demoId)?.mode).toBe('demo')
    expect(h.control.deleteStudio(demoId)).toBe(false)
    expect(h.control.deleteStudio('ws_default')).toBe(false)
    h.controlDb.close()
  })
})
