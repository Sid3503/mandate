// A throwaway server for end-to-end tests and demos: in-memory ledger, fake PayPal, the built console.
// Never use this with real money. Run: node --import tsx src/dev/e2e-server.ts
import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { createApp } from '../app'
import { migrate, openDatabase, seed } from '../db/database'
import { FakePayPal } from '../paypal/fake'

const port = Number(process.env.PORT ?? 8799)
const db = openDatabase(':memory:')
migrate(db)
seed(db, new Date())
const paypal = new FakePayPal()
paypal.autoApprove = process.env.FAKE_BUYER !== 'manual'

const app = createApp({
  db,
  paypal,
  now: () => new Date(),
  config: {
    apiKey: 'owner-e2e-key-0123456789',
    proposerKey: 'proposer-e2e-key-0123456789',
    webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)),
    rateLimitPerMinute: 0,
    paypalConfigured: true,
    log: false,
    publicUrl: `http://127.0.0.1:${port}`,
  },
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(JSON.stringify({ message: 'e2e server', port, paypal: 'fake', buyer: paypal.autoApprove ? 'auto' : 'manual' }))
})
