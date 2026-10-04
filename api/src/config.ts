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
  WEB_DIST: z.string().min(1).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).max(10_000).default(120),
  PUBLIC_URL: z.string().min(1).optional(),
  PAYPAL_CLIENT_ID: z.string().min(1).optional(),
  PAYPAL_CLIENT_SECRET: z.string().min(1).optional(),
  PAYPAL_API: z.string().url().default('https://api-m.sandbox.paypal.com'),
  LOG: z.enum(['on', 'off']).default('on'),
})

export type AppConfig = {
  nodeEnv: string
  host: string
  port: number
  databasePath: string
  apiKey: string
  proposerKey: string | null
  webDist: string | null
  rateLimitPerMinute: number
  publicUrl: string
  log: boolean
  version: string
  paypal: { clientId: string; clientSecret: string; baseUrl: string } | null
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
  const paypal = value.PAYPAL_CLIENT_ID && value.PAYPAL_CLIENT_SECRET
    ? { clientId: value.PAYPAL_CLIENT_ID, clientSecret: value.PAYPAL_CLIENT_SECRET, baseUrl: value.PAYPAL_API }
    : null
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databasePath: value.DATABASE_PATH,
    apiKey,
    proposerKey,
    webDist: value.WEB_DIST ?? null,
    rateLimitPerMinute: value.RATE_LIMIT_PER_MINUTE,
    publicUrl: value.PUBLIC_URL ?? `http://${value.HOST}:${value.PORT}`,
    log: value.LOG === 'on',
    version: VERSION,
    paypal,
  }
}
