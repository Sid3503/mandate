export type ToolTier = 'read' | 'propose' | 'remove'

const READ = new Set(['get_rules', 'get_jobs', 'list_ledger', 'explain', 'get_deal'])
const PROPOSE = new Set(['propose', 'offer_deal'])

/** What a tool is allowed to do. An unknown name is not a tier. */
export function classifyTool(name: string): ToolTier | null {
  if (READ.has(name)) return 'read'
  if (PROPOSE.has(name)) return 'propose'
  return null
}

export type GuardOptions = {
  propose: (name: string, input: unknown) => Promise<unknown>
  exposeRead?: boolean
}

/**
 * Wraps a toolkit. Read tools pass through. Propose tools go to Mandate. Anything else is removed.
 * An unknown tool throws when you wrap, so a new tool cannot slip out as "allowed".
 */
export type ToolFn = (input: unknown) => Promise<unknown>

export function withMandate(tools: Record<string, ToolFn>, options: GuardOptions): Record<string, ToolFn> {
  const out: Record<string, ToolFn> = {}
  for (const name of Object.keys(tools)) {
    const tier = classifyTool(name)
    if (!tier) throw new Error(`unknown tool: ${name}`)
    if (tier === 'read') {
      if (options.exposeRead === false) continue
      const tool = tools[name]
      if (tool) out[name] = tool
    } else {
      out[name] = (input: unknown) => options.propose(name, input)
    }
  }
  return out
}
