import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk'
import { PayPalError } from './port'

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
}): Toolkit {
  const toolkit = new PayPalAgentToolkit({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    configuration: { actions: options.actions, context: { sandbox: options.sandbox } },
  })
  const tools = toolkit.getTools() as unknown as Record<string, ToolLike>
  return {
    async run(name, args) {
      const tool = tools[name]
      if (!tool?.execute) throw new PayPalError(500, 'toolkit_tool_missing', null, name)
      const raw = await tool.execute(args as never, { toolCallId: `mandate-${name}`, messages: [] })
      const value: unknown = typeof raw === 'string' ? safeParse(raw) : raw
      const result = (value && typeof value === 'object' ? value : {}) as Json
      if (result.ok === false) {
        const status = typeof result.status === 'number' ? result.status : 502
        throw new PayPalError(status, typeof result.code === 'string' ? result.code : 'paypal_error', null, String(result.message ?? ''))
      }
      return result
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
