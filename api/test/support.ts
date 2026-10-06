import { createApp, type AppDeps } from '../src/app'
import { migrate, openDatabase, seed } from '../src/db/database'
import { Repo } from '../src/db/repo'
import type { InvoicePort } from '../src/paypal/invoices'
import type { WatchPort } from '../src/paypal/watch'
import type { AgentModel } from '../src/agents/model'
import { ephemeralSigner, type Signer } from '../src/domain/signing'
import { FakePayPal } from '../src/paypal/fake'
import { buildServices, type Services } from '../src/services/container'

export const NOW = new Date('2026-10-03T12:00:00.000Z')
export const OWNER_KEY = 'test-mandate-key-32chars'
export const STUDIO_KEY = 'test-proposer-key-32chars'
export const BUYER_KEY = 'test-buyer-agent-key-32chars'
export const JOB = 'job_northwind_logo'
export const EVIDENCE = 'https://www.figma.com/file/northwind-logo'

const open: Array<{ close: () => void }> = []
export function closeAll() {
  for (const db of open) db.close()
  open.length = 0
}

export type Requester = { request: (input: string, init?: RequestInit) => Response | Promise<Response> }

export function harness(options: { invoices?: InvoicePort | null; model?: AgentModel | null; paypal?: FakePayPal | null; signer?: Signer; watch?: WatchPort | null; webhookId?: string | null } = {}) {
  const db = openDatabase(':memory:')
  open.push(db)
  migrate(db)
  seed(db, NOW)
  const paypal = options.paypal === undefined ? new FakePayPal() : options.paypal
  const signer = options.signer ?? ephemeralSigner()
  let services!: Services
  const build = (useSigner: Signer = signer) => createApp({
    db,
    paypal,
    signer: useSigner,
    invoices: options.invoices,
    watch: options.watch,
    model: options.model,
    services: (services = buildServices({ db, paypal, invoices: options.invoices, watch: options.watch, publicUrl: 'http://127.0.0.1:8787', now: () => NOW, signer: useSigner })),
    now: () => NOW,
    config: {
      apiKey: OWNER_KEY,
      proposerKey: STUDIO_KEY,
      buyerAgentKey: BUYER_KEY,
      buyerAgentParty: 'client_northwind',
      webDist: null,
      rateLimitPerMinute: 0,
      paypalConfigured: paypal !== null,
      log: false,
      publicUrl: 'http://127.0.0.1:8787',
      webhookId: options.webhookId,
    },
  })
  const app = build()
  return { app, db, repo: new Repo(db), paypal, signer, rebuild: build, get services() { return services } }
}

export const bearer = (key: string = OWNER_KEY): HeadersInit => ({ authorization: `Bearer ${key}` })

export async function call(app: Requester, method: string, path: string, options: { key?: string; body?: unknown; idem?: string } = {}) {
  const headers: Record<string, string> = { ...(bearer(options.key) as Record<string, string>) }
  if (options.body !== undefined) headers['content-type'] = 'application/json'
  if (options.idem) headers['idempotency-key'] = options.idem
  const response = await app.request(`http://mandate.test${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) })
  const text = await response.text()
  return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers }
}

export const terms = (totalCents: number, overrides: Record<string, unknown> = {}) => ({
  scope: 'Spring launch logo',
  category: 'design',
  currency: 'USD',
  totalCents,
  milestones: [
    { title: 'Concepts', amountCents: totalCents / 2 },
    { title: 'Final files', amountCents: totalCents / 2 },
  ],
  proofRequired: true,
  ...overrides,
})

let counter = 0
export const idem = (prefix = 'test') => `${prefix}-${Date.now()}-${(counter += 1)}-key`

export async function agree(app: Requester, overrides: Record<string, unknown> = {}) {
  const offer = await call(app, 'POST', '/v1/deals/offers', { idem: idem('deal'), body: { buyer: 'Northwind', terms: terms(30_000, { jobId: JOB, ...overrides }) } })
  if (offer.json.status !== 'agreed') throw new Error(`deal not agreed: ${JSON.stringify(offer.json)}`)
  return offer.json as { id: string; jobId: string; threadId: string }
}

/** Bill milestone n of a deal, approve it, and settle it through the fake PayPal. Returns the capture id. */
export async function collect(app: Requester, dealId: string, milestone: number): Promise<{ proposalId: string; captureId: string }> {
  const billed = await call(app, 'POST', `/v1/deals/${dealId}/milestones/${milestone}/bill`, { body: { evidenceUrl: EVIDENCE } })
  const id = billed.json.id as string
  await call(app, 'POST', `/v1/proposals/${id}/approve`)
  const captured = await call(app, 'POST', `/v1/proposals/${id}/capture`)
  if (!captured.json.captureId) throw new Error(`charge did not capture: ${JSON.stringify(captured.json)}`)
  return { proposalId: id, captureId: captured.json.captureId }
}
