import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { buildServices } from './services/container'
import { loadConfig } from './config'
import { migrate, openDatabase, seed } from './db/database'
import { loadSigner } from './domain/signing'
import { createAgentModel } from './agents/model'
import { createToolkitInvoices } from './paypal/invoices'
import { createPayPalClient } from './paypal/client'
import { createToolkitWatch } from './paypal/watch'

const config = loadConfig(process.env)
const defaultWeb = fileURLToPath(new URL('../../web/dist', import.meta.url))
const webDist = config.webDist ?? (existsSync(defaultWeb) ? defaultWeb : null)
const db = openDatabase(config.databasePath)
migrate(db)
seed(db, new Date())

const signer = loadSigner({
  pem: config.signingKey ?? undefined,
  previousPublicPems: config.previousPublicKeys,
  devKeyPath: config.databasePath === ':memory:' ? null : join(dirname(config.databasePath), 'signing-key.pem'),
  production: config.nodeEnv === 'production',
})

const sandbox = config.paypal ? !config.paypal.baseUrl.includes('api-m.paypal.com') : true
const paypal = config.paypal ? createPayPalClient(config.paypal) : null
const invoices = config.invoices && config.paypal ? createToolkitInvoices({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, sandbox }) : null
const watch = config.paypal ? createToolkitWatch({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, sandbox }) : null
const services = buildServices({ db, paypal, invoices, watch, publicUrl: config.publicUrl, now: () => new Date(), signer })

const app = createApp({
  db,
  signer,
  services,
  invoices,
  model: createAgentModel({ apiKey: config.ollamaApiKey, baseUrl: config.ollamaBaseUrl, name: config.agentModel }),
  watch,
  paypal,
  now: () => new Date(),
  config: {
    apiKey: config.apiKey,
    proposerKey: config.proposerKey,
    buyerAgentKey: config.buyerAgentKey,
    buyerAgentParty: config.buyerAgentParty,
    webDist,
    rateLimitPerMinute: config.rateLimitPerMinute,
    paypalConfigured: config.paypal !== null,
    log: config.log,
    publicUrl: config.publicUrl,
    webhookId: config.paypalWebhookId,
  },
})

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(JSON.stringify({ level: 'info', message: 'listening', host: info.address, port: info.port, paypal: config.paypal ? 'configured' : 'missing', console: webDist ? '/app/' : 'not built' }))
})

// A client dispute is news that can arrive between taps. Look for it every minute so a payout never leaves on stale news.
const disputeTimer = watch ? setInterval(() => { void services.mandate.syncDisputes().catch(() => undefined) }, 60_000) : null
disputeTimer?.unref()

function shutdown() {
  if (disputeTimer) clearInterval(disputeTimer)
  server.close()
  db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
