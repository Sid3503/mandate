import { z } from 'zod'

export const VERSION = '1.0.0'
const DEV_API_KEY = 'dev-mandate-key-change-me'
const DEV_PROPOSER_KEY = 'dev-proposer-key-change-me'

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  DATABASE_PATH: z.string().min(1).default('./data/mandate.sqlite'),
  API_KEY: z.string().min(16).optional(),
  PROPOSER_KEY: z.string().min(16).optional(),
  BUYER_AGENT_KEY: z.string().min(16).optional(),
  BUYER_AGENT_PARTY: z.string().min(1).default('client_northwind'),
  SIGNING_KEY: z.string().min(1).optional(),
  INVOICES: z.enum(['auto', 'off']).default('auto'),
  OLLAMA_API_KEY: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
  AGENT_MODEL: z.string().min(1).optional(),
  DRAFTER_MODEL: z.string().min(1).optional(),
  CLIENT_AGENT: z.enum(['auto', 'manual']).default('auto'),
  BREAKER_REFUSALS: z.coerce.number().int().min(0).max(50).default(3),
  BREAKER_WINDOW_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  SIGNING_KEYS_PREVIOUS: z.string().optional(),
  WEB_DIST: z.string().min(1).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(10_000).default(120),
  PUBLIC_URL: z.string().min(1).optional(),
  /** Render sets this to the service's public https address. It stands in for PUBLIC_URL when that is not set. */
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  /** The commit this build came from. Render sets RENDER_GIT_COMMIT; GIT_COMMIT is for anywhere else. Shown on /ready as releaseId. */
  RENDER_GIT_COMMIT: z.string().optional(),
  GIT_COMMIT: z.string().optional(),
  PAYPAL_CLIENT_ID: z.string().min(1).optional(),
  PAYPAL_CLIENT_SECRET: z.string().min(1).optional(),
  PAYPAL_WEBHOOK_ID: z.string().min(1).optional(),
  PAYPAL_API: z.string().url().default('https://api-m.sandbox.paypal.com'),
  LOG: z.enum(['on', 'off']).default('on'),
  /** An incoming webhook (Slack, Discord, Zapier) that is told when something needs the owner. The address is a secret. */
  NOTIFY_WEBHOOK_URL: z.string().url().refine((value) => value.startsWith('https://'), 'must be an https address').optional(),
  /** Lets the owner wipe the money state from the System page, for a hosted demo that many people try in turn. Sandbox PayPal only. */
  DEMO_RESET: z.enum(['on', 'off']).default('off'),
})

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  databasePath: string
  apiKey: string
  proposerKey: string | null
  buyerAgentKey: string | null
  buyerAgentParty: string
  signingKey: string | null
  invoices: boolean
  breakerRefusals: number
  breakerWindowSeconds: number
  ollamaApiKey: string | undefined
  ollamaBaseUrl: string | undefined
  agentModel: string | undefined
  drafterModel: string | undefined
  /** `auto`: the hosted stand-in for the client's agent reviews each delivery as soon as it arrives. `manual`: only when asked. */
  clientAgent: 'auto' | 'manual'
  previousPublicKeys: string[]
  webDist: string | null
  rateLimitPerMinute: number
  publicUrl: string
  /** The commit this server was built from, when the host says so. A deploy is verified by reading it back. */
  commit: string | null
  log: boolean
  /** Where to tell the owner that something needs them. Null when not set. Never logged. */
  notifyWebhookUrl: string | null
  /** When on, the owner can reset the demo from the System page. Refused unless PayPal is the sandbox. */
  demoReset: boolean
  version: string
  paypal: { clientId: string; clientSecret: string; baseUrl: string } | null
  /** The id PayPal gave the webhook when it was registered. With it, every webhook is checked against PayPal's signature. */
  paypalWebhookId: string | null
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    throw new Error(`invalid environment: ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}`)
  }
  const value = parsed.data
  const apiKey = value.API_KEY ?? (value.NODE_ENV === 'production' ? '' : DEV_API_KEY)
  if (value.NODE_ENV === 'production' && (apiKey.length < 16 || apiKey === DEV_API_KEY)) {
    throw new Error('API_KEY of at least 16 characters is required in production, and it cannot be the development key')
  }
  const proposerKey = value.PROPOSER_KEY ?? (value.NODE_ENV === 'production' ? null : DEV_PROPOSER_KEY)
  if (proposerKey && proposerKey === apiKey) {
    throw new Error('PROPOSER_KEY must differ from API_KEY')
  }
  if (value.NODE_ENV === 'production' && proposerKey === DEV_PROPOSER_KEY) {
    throw new Error('PROPOSER_KEY cannot be the development key in production')
  }
  if (value.BUYER_AGENT_KEY && (value.BUYER_AGENT_KEY === apiKey || value.BUYER_AGENT_KEY === proposerKey)) {
    throw new Error('BUYER_AGENT_KEY must differ from API_KEY and PROPOSER_KEY')
  }
  if (value.NODE_ENV === 'production' && !value.SIGNING_KEY) {
    throw new Error('SIGNING_KEY (an Ed25519 private key in PKCS8 PEM) is required in production')
  }
  const paypal = value.PAYPAL_CLIENT_ID && value.PAYPAL_CLIENT_SECRET
    ? { clientId: value.PAYPAL_CLIENT_ID, clientSecret: value.PAYPAL_CLIENT_SECRET, baseUrl: value.PAYPAL_API }
    : null
  if (value.DEMO_RESET === 'on' && !/sandbox/i.test(value.PAYPAL_API)) {
    throw new Error('DEMO_RESET wipes the ledger, so it only runs against the PayPal sandbox (PAYPAL_API must be a sandbox address)')
  }
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    apiKey,
    proposerKey,
    buyerAgentKey: value.BUYER_AGENT_KEY ?? null,
    buyerAgentParty: value.BUYER_AGENT_PARTY,
    signingKey: value.SIGNING_KEY ?? null,
    invoices: value.INVOICES === 'auto' && Boolean(paypal),
    ollamaApiKey: value.OLLAMA_API_KEY,
    ollamaBaseUrl: value.OLLAMA_BASE_URL,
    agentModel: value.AGENT_MODEL,
    drafterModel: value.DRAFTER_MODEL,
    clientAgent: value.CLIENT_AGENT,
    breakerRefusals: value.BREAKER_REFUSALS,
    breakerWindowSeconds: value.BREAKER_WINDOW_SECONDS,
    previousPublicKeys: (value.SIGNING_KEYS_PREVIOUS ?? '').split('|').map((item) => item.trim()).filter(Boolean),
    webDist: value.WEB_DIST ?? null,
    rateLimitPerMinute: value.RATE_LIMIT_PER_MINUTE,
    publicUrl: value.PUBLIC_URL ?? value.RENDER_EXTERNAL_URL ?? `http://${value.HOST}:${value.PORT}`,
    commit: [value.GIT_COMMIT, value.RENDER_GIT_COMMIT].map((item) => item?.trim().toLowerCase()).find((item) => item !== undefined && /^[0-9a-f]{7,40}$/.test(item)) ?? null,
    log: value.LOG === 'on',
    notifyWebhookUrl: value.NOTIFY_WEBHOOK_URL ?? null,
    demoReset: value.DEMO_RESET === 'on',
    version: VERSION,
    paypalWebhookId: value.PAYPAL_WEBHOOK_ID ?? null,
    paypal,
  }
}
