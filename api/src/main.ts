import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { buildServices } from './services/container'
import { AgentService } from './agents/service'
import { loadConfig } from './config'
import { migrate, openDatabase, seed } from './db/database'
import { loadSigner } from './domain/signing'
import { buildModels } from './agents/model'
import { installProcessGuards } from './http/process'
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
const services = buildServices({ db, paypal, invoices, watch, publicUrl: config.publicUrl, now: () => new Date(), signer, safety: { tripAfter: config.breakerRefusals, windowSeconds: config.breakerWindowSeconds } })

// Ollama Cloud's open-weights models power the agents. With no key they are off and everything else works.
const { primary: model, drafter: drafterModel, fallback: fallbackModel } = buildModels({
  OLLAMA_API_KEY: config.ollamaApiKey,
  OLLAMA_BASE_URL: config.ollamaBaseUrl,
  AGENT_MODEL: config.agentModel,
  DRAFTER_MODEL: config.drafterModel,
})
// If the main model errors, the fallback is tried once before the person sees a failure.
const agents = new AgentService(services, model, () => new Date(), drafterModel, fallbackModel)

installProcessGuards()
let draining = false
const app = createApp({
  draining: () => draining,
  db,
  signer,
  services,
  agents,
  invoices,
  model,
  drafterModel,
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
    clientAgent: config.clientAgent,
  },
})

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(JSON.stringify({ level: 'info', message: 'listening', host: info.address, port: info.port, paypal: config.paypal ? 'configured' : 'missing', console: webDist ? '/app/' : 'not built' }))
})

// A client dispute is news that can arrive between taps. Look for it every minute so a payout never leaves on stale news.
// A standing-rule payout that PayPal could not take, or a dispute held, is sent as soon as it can be.
// Look at PayPal every few seconds while an invoice or payout is in flight, once a minute when nothing is. A webhook
// (when the server has a public URL) makes it instant; this is what makes a payment show up without one.
let lastSweep = 0
let sweeping = false
const standingTimer = setInterval(() => {
  // Check every second whether it is time: 5 s apart while something is in flight, a minute apart otherwise.
  if (sweeping || Date.now() - lastSweep < services.mandate.nextSweepMs()) return
  sweeping = true
  void services.mandate.sweepStanding().then(() => services.mandate.sweepPending()).catch(() => undefined).finally(() => { lastSweep = Date.now(); sweeping = false })
}, 1_000)
standingTimer.unref()

// A delivery the client's stand-in has not answered (the model hiccuped, or the server restarted) is picked up here.
const reviewTimer = config.clientAgent === 'auto' ? setInterval(() => { void agents.reviewWaiting().catch((error) => console.error(JSON.stringify({ level: 'warn', message: 'review sweep failed', detail: String(error) }))) }, 30_000) : null
reviewTimer?.unref()

const disputeTimer = watch ? setInterval(() => { void services.mandate.syncDisputes().catch(() => undefined) }, 60_000) : null
disputeTimer?.unref()

// Slow clients and half-open connections are cut off instead of held forever.
const http = server as unknown as { requestTimeout?: number; headersTimeout?: number; keepAliveTimeout?: number; close: (done?: () => void) => void; closeIdleConnections?: () => void; closeAllConnections?: () => void }
http.requestTimeout = 120_000
http.headersTimeout = 30_000
http.keepAliveTimeout = 10_000

/**
 * Shutting down without cutting anything off: say so on /ready (so traffic moves away), stop the timers, let requests
 * already running finish for up to 15 seconds, then close the database. A second signal exits at once.
 */
let stopping = false
function shutdown() {
  if (stopping) process.exit(1)
  stopping = true
  draining = true
  if (disputeTimer) clearInterval(disputeTimer)
  clearInterval(standingTimer)
  if (reviewTimer) clearInterval(reviewTimer)
  console.log(JSON.stringify({ level: 'info', message: 'draining' }))
  const done = () => {
    try { db.close() } catch { /* already closed */ }
    process.exit(0)
  }
  http.close(done)
  http.closeIdleConnections?.()
  setTimeout(() => { http.closeAllConnections?.(); done() }, 15_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
