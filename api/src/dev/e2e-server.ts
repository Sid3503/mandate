// A throwaway server for end-to-end tests and demos: in-memory ledger, fake PayPal, the built console.
// Never use this with real money. Run: node --import tsx src/dev/e2e-server.ts
import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { createApp } from '../app'
import { buildServices } from '../services/container'
import { migrate, openDatabase, seed } from '../db/database'
import { modelByName } from '../agents/model'
import { FakeInvoices, FakePayPal, FakeWatch } from '../paypal/fake'
import { demoModel } from './demo-model'

const port = Number(process.env.PORT ?? 8799)
const db = openDatabase(':memory:')
migrate(db)
seed(db, new Date())
const paypal = new FakePayPal()
// Like the real sandbox app today, the fake has no permission to send invoices until a test turns it on, so
// billing falls back to checkout. That lets one server show both paths.
const invoices = new FakeInvoices()
invoices.unauthorised = true
const model = (process.env.E2E_LIVE_MODEL ? modelByName(process.env.AGENT_MODEL ?? 'us.openai.gpt-6-luna', process.env) : null) ?? demoModel({ delayMs: Number(process.env.DEMO_MODEL_DELAY_MS ?? 0) })
paypal.autoApprove = process.env.FAKE_BUYER !== 'manual'

const watch = new FakeWatch()
const services = buildServices({ db, paypal, invoices, watch, publicUrl: `http://127.0.0.1:${port}`, now: () => new Date() })
const app = createApp({
  db,
  paypal,
  invoices,
  watch,
  services,
  model,
  now: () => new Date(),
  config: {
    apiKey: 'owner-e2e-key-0123456789',
    proposerKey: 'proposer-e2e-key-0123456789',
    buyerAgentKey: 'buyer-agent-e2e-key-0123456789',
    buyerAgentParty: 'client_northwind',
    webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)),
    rateLimitPerMinute: 0,
    paypalConfigured: true,
    log: false,
    publicUrl: `http://127.0.0.1:${port}`,
  },
})

// Test-only controls for how the fake PayPal answers a payout. They need the owner key like everything else.
app.post('/__fake/payouts/:outcome', async (c) => {
  const outcome = c.req.param('outcome')
  if (outcome === 'settle') paypal.settlePayouts('SUCCESS')
  else if (outcome === 'unregistered') paypal.unregistered.add('priya.shah@example.com')
  else if (outcome === 'registered') paypal.unregistered.delete('priya.shah@example.com')
  else if (outcome === 'sweep') await services.mandate.sweepStanding().then(() => services.mandate.sweepPending())
  else if (outcome === 'buyer-manual') paypal.autoApprove = false
  else if (outcome === 'buyer-auto') paypal.autoApprove = true
  else if (outcome === 'buyer-approve') paypal.approveAll()
  else if (outcome === 'scopes-limited') paypal.scopeList = paypal.scopeList.filter((scope) => !scope.includes('invoicing') && !scope.includes('reporting'))
  else if (outcome === 'scopes-full') paypal.scopeList = [...new Set([...paypal.scopeList, 'https://uri.paypal.com/services/invoicing', 'https://uri.paypal.com/services/reporting/search/read'])]
  else if (outcome === 'invoices-on') invoices.unauthorised = false
  else if (outcome === 'invoices-off') invoices.unauthorised = true
  else if (outcome === 'invoices-pay') {
    for (const [id, invoice] of invoices.invoices) if (invoice.status === 'SENT') invoices.pay(id)
  } else if (outcome === 'SUCCESS' || outcome === 'PENDING' || outcome === 'FAILED') paypal.payoutOutcome = outcome
  else return c.json({ error: 'unknown outcome' }, 400)
  return c.json({ ok: true, outcome })
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(JSON.stringify({ message: 'e2e server', port, paypal: 'fake', buyer: paypal.autoApprove ? 'auto' : 'manual' }))
})
