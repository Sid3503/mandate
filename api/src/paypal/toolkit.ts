import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import { PayPalError } from './port'
import { TOOL_TIERS } from './tiers'

type ToolLike = { execute?: (args: never, options: { toolCallId: string; messages: never[] }) => Promise<unknown> | unknown }
export type Json = Record<string, unknown>

/**
 * One place that talks to PayPal's Agent Toolkit. The toolkit's tools are built for a model to call; here no model
 * ever sees them. The server calls a few of them with values it took from a locked cart or from PayPal itself.
 * Each use enables only the actions it needs, so a bug cannot reach a tool that was never switched on.
 */
export type Toolkit = { run(name: string, args: Json): Promise<Json> }

export function createToolkit(options: {
  clientId: string
  clientSecret: string
  sandbox: boolean
  actions: Record<string, Record<string, boolean>>
  /** Per-call limit. The toolkit has none of its own. */
  timeoutMs?: number
  /** How long one toolkit instance (and its access token) is used before a fresh one is built. */
  refreshMs?: number
  now?: () => number
}): Toolkit {
  // The toolkit fetches one access token and keeps it forever. PayPal's tokens expire (about nine hours), and after that
  // every call answered 401, which reads as "no permission": the dispute check quietly stopped guarding payouts. So the
  // toolkit is rebuilt (a fresh token) well inside a token's life, and at once after any 401.
  const build = () => {
    const toolkit = new PayPalAgentToolkit({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      configuration: { actions: options.actions, context: { sandbox: options.sandbox } },
    })
    return { tools: toolkit.getTools() as unknown as Record<string, ToolLike>, builtAt: (options.now ?? Date.now)() }
  }
  let current = build()
  const timeoutMs = options.timeoutMs ?? 25_000
  const refreshMs = options.refreshMs ?? 4 * 3_600_000
  const once = async (name: string, args: Json): Promise<Json> => {
    if ((options.now ?? Date.now)() - current.builtAt > refreshMs) current = build()
    const tool = current.tools[name]
    if (!tool?.execute) throw new PayPalError(500, 'toolkit_tool_missing', null, name)
    // The toolkit's HTTP client has no timeout. One hung call would hold the sweep forever, so every call has one here.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PayPalError(504, 'toolkit_timeout', null, name)), timeoutMs) })
    let raw: unknown
    try {
      raw = await Promise.race([Promise.resolve(tool.execute(args as never, { toolCallId: `mandate-${name}`, messages: [] })), timeout])
    } finally {
      clearTimeout(timer)
    }
    const value: unknown = typeof raw === 'string' ? safeParse(raw) : raw
    const result = (value && typeof value === 'object' ? value : {}) as Json
    if (result.ok === false) {
      const status = typeof result.status === 'number' ? result.status : 502
      throw new PayPalError(status, typeof result.code === 'string' ? result.code : 'paypal_error', null, String(result.message ?? ''))
    }
    // The toolkit turns some failures (a token fetch that failed, a thrown error) into `{ error: ... }` with no `ok`.
    // That is a failure, never an empty success: an empty dispute list read from an error would wave a payout through.
    if (result.error !== undefined && result.ok !== true) {
      const error = obj(result.error)
      const status = typeof error.status === 'number' ? error.status : typeof error.statusCode === 'number' ? error.statusCode : 502
      throw new PayPalError(status, typeof error.name === 'string' ? error.name : 'toolkit_error', null, String(error.message ?? JSON.stringify(result.error)).slice(0, 300))
    }
    return result
  }
  return {
    async run(name, args) {
      // Only the tools written down as the server's own. A tool that moves money or is out of scope cannot be run from here.
      if (!TOOL_TIERS[name]?.usedByMandate) throw new PayPalError(500, 'toolkit_tool_not_allowed', null, name)
      try {
        return await once(name, args)
      } catch (error) {
        if (!(error instanceof PayPalError && error.httpStatus === 401)) throw error
        current = build()
        return once(name, args)
      }
    },
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

export const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
export const arr = (value: unknown): Json[] => (Array.isArray(value) ? value.map(obj) : [])
export const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null)
