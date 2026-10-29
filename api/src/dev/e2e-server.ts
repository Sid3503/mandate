// A throwaway server for end-to-end tests and demos: in-memory ledger, fake PayPal, the built console.
// Never use this with real money. Run: node --import tsx src/dev/e2e-server.ts
import { serve } from '@hono/node-server'
import { appendFileSync, readFileSync, writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from '../app'
import { buildServices } from '../services/container'
import { migrate, openDatabase, seed } from '../db/database'
import { createAgentModel, DEFAULT_OLLAMA_MODEL } from '../agents/model'
import { FakeInvoices, FakePayPal, FakeWatch } from '../paypal/fake'
import { createPayPalClient } from '../paypal/client'
import { loadFlags } from '../flags'
import { demoModel } from './demo-model'
import { PartyRulesSchema } from '../domain/deal'
import { WARRANT_ID } from '../domain/schemas'
import { adoptPayment } from './adopt'

const port = Number(process.env.PORT ?? 8799)
// To try this server through a tunnel (ngrok), say its address and pick keys of your own: the tests' keys are public.
const publicUrl = process.env.E2E_PUBLIC_URL?.trim().replace(/\/$/, '') || `http://127.0.0.1:${port}`
const ownerKey = process.env.E2E_OWNER_KEY?.trim() || 'owner-e2e-key-0123456789'
const keyTail = process.env.E2E_OWNER_KEY ? ownerKey.slice(-12) : 'e2e-key-0123456789'

// A test server that dies takes every later test down with "connection refused", which hides the cause. Say why,
// synchronously (an exiting process can lose buffered output), and to a file as well when E2E_CRASH_LOG names one.
const crashed = (what: string, error: unknown) => {
  const line = `[e2e-server ${port}] ${what}: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  try { writeSync(2, line) } catch { /* stderr is gone */ }
  if (process.env.E2E_CRASH_LOG) try { appendFileSync(process.env.E2E_CRASH_LOG, line) } catch { /* nowhere to write */ }
}
process.on('uncaughtException', (error) => { crashed('uncaughtException', error); process.exit(1) })
process.on('unhandledRejection', (error) => crashed('unhandledRejection', error))
process.on('exit', (code) => crashed('exit', `code ${code}`))
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => { crashed('signal', signal); process.exit(0) })
const db = openDatabase(':memory:')
migrate(db)
seed(db, new Date())

// E2E_SCENARIO picks the cast a demo is recorded with (api/src/dev/scenarios.json): the studio, its client, its
// contractor, the kinds of work, the rules' amounts and each company's price sheet. `line` is the seed as it is.
// The recorder and the outside agent read the same file, so a take never mixes two casts.
type Scenario = {
  studio: string
  client: { id: string; displayName: string; email: string; aliases: string[] }
  payee: { id: string; displayName: string; email: string; aliases: string[] }
  categories: string[]
  clientCategories: string[]
  rules: { currency: string; autoSettleUnderCents: number; monthlyCapCents: number; perPaymentCeilingCents: number; contractorShareBps: number; timezone: string }
  seller: { minTotalCents: number; targetTotalCents?: number; style?: string; brief?: string }
  buyer: { maxTotalCents: number; targetTotalCents?: number; style?: string; brief?: string }
}
const scenarioName = process.env.E2E_SCENARIO ?? 'line'
const scenarios = JSON.parse(readFileSync(new URL('./scenarios.json', import.meta.url), 'utf8')) as Record<string, Scenario>
const scenario = scenarios[scenarioName]
if (!scenario) throw new Error(`E2E_SCENARIO ${scenarioName} is not in scenarios.json (${Object.keys(scenarios).join(', ')})`)
if (scenarioName !== 'line') {
  const now = new Date().toISOString()
  const row = db.prepare('SELECT body_json FROM warrants WHERE version = 1').get() as { body_json: string }
  const body = { ...JSON.parse(row.body_json), ...scenario.rules, payees: [scenario.payee], clients: [scenario.client], categories: scenario.categories, standing: [] }
  db.prepare('UPDATE warrants SET body_json = ? WHERE version = 1').run(JSON.stringify(body))
  db.exec('DELETE FROM payees')
  db.prepare('INSERT INTO payees (id, email, status, verified_method, first_seen, total_paid_cents) VALUES (?, ?, ?, ?, ?, 0)').run(scenario.payee.id, scenario.payee.email, 'active', 'owner_attested', now)
  db.exec('DELETE FROM party_rules')
  const sheet = db.prepare(`INSERT INTO party_rules (party_id, version, body_json, created_at, origin) VALUES (?, 1, ?, ?, 'seed')`)
  const common = { currency: scenario.rules.currency, maxMilestones: 4, requireProof: true }
  sheet.run(WARRANT_ID, JSON.stringify(PartyRulesSchema.parse({ role: 'seller', displayName: scenario.studio, categories: scenario.categories, ...common, ...scenario.seller })), now)
  sheet.run(scenario.client.id, JSON.stringify(PartyRulesSchema.parse({ role: 'buyer', displayName: scenario.client.displayName, categories: scenario.clientCategories, ...common, ...scenario.buyer })), now)
}
// E2E_REAL_PAYPAL=1 takes money through the real PayPal sandbox (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, sandbox
// only) instead of the fake, for recording the product doing it for real. The example addresses are not PayPal
// accounts, so a payout to them is held as unclaimed: E2E_PAYEE_EMAIL and E2E_CLIENT_EMAIL put sandbox accounts in
// their place, in the seeded rules and payees, before anything is asked.
const realPayPal = process.env.E2E_REAL_PAYPAL === '1'
if (realPayPal) {
  const base = process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com'
  if (!/sandbox/.test(base) || !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) throw new Error('E2E_REAL_PAYPAL needs sandbox PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET')
  const row = db.prepare('SELECT body_json FROM warrants WHERE version = 1').get() as { body_json: string }
  const body = JSON.parse(row.body_json)
  if (process.env.E2E_PAYEE_EMAIL) {
    body.payees[0].email = process.env.E2E_PAYEE_EMAIL
    db.prepare('UPDATE payees SET email = ? WHERE id = ?').run(process.env.E2E_PAYEE_EMAIL, body.payees[0].id)
  }
  if (process.env.E2E_CLIENT_EMAIL) body.clients[0].email = process.env.E2E_CLIENT_EMAIL
  db.prepare('UPDATE warrants SET body_json = ? WHERE version = 1').run(JSON.stringify(body))
}
const fakePayPal = new FakePayPal()
const paypal = realPayPal ? createPayPalClient({ clientId: process.env.PAYPAL_CLIENT_ID!, clientSecret: process.env.PAYPAL_CLIENT_SECRET!, baseUrl: process.env.PAYPAL_API ?? 'https://api-m.sandbox.paypal.com' }) : fakePayPal
// Like the real sandbox app today, the fake has no permission to send invoices until a test turns it on, so
// billing falls back to checkout. That lets one server show both paths.
const invoices = new FakeInvoices()
invoices.unauthorised = true
const model = (process.env.E2E_LIVE_MODEL ? createAgentModel({ apiKey: process.env.OLLAMA_API_KEY, baseUrl: process.env.OLLAMA_BASE_URL, name: process.env.AGENT_MODEL ?? 'gpt-oss:20b' }) : null) ?? demoModel({ delayMs: Number(process.env.DEMO_MODEL_DELAY_MS ?? 0) })
fakePayPal.autoApprove = process.env.FAKE_BUYER !== 'manual'

const watch = new FakeWatch()
// The rules drafter can be a live model while the negotiators stay scripted, the same split the real server makes
// (DRAFTER_MODEL beside AGENT_MODEL). E2E_LIVE_DRAFTER=1 with OLLAMA_API_KEY turns it on.
const drafterModel = process.env.E2E_LIVE_DRAFTER ? createAgentModel({ apiKey: process.env.OLLAMA_API_KEY, baseUrl: process.env.OLLAMA_BASE_URL, name: process.env.DRAFTER_MODEL ?? DEFAULT_OLLAMA_MODEL }) : null
// The breaker is off for the tests (they make many refused requests on purpose). E2E_TRIP_AFTER=3 turns the real one on.
const services = buildServices({ db, paypal, invoices, watch, publicUrl, now: () => new Date(), safety: { tripAfter: Number(process.env.E2E_TRIP_AFTER ?? 0) } })
// E2E_ADOPT=<paypal-record.json> brings a payment PayPal already holds into this ledger (see adopt.ts), to film what happens
// to it next. With E2E_REAL_PAYPAL=1 a refund then goes to the real capture.
if (process.env.E2E_ADOPT) {
  const cast = { client: scenario.client, payee: scenario.payee, categories: scenario.categories, proof: (scenario as unknown as { proof: string }).proof }
  console.log(JSON.stringify({ message: 'adopted', ...adoptPayment(services, process.env.E2E_ADOPT, cast) }))
}
const app = createApp({
  db,
  paypal,
  invoices,
  watch,
  services,
  model,
  drafterModel,
  now: () => new Date(),
  config: {
    apiKey: ownerKey,
    proposerKey: process.env.E2E_OWNER_KEY ? `proposer-${keyTail}-${ownerKey.slice(0, 8)}` : 'proposer-e2e-key-0123456789',
    buyerAgentKey: process.env.E2E_OWNER_KEY ? `buyer-agent-${keyTail}-${ownerKey.slice(0, 8)}` : 'buyer-agent-e2e-key-0123456789',
    buyerAgentParty: scenario.client.id,
    webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)),
    rateLimitPerMinute: 0,
    paypalConfigured: true,
    paypalMode: realPayPal ? 'sandbox' : 'fake',
    log: false,
    publicUrl,
    // Lets the deploy smoke test be rehearsed against this server (GIT_COMMIT=<sha> pretends to be that build).
    commit: process.env.GIT_COMMIT?.trim() || null,
    // The tests run against a fake PayPal, so the reset a hosted demo uses is safe to offer here.
    demoReset: true,
    flags: loadFlags({ FLAG_POLICY_PASTE: '1', ...process.env }),
  },
})

// Test-only: the breaker is off in these tests, so this is how a test gets an agent into the suspended state.
app.post('/__fake/agents/:id/suspend', (c) => {
  services.repo.setAgentStatus(c.req.param('id'), 'suspended', new Date().toISOString())
  return c.json({ ok: true })
})

// Test-only controls for how the fake PayPal answers a payout. They need the owner key like everything else.
app.post('/__fake/payouts/:outcome', async (c) => {
  const outcome = c.req.param('outcome')
  if (outcome === 'settle') fakePayPal.settlePayouts('SUCCESS')
  else if (outcome === 'unregistered') fakePayPal.unregistered.add('priya.shah@example.com')
  else if (outcome === 'registered') fakePayPal.unregistered.delete('priya.shah@example.com')
  else if (outcome === 'sweep') await services.mandate.sweepStanding().then(() => services.mandate.sweepPending())
  else if (outcome === 'buyer-manual') fakePayPal.autoApprove = false
  else if (outcome === 'buyer-auto') fakePayPal.autoApprove = true
  else if (outcome === 'buyer-approve') fakePayPal.approveAll()
  else if (outcome === 'scopes-limited') fakePayPal.scopeList = fakePayPal.scopeList.filter((scope) => !scope.includes('invoicing') && !scope.includes('reporting'))
  else if (outcome === 'scopes-full') fakePayPal.scopeList = [...new Set([...fakePayPal.scopeList, 'https://uri.fakePayPal.com/services/invoicing', 'https://uri.fakePayPal.com/services/reporting/search/read'])]
  else if (outcome === 'invoices-on') invoices.unauthorised = false
  else if (outcome === 'invoices-off') invoices.unauthorised = true
  else if (outcome === 'invoices-pay') {
    for (const [id, invoice] of invoices.invoices) if (invoice.status === 'SENT') invoices.pay(id)
  } else if (outcome === 'SUCCESS' || outcome === 'PENDING' || outcome === 'FAILED') fakePayPal.payoutOutcome = outcome
  else return c.json({ error: 'unknown outcome' }, 400)
  return c.json({ ok: true, outcome })
})

// A dev server may set a cookie instead of reading ?key= from the URL
app.get('/__fake/session', (c) => {
  const token = c.req.query('key') ?? 'owner-e2e-key-0123456789'
  const workspace = c.req.query('workspace')
  c.header('set-cookie', `mandate_session=${token}; Path=/; SameSite=Lax`)
  if (workspace) {
    c.header('set-cookie', `mandate_workspace=${workspace}; Path=/; SameSite=Lax`, { append: true })
  }
  const redirect = c.req.query('redirect')
  if (redirect) return c.redirect(redirect, 302)
  return c.json({ ok: true, session: 'cookie_set' })
})

// With real PayPal, a payout or a card capture settles a few seconds later on PayPal's side. Look, as the real server
// does: every 5 seconds while something is in flight, once a minute otherwise.
if (realPayPal) {
  let lastSweep = 0
  let sweeping = false
  setInterval(() => {
    if (sweeping || Date.now() - lastSweep < services.mandate.nextSweepMs()) return
    sweeping = true
    void services.mandate.sweepStanding().then(() => services.mandate.sweepPending()).catch(() => undefined).finally(() => { lastSweep = Date.now(); sweeping = false })
  }, 1_000).unref()
}

serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(JSON.stringify({ message: 'e2e server', port, paypal: realPayPal ? 'sandbox' : 'fake', buyer: fakePayPal.autoApprove ? 'auto' : 'manual' }))
})
