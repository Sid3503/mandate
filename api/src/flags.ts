import { z } from 'zod'

/** Planned switches. Off means the feature is not active. Nothing here approves or pays. */
export type ServerFlags = {
  tenancy: boolean
  demoEnabled: boolean
  demoTtlHours: number
  demoMaxActive: number
  demoMaxPerIpHour: number
  passkeys: boolean
  requirePasskeyForMoney: boolean
  legacyOwnerKeyEnabled: boolean
  invites: boolean
  inviteTtlHours: number
  safetyBreaker: boolean
  payeeBook: boolean
  newPayeeWaitHours: number
  policyPaste: boolean
  secondReader: boolean
  mcpExposeReadTools: boolean
  paypalLogin: boolean
  modelEnabled: boolean
}

const onOff = z.enum(['0', '1', 'true', 'false', 'on', 'off']).optional()
const hours = z.coerce.number().int().min(1).max(24 * 30)
const count = z.coerce.number().int().min(0).max(100_000)

const EnvFlags = z.object({
  FLAG_TENANCY: onOff,
  DEMO_ENABLED: onOff,
  DEMO_TTL_HOURS: hours.optional(),
  DEMO_MAX_ACTIVE: count.optional(),
  DEMO_MAX_PER_IP_HOUR: count.optional(),
  FLAG_PASSKEYS: onOff,
  REQUIRE_PASSKEY_FOR_MONEY: onOff,
  LEGACY_OWNER_KEY_ENABLED: onOff,
  FLAG_INVITES: onOff,
  INVITE_TTL_HOURS: hours.optional(),
  FLAG_SAFETY_BREAKER: onOff,
  FLAG_PAYEE_BOOK: onOff,
  NEW_PAYEE_WAIT_HOURS: z.coerce.number().int().min(0).max(24 * 30).optional(),
  FLAG_POLICY_PASTE: onOff,
  FLAG_SECOND_READER: onOff,
  MCP_EXPOSE_READ_TOOLS: onOff,
  PAYPAL_LOGIN_ENABLED: onOff,
  MODEL_ENABLED: onOff,
})

function enabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  return value === '1' || value === 'true' || value === 'on'
}

/** Read flags from the environment. Invalid values fail boot. Defaults stay off, except the two the plan turns on for this studio. */
export function loadFlags(env: NodeJS.ProcessEnv): ServerFlags {
  const parsed = EnvFlags.safeParse(env)
  if (!parsed.success) {
    const names = parsed.error.issues.map((issue) => issue.path.join('.') || 'flag').join(', ')
    throw new Error(`invalid flag: ${names}`)
  }
  const value = parsed.data
  return {
    tenancy: enabled(value.FLAG_TENANCY, false),
    demoEnabled: enabled(value.DEMO_ENABLED, false),
    demoTtlHours: value.DEMO_TTL_HOURS ?? 24,
    demoMaxActive: value.DEMO_MAX_ACTIVE ?? 200,
    demoMaxPerIpHour: value.DEMO_MAX_PER_IP_HOUR ?? 5,
    passkeys: enabled(value.FLAG_PASSKEYS, false),
    requirePasskeyForMoney: enabled(value.REQUIRE_PASSKEY_FOR_MONEY, false),
    legacyOwnerKeyEnabled: enabled(value.LEGACY_OWNER_KEY_ENABLED, true),
    invites: enabled(value.FLAG_INVITES, false),
    inviteTtlHours: value.INVITE_TTL_HOURS ?? 72,
    safetyBreaker: enabled(value.FLAG_SAFETY_BREAKER, false),
    payeeBook: enabled(value.FLAG_PAYEE_BOOK, false),
    newPayeeWaitHours: value.NEW_PAYEE_WAIT_HOURS ?? 24,
    policyPaste: enabled(value.FLAG_POLICY_PASTE, false),
    secondReader: enabled(value.FLAG_SECOND_READER, false),
    mcpExposeReadTools: enabled(value.MCP_EXPOSE_READ_TOOLS, false),
    paypalLogin: enabled(value.PAYPAL_LOGIN_ENABLED, false),
    modelEnabled: enabled(value.MODEL_ENABLED, true),
  }
}

export function defaultFlags(): ServerFlags {
  return loadFlags({})
}
