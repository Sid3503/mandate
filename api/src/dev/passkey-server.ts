// A throwaway server for the passkey repair tests. Flags on, fake PayPal, cookie not Secure.
// It listens on PORT (8777 in Playwright). It does not print secrets.
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { fileURLToPath } from 'node:url'
import { createApp } from '../app'
import { openProduct } from '../boot'
import { loadFlags } from '../flags'
import { migrate, openDatabase, seed } from '../db/database'
import { ephemeralSigner } from '../domain/signing'
import { FakePayPal } from '../paypal/fake'
import { buildServices } from '../services/container'

const port = Number(process.env.PORT ?? 8777)
const root = mkdtempSync(join(tmpdir(), 'mandate-passkey-'))
const databasePath = join(root, 'mandate.sqlite')
const db = openDatabase(databasePath)
migrate(db)
seed(db, new Date())
// Chrome rejects an IP address as a WebAuthn relying party id. localhost is allowed, and it matches the page host.
const publicUrl = `http://localhost:${port}`
const flags = loadFlags({ FLAG_TENANCY: '1', FLAG_PASSKEYS: '1', DEMO_ENABLED: '1', MODEL_ENABLED: '0' })
const product = openProduct({
  databasePath,
  ledger: db,
  flags,
  env: {
    MASTER_KEY: randomBytes(24).toString('base64url'),
    KEY_PEPPER: randomBytes(24).toString('base64url'),
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: publicUrl,
    COOKIE_SECURE: '0',
    TRUST_PROXY: '0',
  },
  publicUrl,
  now: () => new Date(),
  nodeEnv: 'test',
})
const paypal = new FakePayPal()
const signer = ephemeralSigner()
const services = buildServices({ db, paypal, now: () => new Date(), signer, publicUrl })
const app = createApp({
  db,
  paypal,
  signer,
  services,
  now: () => new Date(),
  control: product.control,
  registry: product.registry,
  budget: product.budget,
  masterKey: product.masterKey,
  demo: product.demo,
  config: {
    apiKey: 'passkey-repair-owner-key-32',
    rateLimitPerMinute: 0,
    paypalConfigured: false,
    log: false,
    publicUrl,
    flags,
    webDist: process.env.WEB_DIST ?? fileURLToPath(new URL('../../../web/dist', import.meta.url)),
    webauthn: product.webauthn,
    cookieSecure: false,
    trustProxy: false,
    trustedProxyHops: product.trustedProxyHops,
    classedRates: false,
  },
})

serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, () => {
  console.log(JSON.stringify({ message: 'passkey repair server', port }))
})
