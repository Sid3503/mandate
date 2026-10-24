import type { AgentScope } from './types'

/** The choices on "Connect an agent". Each one is a set of scopes the server understands. */
export type PresetId = 'ask' | 'read' | 'deals' | 'custom'

export const PRESETS: Array<{ id: PresetId; title: string; blurb: string; scopes: AgentScope[] | null }> = [
  { id: 'ask', title: 'Read and ask', blurb: 'Looks at the rules, jobs and ledger, and can ask to pay or bill. Every ask still goes through the rules.', scopes: ['mcp', 'read', 'propose'] },
  { id: 'read', title: 'Read only', blurb: 'Can look, never ask. A good first key for trying an agent out.', scopes: ['mcp', 'read'] },
  { id: 'deals', title: 'Read, ask and negotiate', blurb: 'Also offers deal terms for the studio, which the rules check against both sides.', scopes: ['mcp', 'read', 'propose', 'deals'] },
  { id: 'custom', title: 'Custom', blurb: 'Pick the scopes and the hourly limits yourself.', scopes: null },
]

export const SCOPE_WORDS: Record<AgentScope, string> = { read: 'read', propose: 'ask', stream: 'live stream', mcp: 'MCP door', deals: 'deals' }

/** What each tool does, in the words the owner uses. */
export const TOOL_WORDS: Record<string, string> = {
  get_rules: 'read the rules',
  get_jobs: 'look up jobs',
  list_ledger: 'read the ledger',
  propose: 'ask to pay or bill',
  offer_deal: 'offer a deal',
  explain: 'explain a decision',
  get_deliveries: 'see deliveries',
  decide_delivery: 'accept or reject a delivery',
}

/** A tool with one of these names could move money. The door never offers one; the connection check says so if it ever did. */
export const FORBIDDEN_TOOLS = ['approve', 'reject', 'capture', 'pay', 'send_payout', 'refund', 'publish_rules', 'cancel', 'settle']

/** What a key can and cannot do given its scopes. */
export function canAndCannotFor(scopes: AgentScope[]): { can: string[]; cannot: string[] } {
  const can: string[] = []
  if (scopes.includes('mcp')) can.push('Connect through the Model Context Protocol (MCP) door')
  if (scopes.includes('read')) can.push('Read company rules, open jobs, and ledger history')
  if (scopes.includes('propose')) can.push('Ask Mandate to pay vendors or bill clients through standing rules')
  if (scopes.includes('deals')) can.push('Offer and negotiate deal terms with client agents')
  if (scopes.includes('stream')) can.push('Subscribe to live ledger and delivery event streams')

  const cannot: string[] = [
    'Approve or capture any payment (only the studio owner can approve)',
    'Change, publish, or delete studio rules',
    'Emergency pause or resume the system',
    'Access raw PayPal tokens or payment secrets',
    'Modify vendor payout details or add unverified payees',
  ]

  return { can, cannot }
}

/** The ready-to-paste connection details for one key. The key lives only in the page's memory and is shown once. */
export function commandsFor(url: string, key: string) {
  return {
    claude: `claude mcp add --transport http mandate ${url} --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify({ mcpServers: { mandate: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2),
    generic: `URL:     ${url}\nHeader:  Authorization: Bearer ${key}`,
    curl: `curl -s -X POST ${url} \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -H "Accept: application/json, text/event-stream" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  }
}
