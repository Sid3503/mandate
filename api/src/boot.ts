import { mkdirSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type { AgentModel } from './agents/model'
import { ControlStore } from './control/store'
import { migrate, openDatabase, seed } from './db/database'
import { loadSigner } from './domain/signing'
import type { ServerFlags } from './flags'
import { createApp } from './app'
import { ModelBudget, capsFromEnv, sqliteBudgetStore } from './ops/budget'
import { proxyHops } from './ops/client-ip'
import { FakePayPal } from './paypal/fake'
import type { InvoicePort } from './paypal/invoices'
import type { PayPalPort } from './paypal/port'
import type { WatchPort } from './paypal/watch'
import { catalogFromEnv } from './procure/channel3'
import { buildServices } from './services/container'
import { inWorkspace } from './services/live'
import { openSeal } from './tenancy/envelope'
import { TenantRegistry } from './tenancy/registry'

import { cleanupExpiredDemos, runTenantSchedulerSweep, tenantSweepInFlight } from './ops/scheduler'

/** A PayPal account for one studio: the client, the invoice tools and the account reader. */
export type StudioPayPal = { paypal: PayPalPort; invoices: InvoicePort | null; watch: WatchPort | null; environment: 'sandbox' | 'live' }

export type ProductBoot = {
  control: ControlStore | null
  registry: TenantRegistry | null
  budget: ModelBudget
  masterKey: string | null
  demo: { root: string; template: string } | null
  adminKey: string | null
  webauthn: { rpID: string; rpName: string; origins: string[] } | null
  cookieSecure: boolean
  trustProxy: boolean
  trustedProxyHops: number
  classedRates: boolean
  idleHours: number
  absoluteDays: number
  redact: string[]
  cleanupTimer?: NodeJS.Timeout | null
  schedulerTimer?: NodeJS.Timeout | null
  cleanupNow?: () => { cleaned: string[]; skipped: string[] }
  sweepNow?: () => Promise<{ swept: string[]; skipped?: boolean }>
  /**
   * Shutdown, part one: waits (up to `timeoutMs`) for a tenant sweep that is still running, so it is not cut off
   * halfway through a write. `close` then closes every studio database and the control database.
   */
  drain: (timeoutMs?: number) => Promise<void>
  close: () => void
}

/**
 * Settings that are wrong in production, checked once at boot. A setting that would hand out sessions is refused
 * outright; one the free hosting tier cannot avoid is only said, loudly, so the operator knows what they are running.
 */
export function bootSafety(input: { nodeEnv: string; flags: ServerFlags; env: NodeJS.ProcessEnv; databasePath: string }): { warnings: string[] } {
  const production = input.nodeEnv === 'production'
  // The PayPal login door is a stand-in: it signs anyone in as the studio's owner for any code but two. It exists for
  // the tests and a local demo. On a production server it would be an open door, so the server does not start.
  if (production && input.flags.paypalLogin) {
    throw new Error('PAYPAL_LOGIN_ENABLED is a test stand-in that signs anyone in as the owner; it cannot be on when NODE_ENV=production')
  }
  const warnings: string[] = []
  if (!production) return { warnings }
  if (!input.env.KEY_PEPPER?.trim()) {
    warnings.push('KEY_PEPPER is not set: agent and client key hashes use the built-in fallback pepper, which is public in the source. Set KEY_PEPPER (render.yaml generates one).')
  }
  const path = input.databasePath
  if (path !== ':memory:' && (path === '/tmp' || path.startsWith('/tmp/') || path.startsWith('/private/tmp/'))) {
    warnings.push(`DATABASE_PATH is under /tmp (${path}): the ledger, its keys and every studio are lost on each restart, and backups on the same disk go with them.`)
  }
  return { warnings }
}

function perMinute(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function on(value: string | undefined): boolean {
  return value === '1' || value === 'true' || value === 'on'
}

function hours(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`invalid ${name}`)
  return parsed
}

/**
 * Opens the control database and the tenant registry only when a flag needs them.
 * Flags off keeps the single studio database and does not ask for new secrets.
 */
export function openProduct(input: {
  databasePath: string
  flags: ServerFlags
  env: NodeJS.ProcessEnv
  publicUrl: string
  now: () => Date
  nodeEnv: string
  /** The ledger that is already open. Counters and the kill switch are stored here so a restart keeps them. */
  ledger?: DatabaseSync | null
  model?: AgentModel | null
  drafterModel?: AgentModel | null
  /**
   * Builds the PayPal account a studio moves money on. A studio that owns real money gets the server's own account; the
   * hosted demo gets a stand-in. Called once per studio, so each has its own client and its own token.
   */
  paypalFactory?: () => StudioPayPal | null
  /** The per-key request limit of the main app. Each studio's app applies the same limit to its own keys. */
  rateLimitPerMinute?: number
}): ProductBoot {
  const flags = input.flags
  for (const warning of bootSafety({ nodeEnv: input.nodeEnv, flags, env: input.env, databasePath: input.databasePath }).warnings) {
    console.warn(JSON.stringify({ level: 'warn', message: `[boot] ${warning}` }))
  }
  // A machine key sent to the main address is handed to its studio's app before the main app's limiter sees it, so the
  // studio's app must count it itself. Zero (no limit) was the old setting and let a studio key call without limit.
  const tenantRateLimit = input.rateLimitPerMinute ?? perMinute(input.env.RATE_LIMIT_PER_MINUTE, 120)
  const budget = new ModelBudget(capsFromEnv(input.env), input.now, 'ws_default', input.ledger ? sqliteBudgetStore(input.ledger) : null)
  // A flag that is off pauses this process only. A persisted kill would stay on after a later boot turns the model back on.
  if (!flags.modelEnabled) budget.pause()
  const masterKey = input.env.MASTER_KEY?.trim() || null
  const pepper = input.env.KEY_PEPPER?.trim() || null
  const adminKey = input.env.ADMIN_KEY?.trim() || null
  const trustProxy = on(input.env.TRUST_PROXY)
  const trustedProxyHops = proxyHops(input.env.TRUSTED_PROXY_HOPS)
  const cookieSecure = on(input.env.COOKIE_SECURE) || (input.nodeEnv === 'production' && input.publicUrl.startsWith('https://'))
  const classedRates = trustProxy
  const idleHours = hours('SESSION_IDLE_HOURS', input.env.SESSION_IDLE_HOURS, 12)
  const absoluteDays = hours('SESSION_ABSOLUTE_DAYS', input.env.SESSION_ABSOLUTE_DAYS, 7)
  const redact = [input.env.API_KEY, input.env.PROPOSER_KEY, input.env.BUYER_AGENT_KEY, input.env.PAYPAL_CLIENT_SECRET, input.env.MASTER_KEY, input.env.KEY_PEPPER, input.env.ADMIN_KEY, input.env.SIGNING_KEY, input.env.CHANNEL3_API_KEY].filter((item): item is string => typeof item === 'string' && item.length >= 8)
  const needsPeople = flags.tenancy || flags.demoEnabled || flags.passkeys || flags.invites
  const webauthn = input.env.WEBAUTHN_RP_ID && input.env.WEBAUTHN_ORIGINS
    ? { rpID: input.env.WEBAUTHN_RP_ID, rpName: input.env.WEBAUTHN_RP_NAME?.trim() || 'Mandate', origins: input.env.WEBAUTHN_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean) }
    : null
  if (!needsPeople) {
    return { control: null, registry: null, budget, masterKey: null, demo: null, adminKey, webauthn, cookieSecure, trustProxy, trustedProxyHops, classedRates, idleHours, absoluteDays, redact, drain: async () => undefined, close: () => undefined }
  }
  if (!masterKey || masterKey.length < 16 || !pepper || pepper.length < 16) {
    throw new Error('MASTER_KEY and KEY_PEPPER are required when workspaces, the demo, passkeys, or invites are on')
  }
  if (flags.passkeys && (!webauthn || webauthn.origins.length === 0)) {
    throw new Error('WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required when passkeys are on')
  }
  if (input.databasePath === ':memory:') throw new Error('workspaces need a file database')
  const root = dirname(input.databasePath)
  const controlDb = openDatabase(join(root, 'control.sqlite'))
  const control = new ControlStore(controlDb, pepper)
  control.ensureDefault(input.databasePath, input.now().toISOString())
  let demo: { root: string; template: string } | null = null
  if (flags.tenancy || flags.demoEnabled) {
    const template = join(root, 'templates', 'line-studio.sqlite')
    mkdirSync(dirname(template), { recursive: true })
    const fresh = openDatabase(template)
    const empty = (fresh.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'warrants'").get() as { n: number }).n === 0
    if (empty) {
      migrate(fresh)
      seed(fresh, input.now())
      fresh.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    fresh.close()
    const wsRoot = join(root, 'ws')
    mkdirSync(wsRoot, { recursive: true })
    demo = { root: wsRoot, template }
  }
  let registry: TenantRegistry | null = null
  if (flags.tenancy) registry = new TenantRegistry((id) => {
    const row = control.workspace(id)
    if (!row || row.status !== 'active' || !row.signing_key_sealed) return null
    if (row.mode !== 'demo' && row.mode !== 'studio') return null
    if (row.expires_at && row.expires_at <= input.now().toISOString()) return null
    const db = openDatabase(row.db_path)
    migrate(db)
    // The studio's own PayPal. A studio that moves real money uses the server's account; the hosted demo uses a
    // stand-in, and says so. There is no other path: one code, chosen by what the studio is.
    // A studio someone created moves money on this server's PayPal, decided now, at boot: credentials added later are
    // picked up, and a server with none gives the studio none — never a stand-in that pretends money moved. Only the
    // hosted demo plays with a stand-in, and it says so.
    const real = row.mode === 'studio' || row.paypal_mode === 'sandbox' ? input.paypalFactory?.() ?? null : null
    const paypal = real?.paypal ?? (row.mode === 'demo' ? new FakePayPal() : null)
    const paypalMode = real ? 'sandbox' as const : row.mode === 'demo' ? 'fake' as const : 'none' as const
    const invoices = real?.invoices ?? null
    const watch = real?.watch ?? null
    const signer = loadSigner({ pem: openSeal(masterKey, row.signing_key_sealed), production: false })
    const services = buildServices({
      db,
      paypal,
      invoices,
      watch,
      now: input.now,
      signer,
      workspaceId: id,
      payeeBook: flags.payeeBook,
      newPayeeWaitHours: flags.newPayeeWaitHours,
      paypalEnvironment: real?.environment ?? 'sandbox',
      catalog: catalogFromEnv(input.env),
      onExternalRef: (kind, externalId) => control.rememberRef(kind, externalId, id),
    })
    const app = createApp({
      db,
      paypal,
      invoices,
      watch,
      signer,
      now: input.now,
      nested: true,
      control,
      registry,
      budget: row.mode === 'demo'
        ? new ModelBudget({ globalDailyTokens: 10_000_000, workspaceDailyTokens: 50_000, maxOutputTokens: 2048, maxSteps: 4 }, input.now, id, sqliteBudgetStore(db))
        : budget,
      masterKey,
      workspace: { id, mode: row.mode, name: row.name, paypalMode },
      services,
      model: input.model ?? null,
      drafterModel: input.drafterModel ?? null,
      config: {
        apiKey: input.env.API_KEY && input.env.API_KEY.length >= 16 ? input.env.API_KEY : 'tenant-placeholder-key',
        rateLimitPerMinute: tenantRateLimit,
        paypalConfigured: real !== null,
        paypalMode: real ? real.environment : paypalMode,
        paypalEnvironment: real?.environment ?? 'sandbox',
        log: false,
        publicUrl: input.publicUrl,
        flags,
        webauthn,
        adminKey,
        cookieSecure,
        trustProxy,
        trustedProxyHops,
        classedRates: false,
        idleHours,
        absoluteDays,
        redact,
        // Starting over re-seeds the sample studio. That is the demo's to do, never a studio someone created.
        demoReset: row.mode === 'demo',
      },
    })
    return {
      id,
      fetch: (request) => app.fetch(request),
      close: () => db.close(),
      // A sweep runs outside any request, so it says which studio it is working for: what it publishes on the live
      // bus reaches this studio's screens and nobody else's.
      sweep: () => inWorkspace(id, async () => {
        await services.mandate.sweepStanding()
        await services.mandate.sweepPending()
        await services.breaks.scanIfDue()
      }),
    }
  })

  const cleanupTimer = (flags.tenancy || flags.demoEnabled)
    ? setInterval(() => {
        cleanupExpiredDemos({ control, registry, now: input.now() })
      }, 15 * 60_000)
    : null
  cleanupTimer?.unref()

  const schedulerTimer = (flags.tenancy && registry)
    ? setInterval(() => {
        void runTenantSchedulerSweep({ control, registry }).catch(() => undefined)
      }, 15_000)
    : null
  schedulerTimer?.unref()

  return {
    control, registry, budget, masterKey, demo, adminKey, webauthn, cookieSecure, trustProxy, trustedProxyHops, classedRates, idleHours, absoluteDays, redact,
    cleanupTimer,
    schedulerTimer,
    cleanupNow: () => cleanupExpiredDemos({ control, registry, now: input.now() }),
    sweepNow: () => (registry ? runTenantSchedulerSweep({ control, registry }) : Promise.resolve({ swept: [] })),
    drain: async (timeoutMs = 10_000) => {
      if (cleanupTimer) clearInterval(cleanupTimer)
      if (schedulerTimer) clearInterval(schedulerTimer)
      const running = registry ? tenantSweepInFlight(registry) : null
      if (!running) return
      let timer: NodeJS.Timeout | undefined
      await Promise.race([
        running.catch(() => undefined),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref() }),
      ])
      if (timer) clearTimeout(timer)
    },
    close: () => {
      if (cleanupTimer) clearInterval(cleanupTimer)
      if (schedulerTimer) clearInterval(schedulerTimer)
      try { registry?.closeAll() } catch { /* already closed */ }
      try { controlDb.close() } catch { /* already closed */ }
    },
  }
}
