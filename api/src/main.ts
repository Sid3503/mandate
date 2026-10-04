import { serve } from '@hono/node-server'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from './app'
import { loadConfig } from './config'
import { migrate, openDatabase, seed } from './db/database'
import { createPayPalClient } from './paypal/client'

const config = loadConfig(process.env)
const defaultWeb = fileURLToPath(new URL('../../web/dist', import.meta.url))
const webDist = config.webDist ?? (existsSync(defaultWeb) ? defaultWeb : null)
const db = openDatabase(config.databasePath)
migrate(db)
seed(db, new Date())

const app = createApp({
  db,
  paypal: config.paypal ? createPayPalClient(config.paypal) : null,
  now: () => new Date(),
  config: {
    apiKey: config.apiKey,
    proposerKey: config.proposerKey,
    webDist,
    rateLimitPerMinute: config.rateLimitPerMinute,
    paypalConfigured: config.paypal !== null,
    log: config.log,
    publicUrl: config.publicUrl,
  },
})

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(JSON.stringify({ level: 'info', message: 'listening', host: info.address, port: info.port, paypal: config.paypal ? 'configured' : 'missing', console: webDist ? '/app/' : 'not built' }))
})

function shutdown() {
  server.close()
  db.close()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
